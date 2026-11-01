'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photochooser', {
    platform: process.platform,
    versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome
    },
    pickFolder: function () {
        return ipcRenderer.invoke('pc:pick-folder');
    },
    trash: function (paths) {
        return ipcRenderer.invoke('pc:trash', paths);
    },
    reveal: function (target) {
        return ipcRenderer.invoke('pc:reveal', target);
    }
});
