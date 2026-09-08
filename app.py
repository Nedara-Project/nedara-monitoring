# -*- coding: utf-8 -*-

import psycopg
import paramiko
import requests
import configparser
import time
import threading
import json
import sqlite3
import os
import html
import smtplib
import urllib3
import fcntl
import re

from flask import Flask, render_template, request, session, redirect, url_for, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.security import check_password_hash, generate_password_hash
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from decimal import Decimal
from contextlib import closing
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        elif isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)


urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
config = configparser.ConfigParser()
config.read('config.ini')
DEFAULT_ENV = config['environments']['default_env']
REFRESH_RATE = float(config['general']['refresh_rate'])

with open('version.json') as _vf:
    VERSION = json.load(_vf)['version']

app = Flask(__name__)
app.json_encoder = CustomJSONEncoder
app.config['SECRET_KEY'] = config['general'].get('secret_key', 'nedara-change-me')
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins="*", max_decode_packets=50)

@app.context_processor
def inject_version():
    return {'version': VERSION}

# Writable directory for the chart history and the mail lock files. Defaults
# to the application directory; point it to a volume when containerised.
DATA_DIR = os.environ.get('NEDARA_DATA_DIR') or os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(DATA_DIR, 'nedara_monitoring.db')
SCHEMA = """
CREATE TABLE IF NOT EXISTS chart_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chart_id TEXT NOT NULL,
    series_name TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    value REAL NOT NULL,
    environment TEXT NOT NULL,
    UNIQUE(chart_id, series_name, timestamp, environment)
);

CREATE TABLE IF NOT EXISTS chart_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chart_id TEXT UNIQUE NOT NULL,
    max_points INTEGER NOT NULL,
    chart_type TEXT NOT NULL
);
"""

server_data_cache = {}    # {environment: data_dict}
client_environments = {}  # {sid: environment}
alert_state = {}          # {(environment, alert_key): state_dict}
mail_backoff = {}         # {environment: epoch before which no send is retried}
TMP_DIR = os.path.join(DATA_DIR, "tmp")
os.makedirs(TMP_DIR, exist_ok=True)

SEVERITY_ORDER = {'warning': 1, 'critical': 2}

# Seconds to wait before retrying after an SMTP failure
MAIL_RETRY_BACKOFF = 60.0

# Alert thresholds. Every key below can be overridden globally in a
# [thresholds] section, per environment (in the environment section) or per
# server (in the server section) — the most specific value wins.
DEFAULT_THRESHOLDS = {
    'cpu_warning': 70.0,               # %
    'cpu_critical': 90.0,
    'ram_warning': 70.0,               # %
    'ram_critical': 90.0,
    'disk_warning': 70.0,              # % of the root filesystem
    'disk_critical': 90.0,
    'mount_warning': 70.0,             # % of any other mounted volume
    'mount_critical': 90.0,
    'load_warning': 1.5,               # load average (1m) per CPU core
    'load_critical': 3.0,
    'response_time_warning': 1000.0,   # ms — web application response time
    'response_time_critical': 5000.0,
    'pg_active_wait_warning': 30.0,    # s — longest running active query
    'pg_active_wait_critical': 120.0,
    'pg_idle_tx_warning': 120.0,       # s — longest "idle in transaction"
    'pg_idle_tx_critical': 600.0,
    'pgb_waiting_warning': 1.0,        # waiting client connections
    'pgb_waiting_critical': 5.0,
    'pgb_maxwait_warning': 1.0,        # s — longest client wait for a server
    'pgb_maxwait_critical': 5.0,
}


def _reload_config():
    global DEFAULT_ENV, REFRESH_RATE
    config.read('config.ini')
    DEFAULT_ENV = config['environments']['default_env']
    REFRESH_RATE = float(config['general']['refresh_rate'])
    app.config['SECRET_KEY'] = config['general'].get('secret_key', 'nedara-change-me')


def _is_send_emails_enabled(environment):
    try:
        return config[environment].get('send_emails', '1').strip() == '1'
    except Exception:
        return True


def _env_float(environment, key, default):
    """Read a numeric key from an environment section, falling back to [general]."""
    for section in (environment, 'general'):
        if section and section in config:
            raw = (config[section].get(key) or '').strip()
            if raw:
                try:
                    return float(raw)
                except ValueError:
                    pass
    return default


def _get_alert_delay(environment):
    """Minutes an issue must persist before it is emailed."""
    return _env_float(environment, 'alert_delay_minutes', 0.0)


def _get_alert_repeat(environment):
    """Minutes before the same, still-active alert is emailed again."""
    return _env_float(environment, 'alert_repeat_minutes', 60.0)


def _get_alert_min_severity(environment):
    """Lowest severity that triggers an email ('warning' or 'critical')."""
    for section in (environment, 'general'):
        if section in config:
            raw = (config[section].get('alert_email_min_severity') or '').strip().lower()
            if raw in SEVERITY_ORDER:
                return raw
    return 'critical'


def _resolved_emails_enabled(environment):
    for section in (environment, 'general'):
        if section in config:
            raw = (config[section].get('alert_resolved_emails') or '').strip()
            if raw:
                return raw == '1'
    return True


def _has_mail_config():
    general_config = config['general']
    return bool(
        general_config.get('email_notif_smtp_server') and
        general_config.get('email_notif_smtp_port') and
        general_config.get('email_notif_recipients')
    )


def get_thresholds(environment=None, server_name=None):
    """Resolve alert thresholds: defaults < [thresholds] < environment < server."""
    values = dict(DEFAULT_THRESHOLDS)
    for section in ('thresholds', environment, server_name):
        if not section or section not in config:
            continue
        for key in DEFAULT_THRESHOLDS:
            raw = (config[section].get(key) or '').strip()
            if not raw:
                continue
            try:
                values[key] = float(raw)
            except ValueError:
                pass
    return values


def _is_admin_enabled():
    return config['general'].get('admin_enabled', '0').strip() == '1'


def _is_admin_authenticated():
    return session.get('admin_authenticated') is True


def _mail_files(environment):
    safe = re.sub(r'[^a-zA-Z0-9_-]', '_', environment)
    return (
        os.path.join(TMP_DIR, f"error_mail_{safe}.lock"),
        os.path.join(TMP_DIR, f"error_mail_{safe}.state"),
    )


def init_db():
    with closing(connect_db()) as db:
        db.executescript(SCHEMA)
        db.commit()


def connect_db():
    return sqlite3.connect(DATABASE)


def _fmt_duration(seconds):
    seconds = int(max(0, seconds or 0))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60:02d}s"
    hours, rest = divmod(seconds, 3600)
    if hours < 24:
        return f"{hours}h {rest // 60:02d}m"
    days, hours = divmod(hours, 24)
    return f"{days}d {hours:02d}h"


def _fmt_metric(value, unit):
    """Human readable metric value, identical in the dashboard and in emails."""
    if value is None:
        return '—'
    if unit == '%':
        return f"{value:.1f}%"
    if unit == 'ms':
        return f"{value:.0f} ms"
    if unit == 's':
        return f"{value:.1f} s"
    if unit == 'x':
        return f"{value:.2f}"
    if not unit:
        return f"{value:g}"
    return f"{value:g} {unit}"


SEVERITY_COLORS = {
    'critical': ('#ef4444', '#fef2f2', '#fecaca', '#b91c1c'),
    'warning': ('#f59e0b', '#fffbeb', '#fde68a', '#b45309'),
    'resolved': ('#10b981', '#ecfdf5', '#a7f3d0', '#047857'),
}


