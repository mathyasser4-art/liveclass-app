// window.satDesktop: what the website's LiveClass uses when it runs inside the app (see
// src/pages/liveClass/desktopApp.js in the website). The main process only answers our own sites.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
    const found = (process.argv || []).find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : '';
};

contextBridge.exposeInMainWorld('satDesktop', {
    version: arg('lc-version'),
    platform: process.platform,
    // 'meeting' in a meeting window (its "back" closes the window).
    windowKind: arg('lc-window'),
    // Minimizes the meeting window while sharing, and brings it back after.
    setSharing: (on) => ipcRenderer.send('lc:sharing', !!on),
    focusMeeting: () => ipcRenderer.send('lc:focus-meeting'),
    // What was picked in the app's share picker: { type: 'screen' | 'window', displayId }.
    shareInfo: () => ipcRenderer.invoke('lc:share-info'),
    // The drawing layer over the shared screen takes the mouse only while drawing ('draw'), and the
    // keyboard too for the text tool ('text').
    setAnnotating: (mode) => ipcRenderer.send('lc:annotating', mode === 'text' || mode === 'draw' ? mode : false),
    // Sizes a floating window ('lc-bar', 'lc-annotbar', 'lc-videos'); the pill and pen bar stay centred.
    setFloatingSize: (name, width, height) => ipcRenderer.send('lc:float-size', String(name), Number(width), Number(height))
});

// The first-launch site choice (site.html) runs in the main window too.
if (window.location.protocol === 'file:') {
    contextBridge.exposeInMainWorld('lcApp', {
        sites: () => ipcRenderer.invoke('site:list'),
        chooseSite: (id) => ipcRenderer.send('site:choose', id)
    });
}
