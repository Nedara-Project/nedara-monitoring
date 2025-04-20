"use strict";

class MonitoringDB {
    constructor(dbName = 'NedaraMonitoringDB', dbVersion = 1) {
        this.dbName = dbName;
        this.dbVersion = dbVersion;
        this.db = null;
    }

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = (event) => {
                console.error("Database error:", event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('chartData')) {
                    db.createObjectStore('chartData', {keyPath: 'env'});
                }
            };
        });
    }

    async saveChartData(env, data) {
        if (!this.db) {
            await this.open();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['chartData'], 'readwrite');
            const store = transaction.objectStore('chartData');

            const request = store.put({env, data});

            request.onsuccess = () => resolve();
            request.onerror = (event) => {
                console.error("Error saving chart data:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    async getChartData(env) {
        if (!this.db) {
            await this.open();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['chartData'], 'readonly');
            const store = transaction.objectStore('chartData');

            const request = store.get(env);

            request.onsuccess = () => resolve(request.result ? request.result.data : null);
            request.onerror = (event) => {
                console.error("Error getting chart data:", event.target.error);
                reject(event.target.error);
            };
        });
    }

    async clearAllData() {
        if (!this.db) {
            await this.open();
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['chartData'], 'readwrite');
            const store = transaction.objectStore('chartData');

            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = (event) => {
                console.error("Error clearing data:", event.target.error);
                reject(event.target.error);
            };
        });
    }
}

export default MonitoringDB;
