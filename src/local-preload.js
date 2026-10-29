// Bridge for the share picker (picker.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lcApp', {
    onSources: (fn) => ipcRenderer.on('picker:sources', (event, data) => fn(data)),
    choose: (choice) => ipcRenderer.send('picker:choose', choice)
});
