// LiveClass desktop app for teachers. It loads the live website (so site updates need no reinstall)
// and adds what a browser can't do, the way the Zoom app works:
//  - its own share picker (screens and windows) and no browser "Stop sharing / Hide" bar,
//  - the meeting window minimizes while sharing and the floating controls stay on top,
//  - annotations drawn on a see-through layer over the whole shared screen.
// The floating bar and the drawing layer are left out of the screen capture: students get the
// strokes over the data channel (as they do today), so nothing is drawn twice.
const {
    app, BrowserWindow, Menu, desktopCapturer, ipcMain, screen, session, shell, systemPreferences, webContents
} = require('electron');
const path = require('path');
const fs = require('fs');

const SITES = [
    { id: 'satarea', name: 'SATAREA', url: 'https://satarea.tech' },
    { id: 'mrshahin', name: 'Mr. Shahin', url: 'https://mrshahin.com' },
    { id: 'ais', name: 'AIS', url: 'https://ais.satarea.tech' }
];
// Development: `npm start -- --site=http://localhost:3007` opens any site.
const devSite = (process.argv.find((a) => a.startsWith('--site=')) || '').slice(7);
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const BAR = 'lc-bar';
const OVERLAY = 'lc-annotate';
const MEETING = 'lc-meeting';

// ---- Settings (the chosen site) -----------------------------------------------------------------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => {
    try {
        return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    } catch (e) {
        return {};
    }
};
const writeSettings = (value) => {
    try {
        fs.writeFileSync(settingsFile(), JSON.stringify(value));
    } catch (e) {
        // Without a settings file the site is asked again next time.
    }
};
const siteUrl = () => devSite || (SITES.find((s) => s.id === readSettings().site) || {}).url || '';

// Our sites get the app bridge, camera, microphone and screen, and stay inside the app.
const isOurs = (url) => {
    try {
        const u = new URL(url);
        if (devSite && u.origin === new URL(devSite).origin) return true;
        return u.protocol === 'https:' && /(^|\.)(satarea\.tech|mrshahin\.com)$/.test(u.hostname);
    } catch (e) {
        return false;
    }
};
// Google sign-in opens as a popup and must stay one.
const isSignIn = (url) => {
    try {
        return /(^|\.)accounts\.google\.com$/.test(new URL(url).hostname);
    } catch (e) {
        return false;
    }
};
const openOutside = (url) => {
    if (/^(https?:|mailto:)/.test(url)) shell.openExternal(url);
};
const fromOurs = (event) => !!event.senderFrame && isOurs(event.senderFrame.url);

// ---- Windows ------------------------------------------------------------------------------------
let mainWindow = null;
// Per meeting window (by webContents id): what was shared, and its floating bar / drawing layer.
const shares = new Map();
const children = new Map();
const childrenOf = (id) => {
    if (!children.has(id)) children.set(id, {});
    return children.get(id);
};

const appWebPreferences = (extra = {}) => ({
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    additionalArguments: [`--lc-version=${app.getVersion()}`],
    ...extra
});

const meetingWindowOptions = () => ({
    width: 1280,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'LiveClass',
    icon: ICON,
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    // The meeting keeps running at full speed while minimized during a share.
    webPreferences: appWebPreferences({ backgroundThrottling: false })
});

const sharedDisplay = (openerId) => {
    const share = shares.get(openerId);
    const all = screen.getAllDisplays();
    return (share && all.find((d) => String(d.id) === String(share.displayId))) || screen.getPrimaryDisplay();
};

// The floating bar: top centre of the shared screen, above everything, not in the capture.
const setUpBar = (win, openerId) => {
    childrenOf(openerId).bar = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    const area = sharedDisplay(openerId).workArea;
    const [width] = win.getSize();
    win.setPosition(Math.round(area.x + (area.width - width) / 2), area.y + 12);
    win.on('closed', () => { if (childrenOf(openerId).bar === win) delete childrenOf(openerId).bar; });
};

// The drawing layer: covers the shared screen, lets the mouse through unless drawing, never takes
// focus (so it can't cover the bar), and is not in the capture.
const setUpOverlay = (win, openerId) => {
    const kids = childrenOf(openerId);
    kids.overlay = win;
    win.setBounds(sharedDisplay(openerId).bounds);
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    if (kids.bar && !kids.bar.isDestroyed()) kids.bar.moveTop();
    win.on('closed', () => { if (childrenOf(openerId).overlay === win) delete childrenOf(openerId).overlay; });
};

