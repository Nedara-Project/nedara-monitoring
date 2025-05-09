# -*- coding: utf-8 -*-

from flask import Flask, render_template, jsonify
import psycopg2
import paramiko
import requests
import configparser

app = Flask(__name__)

# Load configuration from external file
config = configparser.ConfigParser()
config.read('config.ini')

# Default environment
CURRENT_ENVIRONMENT = config['environments']['default_env']


def get_available_environments():
    """Retrieve the list of available environments."""
    return config['environments']['available_env'].split(', ')


def get_environment_config(environment):
    """Retrieve the configuration for a specific environment."""
    if environment not in config:
        raise ValueError(f"Invalid environment: {environment}")
    return {
        'url': config[environment]['url'],
        'servers': config[environment]['servers'].split(', ')
    }


def get_server_config(server_name):
    """Retrieve the configuration for a specific server."""
    if server_name not in config:
        raise ValueError(f"Invalid server name: {server_name}")
    server_config = dict(config[server_name])
    if 'port' in server_config:
        server_config['port'] = int(server_config['port'])
    return server_config


def get_widget_config():
    """Retrieve data for widget construction."""
    env_config = get_environment_config(CURRENT_ENVIRONMENT)
    general_config = config['general']
    data = {
        'current_env': CURRENT_ENVIRONMENT,
        'refresh_rate': general_config['refresh_rate'],
        'chart_history_short': general_config['chart_history_short'],
        'chart_history_long': general_config['chart_history_long'],
        'chart_info': {},
    }
    for server_name in env_config['servers']:
        server_config = get_server_config(server_name)
        if server_config.get('type') == 'linux':
            data['chart_info'][server_name] = {
                'name': server_name,
                'label': server_config['chart_label'],
                'borderColor': server_config['chart_color'],
                'backgroundColor': 'rgba(59, 130, 246, 0.1)',
                'borderWidth': 2,
                'tension': 0.3,
                'fill': True,
            }
    return jsonify(data)


def get_postgres_stats(postgres_config):
    """Retrieve PostgreSQL statistics for the given configuration."""
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

        # Separate active and idle queries
        active_queries_list = [query for query in active_queries if query[2] == 'active']
        idle_queries_list = [query for query in active_queries if query[2] == 'idle in transaction']

        # Calculate average wait time for active queries
        total_wait_time_active = sum(query[6] for query in active_queries_list if query[6] is not None)
        avg_wait_time_active = total_wait_time_active / len(active_queries_list) if active_queries_list else 0.0

        # Calculate average wait time for idle queries
        total_wait_time_idle = sum(query[6] for query in idle_queries_list if query[6] is not None)
        avg_wait_time_idle = total_wait_time_idle / len(idle_queries_list) if idle_queries_list else 0.0

        # Get database size - using the specific database from config
        cursor.execute("""
            SELECT pg_database_size(%s);
        """, (main_db,))
        db_size = cursor.fetchone()[0]

        # Get all available databases
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
            'db_size': db_size,
            'db_size_mb': f"{db_size / (1024 * 1024):.2f}",
            'db_size_gb': f"{db_size / (1024 * 1024 * 1024):.2f}",
            'avg_wait_time_active': float(avg_wait_time_active),
            'avg_wait_time_idle': float(avg_wait_time_idle),
            'all_databases': all_databases,
            'type': server_type,
            'main_db': main_db,
        }
    except Exception as e:
        return {'error': str(e)}


