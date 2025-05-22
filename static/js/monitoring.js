"use strict";

import Nedara from "../js/lib/nedarajs/nedara.min.js";

const TEMPLATES = "/static/html/templates.html";

const Monitoring = Nedara.createWidget({
    selector: "#monitoring",
    events: {
        'click #filter-active': '_onFilterActiveClick',
        'click #filter-idle': '_onFilterIdleClick',
        'click #filter-all': '_onFilterAllClick',
        'change #environment-selector': '_onEnvironmentSelectorChange',
        'change #database-selector': '_onDatabaseSelectorChange',
        'scroll #logs': '_onLogsScroll',
        'click .open_logs': '_onOpenLogsClick',
    },

    start: async function () {
        await Nedara.importTemplates(TEMPLATES);

        this.socket = window.io();
        this.psqlQueriesFilter = 'all';
        this.dbFilter = 'all';
        this.availableDatabases = [];
        this.chartsInfoMap = {};

        this.render();
        this.setupSocketListeners();
        this.loadChartConfigs();
        this.autoReload();
    },

    // ************************************************************
    // * FUNCTIONS
    // ************************************************************

    setupSocketListeners: function () {
        const self = this;

        this.socket.on('server_data_update', function (data) {
            self.handleServerDataUpdate(data);
        });

        this.socket.on('historical_data_response', function (data) {
            if (data.data && data.data.length > 0) {
                const formattedData = data.data
                .map(item => ({
                    time: Math.floor(item.time),
                    value: parseFloat(item.value),
                }))
                .filter(item =>
                    Number.isInteger(item.time) &&
                    !isNaN(item.value),
                ).sort((a, b) => a.time - b.time);

                const seriesInfo = self.chartsInfoMap[data.chart_id]?.find(info => info.label === data.series_name);
                if (seriesInfo) {
                    self.seriesData[data.chart_id][data.series_name] = formattedData;
                    seriesInfo.series.setData(formattedData);
                    self[data.chart_id].timeScale().fitContent();
                }
            }
        });

        this.socket.on('environment_changed', function (data) {
            if (data.status === 'success') {
                window.location.reload();
            } else {
                console.error("Failed to switch environment:", data.message);
            }
        });

        this.socket.on('connect_error', (error) => {
            console.error('Socket connection error:', error);
        });

        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
        });
    },

    loadChartConfigs: function () {
        _.each(this.charts, (chart) => {
            this.socket.emit('save_chart_config', {
                chart_id: chart.id,
                max_points: chart.maxPoints,
                chart_type: 'area',
            });
        });
    },

    loadHistoricalData: function (chartId, seriesName, maxPoints) {
        this.socket.emit('get_historical_data', {
            chart_id: chartId,
            series_name: seriesName,
            max_points: maxPoints,
            environment: this.env,
        });
    },

    render: function () {
        this.$selector.find('#server-panel').html(Nedara.renderTemplate('server-panel'));
        this.$selector.find('#chart-panel-cpu').html(Nedara.renderTemplate('chart-panel-cpu'));
        this.$selector.find('#chart-panel-cpu-alt').html(Nedara.renderTemplate('chart-panel-cpu-alt'));
        this.$selector.find('#chart-panel-http').html(Nedara.renderTemplate('chart-panel-http'));
        this.$selector.find('#chart-panel-http-alt').html(Nedara.renderTemplate('chart-panel-http-alt'));
        this.$selector.find('#chart-panel-ram').html(Nedara.renderTemplate('chart-panel-ram'));
        this.$selector.find('#chart-panel-ram-alt').html(Nedara.renderTemplate('chart-panel-ram-alt'));
        this.$selector.find('#postgres-panel').html(Nedara.renderTemplate('postgres-panel'));

        this.grid = GridStack.init({
            column: 12,
            cellHeight: 100,
            float: true,
            removable: false,
            acceptWidgets: false,
        });

        const savedLayout = localStorage.getItem("grid-layout");
        if (savedLayout) {
            this.grid.removeAll();
            const layout = JSON.parse(savedLayout);
            this.grid.load(layout);
        }

        this.grid.on('change', (event, items) => {
            const layout = this.grid.save();
            localStorage.setItem("grid-layout", JSON.stringify(layout));
        });
    },

    handleServerDataUpdate: function (data) {
        this.env = data.environment;
        const widgetConfig = data.widget_config;

        if (!this.charts) {
            this.charts = [
                {
                    id: 'CPUChart',
                    container: 'CPUChartContainer',
                    maxPoints: widgetConfig.chart_history,
                },
                {
                    id: 'CPUChartAlt',
                    container: 'CPUChartAltContainer',
                    maxPoints: widgetConfig.chart_history_alt,
                },
                {
                    id: 'httpRequestsChart',
                    container: 'httpRequestsChartContainer',
                    maxPoints: widgetConfig.chart_history,
                },
                {
                    id: 'httpRequestsChartAlt',
                    container: 'httpRequestsChartAltContainer',
                    maxPoints: widgetConfig.chart_history_alt,
                },
                {
                    id: 'RAMChart',
                    container: 'RAMChartContainer',
                    maxPoints: widgetConfig.chart_history,
                },
                {
                    id: 'RAMChartAlt',
                    container: 'RAMChartAltContainer',
                    maxPoints: widgetConfig.chart_history_alt,
                },
            ];

            this.chartsInfoMap = this.chartsInfoMap || {};
            this.seriesData = this.seriesData || {};

            _.each(this.charts, (chart) => {
                this.chartsInfoMap[chart.id] = [];
                this.seriesData[chart.id] = {};

                const chartContainer = document.getElementById(chart.id);
                chartContainer.innerHTML = '';
                const lightweightContainer = document.createElement('div');
                lightweightContainer.id = chart.container;
                lightweightContainer.style.width = '100%';
                lightweightContainer.style.height = '100%';
                chartContainer.appendChild(lightweightContainer);

                this[chart.id] = this.createLightweightChart(chart.container);

                _.each(widgetConfig.chart_info, (chartInfo) => {
                    this.seriesData[chart.id][chartInfo.name] = [];

                    const series = this[chart.id].addSeries(window.LightweightCharts.AreaSeries, {
                        title: chartInfo.label,
                        color: chartInfo.color,
                        lineColor: chartInfo.color,
                        lineWidth: 1.5,
                        lineStyle: 0,
                        priceLineVisible: false,
                        topColor: this.hexToRgba(chartInfo.color, 0.4),
                        bottomColor: 'rgba(0, 0, 0, 0)',
                    });

                    this.chartsInfoMap[chart.id].push({
                        name: chartInfo.name,
                        label: chartInfo.label,
                        series: series,
                        color: chartInfo.color,
                        backgroundColor: chartInfo.background_color,
                    });

                    this.loadHistoricalData(chart.id, chartInfo.label, chart.maxPoints);
                });

                this[chart.id].timeScale().fitContent();
            });
        }

        document.getElementById("environment-selector").value = this.env;
        document.getElementById("web-url").textContent = data.widget_config.web_url;
        document.getElementById("web-url").href = data.widget_config.web_url;

        const webStatus = data.web_status;
        if (webStatus.status === "Online") {
            document.getElementById("web-url-status-text").textContent = "Online";
            document.getElementById("web-url-status-text").style.color = "#10b981";
            document.getElementById("web-url-status").className = "status-indicator status-healthy";
            document.getElementById("web-url-response-time").textContent = `${webStatus.response_time}`;
        } else {
            document.getElementById("web-url-status-text").textContent = `Offline: ${webStatus.status_code}`;
            document.getElementById("web-url-status-text").style.color = "#ef4444";
            document.getElementById("web-url-status").className = "status-indicator status-critical";
            document.getElementById("web-url-response-time").textContent = "N/A";
        }

        const $linuxServers = $('#linux-servers');
        const chartDataMap = {};
        $linuxServers.empty();
        const allDatabases = new Set();

        _.each(data.stats, (server, idx) => {
            if (server.error) {
                this.$container
                    .find(".status-indicator[data-name='%s']".replace('%s', server.server))
                    .addClass('status-critical')
                    .removeClass('status-healthy');
            }

            switch (server.type) {
                case 'linux':
                    $linuxServers.prepend(Nedara.renderTemplate('linux-server',
                        Object.assign({
                            'id': idx,
                            'cpu_usage_class': this.getStatusClass(server.cpu_usage),
                            'ram_usage_class': this.getStatusClass(server.ram_usage_percent),
                            'storage_usage_class': this.getStatusClass(server.storage_usage_percent),
                            'health_class': this.getHealthStatus({
                                'cpu': server.cpu_usage,
                                'ram': server.ram_usage_percent,
                                'storage': server.storage_usage_percent,
                            }),
                        }, server),
                    ));
                    chartDataMap[server.chart_label] = {};
                    chartDataMap[server.chart_label]['cpu'] = parseFloat(server.cpu_usage);
                    chartDataMap[server.chart_label]['http'] = parseFloat(server.http_requests);
                    chartDataMap[server.chart_label]['ram'] = parseFloat(server.ram_usage_percent);
                    let logContainer = this.$container.find('.log-container[data-log-source="%s"]'
                        .replace('%s', server.name));
                    logContainer.html(this.colorizeLogs(server.logs));
                    break;

                case 'postgres':
                    document.getElementById("postgres-status").className = "status-indicator status-healthy";
                    document.getElementById("main-db").textContent = server.main_db;
                    document.getElementById("query-count").textContent = server.active_queries.length;
                    document.getElementById("postgres-db-size").textContent = `${server.db_size_mb} MB | ${server.db_size_gb} GB`;
                    const avgWaitTimeActive = parseFloat(server.avg_wait_time_active);
                    document.getElementById("avg-wait-time-active").textContent =
                        !isNaN(avgWaitTimeActive) && avgWaitTimeActive >= 0 ? `${avgWaitTimeActive.toFixed(2)}s` : "0.00s";
                    const avgWaitTimeIdle = parseFloat(server.avg_wait_time_idle);
                    document.getElementById("avg-wait-time-idle").textContent =
                        !isNaN(avgWaitTimeIdle) && avgWaitTimeIdle >= 0 ? `${avgWaitTimeIdle.toFixed(2)}s` : "0.00s";
                    _.each(server.all_databases, (db) => {
                        allDatabases.add(db);
                    });
                    const tbody = document.querySelector("#postgres-queries tbody");
                    tbody.innerHTML = server.active_queries.map((query) => `
                        <tr data-state="${query[2]}" data-db="${query[0]}">
                            <td>
                                db: ${query[0]}<br/>
                                user: ${query[1]}
                            </td>
                            <td>${query[2]}</td>
                            <td>${query[5] || "N/A"}</td>
                            <td>${query[6] && query[6] >= 0 ? `${parseFloat(query[6]).toFixed(2)}s` : "0.00s"}</td>
                            <td class="truncate" style="width: 97%;" title="${query[3]}">${query[3]}</td>
                        </tr>
                    `).join("");
                    break;
            }
        });

        this.updateDatabaseSelector([...allDatabases].sort());

        _.each(this.charts, (chartConf) => {
            const chartInstance = this[chartConf.id];
            if (chartInstance) {
                const now = new Date();
                const timestamp = Math.floor(now.getTime() / 1000);

                _.each(this.chartsInfoMap[chartConf.id], (seriesInfo) => {
                    let dataType = '';
                    if (['CPUChart', 'CPUChartAlt'].includes(chartConf.id)) {
                        dataType = 'cpu';
                    } else if (['httpRequestsChart', 'httpRequestsChartAlt'].includes(chartConf.id)) {
                        dataType = 'http';
                    } else if (['RAMChart', 'RAMChartAlt'].includes(chartConf.id)) {
                        dataType = 'ram';
                    }

                    const value = chartDataMap[seriesInfo.label][dataType] || 0;
                    const seriesData = this.seriesData[chartConf.id][seriesInfo.name];

                    seriesData.push({
                        time: timestamp,
                        value: value,
                    });

                    if (seriesData.length > parseInt(chartConf.maxPoints)) {
                        const keepData = this.seriesData[chartConf.id][seriesInfo.name].slice(-(chartConf.maxPoints - 1));
                        seriesInfo.series.setData(keepData);
                    } else {
                        seriesInfo.series.update({
                            time: timestamp,
                            value: value,
                        });
                    }

                });

                chartInstance.timeScale().fitContent();
            }
        });

        const timestamp = new Date();
        document.getElementById("last-update-time").textContent = this.formatTime(timestamp);
        this.highlightCriticalQueries();
        this.applyFilters();
        this.updateOverallStatus();

        this.$container.find('#loading-container').remove();
        this.$container.find('#monitoring').show();
    },

    createLightweightChart: function (container) {
        const {createChart} = window.LightweightCharts;

        return createChart(document.getElementById(container), {
            layout: {
                background: {type: 'solid', color: '#1f2937'},
                textColor: '#e5e7eb',
            },
            autoSize: true,
            grid: {
                vertLines: {color: 'rgba(75, 85, 99, 0.2)'},
                horzLines: {color: 'rgba(75, 85, 99, 0.2)'},
            },
            rightPriceScale: {
                borderColor: 'rgba(75, 85, 99, 0.5)',
                visible: true,
                scaleMargins: {
                    top: 0.1,
                    bottom: 0.1,
                },
            },
            timeScale: {
                borderColor: 'rgba(75, 85, 99, 0.5)',
                timeVisible: true,
                secondsVisible: true,
                fixLeftEdge: true,
                fixRightEdge: true,
                lockVisibleTimeRangeOnResize: true,
            },
            crosshair: {
                vertLine: {
                    color: 'rgba(255, 255, 255, 0.3)',
                    width: 1,
                    style: 1,
                },
                horzLine: {
                    color: 'rgba(255, 255, 255, 0.3)',
                    width: 1,
                    style: 1,
                    labelBackgroundColor: '#9ca3af',
                },
            },
            handleScale: {
                axisPressedMouseMove: {
                    time: true,
                    price: true,
                },
                mouseWheel: true,
                pinch: true,
            },
            handleScroll: true,
        });
    },

    hexToRgba: function (hex, alpha) {
        hex = hex.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    },

    getStatusClass: function (value) {
        return value < 70 ? "usage-low" : value < 90 ? "usage-medium" : "usage-high";
    },

    getHealthStatus: function (values) {
        return values.cpu > 90 || values.ram > 90 || values.storage > 90 ? "status-critical" :
            values.cpu > 70 || values.ram > 70 || values.storage > 70 ? "status-warning" : "status-healthy";
    },

    formatTime: function (date) {
        return date.toLocaleTimeString([], {
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
    },

    updateOverallStatus: function () {
        const hasCriticalElements = this.$container.find('.status-critical').not('#overall-status').length;
        const hasWarningElements = this.$container.find('.status-warning').not('#overall-status').length;
        const overallStatus = hasCriticalElements ?
            "status-critical" : hasWarningElements ? "status-warning" : "status-healthy";
        document.getElementById("overall-status").className = `status-indicator ${overallStatus}`;
        document.getElementById("status-text").textContent = overallStatus === "status-critical" ? "Critical System Issues" :
            overallStatus === "status-warning" ? "Performance Warnings" : "All Systems Operational";
    },

    highlightCriticalQueries: function () {
        document.querySelectorAll("#postgres-queries tbody tr").forEach((row) => {
            const state = row.children[1].textContent;
            const duration = parseFloat(row.children[3].textContent);
            if (state === "active") {
                row.style.backgroundColor = "rgba(0, 255, 200, 0.37)";
            } else if (state === "idle in transaction") {
                row.style.backgroundColor = "rgba(0, 81, 255, 0.34)";
            } else {
                row.style.backgroundColor = "";
            }
            if (duration > 10) {
                row.style.backgroundColor = "rgba(255, 0, 34, 0.38)";
            }
        });
    },

    colorizeLogs: function (logs) {
        return logs.split("\n").map((line) => {
            const replacements = [
                [/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})/g, "<span class=\"log-date\">$1</span>"],
                [/(INFO)/g, "<span class=\"log-info\">$1</span>"],
                [/(ERROR)/g, "<span class=\"log-error\">$1</span>"],
                [/(WARNING)/g, "<span class=\"log-warning\">$1</span>"],
                [/(DEBUG)/g, "<span class=\"log-debug\">$1</span>"],
                [/(IDs: \[.*?\])/g, "<span class=\"log-id\">$1</span>"],
                [/Starting job `(.*?)`/g, "Starting job `<span class=\"log-job\">$1</span>`"],
                [/Job `(.*?)` done/g, "Job `<span class=\"log-job\">$1</span>` done"],
            ];
            replacements.forEach(([regex, replacement]) => {
                line = line.replace(regex, replacement);
            });
            return `<div class="log-line">${line}</div>`;
        }).join("\n");
    },

    updateDatabaseSelector: function (databases) {
        this.availableDatabases = databases;
        const dbSelector = document.getElementById("database-selector");
        const currentSelection = dbSelector.value;
        while (dbSelector.options.length > 1) {
            dbSelector.remove(1);
        }
        databases.forEach(db => {
            const option = document.createElement("option");
            option.value = db;
            option.textContent = db;
            dbSelector.appendChild(option);
        });
        if (databases.includes(currentSelection) || currentSelection === 'all') {
            dbSelector.value = currentSelection;
        } else {
            dbSelector.value = 'all';
            this.dbFilter = 'all';
        }
    },

    filterQueriesByDatabase: function (database) {
        this.dbFilter = database;
        this.applyFilters();
    },

    filterQueriesByState: function (state) {
        this.psqlQueriesFilter = state;
        this.applyFilters();
    },

    applyFilters: function () {
        const rows = document.querySelectorAll("#postgres-queries tbody tr");
        rows.forEach((row) => {
            const queryState = row.getAttribute("data-state");
            const queryDb = row.getAttribute("data-db");
            const stateMatch = this.psqlQueriesFilter === "all" || queryState === this.psqlQueriesFilter;
            const dbMatch = this.dbFilter === "all" || queryDb === this.dbFilter;
            if (stateMatch && dbMatch) {
                row.style.display = "";
            } else {
                row.style.display = "none";
            }
        });
    },

    autoReload: function () {
        // This function refreshes the interface every 24 hours to reduce the load
        // when displaying many points on less powerful machines.
        setInterval(() => location.reload(), 24 * 60 * 60 * 1000);
    },

    // ************************************************************
    // * EVENT HANDLERS
    // ************************************************************

    _onFilterActiveClick: function () {
        this.filterQueriesByState("active");
    },

    _onFilterIdleClick: function () {
        this.filterQueriesByState("idle in transaction");
    },

    _onFilterAllClick: function () {
        this.filterQueriesByState("all");
    },

    _onDatabaseSelectorChange: function (ev) {
        this.filterQueriesByDatabase(ev.target.value);
    },

    _onEnvironmentSelectorChange: function (ev) {
        this.socket.emit('change_environment', {environment: ev.target.value});
    },

    _onLogsScroll: function (ev) {
        window.autoScrollLogs = ev.target.scrollHeight - ev.target.scrollTop === ev.target.clientHeight;
    },

    _onOpenLogsClick: function (ev) {
        ev.preventDefault();
        const $link = $(ev.currentTarget);
        const $logsContent = $link.closest(".panel-title").find(".logs_content");
        const rawLogs = $logsContent.text().trim();
        const coloredLogs = this.colorizeLogs(rawLogs);
        const $modal = $(Nedara.renderTemplate("modal-logs", {
            'source': $link.data('source'),
            'logs': coloredLogs,
        }));
        $("body").append($modal);
        $modal.find(".modal-close").on("click", () => $modal.remove());
        $modal.find("#modal-overlay").on("click", (e) => {
            if (e.target.id === "modal-overlay") {
                $modal.remove();
            };
        });
    },
});

// Handle window resize to update chart dimensions
window.addEventListener('resize', function () {
    if (Monitoring && Monitoring.charts) {
        _.each(Monitoring.charts, function (chartConf) {
            if (Monitoring[chartConf.id]) {
                // Use resize method available in v5.0
                const container = document.getElementById(chartConf.container);
                Monitoring[chartConf.id].resize(
                    container.clientWidth,
                    container.clientHeight,
                );
            }
        });
    }
});

Nedara.registerWidget("Monitoring", Monitoring);
