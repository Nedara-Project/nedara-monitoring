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
        'change #server-selector': '_onServerSelectorChange',
        'click #refresh-interface': '_onRefreshInterfaceBtnClick',
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

                const uniqueData = self.ensureUniqueTimestamps(formattedData);
                const seriesInfo = self.chartsInfoMap[data.chart_id]?.find(info => info.label === data.series_name);
                if (seriesInfo) {
                    self.seriesData[data.chart_id][data.series_name] = uniqueData;
                    seriesInfo.series.setData(uniqueData);
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
        this.$selector.find('#chart-panel-http').html(Nedara.renderTemplate('chart-panel-http'));
        this.$selector.find('#chart-panel-ram').html(Nedara.renderTemplate('chart-panel-ram'));
        this.$selector.find('#postgres-panel').html(Nedara.renderTemplate('postgres-panel'));
        this.$selector.find('#processes-panel').html(Nedara.renderTemplate('processes-panel'));

        this.grid = GridStack.init({
            column: 12,
            cellHeight: 100,
            float: true,
            removable: false,
            acceptWidgets: false,
            resizable: {
                handles: 'e, se, s, sw, w',
            },
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

        this.setupChartHoverEvents();
    },

    handleServerDataUpdate: function (data) {
        this.env = data.environment;
        this.showPostgresPanel = data.show_postgres_panel;
        this.showHttpRequestsPanel = data.show_http_requests_panel;
        this.showLinuxPanel = data.show_linux_panel;
        const widgetConfig = data.widget_config;

        if (!this.charts) {
            this.charts = [
                {
                    id: 'CPUChart',
                    container: 'CPUChartContainer',
                    maxPoints: widgetConfig.chart_history,
                },
                {
                    id: 'httpRequestsChart',
                    container: 'httpRequestsChartContainer',
                    maxPoints: widgetConfig.chart_history,
                },
                {
                    id: 'RAMChart',
                    container: 'RAMChartContainer',
                    maxPoints: widgetConfig.chart_history,
                },
            ];

            this.chartAdaptiveDisplay = widgetConfig.chart_adaptive_display;
            this.chartsInfoMap = this.chartsInfoMap || {};
            this.seriesData = this.seriesData || {};

            _.each(this.charts, (chart) => {
                this.chartsInfoMap[chart.id] = [];
                this.seriesData[chart.id] = {};

                const chartContainer = document.getElementById(chart.id);
                if (chartContainer) {
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
                }
            });
        }

        document.getElementById("environment-selector").value = this.env;
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
        const $processesTable = $('#processes-table tbody');
        const chartDataMap = {};
        const allDatabases = new Set();
        const linuxServers = [];
        $linuxServers.empty();
        $processesTable.empty();

        _.each(data.stats, (server, idx) => {
            if (server.error) {
                this.$container
                    .find(".status-indicator[data-name='%s']".replace('%s', server.server))
                    .addClass('status-critical')
                    .removeClass('status-healthy');
            }

            switch (server.type) {
                case 'linux':
                    if (idx.endsWith('_processes') && server.processes) {
                        linuxServers.push(server.name.replace('_processes', ''));
                        server.processes.forEach(process => {
                            $processesTable.append(`
                                <tr data-server="${server.name.replace('_processes', '')}">
                                    <td>${server.name.replace('_processes', '')}</td>
                                    <td>${process.user}</td>
                                    <td>${process.pid}</td>
                                    <td class="${this.getProcessStatusClass(process.cpu)}">${process.cpu.toFixed(1)}%</td>
                                    <td class="${this.getProcessStatusClass(process.ram)}">${process.ram.toFixed(1)}%</td>
                                    <td class="truncate" title="${process.command}">${process.command}</td>
                                </tr>
                            `);
                        });
                    } else {
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
                    }
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
        this.updateServerSelector(linuxServers);

        _.each(this.charts, (chartConf) => {
            if (this[chartConf.id] && !this[chartConf.id].isPaused) {
                _.each(this.chartsInfoMap[chartConf.id], (seriesInfo) => {
                    const seriesData = this.seriesData[chartConf.id][seriesInfo.name];
                    seriesInfo.series.setData(seriesData.slice(-chartConf.maxPoints));
                });
                this[chartConf.id].timeScale().fitContent();
            }
        });

        _.each(this.charts, (chartConf) => {
            const chartInstance = this[chartConf.id];
            if (chartInstance) {
                const now = new Date();
                const timestamp = Math.floor(now.getTime() / 1000);
                const container = document.getElementById(chartConf.container);
                if (container) {
                    this[chartConf.id].resize(
                        container.clientWidth,
                        container.clientHeight,
                    );
                }

                _.each(this.chartsInfoMap[chartConf.id], (seriesInfo) => {
                    let dataType = '';
                    if (['CPUChart'].includes(chartConf.id)) {
                        dataType = 'cpu';
                    } else if (['httpRequestsChart'].includes(chartConf.id)) {
                        dataType = 'http';
                    } else if (['RAMChart'].includes(chartConf.id)) {
                        dataType = 'ram';
                    }

                    const value = chartDataMap[seriesInfo.label][dataType] || 0;
                    const seriesData = this.seriesData[chartConf.id][seriesInfo.label];

                    if (seriesData) {
                        let newTimestamp = timestamp;
                        if (seriesData.length > 0) {
                            const lastTimestamp = seriesData[seriesData.length - 1].time;
                            if (newTimestamp <= lastTimestamp) {
                                newTimestamp = lastTimestamp + 1;
                            }
                        }
                        seriesData.push({
                            time: timestamp,
                            value: value,
                        });
                        if (!this[chartConf.id].isPaused) {
                            const keepData = seriesData.slice(-chartConf.maxPoints);
                            const uniqueData = this.ensureUniqueTimestamps(keepData);
                            seriesInfo.series.setData(uniqueData);
                            chartInstance.timeScale().fitContent();
                        }
                    }
                });
            }
        });

        const timestamp = new Date();
        document.getElementById("last-update-time").textContent = this.formatTime(timestamp);
        this.highlightCriticalQueries();
        this.applyFilters();
        this.updateOverallStatus();

        let postgresPanelDOM = this.$container.find('#postgres-panel').parent().get(0);
        let httpRequestsPanelDOM = this.$container.find('#chart-panel-http').parent().get(0);
        if (!data.show_postgres_panel && postgresPanelDOM && !_.isUndefined(postgresPanelDOM)) {
            this.grid.removeWidget(postgresPanelDOM);
        }
        if (!data.show_http_requests_panel && httpRequestsPanelDOM && !_.isUndefined(httpRequestsPanelDOM)) {
            this.grid.removeWidget(httpRequestsPanelDOM);
        }

        this.$container.find('#loading-container').remove();
        this.$container.find('#monitoring').show();
    },

    createLightweightChart: function (container) {
        const {createChart} = window.LightweightCharts;
        const chartContainer = document.getElementById(container);

        const chart = createChart(chartContainer, {
            layout: {
                background: {type: 'solid', color: '#1f2937'},
                textColor: '#e5e7eb',
            },
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
                fixLeftEdge: this.chartAdaptiveDisplay,
                fixRightEdge: true,
                lockVisibleTimeRangeOnResize: false,
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

        const self = this;
        const interactiveElements = chartContainer.querySelectorAll('canvas, .tv-lightweight-charts');
        interactiveElements.forEach(el => {
            el.addEventListener('mouseenter', () => {
                const gridItem = chartContainer.closest('.grid-stack-item');
                if (gridItem && self.grid) {
                    self.grid.enableMove(gridItem, false);
                }
            });

            el.addEventListener('mouseleave', () => {
                const gridItem = chartContainer.closest('.grid-stack-item');
                if (gridItem && self.grid) {
                    self.grid.enableMove(gridItem, true);
                }
            });
        });

        const pauseButton = document.createElement('div');
        pauseButton.className = 'chart-pause-button simple-link';
        pauseButton.innerHTML = '⏸';
        pauseButton.title = 'Pause/Resume updates';
        chartContainer.appendChild(pauseButton);
        chart.isPaused = false;

        pauseButton.addEventListener('click', () => {
            chart.isPaused = !chart.isPaused;
            pauseButton.innerHTML = chart.isPaused ? '⏭' : '⏸';

            if (!chart.isPaused) {
                const chartId = container.replace('Container', '');
                _.each(this.chartsInfoMap[chartId], (seriesInfo) => {
                    const seriesData = this.seriesData[chartId][seriesInfo.name];
                    seriesInfo.series.setData(seriesData.slice(-this.charts.find(c => c.id === chartId).maxPoints));
                });
                chart.timeScale().fitContent();
            }
        });

        return chart;
    },

    setupChartHoverEvents: function () {
        const self = this;

        function handleChartEvent(event, shouldEnableGrid) {
            const gridItem = event.target.closest('.grid-stack-item');
            if (gridItem && self.grid) {
                self.grid.enableMove(gridItem, shouldEnableGrid);
                self.grid.enableResize(gridItem, shouldEnableGrid);
            }
        }

        function setupChartHandlers(chartElement) {
            if (!chartElement || chartElement.dataset.chartHandled) {
                return;
            };
            chartElement.dataset.chartHandled = 'true';

            const interactiveElements = chartElement.querySelectorAll('canvas, .tv-lightweight-charts');

            interactiveElements.forEach(el => {
                el.addEventListener('mouseenter', (e) => handleChartEvent(e, false));
                el.addEventListener('mouseleave', (e) => handleChartEvent(e, true));
                el.addEventListener('mousedown', (e) => e.stopPropagation());
            });
        }

        document.querySelectorAll('.grid-stack-item-content').forEach(content => {
            const charts = content.querySelectorAll('.tv-lightweight-charts');
            charts.forEach(chart => setupChartHandlers(chart));
        });

        new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType === 1 && node.matches('.tv-lightweight-charts')) {
                        setupChartHandlers(node);
                    }
                });
            });
        }).observe(document.body, {childList: true, subtree: true});
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
        if (logs) {
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
        }
    },

    updateDatabaseSelector: function (databases) {
        if (this.showPostgresPanel) {
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

    updateServerSelector: function (servers) {
        const serverSelector = document.getElementById("server-selector");
        const currentSelection = serverSelector.value;
        if (serverSelector) {
            // Keep the first option (All Servers)
            while (serverSelector.options.length > 1) {
                serverSelector.remove(1);
            }
            servers.forEach(server => {
                const option = document.createElement("option");
                option.value = server;
                option.textContent = server;
                serverSelector.appendChild(option);
            });
            if (servers.includes(currentSelection) || currentSelection === 'all') {
                serverSelector.value = currentSelection;
            } else {
                serverSelector.value = 'all';
                this.serverFilter = 'all';
            }
        }
    },

    filterProcessesByServer: function (server) {
        this.serverFilter = server;
        this.applyProcessesFilters();
    },

    applyProcessesFilters: function () {
        const rows = document.querySelectorAll("#processes-table tbody tr");
        rows.forEach((row) => {
            const processServer = row.getAttribute("data-server");
            const serverMatch = this.serverFilter === "all" || processServer === this.serverFilter;
            if (serverMatch) {
                row.style.display = "";
            } else {
                row.style.display = "none";
            }
        });
    },

    getProcessStatusClass: function (value) {
        return value < 30 ? "usage-low" : value < 70 ? "usage-medium" : "usage-high";
    },

    ensureUniqueTimestamps: function (data) {
        if (!data || data.length === 0) {
            return data;
        }

        // Sort by time first
        data.sort((a, b) => a.time - b.time);

        // Remove or adjust duplicate timestamps
        const uniqueData = [];
        let lastTime = null;

        data.forEach(item => {
            let currentTime = item.time;

            // If we have a duplicate timestamp, increment by 1 second
            if (lastTime !== null && currentTime <= lastTime) {
                currentTime = lastTime + 1;
            }

            uniqueData.push({
                time: currentTime,
                value: item.value,
            });

            lastTime = currentTime;
        });

        return uniqueData;
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
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        ev.preventDefault();
        const $link = $(ev.currentTarget);
        const $logsContent = $link.closest(".panel-title").find(".logs_content");
        const rawLogs = escapeHtml($logsContent.text().trim());
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

    _onServerSelectorChange: function (ev) {
        this.filterProcessesByServer(ev.target.value);
    },

    _onRefreshInterfaceBtnClick: function () {
        localStorage.removeItem('grid-layout');
        window.location.reload();
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
