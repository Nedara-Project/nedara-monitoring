"use strict";

import Nedara from "../js/lib/nedarajs/nedara.min.js";
import MonitoringDB from "./db.js";

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

    // ************************************************************
    // * WIDGET
    // ************************************************************

    start: async function () {
        await Nedara.importTemplates(TEMPLATES);
        const self = this;
        const response = await fetch("/api/widget_data");
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const chartsData = await response.json();
        this.env = chartsData.current_env;
        this.db = new MonitoringDB();
        this.psqlQueriesFilter = 'all';
        this.dbFilter = 'all';
        this.availableDatabases = [];
        this.charts = [
            {
                id: 'performanceChart',
                maxPoints: chartsData.chart_history_short,
            },
            {
                id: 'performanceChart24h',
                maxPoints: chartsData.chart_history_long,
            },
        ];
        this.render();
        // Load saved chart data
        const savedChartData = await this.db.getChartData(this.env);
        this.chartsInfoMap = {};
        const savedDataMap = {};
        if (savedChartData) {
            savedChartData.forEach(item => {
                if (!savedDataMap[item.chart_id]) {
                    savedDataMap[item.chart_id] = {
                        labels: item.labels,
                        datasets: {},
                    };
                }
                savedDataMap[item.chart_id].datasets[item.name] = item.datasets.data;
            });
        }
        _.each(this.charts, (chart) => {
            this.chartsInfoMap[chart.id] = [];
            _.each(chartsData.chart_info, (chartInfo) => {
                const savedDatasetData = savedDataMap[chart.id]?.datasets[chartInfo.label] || Array(chart.maxPoints).fill(null);
                const dataset = {
                    name: chartInfo.name,
                    label: chartInfo.label,
                    data: savedDatasetData,
                    borderColor: chartInfo.borderColor,
                    backgroundColor: chartInfo.backgroundColor,
                    borderWidth: chartInfo.borderWidth,
                    tension: chartInfo.tension,
                    fill: chartInfo.fill,
                };
                this.chartsInfoMap[chart.id].push(dataset);
            });
            const labelsToUse = savedDataMap[chart.id]?.labels || Array(chart.maxPoints).fill("");
            this[chart.id] = new Chart(
                document.getElementById(chart.id).getContext("2d"),
                self.chartConfig(
                    labelsToUse,
                    this.chartsInfoMap[chart.id],
                ),
            );
        });
        this.filterQueriesByState("all");
        this.refreshData();
        setInterval(this.refreshData, 5000);
    },

    // ************************************************************
    // * FUNCTIONS
    // ************************************************************

    render: function () {
        this.$selector.find('#server-panel').html(Nedara.renderTemplate('server-panel'));
        this.$selector.find('#chart-panel').html(Nedara.renderTemplate('chart-panel'));
        this.$selector.find('#chart-panel-lt').html(Nedara.renderTemplate('chart-panel-lt'));
        this.$selector.find('#postgres-panel').html(Nedara.renderTemplate('postgres-panel'));
        this.grid = GridStack.init({
            column: 12,
            cellHeight: 100,
            float: true,
            removable: false,
            acceptWidgets: false,
        });
        // Load saved state
        const savedLayout = localStorage.getItem("grid-layout");
        if (savedLayout) {
            this.grid.removeAll();
            const layout = JSON.parse(savedLayout);
            this.grid.load(layout);
        }
        // Save state on change
        this.grid.on('change', (event, items) => {
            const layout = this.grid.save();
            localStorage.setItem("grid-layout", JSON.stringify(layout));
        });
    },
    loadChartsFromDB: async function () {
        try {
            const savedChartData = await this.db.getChartData(this.env);
            if (savedChartData && savedChartData.length > 0) {
                // Iterate through each saved chart data
                _.each(savedChartData, (chartData) => {
                    const chartInstance = this[chartData.chart_id];
                    if (chartInstance) {
                        // Find the corresponding dataset in the chart
                        const dataset = _.findWhere(chartInstance.data.datasets, {label: chartData.name});
                        if (dataset) {
                            // Restore saved data
                            dataset.data = chartData.datasets.data;
                            // Update labels if they exist
                            if (chartData.labels && chartData.labels.length > 0) {
                                chartInstance.data.labels = chartData.labels;
                            }
                        }
                    }
                });
                // Update all charts with restored data
                _.each(this.charts, (chart) => {
                    if (this[chart.id]) {
                        this[chart.id].update();
                    }
                });
            }
        } catch (error) {
            console.error("Error loading chart data from IndexedDB:", error);
        }
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
    chartConfig: function (labels, datasets) {
        return {
            type: "line",
            data: {labels, datasets},
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {duration: 300},
                plugins: {
                    legend: {position: "top", labels: {color: "#e5e7eb"}},
                    tooltip: {mode: "index", intersect: false},
                },
                scales: {
                    x: {grid: {color: "rgba(75, 85, 99, 0.2)"}, ticks: {color: "#9ca3af"}},
                    y: {
                        beginAtZero: true,
                        max: 100,
                        grid: {color: "rgba(75, 85, 99, 0.2)"},
                        ticks: {color: "#9ca3af", callback: (value) => `${value}%`},
                    },
                },
            },
        };
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
    refreshEnvironment: async function () {
        try {
            const {environment, url} = await (await fetch("/api/current_environment")).json();
            document.getElementById("environment-selector").value = environment;
            document.getElementById("web-url").textContent = url;
            document.getElementById("web-url").href = url;
        } catch (error) {
            console.error("Error fetching current environment:", error);
        }
    },
    checkWebUrlStatus: async function () {
        try {
            const baseUrl = window.location.origin;
            const response = await fetch(`${baseUrl}/check-web-status`);
            const data = await response.json();
            if (data.status === "Online") {
                document.getElementById("web-url-status-text").textContent = "Online";
                document.getElementById("web-url-status-text").style.color = "#10b981"; // Green
                document.getElementById("web-url-status").className = "status-indicator status-healthy";
                document.getElementById("web-url-response-time").textContent = `${data.response_time}`;
            } else {
                document.getElementById("web-url-status-text").textContent = `Offline: ${data.status_code}`;
                document.getElementById("web-url-status-text").style.color = "#ef4444"; // Red
                document.getElementById("web-url-status").className = "status-indicator status-critical";
                document.getElementById("web-url-response-time").textContent = "N/A";
            }
        } catch (error) {
            console.error("Checking URL status failed:", error);
            document.getElementById("web-url-status-text").textContent = "Error while checking";
            document.getElementById("web-url-status-text").style.color = "#ef4444"; // Red
            document.getElementById("web-url-status").className = "status-indicator status-critical";
            document.getElementById("web-url-response-time").textContent = "N/A";
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
    refreshData: async function () {
        let widget = Monitoring;
        try {
            const response = await fetch("/api/stats");
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            const data = await response.json();
            const $linuxServers = $('#linux-servers');
            const chartDataMap = {};
            $linuxServers.empty();
            const allDatabases = new Set();
            _.each(data, function (server, idx) {
                if (server.error) {
                    widget.$container
                        .find(".status-indicator[data-name='%s']".replace('%s', server.server))
                        .addClass('status-critical')
                        .removeClass('status-healthy');
                }
                switch (server.type) {
                    case 'linux':
                        $linuxServers.prepend(Nedara.renderTemplate('linux-server',
                            Object.assign({
                                'id': idx,
                                'cpu_usage_class': widget.getStatusClass(server.cpu_usage),
                                'ram_usage_class': widget.getStatusClass(server.ram_usage_percent),
                                'storage_usage_class': widget.getStatusClass(server.storage_usage_percent),
                                'health_class': widget.getHealthStatus({
                                    'cpu': server.cpu_usage,
                                    'ram': server.ram_usage_percent,
                                    'storage': server.storage_usage_percent,
                                }),
                            }, server),
                        ));
                        chartDataMap[server.chart_label] = parseFloat(server.cpu_usage);
                        let logContainer = widget.$container.find('.log-container[data-log-source="%s"]'
                            .replace('%s', server.name));
                        logContainer.html(widget.colorizeLogs(server.logs));
                        break;
                    case 'postgres':
                        document.getElementById("postgres-status").className = "status-indicator status-healthy";
                        // Update query count and database size
                        document.getElementById("main-db").textContent = server.main_db;
                        document.getElementById("query-count").textContent = server.active_queries.length;
                        document.getElementById("postgres-db-size").textContent = `${server.db_size_mb} MB | ${server.db_size_gb} GB`;
                        // Display average wait time for active queries
                        const avgWaitTimeActive = parseFloat(server.avg_wait_time_active);
                        document.getElementById("avg-wait-time-active").textContent =
                            !isNaN(avgWaitTimeActive) && avgWaitTimeActive >= 0 ? `${avgWaitTimeActive.toFixed(2)}s` : "0.00s";
                        // Display average wait time for idle queries
                        const avgWaitTimeIdle = parseFloat(server.avg_wait_time_idle);
                        document.getElementById("avg-wait-time-idle").textContent =
                            !isNaN(avgWaitTimeIdle) && avgWaitTimeIdle >= 0 ? `${avgWaitTimeIdle.toFixed(2)}s` : "0.00s";
                        _.each(server.all_databases, function (db) {
                            allDatabases.add(db);
                        });
                        // Update queries table
                        const tbody = document.querySelector("#postgres-queries tbody");
                        tbody.innerHTML = server.active_queries.map((query) => `
                            <tr data-state="${query[2]}" data-db="${query[0]}">
                                <td>
                                    db: ${query[0]}<br/> <!-- Database -->
                                    user: ${query[1]} <!-- User -->
                                </td>
                                <td>${query[2]}</td> <!-- State -->
                                <td>${query[5] || "N/A"}</td> <!-- Wait Event -->
                                <td>${query[6] && query[6] >= 0 ? `${parseFloat(query[6]).toFixed(2)}s` : "0.00s"}</td> <!-- Wait Time -->
                                <td class="truncate" style="width: 97%;" title="${query[3]}">${query[3]}</td> <!-- Query -->
                            </tr>
                        `).join("");
                        break;
                }
            });
            widget.updateDatabaseSelector([...allDatabases].sort());
            _.each(widget.charts, function (chartConf) {
                const chartInstance = widget[chartConf.id];
                if (chartInstance) {
                    const now = new Date();
                    const label = widget.formatTime(now);
                    // Update labels
                    chartInstance.data.labels.push(label);
                    if (chartInstance.data.labels.length > chartConf.maxPoints) {
                        chartInstance.data.labels.shift();
                    }
                    // Update datasets
                    _.each(chartInstance.data.datasets, function (dataset) {
                        const cpu = chartDataMap[dataset.label] || 0;
                        dataset.data.push(cpu);
                        if (dataset.data.length > chartConf.maxPoints) {
                            dataset.data.shift();
                        }
                    });
                    chartInstance.update();
                };
            });
            // Update IndexedDB
            try {
                const chartDataToStore = [];
                _.each(widget.charts, function (chartConf) {
                    const chartInstance = widget[chartConf.id];
                    if (chartInstance) {
                        _.each(chartInstance.data.datasets, function (dataset) {
                            chartDataToStore.push({
                                chart_id: chartConf.id,
                                name: dataset.label,
                                datasets: {
                                    data: dataset.data,
                                },
                                labels: chartInstance.data.labels,
                            });
                        });
                    }
                });
                await widget.db.saveChartData(widget.env, chartDataToStore);
            } catch (err) {
                console.error("Error saving chart data to DB:", err);
            }
            // Update overall status
            const timestamp = new Date();
            document.getElementById("last-update-time").textContent = widget.formatTime(timestamp);
            widget.applyFilters();
            widget.highlightCriticalQueries();
            widget.updateOverallStatus();
            widget.refreshEnvironment();
            await widget.checkWebUrlStatus();
        } catch (error) {
            console.error("Refreshing data failed:", error);
            // Set all status indicators to critical
            widget.$container.find(".status-linux-server").attr("class", "status-indicator status-critical");
            widget.$container.find("#postgres-status").attr("class", "status-indicator status-critical");
            widget.$container.find("#web-url-status").attr("class", "status-indicator status-critical");
            widget.$container.find("#overall-status").attr("class", "status-indicator status-critical");
            // Display error message
            widget.$container.find("#status-text").text("Connection Error - Unable to refresh data");
            widget.$container.find("#last-update-time").text("N/A");
            // Optionally stop further automatic refreshes
            clearInterval(5000);
        }
        widget.$container.find('#loading-container').remove();
        widget.$container.find('#monitoring').show();
    },
    changeEnvironment: async function (environment) {
        try {
            const {status, message} = await (await fetch(`/set_environment/${environment}`)).json();
            if (status === "success") {
                window.location.reload();
            } else {
                console.error("Failed to switch environment:", message);
            }
        } catch (error) {
            console.error("Error switching environment:", error);
        }
    },

    // ************************************************************
    // * HANDLERS
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
        this.changeEnvironment(ev.target.value);
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

Nedara.registerWidget("Monitoring", Monitoring);
