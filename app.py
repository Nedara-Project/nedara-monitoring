# -*- coding: utf-8 -*-

import psycopg2
import paramiko
import requests
import configparser
import time
import threading
import json
import sqlite3
import os
import html

from flask import Flask, render_template
from flask_socketio import SocketIO, emit
from datetime import datetime
from decimal import Decimal
from contextlib import closing


class CustomJSONEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, Decimal):
            return float(obj)
        elif isinstance(obj, datetime):
            return obj.isoformat()
        return super().default(obj)


# Configuration
config = configparser.ConfigParser()
config.read('config.ini')
CURRENT_ENVIRONMENT = config['environments']['default_env']
REFRESH_RATE = int(config['general']['refresh_rate'])

app = Flask(__name__)
app.json_encoder = CustomJSONEncoder
app.config['SECRET_KEY'] = config['general']['secret_key']
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins="*")

# SQLite Configuration
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

server_data_cache = {}
last_update_time = None


def init_db():
    with closing(connect_db()) as db:
        db.executescript(SCHEMA)
        db.commit()


def connect_db():
    return sqlite3.connect(DATABASE)


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
    return config['environments']['available_env'].split(', ')


def get_environment_config(environment):
    if environment not in config:
        raise ValueError(f"Invalid environment: {environment}")
    return {
        'url': config[environment]['url'],
        'url_name': config[environment]['url_name'],
        'servers': config[environment]['servers'].split(', ')
    }


def get_server_config(server_name):
    if server_name not in config:
        raise ValueError(f"Invalid server name: {server_name}")
    server_config = dict(config[server_name])
    if 'port' in server_config:
        server_config['port'] = int(server_config['port'])
    return server_config


def get_widget_config():
    env_config = get_environment_config(CURRENT_ENVIRONMENT)
    general_config = config['general']
    data = {
        'current_env': CURRENT_ENVIRONMENT,
        'refresh_rate': general_config['refresh_rate'],
        'chart_history': general_config['chart_history'],
        'chart_info': {},
        'chart_adaptive_display': general_config.get('chart_adaptive_display', '0') == '0',
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
    main_db = postgres_config['database']
    try:
        postgres_config.pop('type', None)
        postgres_config.pop('name', None)
        conn = psycopg2.connect(**postgres_config)
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
        return {'error': str(e), 'server': 'postgres'}


def get_server_stats(server_config):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(server_config['host'], username=server_config['user'], password=server_config['password'])

        stdin, stdout, stderr = ssh.exec_command("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'")
        cpu_usage = stdout.read().decode().strip()

        stdin, stdout, stderr = ssh.exec_command("free -m | grep Mem | awk '{print $2, $3, $7}'")
        ram_stats = stdout.read().decode().strip().split()
        ram_total = int(ram_stats[0])
        ram_used = int(ram_stats[1])
        ram_available = int(ram_stats[2])
        ram_usage_percent = round((ram_used / ram_total) * 100, 2)

        stdin, stdout, stderr = ssh.exec_command("df -h / | grep -v Filesystem | awk '{print $2, $3, $4}'")
        storage_stats = stdout.read().decode().strip().split()
        storage_size = storage_stats[0]
        storage_used = storage_stats[1]
        storage_available = storage_stats[2]
        storage_usage_percent = round((int(storage_used[:-1]) / int(storage_size[:-1])) * 100, 2)

        logs = ""
        if server_config.get('log_file'):
            stdin, stdout, stderr = ssh.exec_command(f"tail -n 500 {server_config.get('log_file')}")
            logs = stdout.read().decode().strip()

        http_requests = '0'
        if server_config.get('nginx_access_file'):
            cmd = """grep -E "\\[$(date -u -d '%d seconds ago' +'%%d/%%b/%%Y:%%H:%%M:%%S')|\\[$(date -u +'%%d/%%b/%%Y:%%H:%%M:%%S')" %s | awk -v start="$(date -u -d '%d seconds ago' +'%%d/%%b/%%Y:%%H:%%M:%%S')" -v end="$(date -u +'%%d/%%b/%%Y:%%H:%%M:%%S')" 'BEGIN { count=0 } { gsub(/^\\[/, "", $4); split($4, dt, /[/:]/); ts = dt[1]"/"dt[2]"/"dt[3]":"dt[4]":"dt[5]":"dt[6]; if (ts >= start && ts <= end) count++ } END { print count }'""" % (REFRESH_RATE, server_config["nginx_access_file"], REFRESH_RATE)
            stdin, stdout, stderr = ssh.exec_command(cmd)
            http_requests = stdout.read().decode().strip().split()

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
            'http_requests': http_requests[0],
        }
    except Exception as e:
        return {'error': str(e), 'server': server_config['name']}