def get_server_stats(server_config):
    """Retrieve server statistics (CPU, RAM, storage, logs) for the given configuration."""
    try:
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(server_config['host'], username=server_config['user'], password=server_config['password'])

        # Get CPU usage -> Note: this does not work properly on ubuntu 18.04 and below (peak when executing cmd!)
        stdin, stdout, stderr = ssh.exec_command("top -bn1 | grep 'Cpu(s)' | sed 's/.*, *\\([0-9.]*\\)%* id.*/\\1/' | awk '{print 100 - $1}'")
        cpu_usage = stdout.read().decode().strip()

        # Get RAM statistics
        stdin, stdout, stderr = ssh.exec_command("free -m | grep Mem | awk '{print $2, $3, $7}'")
        ram_stats = stdout.read().decode().strip().split()
        ram_total = int(ram_stats[0])  # Total RAM in MB
        ram_used = int(ram_stats[1])   # Used RAM in MB
        ram_available = int(ram_stats[2])  # Available RAM in MB
        ram_usage_percent = round((ram_used / ram_total) * 100, 2)  # RAM usage in percentage

        # Get storage statistics
        stdin, stdout, stderr = ssh.exec_command("df -h / | grep -v Filesystem | awk '{print $2, $3, $4}'")
        storage_stats = stdout.read().decode().strip().split()
        storage_size = storage_stats[0]  # Total storage size
        storage_used = storage_stats[1]   # Used storage
        storage_available = storage_stats[2]  # Available storage
        storage_usage_percent = round((int(storage_used[:-1]) / int(storage_size[:-1])) * 100, 2)  # Storage usage in percentage

        # Get logs
        logs = ""
        if server_config.get('log_file'):
            stdin, stdout, stderr = ssh.exec_command(f"tail -n 100 {server_config.get('log_file')}")
            logs = stdout.read().decode().strip()

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
            'logs': logs,
            'type': server_config['type'],
            'name': server_config['name'],
            'chart_label': server_config['chart_label'],
        }
    except Exception as e:
        return {'error': str(e)}


@app.route('/')
def index():
    """Render the dashboard with statistics for the current environment."""
    env_config = get_environment_config(CURRENT_ENVIRONMENT)
    raw_envs = config['environments'].get('available_env', '').strip()
    environments = [env.strip() for env in raw_envs.split(',') if env.strip()]
    return render_template(
        'main.html',
        display_name=config['general'].get('display_name'),
        web_url=env_config.get('url'),
        environments=environments,
    )


@app.route('/api/stats')
def api_stats():
    """Return JSON data for the current environment's statistics."""
    env_config = get_environment_config(CURRENT_ENVIRONMENT)
    stats = {}
    for server_name in env_config['servers']:
        server_config = get_server_config(server_name)
        server_type = server_config.get('type')
        if server_type == 'postgres':
            stats[server_name] = get_postgres_stats(server_config)
        elif server_type == 'linux':
            stats[server_name] = get_server_stats(server_config)
    return jsonify(stats)


@app.route('/api/widget_data')
def api_widget_data():
    """Return JSON data for widget construction."""
    return get_widget_config()


@app.route('/set_environment/<environment>')
def set_environment(environment):
    """Switch between environments."""
    global CURRENT_ENVIRONMENT
    if environment in get_available_environments():
        CURRENT_ENVIRONMENT = environment
        return jsonify({
            'status': 'success',
            'environment': CURRENT_ENVIRONMENT,
            'url': get_environment_config(CURRENT_ENVIRONMENT)['url'],
        })
    else:
        return jsonify({'status': 'error', 'message': 'Invalid environment'}), 400


@app.route('/api/current_environment')
def current_environment():
    """Return the current environment."""
    return jsonify({
        'environment': CURRENT_ENVIRONMENT,
        'url': get_environment_config(CURRENT_ENVIRONMENT)['url'],
    })


@app.route('/check-web-status', methods=['GET'])
def check_web_status():
    web_url = get_environment_config(CURRENT_ENVIRONMENT)['url']
    try:
        response = requests.get(web_url, verify=False)
        response_time = response.elapsed.total_seconds() * 1000  # time in milliseconds for a complete connection
        if response.status_code == 200:
            return jsonify({
                "status": "Online",
                "status_code": response.status_code,
                "response_time": f"{response_time:.2f} ms",
            }), 200
        else:
            return jsonify({
                "status": f"Error: {response.status_code}",
                "status_code": response.status_code,
                "response_time": "N/A",
            }), 200
    except requests.exceptions.RequestException as e:
        return jsonify({
            "status": "Offline",
            "status_code": 500,
            "response_time": "N/A",
            "error": str(e),
        }), 500


if __name__ == '__main__':
    app.run(debug=True)
