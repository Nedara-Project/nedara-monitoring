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

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit, join_room, leave_room
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
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

app = Flask(__name__)
app.json_encoder = CustomJSONEncoder
app.config['SECRET_KEY'] = config['general']['secret_key']
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins="*")

DATABASE = 'nedara_monitoring.db'
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
error_mail_sent_datetime = None
TMP_DIR = os.path.join(os.path.dirname(__file__), "tmp")
os.makedirs(TMP_DIR, exist_ok=True)
LOCK_FILE = TMP_DIR + "/error_mail.lock"
STATE_FILE = TMP_DIR + "/error_mail_state"


def init_db():
    with closing(connect_db()) as db:
        db.executescript(SCHEMA)
        db.commit()


def connect_db():
    return sqlite3.connect(DATABASE)


def send_notification_mail(data):
    global error_mail_sent_datetime
    general_config = config['general']

    try:
        with open(LOCK_FILE, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)

            last_sent = None
            if os.path.exists(STATE_FILE):
                with open(STATE_FILE, "r") as f:
                    ts = f.read().strip()
                    if ts:
                        last_sent = datetime.fromisoformat(ts)

            can_send = not last_sent or (datetime.now() - last_sent > timedelta(minutes=15))
            has_mail_config = (
                general_config.get('email_notif_smtp_server') and
                general_config.get('email_notif_smtp_port') and
                general_config.get('email_notif_login') and
                general_config.get('email_notif_password') and
                general_config.get('email_notif_recipients')
            )

            if not can_send or not has_mail_config:
                return False

            recipients = [email.strip() for email in general_config['email_notif_recipients'].split(',')]

            msg = MIMEMultipart('alternative')
            msg['From'] = general_config['email_notif_login']
            msg['To'] = ', '.join(recipients)
            msg['Subject'] = data.get('subject')
            msg.attach(MIMEText(data.get('body', ''), 'html', 'utf-8'))

            with smtplib.SMTP(
                host=general_config['email_notif_smtp_server'],
                port=int(general_config['email_notif_smtp_port']),
            ) as server:
                server.starttls()
                server.login(general_config['email_notif_login'], general_config['email_notif_password'])
                server.sendmail(msg['From'], recipients, msg.as_string())

            print(f"✅ Notification email sent: {data.get('subject')} -> {recipients}")

            error_mail_sent_datetime = datetime.now()
            with open(STATE_FILE, "w") as f:
                f.write(error_mail_sent_datetime.isoformat())

            return True

    except Exception as e:
        print(f"❌ Error sending notification email: {e}")
        return False


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
        'url':      config[environment].get('url', ''),
        'url_name': config[environment].get('url_name', ''),
        'servers':  [s.strip() for s in config[environment].get('servers', '').split(',') if s.strip()],
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
        'refresh_rate': general_config['refresh_rate'],
        'chart_history': general_config['chart_history'],
        'chart_info': {},
        'chart_adaptive_display': general_config.get('chart_adaptive_display', '0') == '0',
        'email_configured': bool(
            config['general'].get('email_notif_smtp_server') and
            config['general'].get('email_notif_smtp_port') and
            config['general'].get('email_notif_login') and
            config['general'].get('email_notif_password') and
            config['general'].get('email_notif_recipients')
        ),
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


def get_postgres_stats(postgres_config):
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
        send_notification_mail({
            'subject': '⚠️ Nedara Monitoring — Error ⚠️',
            'body': f"""
                <b>Connection could not be established with PostgreSQL!</b>
                <p>Server concerned: {server_name}</p>
            """,
        })
        return {'error': str(e), 'server': 'postgres', 'type': 'postgres'}


def get_server_stats(server_config):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            server_config['host'],
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

        # Load average (1-minute)
        stdin, stdout, stderr = ssh.exec_command("awk '{print $1}' /proc/loadavg")
        load_avg = stdout.read().decode().strip() or '0'

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
        disk_read_bytes  = int(disk_parts[0]) if disk_parts else 0
        disk_write_bytes = int(disk_parts[1]) if len(disk_parts) > 1 else 0

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
            'logs': html.escape(logs),
            'type': server_config['type'],
            'name': server_config['name'],
            'chart_label': server_config['chart_label'],
            'http_requests': http_requests,
            'load_avg': load_avg,
            'net_rx_bytes': net_rx_bytes,
            'net_tx_bytes': net_tx_bytes,
            'disk_read_bytes': disk_read_bytes,
            'disk_write_bytes': disk_write_bytes,
        }
    except Exception as e:
        send_notification_mail({
            'subject': '⚠️ Nedara Monitoring — Error ⚠️',
            'body': f"""
                <b>SSH connection could not be established!</b>
                <p>Server concerned: {server_config['name']}</p>
            """,
        })
        return {'error': str(e), 'type': 'linux', 'server': server_config['name']}


