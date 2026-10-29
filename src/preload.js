// window.satDesktop: what the website's LiveClass uses when it runs inside the app (see
// src/pages/liveClass/desktopApp.js in the website). The main process only answers our own sites.
const { contextBridge, ipcRenderer } = require('electron');

const versionArg = (process.argv || []).find((a) => a.startsWith('--lc-version='));

contextBridge.exposeInMainWorld('satDesktop', {
    version: versionArg ? versionArg.slice('--lc-version='.length) : '',
    platform: process.platform,
    // Minimizes the meeting window while sharing, and brings it back after.
    setSharing: (on) => ipcRenderer.send('lc:sharing', !!on),
    focusMeeting: () => ipcRenderer.send('lc:focus-meeting'),
    // What was picked in the app's share picker: { type: 'screen' | 'window', displayId }.
    shareInfo: () => ipcRenderer.invoke('lc:share-info'),
    // The drawing layer over the shared screen takes the mouse only while drawing.
    setAnnotating: (on) => ipcRenderer.send('lc:annotating', !!on)
});

// The first-launch site choice (site.html) runs in the main window too.
if (window.location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('lcApp', {
        sites: () => ipcRenderer.invoke('site:list'),
        chooseSite: (id) => ipcRenderer.send('site:choose', id)
    });
}
