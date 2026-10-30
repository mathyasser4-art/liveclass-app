// LiveClass desktop app for teachers. It loads the live website (so site updates need no reinstall)
// and adds what a browser can't do, the way the Zoom app works:
//  - its own share picker (screens and windows) and no browser "Stop sharing / Hide" bar,
//  - while sharing the meeting window minimizes; the "You are screen sharing" pill/toolbar, the
//    annotation toolbar and a small video window float on top,
//  - annotations drawn on a see-through layer (with Zoom's green border) over the shared screen,
//  - liveclass:// links: "Start LiveClass" on the website opens the meeting straight in the app.
// The floating windows and the drawing layer are left out of the screen capture: students get the
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
// Development runs get their own profile, so they work next to an installed LiveClass.
if (devSite) app.setPath('userData', path.join(app.getPath('appData'), 'LiveClass-dev'));
// Chromium stops painting windows it thinks are covered; the see-through share windows sit on top of
// each other and of the shared screen, so that guess is wrong for them.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const BAR = 'lc-bar';
const ANNOT_BAR = 'lc-annotbar';
const VIDEOS = 'lc-videos';
const OVERLAY = 'lc-annotate';
const MEETING = 'lc-meeting';
const FLOATING = [BAR, ANNOT_BAR, VIDEOS];
const PROTOCOL = 'liveclass';

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
const pendingSizes = new Map();
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
    webPreferences: appWebPreferences({
        backgroundThrottling: false,
        additionalArguments: [`--lc-version=${app.getVersion()}`, '--lc-window=meeting']
    })
});

const sharedDisplay = (openerId) => {
    const share = shares.get(openerId);
    const all = screen.getAllDisplays();
    return (share && all.find((d) => String(d.id) === String(share.displayId))) || screen.getPrimaryDisplay();
};

// The floating windows stay above the drawing layer.
const raiseFloating = (openerId) => {
    const kids = childrenOf(openerId);
    [ANNOT_BAR, VIDEOS, BAR].forEach((name) => {
        const w = kids[name];
        // Re-asserting "topmost" moves a window to the top of that band without moving, sizing or
        // showing it (moveTop would re-show the hidden pen bar). The share toolbar goes last: when it
        // opens (with its menu or a notice) it is what the teacher is using.
        if (w && !w.isDestroyed() && w.isVisible()) w.setAlwaysOnTop(true, 'screen-saver');
    });
};

// Floating windows (share pill/toolbar, annotation toolbar, videos): above everything on the shared
// screen, not in the capture. The pill sits top centre, the pen tools under it, videos top right.
const setUpFloating = (win, openerId, name) => {
    childrenOf(openerId)[name] = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    const [width, height] = win.getSize();
    setBoundsQuietly(win, homeBounds(openerId, name, width, height));
    win.on('closed', () => { if (childrenOf(openerId)[name] === win) delete childrenOf(openerId)[name]; });
    if (name !== VIDEOS) {
        // Only the teacher's own drags dock or undock a toolbar (our resizes move it too); decided once
        // the window stops moving.
        let settle = null;
        win.on('move', () => {
            if (win.lcResizing) return;
            // Where the teacher put it, right away (a resize during or just after the drag keeps it).
            const dropped = win.getBounds();
            win.lcCenter = dropped.x + dropped.width / 2;
            clearTimeout(settle);
            settle = setTimeout(() => {
                if (win.isDestroyed()) return;
                const side = dockSide(dropped);
                if (side === (win.lcDock || '')) return;
                win.lcDock = side;
                const opener = webContents.fromId(openerId);
                if (opener && !opener.isDestroyed()) opener.send('lc:dock', { name, side });
                // A share toolbar docking where the pen bar already is pushes the pen bar under it.
                const pen = childrenOf(openerId)[ANNOT_BAR];
                if (name === BAR && side && pen && !pen.isDestroyed() && pen.lcDock === side) {
                    const [pw, ph] = pen.getSize();
                    setTimeout(() => { if (!pen.isDestroyed()) applySize(pen, openerId, ANNOT_BAR, pw, ph); }, 400);
                }
            }, 300);
        });
    }
    const pending = pendingSizes.get(`${openerId}:${name}`);
    pendingSizes.delete(`${openerId}:${name}`);
    if (pending) applySize(win, openerId, name, pending[0], pending[1]);
    attachToLayer(openerId);
};

// Where each floating window first appears (DIP). Nothing overlaps, even with the share toolbar open
// (about 112 px tall): pill top centre, pen bar under it, preview on the right below both.
const PEN_BAR_TOP = 132;
const VIDEOS_TOP = 214;
const homeBounds = (openerId, name, w, h) => {
    const area = sharedDisplay(openerId).workArea;
    if (name === VIDEOS) return { x: area.x + area.width - w - 16, y: area.y + VIDEOS_TOP, width: w, height: h };
    return { x: Math.round(area.x + (area.width - w) / 2), y: area.y + (name === ANNOT_BAR ? PEN_BAR_TOP : 6), width: w, height: h };
};

