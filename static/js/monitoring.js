"use strict";

import Nedara from "../js/lib/nedarajs/nedara.min.js";

const TEMPLATES = "/static/html/templates.html";

const Monitoring = Nedara.createWidget({
    selector: "#monitoring",
    events: {
        'click #filter-active':          '_onFilterActiveClick',
        'click #filter-idle':            '_onFilterIdleClick',
        'click #filter-all':             '_onFilterAllClick',
        'change #environment-selector':  '_onEnvironmentSelectorChange',
        'change #database-selector':     '_onDatabaseSelectorChange',
        'click .open_logs':              '_onOpenLogsClick',
        'click .panel-expand-btn':       '_onPanelExpandClick',
        'click .chart-expand-btn':       '_onChartExpandClick',
        'change #server-selector':       '_onServerSelectorChange',
        'click #refresh-interface':      '_onRefreshInterfaceBtnClick',
        'click #theme-toggle':           '_onThemeToggleClick',
    },

    start: async function () {
        await Nedara.importTemplates(TEMPLATES);

        this.socket         = window.io();
        this.psqlFilter     = 'all';
        this.dbFilter       = 'all';
        this.serverFilter   = 'all';
        this.chartsInfoMap  = {};
        this.seriesData     = {};
        this.serverLogs     = {};
        this.openLogSource  = null;
        this.charts         = null;

        this._loadingTimeout = setTimeout(() => this._showDashboard(), 15000);

        const savedTheme = localStorage.getItem('nedara-theme') || 'auto';
        this.updateThemeButton(savedTheme);

        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
            if ((localStorage.getItem('nedara-theme') || 'auto') === 'auto') {
                this.applyTheme('auto');
            }
        });

        this.render();
        this.setupSocketListeners();
        this.autoReload();

        const self = this;
        this.socket.on('connect', function () {
            const savedEnv = localStorage.getItem('nedara-env');
            if (savedEnv) {
                self.socket.emit('change_environment', { environment: savedEnv });
            }
        });
    },

    // ——————————————————————————————————————————
    // SETUP
    // ——————————————————————————————————————————

    render: function () {
        this.$selector.find('#web-app-card').html(Nedara.renderTemplate('web-app-card'));
        this.$selector.find('#postgres-panel').html(Nedara.renderTemplate('postgres-panel'));
        this.$selector.find('#processes-panel').html(Nedara.renderTemplate('processes-panel'));
        this.$selector.find('#pgbouncer-panel').html(Nedara.renderTemplate('pgbouncer-panel'));
    },

    _showDashboard: function () {
        const loading = document.getElementById('loading-container');
        const dash    = document.getElementById('monitoring');
        if (loading) loading.style.display = 'none';
        if (dash)    dash.style.display = '';
    },

    setupSocketListeners: function () {
        const self = this;

        this.socket.on('server_data_update', function (data) {
            self.handleServerDataUpdate(data);
        });

        this.socket.on('historical_data_response', function (data) {
            if (!data.data || !data.data.length) return;

            const formatted = data.data
                .map(item => ({ time: Math.floor(item.time), value: parseFloat(item.value) }))
                .filter(item => Number.isInteger(item.time) && !isNaN(item.value))
                .sort((a, b) => a.time - b.time);

            const unique = self.ensureUniqueTimestamps(formatted);
            const seriesInfo = self.chartsInfoMap[data.chart_id]
                ?.find(i => i.label === data.series_name);
            if (seriesInfo) {
                self.seriesData[data.chart_id][data.series_name] = unique;
                seriesInfo.series.setData(unique);
                self[data.chart_id].timeScale().fitContent();
            }
        });

        this.socket.on('environment_changed', function (data) {
            if (data.status === 'success') {
                self.env = data.environment;
                document.getElementById('environment-selector').value = self.env;
                self.resetCharts();
                document.getElementById('linux-servers-row').innerHTML = '';
                const procTbody = document.querySelector('#processes-table tbody');
                if (procTbody) procTbody.innerHTML = '';
            } else {
                console.error('Environment switch failed:', data.message);
            }
        });

        this.socket.on('connect_error', err => console.error('Socket error:', err));
    },

    // ——————————————————————————————————————————
    // CHART MANAGEMENT
    // ——————————————————————————————————————————

    resetCharts: function () {
        if (!this.charts) return;
        this.charts.forEach(conf => {
            if (this[conf.id] && this[conf.id].remove) {
                this[conf.id].remove();
                this[conf.id] = null;
            }
            const el = document.getElementById(conf.id);
            if (el) el.innerHTML = '';
        });
        this.charts        = null;
        this.chartsInfoMap = {};
        this.seriesData    = {};
    },

    createLightweightChart: function (containerId) {
        const { createChart } = window.LightweightCharts;
        const el = document.getElementById(containerId);
        const t  = this.getChartTheme();

        const chart = createChart(el, {
            layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
            grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
            rightPriceScale: {
                borderColor: t.border, visible: true,
                scaleMargins: { top: 0.1, bottom: 0.1 },
            },
            timeScale: {
                borderColor: t.border, timeVisible: true, secondsVisible: true,
                fixLeftEdge: this.chartAdaptiveDisplay, fixRightEdge: true,
                lockVisibleTimeRangeOnResize: false,
            },
            crosshair: {
                vertLine: { color: t.crosshair, width: 1, style: 1 },
                horzLine: { color: t.crosshair, width: 1, style: 1, labelBackgroundColor: t.labelBg },
            },
            handleScale: { axisPressedMouseMove: { time: true, price: true }, mouseWheel: true, pinch: true },
            handleScroll: true,
        });

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'chart-pause-button';
        pauseBtn.textContent = '⏸ Pause';
        pauseBtn.title = 'Pause/Resume';
        chart.isPaused = false;

        const chartCard = el.parentElement?.parentElement;
        const chartHeader = chartCard?.querySelector('.chart-header');
        if (chartHeader) {
            chartHeader.querySelector('.chart-pause-button')?.remove();
            chartHeader.appendChild(pauseBtn);
        }

        pauseBtn.addEventListener('click', () => {
            chart.isPaused = !chart.isPaused;
            pauseBtn.textContent = chart.isPaused ? '⏭ Resume' : '⏸ Pause';
            if (!chart.isPaused) {
                const chartId = containerId.replace('Container', '');
                const conf = this.charts.find(c => c.id === chartId);
                _.each(this.chartsInfoMap[chartId], si => {
                    const d = this.ensureUniqueTimestamps(
                        (this.seriesData[chartId][si.label] || []).slice(-conf.maxPoints)
                    );
                    si.series.setData(d);
                });
                chart.timeScale().fitContent();
            }
        });

        return chart;
    },

    getChartTheme: function () {
        const dark = document.documentElement.classList.contains('dark');
        return {
            bg:        dark ? '#020617' : '#ffffff',
            text:      dark ? '#475569' : '#64748b',
            grid:      dark ? 'rgba(51,65,85,0.3)'    : 'rgba(226,232,240,0.65)',
            border:    dark ? 'rgba(51,65,85,0.55)'   : 'rgba(226,232,240,0.9)',
            crosshair: dark ? 'rgba(148,163,184,0.3)' : 'rgba(100,116,139,0.3)',
            labelBg:   dark ? '#1e293b' : '#f1f5f9',
        };
    },

    updateChartThemes: function () {
        if (!this.charts) return;
        const t = this.getChartTheme();
        _.each(this.charts, conf => {
            const chart = this[conf.id];
            if (chart && chart.applyOptions) {
                chart.applyOptions({
                    layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
                    grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
                    rightPriceScale: { borderColor: t.border },
                    timeScale: { borderColor: t.border },
                    crosshair: {
                        vertLine: { color: t.crosshair },
                        horzLine: { color: t.crosshair, labelBackgroundColor: t.labelBg },
                    },
                });
            }
        });
    },

    loadHistoricalData: function (chartId, seriesName, maxPoints) {
        this.socket.emit('get_historical_data', {
            chart_id: chartId, series_name: seriesName,
            max_points: maxPoints, environment: this.env,
        });
    },

    // ——————————————————————————————————————————
    // MAIN DATA HANDLER
    // ——————————————————————————————————————————

    handleServerDataUpdate: function (data) {
        clearTimeout(this._loadingTimeout);
        this.env = data.environment;
        const wc = data.widget_config;

        // Init charts on first update (or after env reset)
        if (!this.charts) {
            this.chartAdaptiveDisplay = wc.chart_adaptive_display;
            this.charts = [
                { id: 'CPUChart',          container: 'CPUChartContainer',          maxPoints: wc.chart_history },
                { id: 'httpRequestsChart', container: 'httpRequestsChartContainer', maxPoints: wc.chart_history },
                { id: 'RAMChart',          container: 'RAMChartContainer',          maxPoints: wc.chart_history },
                { id: 'LoadAvgChart',      container: 'LoadAvgChartContainer',      maxPoints: wc.chart_history },
                { id: 'NetworkChart',      container: 'NetworkChartContainer',      maxPoints: wc.chart_history },
                { id: 'DiskIOChart',       container: 'DiskIOChartContainer',       maxPoints: wc.chart_history },
            ];

            _.each(this.charts, chart => {
                this.chartsInfoMap[chart.id] = [];
                this.seriesData[chart.id]    = {};

                const outer = document.getElementById(chart.id);
                if (!outer) return;
                outer.innerHTML = '';

                const inner = document.createElement('div');
                inner.id = chart.container;
                inner.style.cssText = 'width:100%;height:100%';
                outer.appendChild(inner);
                this[chart.id] = this.createLightweightChart(chart.container);

                _.each(wc.chart_info, info => {
                    this.seriesData[chart.id][info.label] = [];
                    const series = this[chart.id].addSeries(window.LightweightCharts.AreaSeries, {
                        title: info.label, color: info.color,
                        lineColor: info.color, lineWidth: 1.5, lineStyle: 0,
                        priceLineVisible: false,
                        topColor: this.hexToRgba(info.color, 0.3),
                        bottomColor: 'rgba(0,0,0,0)',
                    });
                    this.chartsInfoMap[chart.id].push({
                        name: info.name, label: info.label, series, color: info.color,
                    });
                    this.loadHistoricalData(chart.id, info.label, chart.maxPoints);
                });
                this[chart.id].timeScale().fitContent();

                this.socket.emit('save_chart_config', {
                    chart_id: chart.id, max_points: chart.maxPoints, chart_type: 'area',
                });
            });
        }

        // Panel visibility
        const sectionDetails = document.getElementById('section-details');
        const httpPanel      = document.getElementById('chart-panel-http');
        const pgPanel        = document.getElementById('postgres-panel');
        const pgbPanel       = document.getElementById('pgbouncer-panel');

        if (httpPanel) httpPanel.style.display = data.show_http_requests_panel ? '' : 'none';

        if (pgbPanel) {
            pgbPanel.style.display = data.show_pgbouncer_panel ? '' : 'none';
            if (sectionDetails) sectionDetails.classList.toggle('has-pgbouncer', !!data.show_pgbouncer_panel);
        }

        // Mail notification indicator
        const mailEl = document.getElementById('mail-indicator');
        if (mailEl) mailEl.style.display = wc.email_configured ? '' : 'none';
        if (pgPanel && sectionDetails) {
            pgPanel.style.display = data.show_postgres_panel ? '' : 'none';
            sectionDetails.classList.toggle('no-postgres', !data.show_postgres_panel);
        }

        // Web app card
        const wsEl = document.getElementById('web-url-status');
        if (wsEl) {
            const ws = data.web_status;
            const isOnline = ws.status === 'Online';
            wsEl.className = `status-indicator ${isOnline ? 'status-healthy' : 'status-critical'}`;
            const stEl = document.getElementById('web-url-status-text');
            stEl.textContent = isOnline ? 'Online' : (ws.status_code ? `Error ${ws.status_code}` : 'Offline');
            stEl.style.color  = isOnline ? '#10b981' : '#ef4444';
            document.getElementById('web-url-response-time').textContent = isOnline ? ws.response_time : '—';

            const linkEl = document.getElementById('web-url-link-container');
            if (linkEl && data.web_url) {
                const label = data.web_url_name || data.web_url;
                linkEl.innerHTML = `<a href="${data.web_url}" target="_blank" class="web-url-link" title="${data.web_url}">🔗 ${label}</a>`;
            }
        }

        // Server cards + processes + charts data
        const $serversRow = $('#linux-servers-row');
        $serversRow.empty();
        const $procTbody = $('#processes-table tbody');
        $procTbody.empty();

        const allProcesses = [];
        const linuxServers = [];
        const allDatabases = new Set();
        const chartDataMap = {};

        _.each(data.stats, (server, key) => {
            if (server.error) {
                if (server.type === 'linux' && !key.endsWith('_processes')) {
                    $serversRow.append(Nedara.renderTemplate('linux-server-unreachable', {
                        id: key, name: server.name || key,
                    }));
                } else if (server.type === 'postgres') {
                    const pgStatus = document.getElementById('postgres-status');
                    if (pgStatus) pgStatus.className = 'status-indicator status-critical';
                    const qTbody = document.querySelector('#postgres-queries tbody');
                    if (qTbody) qTbody.innerHTML =
                        '<tr><td colspan="5" style="text-align:center;padding:1.25rem 0;color:#ef4444;font-size:0.8125rem;font-weight:500">PostgreSQL unreachable</td></tr>';
                } else if (server.type === 'pgbouncer') {
                    const pgbStatus = document.getElementById('pgbouncer-status');
                    if (pgbStatus) pgbStatus.className = 'status-indicator status-critical';
                    const pgbTbody = document.querySelector('#pgbouncer-pools tbody');
                    if (pgbTbody) pgbTbody.innerHTML =
                        '<tr><td colspan="8" style="text-align:center;padding:1.25rem 0;color:#ef4444;font-size:0.8125rem;font-weight:500">PGBouncer unreachable</td></tr>';
                }
                return;
            }

            if (server.type === 'linux') {
                if (key.endsWith('_processes') && server.processes) {
                    const srvName = server.name.replace('_processes', '');
                    linuxServers.push(srvName);
                    server.processes.forEach(p => allProcesses.push({ ...p, serverName: srvName }));
                } else {
                    // Live log diffing
                    if (server.logs !== undefined) {
                        const prev = this.serverLogs[server.name] || '';
                        this.serverLogs[server.name] = server.logs || '';
                        if (this.openLogSource === server.name) {
                            this._updateOpenLogModal(prev, server.logs || '');
                        }
                    }

                    $serversRow.append(Nedara.renderTemplate('linux-server', Object.assign({
                        id: key,
                        cpu_usage_class:     this.getStatusClass(server.cpu_usage),
                        ram_usage_class:     this.getStatusClass(server.ram_usage_percent),
                        storage_usage_class: this.getStatusClass(server.storage_usage_percent),
                        cpu_value_class:     this.getValueColorClass(server.cpu_usage),
                        ram_value_class:     this.getValueColorClass(server.ram_usage_percent),
                        storage_value_class: this.getValueColorClass(server.storage_usage_percent),
                        health_class: this.getHealthStatus({
                            cpu: server.cpu_usage,
                            ram: server.ram_usage_percent,
                            storage: server.storage_usage_percent,
                        }),
                    }, server)));

                    chartDataMap[server.chart_label] = {
                        cpu:  parseFloat(server.cpu_usage),
                        http: parseFloat(server.http_requests),
                        ram:  parseFloat(server.ram_usage_percent),
                        load: parseFloat(server.load_avg  || 0),
                        net:  parseFloat(server.net_mbps  || 0),
                        disk: parseFloat(server.disk_mbps || 0),
                    };
                }

            } else if (server.type === 'postgres') {
                document.getElementById('postgres-status').className = 'status-indicator status-healthy';
                document.getElementById('main-db').textContent        = server.main_db;
                document.getElementById('query-count').textContent    = server.active_queries.length;
                document.getElementById('postgres-db-size').textContent =
                    `${server.db_size_mb} MB | ${server.db_size_gb} GB`;
                const ata = parseFloat(server.avg_wait_time_active);
                const ati = parseFloat(server.avg_wait_time_idle);
                document.getElementById('avg-wait-time-active').textContent =
                    (!isNaN(ata) && ata >= 0) ? `${ata.toFixed(2)}s` : '0.00s';
                document.getElementById('avg-wait-time-idle').textContent =
                    (!isNaN(ati) && ati >= 0) ? `${ati.toFixed(2)}s` : '0.00s';

                _.each(server.all_databases, db => allDatabases.add(db));

                document.querySelector('#postgres-queries tbody').innerHTML =
                    server.active_queries.map(q => `
                        <tr data-state="${q[2]}" data-db="${q[0]}">
                            <td>db: ${q[0]}<br>user: ${q[1]}</td>
                            <td>${q[2]}</td>
                            <td>${q[5] || 'N/A'}</td>
                            <td>${q[6] >= 0 ? parseFloat(q[6]).toFixed(2) + 's' : '0.00s'}</td>
                            <td class="truncate" title="${q[3]}">${q[3]}</td>
                        </tr>`).join('');

            } else if (server.type === 'pgbouncer') {
                const upd = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
                document.getElementById('pgbouncer-status').className = 'status-indicator status-healthy';
                upd('pgb-cl-active',  server.total_cl_active);
                upd('pgb-cl-waiting', server.total_cl_waiting);
                upd('pgb-sv-active',  server.total_sv_active);
                upd('pgb-sv-idle',    server.total_sv_idle);
                upd('pgb-qps',        parseFloat(server.total_qps       || 0).toFixed(1));
                upd('pgb-avg-query',  `${parseFloat(server.avg_query_time_ms || 0).toFixed(2)} ms`);
                upd('pgb-max-wait',   `${parseFloat(server.max_wait          || 0).toFixed(2)} s`);
                upd('pgb-pool-size',  server.default_pool_size || '?');

                const pgbTbody = document.querySelector('#pgbouncer-pools tbody');
                if (pgbTbody && Array.isArray(server.pools)) {
                    pgbTbody.innerHTML = server.pools.map(p => {
                        const waiting = parseInt(p.cl_waiting || 0);
                        return `<tr>
                            <td class="truncate" title="${p.database || ''}">${p.database || '—'}</td>
                            <td>${p.user || '—'}</td>
                            <td>${p.cl_active  ?? 0}</td>
                            <td class="${waiting > 0 ? 'value-high' : ''}">${waiting}</td>
                            <td>${p.sv_active  ?? 0}</td>
                            <td>${p.sv_idle    ?? 0}</td>
                            <td>${parseFloat(p.maxwait || 0).toFixed(2)}s</td>
                            <td>${p.pool_mode  || '—'}</td>
                        </tr>`;
                    }).join('');
                }
            }
        });

        // Sorted processes
        allProcesses
            .sort((a, b) => b.cpu !== a.cpu ? b.cpu - a.cpu : b.ram - a.ram)
            .forEach(p => $procTbody.append(`
                <tr data-server="${p.serverName}">
                    <td>${p.serverName}</td>
                    <td>${p.user}</td>
                    <td>${p.pid}</td>
                    <td><span class="proc-badge ${this.getProcessStatusClass(p.cpu)}">${p.cpu.toFixed(1)}%</span></td>
                    <td><span class="proc-badge ${this.getProcessStatusClass(p.ram)}">${p.ram.toFixed(1)}%</span></td>
                    <td class="truncate" title="${p.command}">${p.command}</td>
                </tr>`));

        this.updateDatabaseSelector([...allDatabases].sort());
        this.updateServerSelector(linuxServers);

        // Push new data points to charts
        const now = Math.floor(Date.now() / 1000);
        _.each(this.charts, conf => {
            const chart = this[conf.id];
            if (!chart || chart.isPaused) return;

            _.each(this.chartsInfoMap[conf.id], si => {
                const type = conf.id === 'CPUChart'          ? 'cpu'
                           : conf.id === 'httpRequestsChart'  ? 'http'
                           : conf.id === 'RAMChart'           ? 'ram'
                           : conf.id === 'LoadAvgChart'       ? 'load'
                           : conf.id === 'NetworkChart'       ? 'net'
                           : conf.id === 'DiskIOChart'        ? 'disk'
                           : null;
                if (!type) return;
                const row = chartDataMap[si.label];
                if (!row) return;

                const sd = this.seriesData[conf.id][si.label];
                if (!sd) return;

                let ts = now;
                if (sd.length && ts <= sd[sd.length - 1].time) ts = sd[sd.length - 1].time + 1;
                sd.push({ time: ts, value: row[type] || 0 });

                const trimmed = this.ensureUniqueTimestamps(sd.slice(-conf.maxPoints));
                si.series.setData(trimmed);
            });

            chart.timeScale().fitContent();

            const inner = document.getElementById(conf.container);
            if (inner) chart.resize(inner.clientWidth, inner.clientHeight);
        });

        document.getElementById('last-update-time').textContent = this.formatTime(new Date());
        document.getElementById('environment-selector').value   = this.env;

        this.highlightCriticalQueries();
        this.applyFilters();
        this.applyProcessesFilters();
        this.updateOverallStatus();
        this._showDashboard();
    },

    // ——————————————————————————————————————————
    // LOG HANDLING
    // ——————————————————————————————————————————

    colorizeLogLine: function (line) {
        const rules = [
            [/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})/g, '<span class="log-date">$1</span>'],
            [/(INFO)/g,     '<span class="log-info">$1</span>'],
            [/(ERROR)/g,    '<span class="log-error">$1</span>'],
            [/(WARNING)/g,  '<span class="log-warning">$1</span>'],
            [/(DEBUG)/g,    '<span class="log-debug">$1</span>'],
            [/(IDs: \[.*?\])/g,         '<span class="log-id">$1</span>'],
            [/Starting job `(.*?)`/g,   'Starting job `<span class="log-job">$1</span>`'],
            [/Job `(.*?)` done/g,       'Job `<span class="log-job">$1</span>` done'],
        ];
        rules.forEach(([re, repl]) => { line = line.replace(re, repl); });
        return line;
    },

    colorizeLogs: function (raw) {
        if (!raw) return '';
        return raw.split('\n').map(l => `<div class="log-line">${this.colorizeLogLine(l)}</div>`).join('');
    },

    _updateOpenLogModal: function (prevRaw, newRaw) {
        const $lc = $('#modal-log-container');
        if (!$lc.length) return;

        const prevLines = prevRaw ? prevRaw.split('\n') : [];
        const newLines  = newRaw  ? newRaw.split('\n')  : [];

        if (newLines.length > prevLines.length) {
            const atBottom = ($lc[0].scrollHeight - $lc[0].scrollTop - $lc[0].clientHeight) < 60;
            newLines.slice(prevLines.length).forEach(line => {
                const $l = $(`<div class="log-line log-new">${this.colorizeLogLine(line)}</div>`);
                $lc.append($l);
                setTimeout(() => $l.removeClass('log-new'), 800);
            });
            if (atBottom) $lc.scrollTop($lc[0].scrollHeight);
        } else if (newLines.length < prevLines.length) {
            $lc.html(this.colorizeLogs(newRaw));
            $lc.scrollTop($lc[0].scrollHeight);
        }
    },

    // ——————————————————————————————————————————
    // UTILITIES
    // ——————————————————————————————————————————

    hexToRgba: function (hex, alpha) {
        hex = hex.replace('#', '');
        return `rgba(${parseInt(hex.slice(0,2),16)},${parseInt(hex.slice(2,4),16)},${parseInt(hex.slice(4,6),16)},${alpha})`;
    },

    getStatusClass:      function (v) { return v < 70 ? 'usage-low' : v < 90 ? 'usage-medium' : 'usage-high'; },
    getValueColorClass:  function (v) { return v < 70 ? 'value-low' : v < 90 ? 'value-medium' : 'value-high'; },
    getProcessStatusClass: function (v) { return v < 30 ? 'value-low' : v < 70 ? 'value-medium' : 'value-high'; },

    getHealthStatus: function (v) {
        return v.cpu > 90 || v.ram > 90 || v.storage > 90 ? 'status-critical'
             : v.cpu > 70 || v.ram > 70 || v.storage > 70 ? 'status-warning'
             : 'status-healthy';
    },

    formatTime: function (d) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    },

    ensureUniqueTimestamps: function (data) {
        if (!data || !data.length) return data;
        data.sort((a, b) => a.time - b.time);
        const out = []; let last = null;
        data.forEach(item => {
            let t = item.time;
            if (last !== null && t <= last) t = last + 1;
            out.push({ time: t, value: item.value });
            last = t;
        });
        return out;
    },

    updateOverallStatus: function () {
        const hasCrit = this.$container.find('.status-critical').not('#overall-status').length;
        const hasWarn = this.$container.find('.status-warning').not('#overall-status').length;
        const badge   = document.getElementById('status-badge');
        const dot     = document.getElementById('overall-status');
        const text    = document.getElementById('status-text');

        badge.className = hasCrit ? 'badge-critical' : hasWarn ? 'badge-warning' : '';
        dot.className   = `status-indicator ${hasCrit ? 'status-critical' : hasWarn ? 'status-warning' : 'status-healthy'}`;
        text.textContent = hasCrit ? 'Critical Issues' : hasWarn ? 'Warnings' : 'All Operational';
    },

    highlightCriticalQueries: function () {
        document.querySelectorAll('#postgres-queries tbody tr').forEach(row => {
            const state    = row.children[1]?.textContent || '';
            const duration = parseFloat(row.children[3]?.textContent);
            if (duration > 10)                    row.style.background = 'rgba(239,68,68,0.09)';
            else if (state === 'active')          row.style.background = 'rgba(16,185,129,0.07)';
            else if (state === 'idle in transaction') row.style.background = 'rgba(99,102,241,0.07)';
            else                                  row.style.background = '';
        });
    },

    updateDatabaseSelector: function (dbs) {
        const sel = document.getElementById('database-selector');
        if (!sel) return;
        const cur = sel.value;
        while (sel.options.length > 1) sel.remove(1);
        dbs.forEach(db => {
            const o = document.createElement('option');
            o.value = o.textContent = db;
            sel.appendChild(o);
        });
        sel.value = (dbs.includes(cur) || cur === 'all') ? cur : 'all';
        if (sel.value === 'all') this.dbFilter = 'all';
    },

    updateServerSelector: function (servers) {
        const sel = document.getElementById('server-selector');
        if (!sel) return;
        const cur = sel.value;
        while (sel.options.length > 1) sel.remove(1);
        servers.forEach(s => {
            const o = document.createElement('option');
            o.value = o.textContent = s;
            sel.appendChild(o);
        });
        sel.value = (servers.includes(cur) || cur === 'all') ? cur : 'all';
        if (sel.value === 'all') this.serverFilter = 'all';
    },

    applyFilters: function () {
        document.querySelectorAll('#postgres-queries tbody tr').forEach(row => {
            const stateOk = this.psqlFilter === 'all' || row.dataset.state === this.psqlFilter;
            const dbOk    = this.dbFilter === 'all'   || row.dataset.db    === this.dbFilter;
            row.style.display = stateOk && dbOk ? '' : 'none';
        });
    },

    applyProcessesFilters: function () {
        document.querySelectorAll('#processes-table tbody tr').forEach(row => {
            row.style.display =
                this.serverFilter === 'all' || row.dataset.server === this.serverFilter ? '' : 'none';
        });
    },

    autoReload: function () {
        setInterval(() => location.reload(), 24 * 60 * 60 * 1000);
    },

    // ——————————————————————————————————————————
    // THEME
    // ——————————————————————————————————————————

    applyTheme: function (theme) {
        const root = document.documentElement;
        if (theme === 'dark')       root.classList.add('dark');
        else if (theme === 'light') root.classList.remove('dark');
        else window.matchMedia('(prefers-color-scheme: dark)').matches
            ? root.classList.add('dark')
            : root.classList.remove('dark');
        this.updateChartThemes();
    },

    updateThemeButton: function (theme) {
        const map = {
            auto:  { icon: '⊙', label: 'Auto'  },
            light: { icon: '☀', label: 'Light' },
            dark:  { icon: '☾', label: 'Dark'  },
        };
        const { icon, label } = map[theme] || map.auto;
        const i = document.getElementById('theme-icon');
        const l = document.getElementById('theme-label');
        if (i) i.textContent = icon;
        if (l) l.textContent = label;
    },

    // ——————————————————————————————————————————
    // EVENT HANDLERS
    // ——————————————————————————————————————————

    _onFilterActiveClick: function () {
        this.psqlFilter = 'active';
        this._syncFilterButtons('#filter-active');
        this.applyFilters();
    },
    _onFilterIdleClick: function () {
        this.psqlFilter = 'idle in transaction';
        this._syncFilterButtons('#filter-idle');
        this.applyFilters();
    },
    _onFilterAllClick: function () {
        this.psqlFilter = 'all';
        this._syncFilterButtons('#filter-all');
        this.applyFilters();
    },
    _syncFilterButtons: function (activeSelector) {
        ['#filter-active', '#filter-idle', '#filter-all'].forEach(sel => {
            const el = document.querySelector(sel);
            if (el) el.classList.toggle('active', sel === activeSelector);
        });
    },

    _onDatabaseSelectorChange: function (ev) {
        this.dbFilter = ev.target.value;
        this.applyFilters();
    },

    _onEnvironmentSelectorChange: function (ev) {
        const env = ev.target.value;
        localStorage.setItem('nedara-env', env);
        this.socket.emit('change_environment', { environment: env });
    },

    _onServerSelectorChange: function (ev) {
        this.serverFilter = ev.target.value;
        this.applyProcessesFilters();
    },

    _onOpenLogsClick: function (ev) {
        ev.preventDefault();
        const source = $(ev.currentTarget).data('source');
        this.openLogSource = source;

        const $modal = $(Nedara.renderTemplate('modal-logs', { source }));
        $('body').append($modal);

        const $lc = $modal.find('#modal-log-container');
        $lc.html(this.colorizeLogs(this.serverLogs[source] || ''));
        $lc.scrollTop($lc[0].scrollHeight);

        const close = () => { $modal.remove(); this.openLogSource = null; };
        $modal.find('#close-modal').on('click', close);
        $modal.find('#modal-overlay').on('click', e => { if (e.target.id === 'modal-overlay') close(); });
    },

    _onPanelExpandClick: function (ev) {
        ev.stopPropagation();
        const $panel = $(ev.currentTarget).closest('.detail-panel');
        if (!$panel.length) return;

        const $expandBtn = $(ev.currentTarget);
        const $backdrop  = $('<div class="panel-fullscreen-backdrop"></div>');
        const $closeBtn  = $('<button class="panel-fullscreen-close" title="Close">&times;</button>');

        $expandBtn.hide();
        $('body').append($backdrop);
        $panel.addClass('panel-fullscreen');
        $panel.find('.panel-heading').first().append($closeBtn);

        const close = () => {
            $panel.removeClass('panel-fullscreen');
            $backdrop.remove();
            $closeBtn.remove();
            $expandBtn.show();
        };
        $backdrop.on('click', close);
        $closeBtn.on('click', (e) => { e.stopPropagation(); close(); });
    },

    _onChartExpandClick: function (ev) {
        ev.stopPropagation();
        const chartCard = $(ev.currentTarget).closest('.chart-card')[0];
        if (!chartCard) return;

        const chartInner = chartCard.querySelector('.chart-inner');
        const chartId    = chartInner?.id;
        const chart      = chartId ? this[chartId] : null;
        const $expandBtn = $(ev.currentTarget);

        const $backdrop = $('<div class="panel-fullscreen-backdrop"></div>');
        const $closeBtn = $('<button class="panel-fullscreen-close" title="Close">&times;</button>');

        $expandBtn.hide();
        $('body').append($backdrop);
        $(chartCard).addClass('chart-fullscreen');
        $(chartCard).find('.chart-header').first().append($closeBtn);

        if (chart) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const inner = document.getElementById(chartId);
                if (inner) chart.resize(inner.clientWidth, inner.clientHeight);
            }));
        }

        const close = () => {
            $(chartCard).removeClass('chart-fullscreen');
            $backdrop.remove();
            $closeBtn.remove();
            $expandBtn.show();
            if (chart) {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    const inner = document.getElementById(chartId);
                    if (inner) chart.resize(inner.clientWidth, inner.clientHeight);
                }));
            }
        };
        $backdrop.on('click', close);
        $closeBtn.on('click', (e) => { e.stopPropagation(); close(); });
    },

    _onRefreshInterfaceBtnClick: function () {
        window.location.reload();
    },

    _onThemeToggleClick: function () {
        const order   = ['auto', 'light', 'dark'];
        const current = localStorage.getItem('nedara-theme') || 'auto';
        const next    = order[(order.indexOf(current) + 1) % order.length];
        localStorage.setItem('nedara-theme', next);
        this.applyTheme(next);
        this.updateThemeButton(next);
    },
});

window.addEventListener('resize', function () {
    if (!Monitoring || !Monitoring.charts) return;
    _.each(Monitoring.charts, conf => {
        if (!Monitoring[conf.id]) return;
        const inner = document.getElementById(conf.container);
        if (inner) Monitoring[conf.id].resize(inner.clientWidth, inner.clientHeight);
    });
});

Nedara.registerWidget('Monitoring', Monitoring);