def get_processes_stats(server_config):
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(server_config['host'], username=server_config['user'], password=server_config['password'])

        # Command to get processes with CPU, RAM, user and name
        cmd = "ps aux --sort=-%cpu | head -n 20 | awk '{print $1,$2,$3,$4,$11}'"
        stdin, stdout, stderr = ssh.exec_command(cmd)
        processes = stdout.read().decode().strip().split('\n')

        # Skip header line
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


def check_web_status():
    web_url = get_environment_config(CURRENT_ENVIRONMENT)['url']
    try:
        response = requests.get(web_url, verify=False)
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


def collect_server_data():
    global server_data_cache, last_update_time

    if not os.path.exists(DATABASE):
        init_db()

    while True:
        try:
            env_config = get_environment_config(CURRENT_ENVIRONMENT)
            stats = {}
            show_postgres_panel = False
            show_http_requests_panel = False

            for server_name in env_config['servers']:
                server_config = get_server_config(server_name)
                server_type = server_config.get('type')
                if server_type == 'postgres':
                    show_postgres_panel = True
                    stats[server_name] = get_postgres_stats(server_config)
                elif server_type == 'linux':
                    show_http_requests_panel = server_config.get('nginx_access_file') is not None
                    stats[server_name] = get_server_stats(server_config)
                    stats[f"{server_name}_processes"] = get_processes_stats(server_config)

            web_status = check_web_status()

            data = {
                'stats': stats,
                'web_status': web_status,
                'timestamp': datetime.now().strftime('%H:%M:%S'),
                'environment': CURRENT_ENVIRONMENT,
                'widget_config': get_widget_config(),
                'show_postgres_panel': show_postgres_panel,
                'show_http_requests_panel': show_http_requests_panel,
            }

            server_data_cache = data
            last_update_time = datetime.now()

            timestamp = int(datetime.now().timestamp())
            for server_name, server_data in stats.items():
                if 'chart_label' in server_data and 'type' in server_data and server_data['type'] == 'linux':
                    chart_label = server_data['chart_label']
                    save_chart_data('CPUChart', chart_label, timestamp, float(server_data['cpu_usage']), CURRENT_ENVIRONMENT)
                    save_chart_data('httpRequestsChart', chart_label, timestamp, float(server_data['http_requests']), CURRENT_ENVIRONMENT)
                    save_chart_data('RAMChart', chart_label, timestamp, float(server_data['ram_usage_percent']), CURRENT_ENVIRONMENT)

            socketio.emit('server_data_update', data)

        except Exception as e:
            print(f"Error collecting server data: {str(e)}")

        time.sleep(REFRESH_RATE)


@app.route('/')
def index():
    env_config = get_environment_config(CURRENT_ENVIRONMENT)
    raw_envs = config['environments'].get('available_env', '').strip()
    environments = [env.strip() for env in raw_envs.split(',') if env.strip()]
    return render_template(
        'main.html',
        display_name=config['general'].get('display_name'),
        web_url=env_config.get('url'),
        web_url_name=env_config.get('url_name'),
        info_url=config['general'].get('url_info'),
        info_url_name=config['general'].get('url_info_name'),
        environments=environments,
    )


@socketio.on('connect')
def handle_connect():
    print('SocketIO: Client connected')
    if server_data_cache:
        emit('server_data_update', server_data_cache)


@socketio.on('change_environment')
def handle_change_environment(data):
    global CURRENT_ENVIRONMENT
    environment = data.get('environment')
    if environment in get_available_environments():
        CURRENT_ENVIRONMENT = environment
        emit('environment_changed', {
            'status': 'success',
            'environment': CURRENT_ENVIRONMENT,
            'url': get_environment_config(CURRENT_ENVIRONMENT)['url'],
        }, broadcast=True)
    else:
        emit('environment_changed', {
            'status': 'error',
            'message': 'Invalid environment'
        })


@socketio.on('get_historical_data')
def handle_get_historical_data(data):
    chart_id = data.get('chart_id')
    series_name = data.get('series_name')
    max_points = data.get('max_points', 100)
    environment = data.get('environment', CURRENT_ENVIRONMENT)

    data = get_chart_data(chart_id, series_name, max_points, environment)

    if not data or not all(isinstance(row, (list, tuple)) and len(row) == 2 for row in data):
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
        'data': [{'time': row[0], 'value': row[1]} for row in data],
        'environment': environment
    })


@socketio.on('save_chart_config')
def handle_save_chart_config(data):
    chart_id = data.get('chart_id')
    max_points = data.get('max_points')
    chart_type = data.get('chart_type')
    save_chart_config(chart_id, max_points, chart_type)


if __name__ == '__main__':
    data_thread = threading.Thread(target=collect_server_data, daemon=True)
    data_thread.start()
    socketio.run(app, debug=config['general']['debug'] == '1', host='0.0.0.0')