// Our own resizes must not count as the teacher moving a toolbar.
const setBoundsQuietly = (win, bounds) => {
    win.lcResizing = true;
    try {
        win.setBounds(bounds);
    } finally {
        win.lcResizing = false;
    }
};

// A toolbar dropped within reach of the left or right screen edge docks there and turns vertical.
const DOCK_REACH = 40;
const dockSide = (b) => {
    const area = screen.getDisplayMatching(b).workArea;
    if (b.x <= area.x + DOCK_REACH) return 'left';
    if (b.x + b.width >= area.x + area.width - DOCK_REACH) return 'right';
    return '';
};

// The drawing layer: covers the shared screen, lets the mouse through unless drawing, never takes
// focus (so it can't cover the bar), and is not in the capture.
const setUpOverlay = (win, openerId) => {
    const kids = childrenOf(openerId);
    kids.overlay = win;
    win.lcFocusable = false;
    win.setBounds(sharedDisplay(openerId).bounds);
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    attachToLayer(openerId);
    raiseFloating(openerId);
    // The toolbars outlive the layer when a New Share switches from a screen to a window.
    win.on('close', () => {
        FLOATING.forEach((name) => {
            const w = childrenOf(openerId)[name];
            if (w && !w.isDestroyed() && w.getParentWindow() === win) {
                w.setParentWindow(null);
                w.setAlwaysOnTop(true, 'screen-saver');
            }
        });
    });
    win.on('closed', () => { if (childrenOf(openerId).overlay === win) delete childrenOf(openerId).overlay; });
};

// All these windows are "always on top", and Windows doesn't keep an order among them: after a click
// on the drawing layer it could end up over the toolbars, which then took no clicks. A window's own
// windows always stay above it, so the toolbars and the preview belong to the layer.
function attachToLayer(openerId) {
    const kids = childrenOf(openerId);
    const layer = kids.overlay;
    if (!layer || layer.isDestroyed()) return;
    FLOATING.forEach((name) => {
        const w = kids[name];
        if (!w || w.isDestroyed() || w.getParentWindow() === layer) return;
        const visible = w.isVisible();
        w.setParentWindow(layer);
        if (!visible) w.hide();
    });
}