def _alert_mail_block(alert, resolved=False):
    severity = 'resolved' if resolved else alert.get('severity', 'critical')
    accent, bg, border, text = SEVERITY_COLORS.get(severity, SEVERITY_COLORS['critical'])
    rows = {
        'Server': alert.get('target', '—'),
        'Metric': alert.get('label', '—'),
    }
    if alert.get('value') is not None:
        rows['Last value' if resolved else 'Value'] = (
            alert.get('value_display') or _fmt_metric(alert.get('value'), alert.get('unit', ''))
        )
    if alert.get('threshold') is not None:
        rows['Threshold'] = alert.get('threshold_display') or _fmt_metric(alert.get('threshold'), alert.get('unit', ''))
    rows['Duration'] = _fmt_duration(alert.get('duration'))
    if alert.get('since'):
        rows['Since'] = datetime.fromtimestamp(alert['since']).strftime('%Y-%m-%d %H:%M:%S')
    if alert.get('detail'):
        rows['Details'] = html.escape(str(alert['detail']))

    rows_html = ''.join(
        f"""<tr>
              <td style="padding:5px 0;font-size:12px;color:#64748b;font-weight:500;width:110px;vertical-align:top;">{k}</td>
              <td style="padding:5px 0;font-size:12px;color:#1e293b;vertical-align:top;word-break:break-word;">{v}</td>
            </tr>"""
        for k, v in rows.items()
    )
    label = 'Resolved' if resolved else severity.upper()
    return f"""<table width="100%" cellpadding="0" cellspacing="0" style="background:{bg};border:1px solid {border};border-radius:10px;margin-bottom:12px;">
  <tr><td style="padding:14px 16px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="font-size:11px;font-weight:700;color:{text};letter-spacing:0.06em;text-transform:uppercase;">{label}</td>
        <td align="right" style="font-size:11px;color:#94a3b8;">{html.escape(str(alert.get('category', '')))}</td>
      </tr>
      <tr><td colspan="2" style="padding-top:4px;font-size:15px;font-weight:700;color:#0f172a;">
        {html.escape(str(alert.get('title') or alert.get('message', '')))}
      </td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:10px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:2px 12px;">
      <tr><td><table width="100%" cellpadding="0" cellspacing="0">{rows_html}</table></td></tr>
    </table>
  </td></tr>
</table>"""