def get_processes_stats(server_config):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(
            server_config['host'],
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
            send_notification_mail({
                'subject': '⚠️ Nedara Monitoring — Error ⚠️',
                'body': f"""
                    <b>An error occurred with the Web Application!</b>
                    <p>Web URL: {web_url}</p>
                """,
            })
            return {
                "status": f"Error: {response.status_code}",
                "status_code": response.status_code,
                "response_time": "N/A",
            }
    except requests.exceptions.RequestException as e:
        send_notification_mail({
            'subject': '⚠️ Nedara Monitoring — Error ⚠️',
            'body': f"""
                <b>Web Application seems offline!</b>
                <p>Web URL: {web_url}</p>
            """,
        })
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

        total_cl_active  = sum(int(p.get('cl_active',  0)) for p in pools)
        total_cl_waiting = sum(int(p.get('cl_waiting', 0)) for p in pools)
        total_sv_active  = sum(int(p.get('sv_active',  0)) for p in pools)
        total_sv_idle    = sum(int(p.get('sv_idle',    0)) for p in pools)
        max_wait         = max((float(p.get('maxwait', 0)) for p in pools), default=0.0)

        db_stats = [s for s in stats if s.get('database') != 'pgbouncer']
        total_qps      = sum(float(s.get('avg_query_count', 0)) for s in db_stats)
        avg_query_time = (sum(float(s.get('avg_query_time', 0)) for s in db_stats) / len(db_stats) / 1000) if db_stats else 0.0
        avg_wait_time  = (sum(float(s.get('avg_wait_time',  0)) for s in db_stats) / len(db_stats) / 1000) if db_stats else 0.0

        return {
            'type': 'pgbouncer',
            'name': pgb_name,
            'pools': pools,
            'total_cl_active':  total_cl_active,
            'total_cl_waiting': total_cl_waiting,
            'total_sv_active':  total_sv_active,
            'total_sv_idle':    total_sv_idle,
            'max_wait':         max_wait,
            'total_qps':        total_qps,
            'avg_query_time_ms': avg_query_time,
            'avg_wait_time_ms':  avg_wait_time,
            'max_client_conn':   pgb_cfg.get('max_client_conn', '?'),
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

    while True:
        try:
            stats = {}

            def collect_one(server_name):
                sc = get_server_config(server_name)
                server_type = sc.get('type')
                result = {}
                if server_type == 'postgres':
                    result[server_name] = get_postgres_stats(sc)
                elif server_type == 'linux':
                    result[server_name] = get_server_stats(sc)
                    result[f"{server_name}_processes"] = get_processes_stats(sc)
                elif server_type == 'pgbouncer':
                    result[server_name] = get_pgbouncer_stats(sc)
                return result

            with ThreadPoolExecutor(max_workers=max(len(server_names), 1)) as executor:
                futures = [executor.submit(collect_one, name) for name in server_names]
                for future in as_completed(futures, timeout=60):
                    try:
                        stats.update(future.result())
                    except Exception as e:
                        print(f"[{environment}] Error collecting server: {e}")

            # Compute network/disk rates from cumulative counters
            ts_now = time.time()
            for sn, sd in list(stats.items()):
                if sd.get('type') != 'linux' or sn.endswith('_processes') or sd.get('error'):
                    continue
                prev = prev_net_disk.get(sn)
                if prev and (ts_now - prev['ts']) > 0:
                    dt = ts_now - prev['ts']
                    sd['net_mbps']  = max(0.0, (sd['net_rx_bytes'] + sd['net_tx_bytes'] - prev['rx'] - prev['tx']) / dt / 1_000_000)
                    sd['disk_mbps'] = max(0.0, (sd['disk_read_bytes'] + sd['disk_write_bytes'] - prev['dr'] - prev['dw']) / dt / 1_000_000)
                else:
                    sd['net_mbps']  = 0.0
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
                'web_url_name': env_config['url_name'],
                'timestamp': datetime.now().strftime('%H:%M:%S'),
                'environment': environment,
                'widget_config': get_widget_config(environment),
                'show_postgres_panel': show_postgres_panel,
                'show_http_requests_panel': show_http_requests_panel,
                'show_pgbouncer_panel': show_pgbouncer_panel,
            }

            server_data_cache[environment] = data

            timestamp = int(datetime.now().timestamp())
            for server_name, server_data in stats.items():
                if 'chart_label' in server_data and server_data.get('type') == 'linux':
                    chart_label = server_data['chart_label']
                    save_chart_data('CPUChart',          chart_label, timestamp, float(server_data['cpu_usage']),        environment)
                    save_chart_data('httpRequestsChart', chart_label, timestamp, float(server_data['http_requests']),    environment)
                    save_chart_data('RAMChart',          chart_label, timestamp, float(server_data['ram_usage_percent']), environment)
                    save_chart_data('LoadAvgChart',      chart_label, timestamp, float(server_data.get('load_avg', 0)),  environment)
                    save_chart_data('NetworkChart',      chart_label, timestamp, float(server_data.get('net_mbps', 0)),  environment)
                    save_chart_data('DiskIOChart',       chart_label, timestamp, float(server_data.get('disk_mbps', 0)), environment)

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


if __name__ == '__main__':
    for env in get_available_environments():
        t = threading.Thread(target=collect_server_data, args=(env,), daemon=True)
        t.start()
        print(f"Started collection thread for environment: {env}")

    socketio.run(
        app,
        debug=config['general']['debug'] == '1',
        host='0.0.0.0',
        port=config['general']['port'],
        allow_unsafe_werkzeug=True,
    )