function wireContents(contents) {
    contents.setWindowOpenHandler(({ url, frameName }) => {
        if (frameName === BAR && url === 'about:blank') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    frame: false, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
                    skipTaskbar: true, backgroundColor: '#1a1a1a', title: 'LiveClass', icon: ICON
                }
            };
        }
        if (frameName === OVERLAY && url === 'about:blank') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false,
                    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
                    skipTaskbar: true, enableLargerThanScreen: true, show: true
                }
            };
        }
        if (isOurs(url)) {
            const meeting = frameName === MEETING && BrowserWindow.getAllWindows().find((w) => w.lcMeeting && !w.isDestroyed());
            if (meeting) {
                if (meeting.isMinimized()) meeting.restore();
                meeting.focus();
                return { action: 'deny' };
            }
            return { action: 'allow', overrideBrowserWindowOptions: meetingWindowOptions() };
        }
        if (isSignIn(url)) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: { width: 500, height: 640, autoHideMenuBar: true, webPreferences: { preload: undefined, sandbox: true, contextIsolation: true } }
            };
        }
        openOutside(url);
        return { action: 'deny' };
    });

    contents.on('did-create-window', (win, { frameName, url }) => {
        if (frameName === BAR) return setUpBar(win, contents.id);
        if (frameName === OVERLAY) return setUpOverlay(win, contents.id);
        if (isOurs(url)) {
            win.lcMeeting = frameName === MEETING;
            win.setMenuBarVisibility(false);
            wireContents(win.webContents);
        }
        return undefined;
    });

    contents.on('will-navigate', (event, url) => {
        if (isOurs(url) || isSignIn(url) || url.startsWith('file:')) return;
        event.preventDefault();
        openOutside(url);
    });

    const id = contents.id;
    contents.on('destroyed', () => {
        const kids = children.get(id) || {};
        [kids.bar, kids.overlay].forEach((w) => { if (w && !w.isDestroyed()) w.close(); });
        children.delete(id);
        shares.delete(id);
    });
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        title: 'LiveClass',
        icon: ICON,
        backgroundColor: '#1a1a1a',
        autoHideMenuBar: true,
        webPreferences: appWebPreferences()
    });
    wireContents(mainWindow.webContents);
    const url = siteUrl();
    if (url) mainWindow.loadURL(url);
    else mainWindow.loadFile(path.join(__dirname, 'site.html'));
    mainWindow.on('closed', () => { mainWindow = null; });
}

const chooseSite = () => {
    if (!mainWindow) return;
    mainWindow.loadFile(path.join(__dirname, 'site.html'));
};

// ---- Share picker (Zoom's "Select a window or an application that you want to share") -----------
const pageLanguage = (contents) => contents.executeJavaScript("localStorage.getItem('i18nextLng') || document.documentElement.lang || ''", true)
    .then((lang) => (String(lang).startsWith('ar') ? 'ar' : 'en'))
    .catch(() => 'en');

const picking = new Set();