def _build_alert_mail_body(alerts, environment, resolved=False):
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    worst = 'resolved' if resolved else (
        'critical' if any(a.get('severity') == 'critical' for a in alerts) else 'warning'
    )
    accent = SEVERITY_COLORS[worst][0]
    if resolved:
        heading = 'Alert resolved' if len(alerts) == 1 else f'{len(alerts)} alerts resolved'
        intro = 'The condition below is no longer detected. No action is required.'
    else:
        heading = 'Alert triggered' if len(alerts) == 1 else f'{len(alerts)} active alerts'
        intro = (
            'The following condition crossed its configured threshold and is still active.'
            if len(alerts) == 1 else
            'The following conditions crossed their configured thresholds and are still active.'
        )
    blocks = ''.join(_alert_mail_block(a, resolved=resolved) for a in alerts)
    return f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#6366f1;border-radius:14px 14px 0 0;padding:24px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td>
                <span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.65);letter-spacing:0.08em;text-transform:uppercase;">Nedara Monitoring</span>
                <div style="margin-top:6px;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">{heading}</div>
              </td>
              <td align="right" style="vertical-align:top;">
                <div style="width:14px;height:14px;background:{accent};border-radius:50%;box-shadow:0 0 0 4px rgba(255,255,255,0.25);margin-top:6px;"></div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:24px 32px 8px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
          <p style="margin:0 0 18px;font-size:14px;color:#1e293b;line-height:1.6;">{intro}</p>
          {blocks}
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:0 0 14px 14px;padding:16px 32px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:12px;color:#94a3b8;">
                Environment: <span style="font-weight:600;color:#6366f1;">{html.escape(str(environment))}</span>
              </td>
              <td align="right" style="font-size:12px;color:#94a3b8;">{now}</td>
            </tr>
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>"""


def _alert_mail_subject(alerts, environment, resolved=False):
    targets = []
    for a in alerts:
        target = a.get('target')
        if target and target not in targets:
            targets.append(target)
    if resolved:
        if len(alerts) == 1:
            a = alerts[0]
            return (f"✅ Nedara Monitoring [{environment}] — Resolved: {a.get('target')} "
                    f"{a.get('label')} (after {_fmt_duration(a.get('duration'))})")
        return f"✅ Nedara Monitoring [{environment}] — {len(alerts)} alerts resolved: {', '.join(targets)}"
    icon = '🔴' if any(a.get('severity') == 'critical' for a in alerts) else '🟠'
    if len(alerts) == 1:
        a = alerts[0]
        value = a.get('value_display')
        suffix = f" — {value}" if value and value != '—' else ''
        return f"{icon} Nedara Monitoring [{environment}] — {a.get('target')}: {a.get('label')}{suffix}"
    return f"{icon} Nedara Monitoring [{environment}] — {len(alerts)} active alerts: {', '.join(targets)}"


def _mail_state_load(state_file_path):
    """Return {alert_key: last_sent_epoch}; tolerates the legacy state file."""
    if not os.path.exists(state_file_path):
        return {}
    try:
        with open(state_file_path, 'r') as f:
            raw = f.read().strip()
        if not raw:
            return {}
        if raw.startswith('{'):
            return {k: float(v) for k, v in json.loads(raw).items()}
        # Legacy format (a single ISO timestamp for the whole environment):
        # throttling is now per alert key, so start from a clean state.
        return {}
    except Exception as e:
        print(f"⚠️  Could not read mail state {state_file_path}: {e}")
        return {}


def _smtp_send(subject, body):
    general_config = config['general']
    recipients = [
        email.strip()
        for email in general_config['email_notif_recipients'].split(',')
        if email.strip()
    ]
    if not recipients:
        return False

    msg = MIMEMultipart('alternative')
    msg['From'] = general_config.get('email_notif_login') or 'nedara-monitoring@localhost'
    msg['To'] = ', '.join(recipients)
    msg['Subject'] = subject
    msg.attach(MIMEText(body or '', 'html', 'utf-8'))

    with smtplib.SMTP(
        host=general_config['email_notif_smtp_server'],
        port=int(general_config['email_notif_smtp_port']),
    ) as server:
        server.ehlo()
        if server.has_extn('starttls'):
            server.starttls()
            server.ehlo()
        login = general_config.get('email_notif_login')
        password = general_config.get('email_notif_password')
        if login and password:
            server.login(login, password)
        server.sendmail(msg['From'], recipients, msg.as_string())

    print(f"✅ Notification email sent: {subject} -> {recipients}")
    return True


def send_alert_mails(environment, alerts, resolved=False):
    """Email the given alerts as a single message.

    Throttling is per alert key (an alert about one server never masks an
    alert about another) and persisted on disk so that concurrent workers
    share it. Returns the list of alert keys actually notified.
    """
    if not alerts or not _is_send_emails_enabled(environment) or not _has_mail_config():
        return []

    now = time.time()
    # A failing SMTP server must not be retried on every collection cycle
    if now < mail_backoff.get(environment, 0):
        return []

    repeat_seconds = max(_get_alert_repeat(environment), 0.0) * 60
    lock_file_path, state_file_path = _mail_files(environment)

    try:
        with open(lock_file_path, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)

            state = _mail_state_load(state_file_path)
            to_send = []
            for alert in alerts:
                state_key = f"resolved:{alert['key']}" if resolved else alert['key']
                last_sent = state.get(state_key)
                if resolved or alert.get('escalated') or not last_sent:
                    to_send.append(alert)
                elif now - last_sent >= repeat_seconds:
                    to_send.append(alert)

            if not to_send:
                return []

            _smtp_send(
                _alert_mail_subject(to_send, environment, resolved=resolved),
                _build_alert_mail_body(to_send, environment, resolved=resolved),
            )

            for alert in to_send:
                if resolved:
                    # A resolved incident starts over: drop its throttle entry.
                    state.pop(alert['key'], None)
                    state[f"resolved:{alert['key']}"] = now
                else:
                    state[alert['key']] = now
                    state.pop(f"resolved:{alert['key']}", None)

            with open(state_file_path, "w") as f:
                json.dump(state, f)

            return [alert['key'] for alert in to_send]

    except Exception as e:
        mail_backoff[environment] = time.time() + MAIL_RETRY_BACKOFF
        print(f"❌ Error sending notification email: {e} "
              f"(retrying in {int(MAIL_RETRY_BACKOFF)}s)")
        return []


# ──────────────────────────────────────────────────────────────
# ALERT EVALUATION
# ──────────────────────────────────────────────────────────────

def _severity(value, warning, critical):
    if value is None:
        return None
    if critical is not None and value >= critical:
        return 'critical'
    if warning is not None and value >= warning:
        return 'warning'
    return None


def _to_float(value, default=None):
    try:
        if value is None or value == '':
            return default
        return float(str(value).strip().split()[0].replace(',', '.'))
    except (TypeError, ValueError, IndexError):
        return default


def _make_alert(key, severity, category, scope, target, target_id, label,
                message, value=None, threshold=None, unit='', detail='', title=None):
    return {
        'key': key,
        'severity': severity,
        'category': category,
        'scope': scope,
        'target': target,
        'target_id': target_id,
        'label': label,
        'message': message,
        'title': title or message,
        'value': value,
        'threshold': threshold,
        'unit': unit,
        'value_display': _fmt_metric(value, unit) if value is not None else '',
        'threshold_display': _fmt_metric(threshold, unit) if threshold is not None else '',
        'detail': detail,
    }


def _threshold_alert(key, category, scope, target, target_id, label, value,
                     thresholds, warning_key, critical_key, unit='%', detail=''):
    """Build an alert when `value` crosses its warning/critical threshold."""
    value = _to_float(value)
    if value is None:
        return None
    warning = thresholds.get(warning_key)
    critical = thresholds.get(critical_key)
    severity = _severity(value, warning, critical)
    if not severity:
        return None
    threshold = critical if severity == 'critical' else warning
    return _make_alert(
        key=key, severity=severity, category=category, scope=scope,
        target=target, target_id=target_id, label=label,
        message=(f"{label} is {_fmt_metric(value, unit)} "
                 f"(≥ {severity} threshold {_fmt_metric(threshold, unit)})"),
        title=f"{target} — {label} {_fmt_metric(value, unit)}",
        value=value, threshold=threshold, unit=unit, detail=detail,
    )


def evaluate_alerts(environment, data):
    """Turn a collection payload into a list of precise, targeted alerts."""
    alerts = []
    stats = data.get('stats') or {}
    env_thresholds = get_thresholds(environment)

    # ── Web application ──
    web_status = data.get('web_status') or {}
    web_url = data.get('web_url') or ''
    web_name = data.get('web_url_name') or web_url or 'Web application'
    status = web_status.get('status', '')
    if status == 'Online':
        alert = _threshold_alert(
            key=f'web_response:{environment}', category='response_time', scope='web',
            target=web_name, target_id='web-app-card', label='Response time',
            value=_to_float(web_status.get('response_time')), thresholds=env_thresholds,
            warning_key='response_time_warning', critical_key='response_time_critical',
            unit='ms', detail=web_url,
        )
        if alert:
            alerts.append(alert)
    elif web_status.get('status_code') and status.startswith('Error'):
        alerts.append(_make_alert(
            key=f'web_error:{environment}', severity='critical', category='http',
            scope='web', target=web_name, target_id='web-app-card', label='HTTP status',
            message=f"The web application returned HTTP {web_status['status_code']}",
            title=f"{web_name} — HTTP {web_status['status_code']}",
            detail=web_url,
        ))
    else:
        alerts.append(_make_alert(
            key=f'web_offline:{environment}', severity='critical', category='offline',
            scope='web', target=web_name, target_id='web-app-card', label='Availability',
            message='The web application is unreachable (no response before timeout)',
            title=f"{web_name} — offline",
            detail=web_status.get('error') or web_url,
        ))

    # ── Servers and services ──
    for server_key, server in stats.items():
        if not isinstance(server, dict) or server_key.endswith('_processes'):
            continue
        server_type = server.get('type')
        name = server.get('name') or server.get('server') or server_key

        if server_type == 'linux':
            if server.get('error'):
                alerts.append(_make_alert(
                    key=f'ssh:{server_key}', severity='critical', category='unreachable',
                    scope='server', target=name, target_id=server_key, label='SSH connection',
                    message='The server is unreachable over SSH',
                    title=f"{name} — unreachable",
                    detail=str(server['error'])[:300],
                ))
                continue

            thresholds = get_thresholds(environment, server_key)
            candidates = [
                _threshold_alert(
                    f'cpu:{server_key}', 'cpu', 'server', name, server_key, 'CPU usage',
                    server.get('cpu_usage'), thresholds, 'cpu_warning', 'cpu_critical',
                ),
                _threshold_alert(
                    f'ram:{server_key}', 'ram', 'server', name, server_key, 'RAM usage',
                    server.get('ram_usage_percent'), thresholds, 'ram_warning', 'ram_critical',
                    detail=f"{server.get('ram_used', '?')} MB used of {server.get('ram_total', '?')} MB",
                ),
                _threshold_alert(
                    f'disk:{server_key}', 'disk', 'server', name, server_key, 'Disk usage (/)',
                    server.get('storage_usage_percent'), thresholds, 'disk_warning', 'disk_critical',
                    detail=(f"{server.get('storage_used', '?')} / {server.get('storage_size', '?')} used — "
                            f"{server.get('storage_available', '?')} free"),
                ),
            ]

            cores = _to_float(server.get('cpu_cores'), 1.0) or 1.0
            load_avg = _to_float(server.get('load_avg'))
            if load_avg is not None:
                candidates.append(_threshold_alert(
                    f'load:{server_key}', 'load', 'server', name, server_key,
                    'Load average per core', load_avg / cores, thresholds,
                    'load_warning', 'load_critical', unit='x',
                    detail=f"load average (1m) {load_avg:.2f} on {int(cores)} core(s)",
                ))

            for mount in server.get('mounts') or []:
                candidates.append(_threshold_alert(
                    f"mount:{server_key}:{mount.get('mountpoint')}", 'mount', 'server',
                    name, server_key, f"Volume {mount.get('mountpoint')}",
                    mount.get('percent'), thresholds, 'mount_warning', 'mount_critical',
                    detail=(f"{mount.get('used', '?')} / {mount.get('size', '?')} used — "
                            f"{mount.get('available', '?')} free"),
                ))

            alerts.extend([a for a in candidates if a])

        elif server_type == 'postgres':
            if server.get('error'):
                alerts.append(_make_alert(
                    key=f'postgres:{server_key}', severity='critical', category='unreachable',
                    scope='postgres', target=name, target_id='postgres-panel',
                    label='PostgreSQL connection',
                    message='The PostgreSQL server is unreachable',
                    title=f"{name} — PostgreSQL unreachable",
                    detail=str(server['error'])[:300],
                ))
                continue

            thresholds = get_thresholds(environment, server_key)
            queries = server.get('active_queries') or []

            def _longest(state):
                rows = [q for q in queries if q[2] == state]
                return max(rows, key=lambda q: q[6]) if rows else None

            longest_active = _longest('active')
            if longest_active:
                alert = _threshold_alert(
                    f'pg_active:{server_key}', 'query', 'postgres', name, 'postgres-panel',
                    'Longest active query', longest_active[6], thresholds,
                    'pg_active_wait_warning', 'pg_active_wait_critical', unit='s',
                    detail=f"db {longest_active[0]} · user {longest_active[1]} · {longest_active[3][:200]}",
                )
                if alert:
                    alerts.append(alert)

            longest_idle = _longest('idle in transaction')
            if longest_idle:
                alert = _threshold_alert(
                    f'pg_idle_tx:{server_key}', 'query', 'postgres', name, 'postgres-panel',
                    'Longest idle transaction', longest_idle[6], thresholds,
                    'pg_idle_tx_warning', 'pg_idle_tx_critical', unit='s',
                    detail=f"db {longest_idle[0]} · user {longest_idle[1]} · {longest_idle[3][:200]}",
                )
                if alert:
                    alerts.append(alert)

        elif server_type == 'pgbouncer':
            if server.get('error'):
                alerts.append(_make_alert(
                    key=f'pgbouncer:{server_key}', severity='critical', category='unreachable',
                    scope='pgbouncer', target=name, target_id='pgbouncer-panel',
                    label='PGBouncer connection',
                    message='The PGBouncer admin interface is unreachable',
                    title=f"{name} — PGBouncer unreachable",
                    detail=str(server['error'])[:300],
                ))
                continue

            thresholds = get_thresholds(environment, server_key)
            waiting_pools = [
                f"{p.get('database')}/{p.get('user')}"
                for p in server.get('pools') or []
                if _to_float(p.get('cl_waiting'), 0.0)
            ]
            candidates = [
                _threshold_alert(
                    f'pgb_waiting:{server_key}', 'pool', 'pgbouncer', name, 'pgbouncer-panel',
                    'Waiting client connections', server.get('total_cl_waiting'), thresholds,
                    'pgb_waiting_warning', 'pgb_waiting_critical', unit='',
                    detail='pools: ' + (', '.join(waiting_pools) if waiting_pools else '—'),
                ),
                _threshold_alert(
                    f'pgb_maxwait:{server_key}', 'pool', 'pgbouncer', name, 'pgbouncer-panel',
                    'Longest client wait', server.get('max_wait'), thresholds,
                    'pgb_maxwait_warning', 'pgb_maxwait_critical', unit='s',
                    detail=f"pool size {server.get('default_pool_size', '?')}",
                ),
            ]
            alerts.extend([a for a in candidates if a])

    return alerts


def process_alerts(environment, data):
    """Track alert lifecycles, send the notifications and return live alerts.

    An issue must hold for `alert_sustain_seconds` before it is raised, and a
    raised alert only disappears once it has been clear for
    `alert_clear_seconds`. This debouncing on both edges keeps a single noisy
    sample (a CPU spike between two polls) out of the alert list and out of
    the mailbox.
    """
    now = time.time()
    raw_alerts = {alert['key']: alert for alert in evaluate_alerts(environment, data)}
    sustain_seconds = max(_env_float(environment, 'alert_sustain_seconds', 5.0), 0.0)
    clear_seconds = max(_env_float(environment, 'alert_clear_seconds', 15.0), 0.0)
    delay_seconds = max(_get_alert_delay(environment), 0.0) * 60
    min_severity = SEVERITY_ORDER[_get_alert_min_severity(environment)]

    active = []
    for key, alert in raw_alerts.items():
        state = alert_state.get((environment, key))
        if state is None:
            state = {
                'first_seen': now, 'severity': alert['severity'],
                'notified': False, 'active': False, 'clear_since': None,
            }
            alert_state[(environment, key)] = state
        elif SEVERITY_ORDER[alert['severity']] > SEVERITY_ORDER[state['severity']]:
            # warning → critical: notify again even inside the repeat window
            state['escalated'] = True
        state['severity'] = alert['severity']
        state['snapshot'] = alert
        state['clear_since'] = None
        if not state['active'] and (now - state['first_seen']) >= sustain_seconds:
            state['active'] = True

        if state['active']:
            alert['since'] = state['first_seen']
            alert['duration'] = int(now - state['first_seen'])
            alert['clearing'] = False
            alert['notified'] = state['notified']
            # An escalation is mailed immediately, even inside the repeat window
            alert['escalated'] = state.get('escalated', False)
            active.append(alert)

    # Anything tracked but no longer reported is clearing, then resolved.
    resolved = []
    for (env, key), state in list(alert_state.items()):
        if env != environment or key in raw_alerts:
            continue
        if not state['active']:
            # Never held long enough to be raised: forget it.
            alert_state.pop((env, key), None)
            continue
        if state['clear_since'] is None:
            state['clear_since'] = now
        if (now - state['clear_since']) >= clear_seconds:
            if state.get('notified') and state.get('snapshot'):
                snapshot = dict(state['snapshot'])
                snapshot['duration'] = int(state['clear_since'] - state['first_seen'])
                resolved.append(snapshot)
            alert_state.pop((env, key), None)
        else:
            alert = dict(state['snapshot'])
            alert['since'] = state['first_seen']
            # Frozen at the moment the condition disappeared
            alert['duration'] = int(state['clear_since'] - state['first_seen'])
            alert['clearing'] = True
            alert['notified'] = state['notified']
            active.append(alert)

    notifiable = [
        alert for alert in active
        if not alert['clearing']
        and SEVERITY_ORDER[alert['severity']] >= min_severity
        and (now - alert['since']) >= delay_seconds
    ]
    for key in send_alert_mails(environment, notifiable):
        state = alert_state.get((environment, key))
        if state:
            state['notified'] = True
            state['escalated'] = False
    for alert in active:
        state = alert_state.get((environment, alert['key']))
        alert['notified'] = bool(state and state['notified'])
        alert.pop('escalated', None)

    if resolved and _resolved_emails_enabled(environment):
        send_alert_mails(environment, resolved, resolved=True)

    active.sort(key=lambda a: (
        a['clearing'], -SEVERITY_ORDER[a['severity']], -a['duration'], a['target'] or '',
    ))
    return active


def save_chart_data(chart_id, series_name, timestamp, value, environment):
    with closing(connect_db()) as db:
        try:
            db.execute(
                "INSERT OR IGNORE INTO chart_data (chart_id, series_name, timestamp, value, environment) "
                "VALUES (?, ?, ?, ?, ?)",
                (chart_id, series_name, timestamp, value, environment)
            )
            db.commit()
        except sqlite3.Error as e:
            print(f"Error saving chart data: {e}")


def get_chart_data(chart_id, series_name, max_points, environment):
    with closing(connect_db()) as db:
        cursor = db.execute(
            "SELECT timestamp, value FROM chart_data "
            "WHERE chart_id = ? AND series_name = ? AND environment = ? "
            "ORDER BY timestamp DESC LIMIT ?",
            (chart_id, series_name, environment, max_points))
        return cursor.fetchall()


def save_chart_config(chart_id, max_points, chart_type):
    with closing(connect_db()) as db:
        db.execute(
            "INSERT OR REPLACE INTO chart_config (chart_id, max_points, chart_type) "
            "VALUES (?, ?, ?)",
            (chart_id, max_points, chart_type))
        db.commit()


def get_chart_config(chart_id):
    with closing(connect_db()) as db:
        cursor = db.execute(
            "SELECT max_points, chart_type FROM chart_config WHERE chart_id = ?",
            (chart_id,))
        return cursor.fetchone()


def get_available_environments():
    return [e.strip() for e in config['environments']['available_env'].split(',') if e.strip()]


def get_environment_config(environment):
    if environment not in config:
        raise ValueError(f"Invalid environment: {environment}")
    return {
        'url': config[environment].get('url', ''),
        'external_url': config[environment].get('external_url', config[environment].get('url', '')),
        'url_name': config[environment].get('url_name', ''),
        'servers': [s.strip() for s in config[environment].get('servers', '').split(',') if s.strip()],
    }


def get_server_config(server_name):
    if server_name not in config:
        raise ValueError(f"Invalid server name: {server_name}")
    server_config = dict(config[server_name])
    if server_config.get('port'):
        server_config['port'] = int(server_config['port'])
    else:
        server_config.pop('port', None)
    return server_config


def get_widget_config(environment):
    env_config = get_environment_config(environment)
    general_config = config['general']
    data = {
        'current_env': environment,
        'refresh_rate': general_config.get('refresh_rate', '1'),
        'chart_history': general_config.get('chart_history', '5000'),
        'chart_info': {},
        'chart_adaptive_display': general_config.get('chart_adaptive_display', '0') == '0',
        'email_configured': _has_mail_config(),
        'thresholds': get_thresholds(environment),
        'alert_delay_minutes': _get_alert_delay(environment),
        'alert_email_min_severity': _get_alert_min_severity(environment),
        'emails_enabled': _is_send_emails_enabled(environment),
    }
    for server_name in env_config['servers']:
        server_config = get_server_config(server_name)
        if server_config.get('type') == 'linux':
            data['chart_info'][server_name] = {
                'name': server_name,
                'label': server_config['chart_label'],
                'color': server_config['chart_color'],
                'background_color': 'rgba(59, 130, 246, 0.1)',
            }
    return data


def get_postgres_stats(postgres_config, environment='default'):
    server_type = postgres_config['type']
    server_name = postgres_config['name']
    main_db = postgres_config['database']
    try:
        postgres_config.pop('type', None)
        postgres_config.pop('name', None)
        postgres_config['dbname'] = postgres_config.pop('database', None)
        postgres_config.setdefault('connect_timeout', 10)
        conn = psycopg.connect(**postgres_config)
        cursor = conn.cursor()
        cursor.execute("""
            SELECT
                datname,
                usename,
                state,
                query,
                wait_event_type,
                wait_event,
                GREATEST(EXTRACT(EPOCH FROM (NOW() - state_change)), 0) AS wait_time_seconds
            FROM pg_stat_activity
            WHERE state IN ('active', 'idle in transaction')
            ORDER BY wait_time_seconds DESC;
        """)
        active_queries = cursor.fetchall()

        active_queries = [
            (
                str(q[0]), str(q[1]), str(q[2]), str(q[3]),
                str(q[4]), str(q[5]) if q[6] else 'Running', float(q[6]) if q[6] is not None else 0.0
            )
            for q in active_queries
        ]

        active_queries_list = [query for query in active_queries if query[2] == 'active']
        idle_queries_list = [query for query in active_queries if query[2] == 'idle in transaction']

        total_wait_time_active = sum(query[6] for query in active_queries_list if query[6] is not None)
        avg_wait_time_active = total_wait_time_active / len(active_queries_list) if active_queries_list else 0.0

        total_wait_time_idle = sum(query[6] for query in idle_queries_list if query[6] is not None)
        avg_wait_time_idle = total_wait_time_idle / len(idle_queries_list) if idle_queries_list else 0.0

        cursor.execute("SELECT pg_database_size(%s);", (main_db,))
        db_size = cursor.fetchone()[0]

        cursor.execute("""
            SELECT datname FROM pg_database
            WHERE datistemplate = false AND datname != 'postgres'
            ORDER BY datname;
        """)
        all_databases = [db[0] for db in cursor.fetchall()]

        cursor.close()
        conn.close()

        return {
            'active_queries': active_queries,
            'db_size': float(db_size),
            'db_size_mb': f"{db_size / (1024 * 1024):.2f}",
            'db_size_gb': f"{db_size / (1024 * 1024 * 1024):.2f}",
            'avg_wait_time_active': float(avg_wait_time_active),
            'avg_wait_time_idle': float(avg_wait_time_idle),
            'all_databases': all_databases,
            'type': server_type,
            'main_db': main_db,
        }
    except Exception as e:
        return {'error': str(e), 'server': 'postgres', 'name': server_name, 'type': 'postgres'}


def get_server_stats(server_config, environment='default'):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            server_config['host'],
            port=server_config.get('port', 22),
            username=server_config['user'],
            password=server_config['password'],
            timeout=5,
        )

        stdin, stdout, stderr = ssh.exec_command("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'")
        cpu_usage = stdout.read().decode().strip()

        stdin, stdout, stderr = ssh.exec_command("free -m | grep Mem | awk '{print $2, $3, $7}'")
        ram_stats = stdout.read().decode().strip().split()
        ram_total = int(ram_stats[0])
        ram_used = int(ram_stats[1])
        ram_available = int(ram_stats[2])
        ram_usage_percent = round((ram_used / ram_total) * 100, 2)

        stdin, stdout, stderr = ssh.exec_command("df -B1 / | tail -1 | awk '{print $2, $3, $4}'")
        storage_stats = stdout.read().decode().strip().split()
        storage_size_bytes = int(storage_stats[0])
        storage_used_bytes = int(storage_stats[1])
        storage_available_bytes = int(storage_stats[2])
        storage_usage_percent = round((storage_used_bytes / storage_size_bytes) * 100, 2)
        storage_size = f"{round(storage_size_bytes / (1024**3), 1)}G"
        storage_used = (
            f"{round(storage_used_bytes / (1024**2), 1)}M"
            if storage_used_bytes < 1024**3
            else f"{round(storage_used_bytes / (1024**3), 1)}G"
        )
        storage_available = f"{round(storage_available_bytes / (1024**3), 1)}G"

        logs = ""
        if server_config.get('log_file'):
            stdin, stdout, stderr = ssh.exec_command(f"tail -n 500 {server_config.get('log_file')}")
            logs = stdout.read().decode().strip()

        http_requests = '0'
        if server_config.get('nginx_access_file'):
            cmd = (
                f"awk -v start=\"$(date -u -d '{REFRESH_RATE} seconds ago' '+%d/%b/%Y:%H:%M:%S')\" "
                f"-v end=\"$(date -u '+%d/%b/%Y:%H:%M:%S')\" "
                f"'{{ "
                f"gsub(/^\\[/, \"\", $4); "
                f"split($4, dt, /[/:]/); "
                f"ts = dt[1]\"/\"dt[2]\"/\"dt[3]\":\"dt[4]\":\"dt[5]\":\"dt[6]; "
                f"if (ts >= start && ts <= end) count++ "
                f"}} END {{ print count+0 }}' "
                f"{server_config['nginx_access_file']}"
            )
            stdin, stdout, stderr = ssh.exec_command(cmd)
            parts = stdout.read().decode().strip().split()
            http_requests = parts[0] if parts else '0'

        # Load average (1-minute) and CPU core count (to read it per core)
        stdin, stdout, stderr = ssh.exec_command("awk '{print $1}' /proc/loadavg")
        load_avg = stdout.read().decode().strip() or '0'

        stdin, stdout, stderr = ssh.exec_command("nproc 2>/dev/null || echo 1")
        cpu_cores = stdout.read().decode().strip() or '1'

        # Cumulative network bytes (all non-loopback interfaces)
        stdin, stdout, stderr = ssh.exec_command(
            "awk 'NR>2 && !/lo:/{gsub(/:/, \"\", $1); rx+=$2; tx+=$10} END{print rx+0, tx+0}' /proc/net/dev"
        )
        net_parts = stdout.read().decode().strip().split()
        net_rx_bytes = int(net_parts[0]) if net_parts else 0
        net_tx_bytes = int(net_parts[1]) if len(net_parts) > 1 else 0

        # Cumulative disk I/O bytes (main block devices, not partitions)
        stdin, stdout, stderr = ssh.exec_command(
            "awk '$3~/^(sd[a-z]|vd[a-z]|nvme[0-9]n[0-9]|xvd[a-z])$/{r+=$6;w+=$10} END{print r*512+0, w*512+0}' /proc/diskstats"
        )
        disk_parts = stdout.read().decode().strip().split()
        disk_read_bytes = int(disk_parts[0]) if disk_parts else 0
        disk_write_bytes = int(disk_parts[1]) if len(disk_parts) > 1 else 0

        # Mounted filesystems (excluding root and virtual filesystems)
        mounts = []
        if server_config.get('show_mounts', '1') != '0':
            stdin, stdout, stderr = ssh.exec_command(
                "df -B1 -x tmpfs -x devtmpfs -x squashfs 2>/dev/null | "
                "awk 'NR>1 && $6 != \"/\" {gsub(/%/, \"\", $5); "
                "printf \"%s\\t%s\\t%s\\t%s\\t%s\\n\", $2, $3, $4, $5, $6}'"
            )
            mount_output = stdout.read().decode().strip()

            def _fmt(b):
                if b >= 1024 ** 4: return f"{round(b / 1024 ** 4, 1)}T"
                if b >= 1024 ** 3: return f"{round(b / 1024 ** 3, 1)}G"
                if b >= 1024 ** 2: return f"{round(b / 1024 ** 2, 1)}M"
                return f"{b}B"

            for line in mount_output.split('\n'):
                if not line.strip():
                    continue
                parts = line.split('\t')
                if len(parts) < 5:
                    continue
                try:
                    size_b, used_b, avail_b = int(parts[0]), int(parts[1]), int(parts[2])
                    pct = round(float(parts[3]), 1)
                    mp = parts[4].strip()
                    mounts.append({
                        'mountpoint': mp,
                        'size': _fmt(size_b),
                        'used': _fmt(used_b),
                        'available': _fmt(avail_b),
                        'percent': pct,
                    })
                except (ValueError, IndexError):
                    continue

        ssh.close()

        return {
            'cpu_usage': cpu_usage,
            'ram_total': ram_total,
            'ram_used': ram_used,
            'ram_available': ram_available,
            'ram_usage_percent': ram_usage_percent,
            'storage_size': storage_size,
            'storage_used': storage_used,
            'storage_available': storage_available,
            'storage_usage_percent': storage_usage_percent,
            'mounts': mounts,
            'logs': html.escape(logs),
            'type': server_config['type'],
            'name': server_config['name'],
            'chart_label': server_config['chart_label'],
            'http_requests': http_requests,
            'load_avg': load_avg,
            'cpu_cores': cpu_cores,
            'net_rx_bytes': net_rx_bytes,
            'net_tx_bytes': net_tx_bytes,
            'disk_read_bytes': disk_read_bytes,
            'disk_write_bytes': disk_write_bytes,
        }
    except Exception as e:
        return {
            'error': str(e),
            'type': 'linux',
            'server': server_config['name'],
            'name': server_config['name'],
        }


def get_processes_stats(server_config):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            server_config['host'],
            port=server_config.get('port', 22),
            username=server_config['user'],
            password=server_config['password'],
            timeout=5,
        )

        cmd = "ps aux --sort=-%cpu | head -n 20 | awk '{print $1,$2,$3,$4,$11}'"
        stdin, stdout, stderr = ssh.exec_command(cmd)
        processes = stdout.read().decode().strip().split('\n')
        processes = processes[1:] if len(processes) > 1 else []

        ssh.close()

        processes_list = []
        for proc in processes:
            if proc.strip():
                parts = proc.split()
                if len(parts) >= 5:
                    processes_list.append({
                        'user': parts[0],
                        'pid': parts[1],
                        'cpu': float(parts[2]),
                        'ram': float(parts[3]),
                        'command': ' '.join(parts[4:])
                    })

        return {
            'processes': processes_list,
            'type': 'linux',
            'name': server_config['name']
        }
    except Exception as e:
        return {'error': str(e), 'server': server_config['name']}


def check_web_status(environment):
    env_config = get_environment_config(environment)
    web_url = env_config['url']
    try:
        response = requests.get(web_url, verify=False, timeout=5)
        response_time = response.elapsed.total_seconds() * 1000
        if response.status_code == 200:
            return {
                "status": "Online",
                "status_code": response.status_code,
                "response_time": f"{response_time:.2f} ms",
            }
        else:
            return {
                "status": f"Error: {response.status_code}",
                "status_code": response.status_code,
                "response_time": "N/A",
            }
    except requests.exceptions.RequestException as e:
        return {
            "status": "Offline",
            "status_code": 500,
            "response_time": "N/A",
            "error": str(e),
        }


def get_pgbouncer_stats(pgbouncer_config):
    pgb_name = pgbouncer_config.get('name', 'pgbouncer')
    try:
        conn = psycopg.connect(
            host=pgbouncer_config['host'],
            port=int(pgbouncer_config.get('port', 6432)),
            dbname=pgbouncer_config.get('database', 'pgbouncer'),
            user=pgbouncer_config['user'],
            password=pgbouncer_config.get('password', ''),
            connect_timeout=5,
            autocommit=True,
        )
        cursor = conn.cursor()

        cursor.execute("SHOW POOLS;")
        pool_cols = [desc[0] for desc in cursor.description]
        pools = [dict(zip(pool_cols, row)) for row in cursor.fetchall()]

        cursor.execute("SHOW STATS;")
        stats_cols = [desc[0] for desc in cursor.description]
        stats = [dict(zip(stats_cols, row)) for row in cursor.fetchall()]

        cursor.execute("SHOW CONFIG;")
        cfg_cols = [desc[0] for desc in cursor.description]
        pgb_cfg = {}
        for row in cursor.fetchall():
            r = dict(zip(cfg_cols, row))
            pgb_cfg[r.get('key', r.get(cfg_cols[0], ''))] = r.get('value', r.get(cfg_cols[1], ''))

        cursor.close()
        conn.close()

        total_cl_active = sum(int(p.get('cl_active', 0)) for p in pools)
        total_cl_waiting = sum(int(p.get('cl_waiting', 0)) for p in pools)
        total_sv_active = sum(int(p.get('sv_active', 0)) for p in pools)
        total_sv_idle = sum(int(p.get('sv_idle', 0)) for p in pools)
        max_wait = max((float(p.get('maxwait', 0)) for p in pools), default=0.0)

        db_stats = [s for s in stats if s.get('database') != 'pgbouncer']
        total_qps = sum(float(s.get('avg_query_count', 0)) for s in db_stats)
        avg_query_time = (sum(float(s.get('avg_query_time', 0)) for s in db_stats) / len(db_stats) / 1000) if db_stats else 0.0
        avg_wait_time = (sum(float(s.get('avg_wait_time', 0)) for s in db_stats) / len(db_stats) / 1000) if db_stats else 0.0

        return {
            'type': 'pgbouncer',
            'name': pgb_name,
            'pools': pools,
            'total_cl_active': total_cl_active,
            'total_cl_waiting': total_cl_waiting,
            'total_sv_active': total_sv_active,
            'total_sv_idle': total_sv_idle,
            'max_wait': max_wait,
            'total_qps': total_qps,
            'avg_query_time_ms': avg_query_time,
            'avg_wait_time_ms': avg_wait_time,
            'max_client_conn': pgb_cfg.get('max_client_conn', '?'),
            'default_pool_size': pgb_cfg.get('default_pool_size', '?'),
        }
    except Exception as e:
        return {'error': str(e), 'type': 'pgbouncer', 'name': pgb_name}


def collect_server_data(environment):
    if not os.path.exists(DATABASE):
        init_db()

    env_config = get_environment_config(environment)
    server_names = env_config['servers']

    show_postgres_panel = False
    show_http_requests_panel = False
    show_pgbouncer_panel = False
    for sn in server_names:
        sc = get_server_config(sn)
        if sc.get('type') == 'postgres':
            show_postgres_panel = True
        elif sc.get('type') == 'linux' and sc.get('nginx_access_file'):
            show_http_requests_panel = True
        elif sc.get('type') == 'pgbouncer':
            show_pgbouncer_panel = True

    prev_net_disk = {}  # {server_name: {rx, tx, dr, dw, ts}}
    reported_errors = {}  # {server_name: last logged error message}

    while True:
        try:
            stats = {}

            def collect_one(server_name):
                sc = get_server_config(server_name)
                server_type = sc.get('type')
                result = {}
                if server_type == 'postgres':
                    result[server_name] = get_postgres_stats(sc, environment)
                elif server_type == 'linux':
                    result[server_name] = get_server_stats(sc, environment)
                    result[f"{server_name}_processes"] = get_processes_stats(sc)
                elif server_type == 'pgbouncer':
                    result[server_name] = get_pgbouncer_stats(sc)
                thresholds = get_thresholds(environment, server_name)
                for key, payload in result.items():
                    if isinstance(payload, dict) and not key.endswith('_processes'):
                        payload['thresholds'] = thresholds
                return result

            with ThreadPoolExecutor(max_workers=max(len(server_names), 1)) as executor:
                futures = [executor.submit(collect_one, name) for name in server_names]
                for future in as_completed(futures, timeout=60):
                    try:
                        result = future.result()
                    except Exception as e:
                        print(f"[{environment}] Error collecting server: {e}")
                        continue
                    # Collectors report soft errors inside their payload:
                    # log every state change, but keep the payload so the
                    # dashboard can flag the server as unreachable.
                    for sn, payload in result.items():
                        error = payload.get('error') if isinstance(payload, dict) else None
                        if error:
                            if reported_errors.get(sn) != error:
                                print(f"[{environment}] {sn}: {error}")
                                reported_errors[sn] = error
                        elif reported_errors.pop(sn, None):
                            print(f"[{environment}] {sn}: recovered")
                    stats.update(result)

            # Compute network/disk rates from cumulative counters
            ts_now = time.time()
            for sn, sd in list(stats.items()):
                if sd.get('type') != 'linux' or sn.endswith('_processes') or sd.get('error'):
                    continue
                prev = prev_net_disk.get(sn)
                if prev and (ts_now - prev['ts']) > 0:
                    dt = ts_now - prev['ts']
                    sd['net_mbps'] = max(0.0, (sd['net_rx_bytes'] + sd['net_tx_bytes'] - prev['rx'] - prev['tx']) / dt / 1_000_000)
                    sd['disk_mbps'] = max(0.0, (sd['disk_read_bytes'] + sd['disk_write_bytes'] - prev['dr'] - prev['dw']) / dt / 1_000_000)
                else:
                    sd['net_mbps'] = 0.0
                    sd['disk_mbps'] = 0.0
                prev_net_disk[sn] = {
                    'rx': sd.get('net_rx_bytes', 0), 'tx': sd.get('net_tx_bytes', 0),
                    'dr': sd.get('disk_read_bytes', 0), 'dw': sd.get('disk_write_bytes', 0),
                    'ts': ts_now,
                }

            web_status = check_web_status(environment)

            data = {
                'stats': stats,
                'web_status': web_status,
                'web_url': env_config['url'],
                'external_url': env_config['external_url'],
                'web_url_name': env_config['url_name'],
                'timestamp': datetime.now().strftime('%H:%M:%S'),
                'environment': environment,
                'widget_config': get_widget_config(environment),
                'show_postgres_panel': show_postgres_panel,
                'show_http_requests_panel': show_http_requests_panel,
                'show_pgbouncer_panel': show_pgbouncer_panel,
            }

            alerts = process_alerts(environment, data)
            data['alerts'] = alerts
            data['alert_summary'] = {
                'critical': sum(1 for a in alerts if a['severity'] == 'critical'),
                'warning': sum(1 for a in alerts if a['severity'] == 'warning'),
            }

            server_data_cache[environment] = data

            timestamp = int(datetime.now().timestamp())
            for server_name, server_data in stats.items():
                if 'chart_label' in server_data and server_data.get('type') == 'linux':
                    chart_label = server_data['chart_label']
                    save_chart_data('CPUChart', chart_label, timestamp, float(server_data['cpu_usage']), environment)
                    save_chart_data('httpRequestsChart', chart_label, timestamp, float(server_data['http_requests']), environment)
                    save_chart_data('RAMChart', chart_label, timestamp, float(server_data['ram_usage_percent']), environment)
                    save_chart_data('LoadAvgChart', chart_label, timestamp, float(server_data.get('load_avg', 0)), environment)
                    save_chart_data('NetworkChart', chart_label, timestamp, float(server_data.get('net_mbps', 0)), environment)
                    save_chart_data('DiskIOChart', chart_label, timestamp, float(server_data.get('disk_mbps', 0)), environment)

            socketio.emit('server_data_update', data, room=environment)

        except Exception as e:
            print(f"[{environment}] Error in collect_server_data: {e}")

        time.sleep(REFRESH_RATE)


@app.route('/')
def index():
    raw_envs = config['environments'].get('available_env', '').strip()
    environments = [env.strip() for env in raw_envs.split(',') if env.strip()]
    return render_template(
        'main.html',
        display_name=config['general'].get('display_name'),
        environments=environments,
    )


@socketio.on('connect')
def handle_connect():
    sid = request.sid
    client_environments[sid] = DEFAULT_ENV
    join_room(DEFAULT_ENV)
    print(f'SocketIO: Client {sid} connected → room {DEFAULT_ENV}')
    if DEFAULT_ENV in server_data_cache:
        emit('server_data_update', server_data_cache[DEFAULT_ENV])


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    env = client_environments.pop(sid, None)
    print(f'SocketIO: Client {sid} disconnected (was in {env})')


@socketio.on('change_environment')
def handle_change_environment(data):
    sid = request.sid
    environment = data.get('environment')
    if environment not in get_available_environments():
        emit('environment_changed', {'status': 'error', 'message': 'Invalid environment'})
        return

    old_env = client_environments.get(sid, DEFAULT_ENV)
    if old_env != environment:
        leave_room(old_env)
        join_room(environment)
        client_environments[sid] = environment

    emit('environment_changed', {'status': 'success', 'environment': environment})
    if environment in server_data_cache:
        emit('server_data_update', server_data_cache[environment])


@socketio.on('get_historical_data')
def handle_get_historical_data(data):
    sid = request.sid
    chart_id = data.get('chart_id')
    series_name = data.get('series_name')
    max_points = data.get('max_points', 100)
    environment = client_environments.get(sid, DEFAULT_ENV)

    rows = get_chart_data(chart_id, series_name, max_points, environment)

    if not rows or not all(isinstance(row, (list, tuple)) and len(row) == 2 for row in rows):
        emit('historical_data_response', {
            'chart_id': chart_id,
            'series_name': series_name,
            'data': [],
            'environment': environment
        })
        return

    emit('historical_data_response', {
        'chart_id': chart_id,
        'series_name': series_name,
        'data': [{'time': row[0], 'value': row[1]} for row in rows],
        'environment': environment
    })


@socketio.on('save_chart_config')
def handle_save_chart_config(data):
    chart_id = data.get('chart_id')
    max_points = data.get('max_points')
    chart_type = data.get('chart_type')
    save_chart_config(chart_id, max_points, chart_type)


@app.route('/admin')
def admin_index():
    if not _is_admin_enabled():
        return 'Admin interface is disabled.', 403

    admin_password = config['general'].get('admin_password', '').strip()
    if not admin_password:
        return render_template('admin.html', state='setup', config=None, environments=[], error=None)

    if not _is_admin_authenticated():
        error = request.args.get('error')
        return render_template('admin.html', state='login', config=None, environments=[], error=error)

    envs = get_available_environments()
    cfg = {
        'general': dict(config['general']),
        'environments': {e: dict(config[e]) for e in envs if e in config},
        'servers': {},
        'thresholds': dict(config['thresholds']) if 'thresholds' in config else {},
    }
    for e in envs:
        if e not in config:
            continue
        for sname in [s.strip() for s in config[e].get('servers', '').split(',') if s.strip()]:
            if sname in config:
                cfg['servers'][sname] = dict(config[sname])

    return render_template(
        'admin.html', state='admin', config=cfg, environments=envs, error=None,
        default_thresholds=DEFAULT_THRESHOLDS,
    )


@app.route('/admin/login', methods=['POST'])
def admin_login():
    if not _is_admin_enabled():
        return 'Admin interface is disabled.', 403

    password = request.form.get('password', '')
    stored_hash = config['general'].get('admin_password', '').strip()

    if stored_hash and check_password_hash(stored_hash, password):
        session['admin_authenticated'] = True
        return redirect(url_for('admin_index'))

    return redirect(url_for('admin_index') + '?error=Incorrect+password')


@app.route('/admin/setup', methods=['POST'])
def admin_setup():
    if not _is_admin_enabled():
        return 'Admin interface is disabled.', 403

    if config['general'].get('admin_password', '').strip():
        return redirect(url_for('admin_index'))

    password = request.form.get('password', '').strip()
    confirm = request.form.get('confirm', '').strip()

    if not password or password != confirm:
        return render_template('admin.html', state='setup', config=None, environments=[], error='Passwords do not match.')

    if len(password) < 6:
        return render_template('admin.html', state='setup', config=None, environments=[], error='Password must be at least 6 characters.')

    config['general']['admin_password'] = generate_password_hash(password)
    with open('config.ini', 'w') as f:
        config.write(f)

    session['admin_authenticated'] = True
    return redirect(url_for('admin_index'))


@app.route('/admin/logout')
def admin_logout():
    session.pop('admin_authenticated', None)
    return redirect(url_for('admin_index'))


@app.route('/admin/save', methods=['POST'])
def admin_save():
    if not _is_admin_enabled():
        return jsonify({'success': False, 'message': 'Admin disabled'}), 403
    if not _is_admin_authenticated():
        return jsonify({'success': False, 'message': 'Not authenticated'}), 401

    try:
        data = request.get_json(force=True)

        # General settings
        general_fields = ['display_name', 'refresh_rate', 'chart_history', 'chart_adaptive_display', 'debug']
        for field in general_fields:
            if field in data.get('general', {}):
                config['general'][field] = str(data['general'][field])

        # Email settings (keep existing password if empty string sent)
        email_fields = ['email_notif_smtp_server', 'email_notif_smtp_port', 'email_notif_login', 'email_notif_recipients']
        for field in email_fields:
            if field in data.get('email', {}):
                config['general'][field] = str(data['email'][field])
        if data.get('email', {}).get('email_notif_password', '').strip():
            config['general']['email_notif_password'] = data['email']['email_notif_password']

        # Alert thresholds (an empty field falls back to the built-in default)
        thresholds = {
            field: str(value).strip()
            for field, value in data.get('thresholds', {}).items()
            if field in DEFAULT_THRESHOLDS
        }
        if any(thresholds.values()) and 'thresholds' not in config:
            config.add_section('thresholds')
        if 'thresholds' in config:
            for field, value in thresholds.items():
                if value:
                    config['thresholds'][field] = value
                else:
                    config.remove_option('thresholds', field)
            if not config.options('thresholds'):
                config.remove_section('thresholds')

        # Per-environment settings
        env_alert_fields = [
            'send_emails', 'alert_delay_minutes', 'alert_repeat_minutes',
            'alert_email_min_severity', 'alert_resolved_emails',
            'alert_sustain_seconds', 'alert_clear_seconds',
        ]
        for env, env_data in data.get('environments', {}).items():
            if env not in config:
                continue
            for field in env_alert_fields:
                if field in env_data:
                    config[env][field] = str(env_data[field])

        # Server settings (credentials only — type/name/host changes need restart)
        for sname, sdata in data.get('servers', {}).items():
            if sname not in config:
                continue
            for field in ['host', 'user', 'chart_label', 'chart_color', 'log_file', 'nginx_access_file', 'port', 'database', 'show_mounts']:
                if field in sdata:
                    config[sname][field] = str(sdata[field])
            if sdata.get('password', '').strip():
                config[sname]['password'] = sdata['password']

        # Admin settings
        if 'admin' in data:
            admin_data = data['admin']
            if 'admin_enabled' in admin_data:
                config['general']['admin_enabled'] = str(admin_data['admin_enabled'])
            if admin_data.get('new_password', '').strip():
                current = admin_data.get('current_password', '')
                stored = config['general'].get('admin_password', '')
                if not check_password_hash(stored, current):
                    return jsonify({'success': False, 'message': 'Incorrect current password'}), 400
                new_pw = admin_data['new_password'].strip()
                if len(new_pw) < 6:
                    return jsonify({'success': False, 'message': 'New password must be at least 6 characters'}), 400
                config['general']['admin_password'] = generate_password_hash(new_pw)

        with open('config.ini', 'w') as f:
            config.write(f)
        _reload_config()

        return jsonify({'success': True, 'message': 'Configuration saved successfully'})

    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


_collectors_lock = threading.Lock()
_collectors_started = False


def start_collectors():
    """Start one collection thread per environment. Safe to call twice."""
    global _collectors_started
    with _collectors_lock:
        if _collectors_started:
            return
        _collectors_started = True
    for env in get_available_environments():
        t = threading.Thread(target=collect_server_data, args=(env,), daemon=True)
        t.start()
        print(f"Started collection thread for environment: {env}")


# The __main__ block below never runs when the application is served by a WSGI
# server (gunicorn, uwsgi, …), so collection has to be started on import too.
# Set NEDARA_START_COLLECTORS=0 to import the module without collecting.
if os.environ.get('NEDARA_START_COLLECTORS', '1') != '0':
    start_collectors()


if __name__ == '__main__':
    start_collectors()

    socketio.run(
        app,
        debug=config['general']['debug'] == '1',
        host='0.0.0.0',
        port=config['general']['port'],
        allow_unsafe_werkzeug=True,
    )
