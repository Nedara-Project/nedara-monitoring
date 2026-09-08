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
        'click #alerts-toggle':          '_onAlertsToggleClick',
        'change #alerts-severity-filter': '_onAlertsSeverityFilterChange',
        'click .alert-item':             '_onAlertItemClick',
        'keydown .alert-item':           '_onAlertItemKeydown',
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
        this.alerts         = [];
        this.alertsSeverityFilter = localStorage.getItem('nedara-alerts-severity') || 'all';
        this.alertsCollapsed = localStorage.getItem('nedara-alerts-collapsed') === '1';

        this._loadingTimeout = setTimeout(() => this._showDashboard(), 15000);

        window.updateThemeButton(localStorage.getItem('nedara-theme') || 'auto');
        this._restoreAlertsPanelState();

        new MutationObserver(() => this.updateChartThemes())
            .observe(document.documentElement, { attributeFilter: ['class'] });

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
            if (!data.data || !data.data.length) {
                // Retry after a short delay if we have very few live points (DB may have been empty at connect time)
                const conf = self.charts?.find(c => c.id === data.chart_id);
                if (conf) {
                    const live = self.seriesData[data.chart_id]?.[data.series_name] || [];
                    if (live.length < 5) {
                        setTimeout(() => {
                            if (self.chartsInfoMap[data.chart_id]?.find(i => i.label === data.series_name)) {
                                self.loadHistoricalData(data.chart_id, data.series_name, conf.maxPoints);
                            }
                        }, 3000);
                    }
                }
                return;
            }

            const formatted = data.data
                .map(item => ({ time: Math.floor(item.time), value: parseFloat(item.value) }))
                .filter(item => Number.isInteger(item.time) && !isNaN(item.value))
                .sort((a, b) => a.time - b.time);

            const unique = self.ensureUniqueTimestamps(formatted);
            const seriesInfo = self.chartsInfoMap[data.chart_id]
                ?.find(i => i.label === data.series_name);
            if (seriesInfo) {
                // Preserve live points collected while waiting for history to arrive
                const existing = self.seriesData[data.chart_id][data.series_name] || [];
                const lastHistTime = unique.length ? unique[unique.length - 1].time : 0;
                const liveAfter = existing.filter(p => p.time > lastHistTime);
                const merged = self.ensureUniqueTimestamps([...unique, ...liveAfter]);
                self.seriesData[data.chart_id][data.series_name] = merged;
                seriesInfo.series.setData(merged);
                self[data.chart_id].timeScale().fitContent();
            }
        });

        this.socket.on('environment_changed', function (data) {
            if (data.status === 'success') {
                self.env = data.environment;
                document.getElementById('environment-selector').value = self.env;
                self.resetCharts();
                self.alerts = [];
                self.renderAlerts({ alerts: [], alert_summary: { critical: 0, warning: 0 } });
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
            chartHeader.insertBefore(pauseBtn, chartHeader.querySelector('.chart-expand-btn'));
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

        // Alerts drive the card accents, the top bar badge and the alert panel
        this.alerts = data.alerts || [];
        const alertsByTarget = {};
        _.each(this.alerts, alert => {
            (alertsByTarget[alert.target_id] = alertsByTarget[alert.target_id] || []).push(alert);
        });
        this.envThresholds = (wc && wc.thresholds) || {};

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
            const webAlerts = alertsByTarget['web-app-card'] || [];
            const webSeverity = this.worstSeverity(webAlerts);
            wsEl.className = `status-indicator ${isOnline ? (webSeverity === 'none' ? 'status-healthy' : 'status-' + webSeverity) : 'status-critical'}`;
            const stEl = document.getElementById('web-url-status-text');
            stEl.textContent = isOnline ? 'Online' : (ws.status_code ? `Error ${ws.status_code}` : 'Offline');
            stEl.className = `metric-value-text ${isOnline ? 'value-low' : 'value-high'}`;

            const rtEl = document.getElementById('web-url-response-time');
            const rtMs = isOnline ? parseFloat(ws.response_time) : null;
            rtEl.textContent = isOnline ? ws.response_time : '—';
            rtEl.className = 'metric-value-text' + (rtMs === null ? '' : ' ' + this.getValueColorClass(
                rtMs, this.envThresholds.response_time_warning, this.envThresholds.response_time_critical,
            ));

            const webCard = document.getElementById('web-app-dash-card');
            if (webCard) webCard.dataset.severity = isOnline ? webSeverity : 'critical';
            this._updateAlertChip(document.getElementById('web-alert-chip'), webAlerts);

            const linkEl = document.getElementById('web-url-link-container');
            if (linkEl && data.web_url) {
                const link = document.createElement('a');
                link.className = 'web-url-link';
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.href = data.external_url || data.web_url;
                link.title = data.web_url;
                link.textContent = `🔗 ${data.web_url_name || data.web_url}`;
                linkEl.replaceChildren(link);
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
                        id: key,
                        name: this.sanitize(server.name || key),
                        error_detail: this.sanitize(String(server.error).slice(0, 160)),
                    }));
                } else if (server.type === 'postgres') {
                    const pgStatus = document.getElementById('postgres-status');
                    if (pgStatus) pgStatus.className = 'status-indicator status-critical';
                    const qTbody = document.querySelector('#postgres-queries tbody');
                    if (qTbody) qTbody.innerHTML =
                        '<tr class="table-empty table-error"><td colspan="5">PostgreSQL unreachable</td></tr>';
                } else if (server.type === 'pgbouncer') {
                    const pgbStatus = document.getElementById('pgbouncer-status');
                    if (pgbStatus) pgbStatus.className = 'status-indicator status-critical';
                    const pgbTbody = document.querySelector('#pgbouncer-pools tbody');
                    if (pgbTbody) pgbTbody.innerHTML =
                        '<tr class="table-empty table-error"><td colspan="8">PGBouncer unreachable</td></tr>';
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

                    const thr = server.thresholds || {};
                    const serverAlerts = alertsByTarget[key] || [];
                    const severity = this.worstSeverity(serverAlerts);

                    const mounts = (server.mounts || []).map(m => {
                        const mountAlert = serverAlerts.find(
                            a => a.key === `mount:${key}:${m.mountpoint}`,
                        );
                        return Object.assign({}, m, {
                            percent_usage_class: this.getStatusClass(m.percent, thr.mount_warning, thr.mount_critical),
                            percent_value_class: this.getValueColorClass(m.percent, thr.mount_warning, thr.mount_critical),
                            row_class: mountAlert ? `is-${mountAlert.severity}` : '',
                        });
                    });
                    const mountAlertCount = mounts.filter(m => m.row_class).length;
                    const worstMountPct = mounts.length ? Math.max(...mounts.map(m => m.percent)) : 0;

                    const cores = parseFloat(server.cpu_cores) || 1;
                    const loadAvg = parseFloat(server.load_avg) || 0;
                    const loadPerCore = loadAvg / cores;
                    const loadCritical = parseFloat(thr.load_critical) || 3;

                    $serversRow.append(Nedara.renderTemplate('linux-server', Object.assign({}, server, {
                        id: key,
                        name: this.sanitize(server.name || key),
                        cpu_bar_width:       Math.min(100, parseFloat(server.cpu_usage) || 0),
                        ram_bar_width:       Math.min(100, parseFloat(server.ram_usage_percent) || 0),
                        storage_bar_width:   Math.min(100, parseFloat(server.storage_usage_percent) || 0),
                        load_bar_width:      Math.min(100, (loadPerCore / loadCritical) * 100),
                        cpu_usage_class:     this.getStatusClass(server.cpu_usage, thr.cpu_warning, thr.cpu_critical),
                        ram_usage_class:     this.getStatusClass(server.ram_usage_percent, thr.ram_warning, thr.ram_critical),
                        storage_usage_class: this.getStatusClass(server.storage_usage_percent, thr.disk_warning, thr.disk_critical),
                        load_usage_class:    this.getStatusClass(loadPerCore, thr.load_warning, thr.load_critical),
                        cpu_value_class:     this.getValueColorClass(server.cpu_usage, thr.cpu_warning, thr.cpu_critical),
                        ram_value_class:     this.getValueColorClass(server.ram_usage_percent, thr.ram_warning, thr.ram_critical),
                        storage_value_class: this.getValueColorClass(server.storage_usage_percent, thr.disk_warning, thr.disk_critical),
                        load_value_class:    this.getValueColorClass(loadPerCore, thr.load_warning, thr.load_critical),
                        cpu_row_class:       this.alertRowClass(serverAlerts, 'cpu'),
                        ram_row_class:       this.alertRowClass(serverAlerts, 'ram'),
                        storage_row_class:   this.alertRowClass(serverAlerts, 'disk'),
                        load_row_class:      this.alertRowClass(serverAlerts, 'load'),
                        load_per_core:       loadPerCore.toFixed(2),
                        cpu_cores:           cores,
                        health_class: this.getHealthStatus({
                            cpu: parseFloat(server.cpu_usage) || 0,
                            ram: parseFloat(server.ram_usage_percent) || 0,
                            storage: Math.max(parseFloat(server.storage_usage_percent) || 0, worstMountPct),
                            load: loadPerCore,
                        }, thr),
                        severity,
                        has_alerts: serverAlerts.length > 0,
                        has_logs: server.logs !== undefined && server.logs !== '',
                        alert_chip_text: this.alertChipText(serverAlerts),
                        alert_tooltip: this.sanitize(serverAlerts.map(a => a.message).join(' · ')),
                        mounts_alert_text: mountAlertCount ? `${mountAlertCount} alerting` : '',
                        mounts_alert_class: mountAlertCount ? `is-${severity}` : '',
                        mounts,
                    })));

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
                const pgAlerts = alertsByTarget['postgres-panel'] || [];
                const pgSeverity = this.worstSeverity(pgAlerts);
                document.getElementById('postgres-status').className =
                    `status-indicator status-${pgSeverity === 'none' ? 'healthy' : pgSeverity}`;
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

                const pgThr = server.thresholds || {};
                this._flagStat('stat-wait-active', ata,
                    pgThr.pg_active_wait_warning, pgThr.pg_active_wait_critical);
                this._flagStat('stat-wait-idle', ati,
                    pgThr.pg_idle_tx_warning, pgThr.pg_idle_tx_critical);

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
                const pgbAlerts = alertsByTarget['pgbouncer-panel'] || [];
                const pgbSeverity = this.worstSeverity(pgbAlerts);
                document.getElementById('pgbouncer-status').className =
                    `status-indicator status-${pgbSeverity === 'none' ? 'healthy' : pgbSeverity}`;
                upd('pgb-cl-active',  server.total_cl_active);
                upd('pgb-cl-waiting', server.total_cl_waiting);
                upd('pgb-sv-active',  server.total_sv_active);
                upd('pgb-sv-idle',    server.total_sv_idle);
                upd('pgb-qps',        parseFloat(server.total_qps       || 0).toFixed(1));
                upd('pgb-avg-query',  `${parseFloat(server.avg_query_time_ms || 0).toFixed(2)} ms`);
                upd('pgb-max-wait',   `${parseFloat(server.max_wait          || 0).toFixed(2)} s`);
                upd('pgb-pool-size',  server.default_pool_size || '?');

                const pgbThr = server.thresholds || {};
                this._flagStat('stat-pgb-waiting', parseFloat(server.total_cl_waiting),
                    pgbThr.pgb_waiting_warning, pgbThr.pgb_waiting_critical);
                this._flagStat('stat-pgb-max-wait', parseFloat(server.max_wait),
                    pgbThr.pgb_maxwait_warning, pgbThr.pgb_maxwait_critical);

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
        this.renderAlerts(data);
        this.updateOverallStatus(data.alert_summary);
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

    // Severity of a value against its configured thresholds (defaults: 70 / 90)
    severityFor: function (value, warning, critical) {
        const v = parseFloat(value);
        if (isNaN(v)) return 'none';
        const warn = isNaN(parseFloat(warning)) ? 70 : parseFloat(warning);
        const crit = isNaN(parseFloat(critical)) ? 90 : parseFloat(critical);
        if (v >= crit) return 'critical';
        if (v >= warn) return 'warning';
        return 'none';
    },

    getStatusClass: function (v, warning, critical) {
        const sev = this.severityFor(v, warning, critical);
        return sev === 'critical' ? 'usage-high' : sev === 'warning' ? 'usage-medium' : 'usage-low';
    },

    getValueColorClass: function (v, warning, critical) {
        const sev = this.severityFor(v, warning, critical);
        return sev === 'critical' ? 'value-high' : sev === 'warning' ? 'value-medium' : 'value-low';
    },

    getProcessStatusClass: function (v) { return v < 30 ? 'value-low' : v < 70 ? 'value-medium' : 'value-high'; },

    getHealthStatus: function (v, thr) {
        thr = thr || {};
        const severities = [
            this.severityFor(v.cpu, thr.cpu_warning, thr.cpu_critical),
            this.severityFor(v.ram, thr.ram_warning, thr.ram_critical),
            this.severityFor(v.storage, thr.disk_warning, thr.disk_critical),
            this.severityFor(v.mount, thr.mount_warning, thr.mount_critical),
            this.severityFor(v.load, thr.load_warning, thr.load_critical),
        ];
        return severities.includes('critical') ? 'status-critical'
             : severities.includes('warning')  ? 'status-warning'
             : 'status-healthy';
    },

    // ——————————————————————————————————————————
    // ALERTS
    // ——————————————————————————————————————————

    // Values are injected raw into the templates: keep markup out of them
    sanitize: function (value) {
        return String(value === undefined || value === null ? '' : value).replace(/[<>"'`]/g, ' ');
    },

    worstSeverity: function (alerts) {
        const live = (alerts || []).filter(a => !a.clearing);
        if (live.some(a => a.severity === 'critical')) return 'critical';
        if (live.some(a => a.severity === 'warning'))  return 'warning';
        return 'none';
    },

    alertRowClass: function (alerts, category) {
        const alert = (alerts || []).find(a => a.category === category && !a.clearing);
        return alert ? `is-${alert.severity}` : '';
    },

    alertChipText: function (alerts) {
        const count = (alerts || []).filter(a => !a.clearing).length;
        return count ? `${count} alert${count > 1 ? 's' : ''}` : '';
    },

    formatDuration: function (seconds) {
        const s = Math.max(0, parseInt(seconds, 10) || 0);
        if (s < 60) return `${s}s`;
        if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
        const h = Math.floor(s / 3600);
        if (h < 24) return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
        return `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h`;
    },

    _span: function (className, text) {
        const el = document.createElement('span');
        if (className) el.className = className;
        el.textContent = text === undefined || text === null ? '' : String(text);
        return el;
    },

    _updateAlertChip: function (el, alerts) {
        if (!el) return;
        const severity = this.worstSeverity(alerts);
        const text = this.alertChipText(alerts);
        if (severity === 'none' || !text) {
            el.style.display = 'none';
            el.textContent = '';
            return;
        }
        el.style.display = '';
        el.className = `card-alert-chip is-${severity}`;
        el.textContent = text;
        el.title = alerts.map(a => a.message).join(' · ');
    },

    _flagStat: function (id, value, warning, critical) {
        const el = document.getElementById(id);
        if (!el) return;
        const severity = this.severityFor(value, warning, critical);
        el.classList.toggle('is-warning', severity === 'warning');
        el.classList.toggle('is-critical', severity === 'critical');
    },

    _buildAlertItem: function (alert) {
        // A <div> rather than a <button>: buttons do not grow to fit a
        // multi-line flex layout in every engine.
        const item = document.createElement('div');
        item.setAttribute('role', 'button');
        item.setAttribute('tabindex', '0');
        item.className = `alert-item is-${alert.severity}${alert.clearing ? ' is-clearing' : ''}`;
        if (alert.target_id) item.dataset.targetId = alert.target_id;
        item.title = alert.message || '';

        const dot = document.createElement('span');
        dot.className = `status-indicator status-${alert.severity}`;

        const line = document.createElement('div');
        line.className = 'alert-line';
        line.appendChild(this._span('alert-target', alert.target));
        line.appendChild(this._span('alert-metric', alert.label));
        if (alert.value_display) {
            line.appendChild(this._span('alert-value', alert.value_display));
        }
        if (alert.threshold_display) {
            line.appendChild(this._span('alert-threshold', `threshold ${alert.threshold_display}`));
        }

        const meta = document.createElement('div');
        meta.className = 'alert-meta';
        const bits = [this._span('alert-duration', `for ${this.formatDuration(alert.duration)}`)];
        if (alert.since) {
            bits.push(this._span('', `since ${this.formatTime(new Date(alert.since * 1000))}`));
        }
        if (alert.detail) {
            bits.push(this._span('alert-detail', alert.detail));
        }
        if (alert.notified) {
            bits.push(this._span('', '✉ mail sent'));
        }
        bits.forEach((bit, index) => {
            if (index) meta.appendChild(this._span('alert-sep', '·'));
            meta.appendChild(bit);
        });

        const body = document.createElement('div');
        body.className = 'alert-body';
        body.append(line, meta);

        const side = document.createElement('div');
        side.className = 'alert-side';
        side.appendChild(this._span('alert-sev', alert.clearing ? 'clearing' : alert.severity));
        side.appendChild(this._span('alert-tag', alert.category));

        item.append(dot, body, side);
        return item;
    },

    renderAlerts: function (data) {
        const alerts  = data.alerts || [];
        const summary = data.alert_summary || { critical: 0, warning: 0 };
        const section = document.getElementById('section-alerts');
        const list    = document.getElementById('alerts-list');
        const empty   = document.getElementById('alerts-empty');
        const chips   = document.getElementById('alerts-chips');
        if (!section || !list) return;

        section.dataset.severity =
            summary.critical ? 'critical' : summary.warning ? 'warning' : 'none';

        if (chips) {
            const parts = [];
            if (summary.critical) parts.push(['is-critical', `${summary.critical} critical`]);
            if (summary.warning)  parts.push(['is-warning',  `${summary.warning} warning`]);
            if (!parts.length)    parts.push(['is-ok',       'all clear']);
            chips.replaceChildren(...parts.map(([cls, text]) => {
                const chip = this._span(`alerts-chip ${cls}`, text);
                return chip;
            }));
        }

        const visible = this.alertsSeverityFilter === 'critical'
            ? alerts.filter(a => a.severity === 'critical')
            : alerts;

        list.replaceChildren(...visible.map(alert => this._buildAlertItem(alert)));

        if (empty) {
            empty.style.display = visible.length ? 'none' : '';
            const message = empty.querySelector('span');
            if (message) {
                message.textContent = alerts.length
                    ? 'No critical alert — only warnings are currently active.'
                    : 'No active alert — every monitored metric is below its threshold.';
            }
        }
    },

    _restoreAlertsPanelState: function () {
        const section = document.getElementById('section-alerts');
        const toggle  = document.getElementById('alerts-toggle');
        const filter  = document.getElementById('alerts-severity-filter');
        if (section) section.classList.toggle('is-collapsed', this.alertsCollapsed);
        if (toggle)  toggle.textContent = this.alertsCollapsed ? '▸' : '▾';
        if (filter)  filter.value = this.alertsSeverityFilter;
    },

    focusAlertTarget: function (targetId) {
        const el = document.getElementById(targetId);
        if (!el) return;
        const card = el.closest('.dash-card') || el.querySelector('.dash-card') || el;
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.classList.remove('card-focus');
        // Force a reflow so the animation replays on repeated clicks
        void card.offsetWidth;
        card.classList.add('card-focus');
        setTimeout(() => card.classList.remove('card-focus'), 1800);
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

    updateOverallStatus: function (summary) {
        const counts  = summary || { critical: 0, warning: 0 };
        const hasCrit = counts.critical > 0;
        const hasWarn = counts.warning > 0;
        const badge   = document.getElementById('status-badge');
        const dot     = document.getElementById('overall-status');
        const text    = document.getElementById('status-text');

        const parts = [];
        if (hasCrit) parts.push(`${counts.critical} critical`);
        if (hasWarn) parts.push(`${counts.warning} warning`);

        badge.className = hasCrit ? 'badge-critical' : hasWarn ? 'badge-warning' : '';
        dot.className   = `status-indicator ${hasCrit ? 'status-critical' : hasWarn ? 'status-warning' : 'status-healthy'}`;
        text.textContent = parts.length ? parts.join(' · ') : 'All Operational';
        badge.title = parts.length
            ? `${parts.join(', ')} — see the alert panel for details`
            : 'Every monitored metric is below its threshold';
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
        window.applyThemeClass(theme);
        this.updateChartThemes();
    },

    updateThemeButton: function (theme) {
        window.updateThemeButton(theme);
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
        window.cycleTheme();
    },

    _onAlertsToggleClick: function (ev) {
        ev.preventDefault();
        this.alertsCollapsed = !this.alertsCollapsed;
        localStorage.setItem('nedara-alerts-collapsed', this.alertsCollapsed ? '1' : '0');
        this._restoreAlertsPanelState();
    },

    _onAlertsSeverityFilterChange: function (ev) {
        this.alertsSeverityFilter = ev.target.value;
        localStorage.setItem('nedara-alerts-severity', this.alertsSeverityFilter);
        this.renderAlerts({
            alerts: this.alerts,
            alert_summary: {
                critical: this.alerts.filter(a => a.severity === 'critical').length,
                warning: this.alerts.filter(a => a.severity === 'warning').length,
            },
        });
    },

    _onAlertItemClick: function (ev) {
        const targetId = ev.currentTarget.dataset.targetId;
        if (targetId) this.focusAlertTarget(targetId);
    },

    _onAlertItemKeydown: function (ev) {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        const targetId = ev.currentTarget.dataset.targetId;
        if (targetId) this.focusAlertTarget(targetId);
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