async function pickShare(request, callback) {
    const contents = request.frame && webContents.fromFrame(request.frame);
    const parent = contents && BrowserWindow.fromWebContents(contents);
    // One picker per meeting window at a time.
    if (!contents || !parent || !isOurs(request.frame.url) || picking.has(contents.id)) return callback({});
    picking.add(contents.id);

    // Our own windows (meeting, bar, drawing layer) are never offered.
    const ours = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    let sources = [];
    try {
        sources = (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true }))
            .filter((s) => !ours.has(s.id));
    } catch (e) {
        sources = [];
    }
    const screenAccess = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';

    const picker = new BrowserWindow({
        parent,
        modal: true,
        width: 860,
        height: 620,
        minWidth: 600,
        minHeight: 460,
        title: 'LiveClass',
        icon: ICON,
        backgroundColor: '#1a1a1a',
        autoHideMenuBar: true,
        minimizable: false,
        maximizable: false,
        show: false,
        webPreferences: { preload: path.join(__dirname, 'local-preload.js'), contextIsolation: true, sandbox: true }
    });
    picker.setMenuBarVisibility(false);
    let answered = false;
    const answer = (streams) => {
        if (answered) return;
        answered = true;
        picking.delete(contents.id);
        try {
            callback(streams);
        } catch (e) {
            // The page stopped waiting (it was closed).
        }
    };

    const onChoose = (event, choice) => {
        if (event.sender !== picker.webContents) return;
        const source = choice && sources.find((s) => s.id === choice.id);
        if (source) {
            shares.set(contents.id, { type: source.id.startsWith('screen:') ? 'screen' : 'window', displayId: source.display_id || '' });
            answer({ video: source, ...(choice.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
        } else {
            answer({});
        }
        if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.on('picker:choose', onChoose);
    picker.on('closed', () => {
        ipcMain.removeListener('picker:choose', onChoose);
        answer({});
    });

    const lang = await pageLanguage(contents);
    picker.webContents.once('did-finish-load', () => {
        picker.webContents.send('picker:sources', {
            lang,
            platform: process.platform,
            screenAccess,
            sources: sources.map((s) => ({
                id: s.id,
                name: s.name,
                type: s.id.startsWith('screen:') ? 'screen' : 'window',
                thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
                icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
            }))
        });
        picker.show();
    });
    picker.loadFile(path.join(__dirname, 'picker.html'));
    return undefined;
}

// ---- Bridge for the meeting page (window.satDesktop, see preload.js) -----------------------------
ipcMain.on('lc:sharing', (event, on) => {
    if (!fromOurs(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (on) {
        if (!win.isMinimized()) win.minimize();
    } else {
        shares.delete(event.sender.id);
        if (win.isMinimized()) win.restore();
        win.focus();
    }
});

ipcMain.on('lc:focus-meeting', (event) => {
    if (!fromOurs(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
});

ipcMain.handle('lc:share-info', (event) => (fromOurs(event) ? shares.get(event.sender.id) || null : null));

// Drawing: the layer takes the mouse; otherwise clicks go through to the shared apps.
ipcMain.on('lc:annotating', (event, on) => {
    if (!fromOurs(event)) return;
    const kids = children.get(event.sender.id) || {};
    if (!kids.overlay || kids.overlay.isDestroyed()) return;
    kids.overlay.setIgnoreMouseEvents(!on);
    if (kids.bar && !kids.bar.isDestroyed()) kids.bar.moveTop();
});

ipcMain.on('site:choose', (event, id) => {
    const site = SITES.find((s) => s.id === id);
    if (!site || !event.senderFrame || !event.senderFrame.url.startsWith('file:')) return;
    writeSettings({ ...readSettings(), site: site.id });
    if (mainWindow) mainWindow.loadURL(site.url);
});
ipcMain.handle('site:list', () => ({ sites: SITES, current: readSettings().site || '' }));

// ---- App ----------------------------------------------------------------------------------------
function buildMenu() {
    const template = [
        ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
        {
            label: 'LiveClass',
            submenu: [
                { label: 'Change site…', click: chooseSite, enabled: !devSite },
                { role: 'reload' },
                ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        { role: 'editMenu' },
        { role: 'windowMenu' }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (!mainWindow) return createMainWindow();
        if (mainWindow.isMinimized()) mainWindow.restore();
        return mainWindow.focus();
    });

    app.whenReady().then(() => {
        const ses = session.defaultSession;
        const allowed = ['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'notifications'];
        ses.setPermissionRequestHandler((contents, permission, done, details) => {
            const ok = allowed.includes(permission) && isOurs(details.requestingUrl || contents.getURL());
            if (ok && permission === 'media' && process.platform === 'darwin') {
                const kinds = (details.mediaTypes || []).map((m) => (m === 'video' ? 'camera' : 'microphone'));
                return Promise.all(kinds.map((k) => systemPreferences.askForMediaAccess(k))).then(() => done(true), () => done(true));
            }
            return done(ok);
        });
        ses.setPermissionCheckHandler((contents, permission, origin) => allowed.includes(permission) && isOurs(origin));
        ses.setDisplayMediaRequestHandler(pickShare);

        buildMenu();
        createMainWindow();
        app.on('activate', () => { if (!mainWindow) createMainWindow(); });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
