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
    // 1.7.0 on: the website shows only the class in the app (no website pages), and signs the app in
    // with the one-time code in the page address (#lc=...).
    appHome: true,
    // Minimizes the meeting window while sharing, and brings it back after.
    setSharing: (on) => ipcRenderer.send('lc:sharing', !!on),
    focusMeeting: () => ipcRenderer.send('lc:focus-meeting'),
    // What was picked in the app's share picker: { type: 'screen' | 'window', displayId }.
    shareInfo: () => ipcRenderer.invoke('lc:share-info'),
    // The drawing layer over the shared screen takes the mouse only while drawing ('draw'), and the
    // keyboard too for the text tool ('text').
    setAnnotating: (mode) => ipcRenderer.send('lc:annotating', mode === 'text' || mode === 'draw' ? mode : false),
    // While sharing, Participants and Chat open as floating windows of their own ('lc-people', 'lc-chat').
    floatingPanels: true,
    // Zoom's Save with no dialog: { data: PNG data URL, format: 'png' | 'pdf', name, course } -> a
    // promise of the saved file's path (in Documents/LiveClass); rejects when nothing was written.
    saveAnnotation: (image) => ipcRenderer.invoke('lc:save-annotation', {
        data: String((image && image.data) || ''),
        format: image && image.format === 'pdf' ? 'pdf' : 'png',
        name: String((image && image.name) || ''),
        course: String((image && image.course) || '')
    }),
    saveFormats: ['png', 'pdf'],
    // Opens Explorer (Finder) on a file Save wrote.
    showInFolder: (file) => ipcRenderer.send('lc:show-in-folder', String(file)),
    // The meeting window went down ({ minimized: true }) or came back; returns an unsubscribe.
    onWindowState: (fn) => {
        const listener = (event, state) => fn(state);
        ipcRenderer.on('lc:window-state', listener);
        return () => ipcRenderer.removeListener('lc:window-state', listener);
    },
    // Sizes a floating window ('lc-bar', 'lc-bartools', 'lc-annotbar', 'lc-videos', 'lc-people',
    // 'lc-chat'). anchor ({ x, y, width }): where its bar sits inside it, so the bar stays put when a
    // menu grows the window.
    setFloatingSize: (name, width, height, anchor) => ipcRenderer.send(
        'lc:float-size', String(name), Number(width), Number(height),
        anchor ? { x: Number(anchor.x), y: Number(anchor.y), width: Number(anchor.width) } : undefined
    ),
    setFloatingVisible: (name, visible) => ipcRenderer.send('lc:float-visible', String(name), !!visible),
    // Moves a floating window with the mouse from the point it was grabbed (offset inside the window)
    // until endDrag; dragging 'lc-bartools' moves the pill.
    startDrag: (name, offsetX, offsetY) => ipcRenderer.send('lc:float-drag', {
        name: String(name), phase: 'start', offsetX: Number(offsetX), offsetY: Number(offsetY)
    }),
    endDrag: (name) => ipcRenderer.send('lc:float-drag', { name: String(name), phase: 'end' }),
    // A toolbar was dropped at a screen edge ('left' / 'right') or away from it (''); returns an unsubscribe.
    onDock: (fn) => {
        const listener = (event, dock) => fn(dock);
        ipcRenderer.on('lc:dock', listener);
        return () => ipcRenderer.removeListener('lc:dock', listener);
    },
    // Whether Ctrl+Alt+Shift+H is LiveClass's now (another program may hold it): a promise of a boolean.
    controlsShortcut: () => ipcRenderer.invoke('lc:controls-shortcut'),
    // Ctrl+Alt+Shift+H while sharing: hide or show the floating meeting controls; returns an unsubscribe.
    onToggleControls: (fn) => {
        const listener = () => fn();
        ipcRenderer.on('lc:toggle-controls', listener);
        return () => ipcRenderer.removeListener('lc:toggle-controls', listener);
    }
});
