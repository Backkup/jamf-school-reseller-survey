const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    addMaster: (master) => ipcRenderer.invoke('add-master', master),
    removeMaster: (masterId) => ipcRenderer.invoke('remove-master', masterId),
    addInstance: (payload) => ipcRenderer.invoke('add-instance', payload),
    removeInstance: (payload) => ipcRenderer.invoke('remove-instance', payload),
    updateInstance: (payload) => ipcRenderer.invoke('update-instance', payload),
    updateMaster: (payload) => ipcRenderer.invoke('update-master', payload),
    setReason: (payload) => ipcRenderer.invoke('set-reason', payload),
    startScraper: (masterId) => ipcRenderer.invoke('start-scraper', { masterId }),
    onProgress: (cb) => ipcRenderer.on('progress', (_, data) => cb(data)),
    onDone: (cb) => ipcRenderer.on('done', (_, data) => cb(data)),
    onScraperDone: (cb) => ipcRenderer.on('scraper-done', (_, data) => cb(data)),
});