function wireContents(contents) {
    contents.setWindowOpenHandler(({ url, frameName }) => {
        if (FLOATING.includes(frameName) && url === 'about:blank') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
                    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, title: 'LiveClass', icon: ICON,
                    focusable: false,
                    show: frameName !== ANNOT_BAR,
                    webPreferences: { backgroundThrottling: false }
                }
            };
        }
        if (frameName === OVERLAY && url === 'about:blank') {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false,
                    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
                    skipTaskbar: true, enableLargerThanScreen: true, show: true,
                    webPreferences: { backgroundThrottling: false }
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
        if (FLOATING.includes(frameName)) return setUpFloating(win, contents.id, frameName);
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
    const closeKids = () => {
        const kids = children.get(id) || {};
        [...FLOATING.map((name) => kids[name]), kids.overlay].forEach((w) => { if (w && !w.isDestroyed()) w.close(); });
        children.delete(id);
        shares.delete(id);
    };
    contents.on('destroyed', closeKids);
    // A reload or another page: the old page's share windows go with it.
    contents.on('did-start-navigation', (details) => {
        if (details && details.isMainFrame && !details.isSameDocument) closeKids();
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

    // New Share is asked for while the meeting is minimized: then the picker stands on its own, on top.
    const hidden = parent.isMinimized();
    const picker = new BrowserWindow({
        ...(hidden ? { alwaysOnTop: true } : { parent, modal: true }),
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

// Pages can't make their popups smaller than 100 px, so the floating windows are sized here.
ipcMain.on('lc:float-size', (event, name, width, height) => {
    if (!fromOurs(event) || !FLOATING.includes(name)) return;
    const win = (children.get(event.sender.id) || {})[name];
    // Asked before the window was set up: applied by setUpFloating.
    if (!win || win.isDestroyed()) {
        pendingSizes.set(`${event.sender.id}:${name}`, [width, height]);
        return;
    }
    applySize(win, event.sender.id, name, width, height);
});

function applySize(win, openerId, name, width, height) {
    const w = Math.round(Math.min(Math.max(width, 40), 1600));
    const h = Math.round(Math.min(Math.max(height, 24), 1200));
    // The first size also places the window (Chromium may still move a new popup after it opens).
    if (!win.lcPlaced) {
        win.lcPlaced = true;
        const home = homeBounds(openerId, name, w, h);
        win.lcCenter = home.x + w / 2;
        setBoundsQuietly(win, home);
        return;
    }
    const old = win.getBounds();
    const area = screen.getDisplayMatching(old).workArea;
    // Docked toolbars hug their edge (and grow away from it); the preview keeps its right edge; the
    // others keep their centre, so opening and folding the toolbar never shifts the pill.
    let x;
    if (win.lcDock === 'left') x = area.x + 4;
    else if (win.lcDock === 'right') x = area.x + area.width - w - 4;
    else if (name === VIDEOS) x = old.x + old.width - w;
    else x = Math.round((typeof win.lcCenter === 'number' ? win.lcCenter : old.x + old.width / 2) - w / 2);
    x = Math.max(area.x, Math.min(x, area.x + area.width - w));
    let y = Math.max(area.y, Math.min(old.y, area.y + area.height - h));
    // Both toolbars docked on the same side: the pen bar goes under the share toolbar.
    if (name === ANNOT_BAR && win.lcDock) {
        const bar = childrenOf(openerId)[BAR];
        if (bar && !bar.isDestroyed() && bar.lcDock === win.lcDock) {
            const b = bar.getBounds();
            if (y < b.y + b.height + 8 && y + h > b.y) y = Math.min(b.y + b.height + 8, area.y + area.height - h);
        }
    }
    setBoundsQuietly(win, { x, y, width: w, height: h });
}

ipcMain.on('lc:float-visible', (event, name, visible) => {
    if (!fromOurs(event) || !FLOATING.includes(name)) return;
    const win = (children.get(event.sender.id) || {})[name];
    if (!win || win.isDestroyed()) return;
    if (!visible) return win.hide();
    win.showInactive();
    return raiseFloating(event.sender.id);
});

ipcMain.handle('lc:share-info', (event) => (fromOurs(event) ? shares.get(event.sender.id) || null : null));

// Drawing ('draw'): the layer takes the mouse; typing ('text') also needs the keyboard; otherwise
// (false) clicks go through to the shared apps.
ipcMain.on('lc:annotating', (event, mode) => {
    if (!fromOurs(event)) return;
    const kids = children.get(event.sender.id) || {};
    const layer = kids.overlay;
    if (!layer || layer.isDestroyed()) return;
    layer.setIgnoreMouseEvents(!mode);
    // Only the text tool needs the keyboard; changing this re-arranges the window, so only on change.
    const wantFocus = mode === 'text';
    if (layer.lcFocusable !== wantFocus) {
        layer.lcFocusable = wantFocus;
        layer.setFocusable(wantFocus);
        layer.setSkipTaskbar(true);
    }
    if (wantFocus) layer.focus();
    raiseFloating(event.sender.id);
});

ipcMain.on('site:choose', (event, id) => {
    const site = SITES.find((s) => s.id === id);
    if (!site || !event.senderFrame || !event.senderFrame.url.startsWith('file:')) return;
    writeSettings({ ...readSettings(), site: site.id });
    if (mainWindow) mainWindow.loadURL(site.url);
});
ipcMain.handle('site:list', () => ({ sites: SITES, current: readSettings().site || '' }));

// ---- liveclass:// links ------------------------------------------------------------------------
// liveclass://open?url=<https://satarea.tech/live/<courseId>>, from "Start LiveClass" on the website:
// the meeting opens in its own window (signed in with the app's own login).
const linkFrom = (argv) => (argv || []).find((a) => typeof a === 'string' && a.startsWith(`${PROTOCOL}://`));
let pendingLink = linkFrom(process.argv);

function openLink(link) {
    let target;
    try {
        target = new URL(link).searchParams.get('url');
    } catch (e) {
        return;
    }
    if (!target || !isOurs(target)) return;
    // The first link also picks the site for the main window.
    const site = SITES.find((s) => new URL(s.url).origin === new URL(target).origin);
    if (site && !readSettings().site) writeSettings({ ...readSettings(), site: site.id });
    const existing = BrowserWindow.getAllWindows().find((w) => w.lcMeeting && !w.isDestroyed());
    if (existing) {
        if (existing.webContents.getURL() !== target) existing.loadURL(target);
        if (existing.isMinimized()) existing.restore();
        existing.focus();
        return;
    }
    const win = new BrowserWindow(meetingWindowOptions());
    win.lcMeeting = true;
    win.setMenuBarVisibility(false);
    wireContents(win.webContents);
    win.loadURL(target);
}

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
    // Windows: links start the app with the link as an argument (or reach the running app here).
    // Development runs leave the link to the installed app (pass a link on the command line instead).
    if (app.isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    // macOS: links arrive as an event.
    app.on('open-url', (event, link) => {
        event.preventDefault();
        if (app.isReady()) openLink(link);
        else pendingLink = link;
    });

    app.on('second-instance', (event, argv) => {
        const link = linkFrom(argv);
        if (link) return openLink(link);
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
        // Opened from a link: just the meeting, like Zoom (the main window opens when asked for).
        if (pendingLink) openLink(pendingLink);
        else createMainWindow();
        pendingLink = null;
        app.on('activate', () => { if (!mainWindow) createMainWindow(); });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
