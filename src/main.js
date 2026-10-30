// LiveClass desktop app for teachers. It loads the live website (so site updates need no reinstall)
// and adds what a browser can't do, the way the Zoom app works:
//  - its own share picker (screens and windows) and no browser "Stop sharing / Hide" bar,
//  - while sharing the meeting window minimizes; the "You are screen sharing" pill/toolbar, the
//    annotation toolbar and a small video window float on top,
//  - annotations drawn on a see-through layer (with Zoom's green border) over the shared screen; a
//    shared window gets the green border too, following it (Windows),
//  - liveclass:// links: "Start LiveClass" on the website opens the meeting straight in the app.
//  - Participants and Chat open as windows of their own over the shared screen, like Zoom's.
//  - Save (annotations) writes straight to Documents/LiveClass, one folder per meeting, no dialog.
// The floating windows, the drawing layer, the share picker and (while sharing) the meeting window are
// left out of the screen capture: students never see LiveClass itself, and they get the strokes over
// the data channel (as they do today), so nothing is drawn twice.
const {
    app, BrowserWindow, Menu, desktopCapturer, globalShortcut, ipcMain, nativeImage, screen, session, shell, systemPreferences,
    webContents
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
// The share toolbar: its own window under the pill, shown while the pill or it is hovered, so the
// pill itself never resizes (resizing a window under the mouse made it twitch).
const BAR_TOOLS = 'lc-bartools';
const ANNOT_BAR = 'lc-annotbar';
const VIDEOS = 'lc-videos';
const OVERLAY = 'lc-annotate';
const MEETING = 'lc-meeting';
// Zoom's floating Participants and Chat windows while sharing. They take the keyboard (chat, search);
// every other floating window never does.
const PEOPLE = 'lc-people';
const CHAT = 'lc-chat';
const PANELS = [PEOPLE, CHAT];
const FLOATING = [BAR, BAR_TOOLS, ANNOT_BAR, VIDEOS, ...PANELS];
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
    [...PANELS, ANNOT_BAR, VIDEOS, BAR, BAR_TOOLS].forEach((name) => {
        const w = kids[name];
        // Re-asserting "topmost" moves a window to the top of that band without moving, sizing or
        // showing it (moveTop would re-show the hidden pen bar). The share toolbar goes last: when it
        // opens (with its menu or a notice) it is what the teacher is using.
        if (w && !w.isDestroyed() && w.isVisible()) w.setAlwaysOnTop(true, 'screen-saver');
    });
    // A share picker opened over the share (New Share) stays above them all until it is answered.
    const picker = pickers.get(openerId);
    if (picker && !picker.isDestroyed() && picker.isVisible()) picker.setAlwaysOnTop(true, 'screen-saver');
};

// Floating windows (share pill/toolbar, annotation toolbar, videos): above everything on the shared
// screen, not in the capture. The pill sits top centre, the pen tools under it, videos top right.
const setUpFloating = (win, openerId, name) => {
    childrenOf(openerId)[name] = win;
    // Whether the page wants it on screen (the pen bar and the toolbar open hidden); keepControls
    // brings back a window that should show and doesn't.
    win.lcWantShown = name !== ANNOT_BAR && name !== BAR_TOOLS;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setContentProtection(true);
    const [width, height] = win.getSize();
    const panel = PANELS.includes(name);
    if (name === BAR_TOOLS) placeTools(openerId, width, height);
    else if (panel) win.lcWanted = [width, height];
    else setBoundsQuietly(win, homeBounds(openerId, name, width, height));
    win.on('closed', () => {
        stopDrag(win);
        if (childrenOf(openerId)[name] === win) delete childrenOf(openerId)[name];
        // The video window takes back the room a closed panel leaves.
        if (panel) layoutRight(openerId);
    });
    // Typing in Chat brings its window up among the always-on-top ones: the toolbars go back over it.
    if (panel) win.on('focus', () => raiseFloating(openerId));
    if (name !== VIDEOS && name !== BAR_TOOLS && !panel) {
        // Pages from before the page-driven drag move the toolbars by drag regions: only the teacher's
        // own drags dock or undock them (our resizes and drags move them too), once the window stops.
        let settle = null;
        win.on('move', () => {
            if (win.lcResizing || win.lcDrag) return;
            // Where the teacher put it, right away (a resize during or just after the drag keeps it).
            const dropped = win.getBounds();
            win.lcCenter = barCentre(win, dropped);
            clearTimeout(settle);
            settle = setTimeout(() => { if (!win.isDestroyed()) decideDock(win, openerId, name, dropped); }, 300);
        });
    }
    const pending = pendingSizes.get(`${openerId}:${name}`);
    pendingSizes.delete(`${openerId}:${name}`);
    if (pending) applySize(win, openerId, name, ...pending);
    attachToLayer(openerId);
    if (panel) {
        layoutRight(openerId);
        // Chat comes up ready to type in; Participants doesn't take the keyboard from the shared app.
        if (name === CHAT) win.show();
        else win.showInactive();
        raiseFloating(openerId);
    }
};

// A toolbar dropped at the left or right screen edge docks there (the page turns it vertical).
function decideDock(win, openerId, name, dropped) {
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
}

// The page says where its bar sits inside the window (anchor: { x, y, width }): a menu sticking out
// to one side grows the window that way while the bar itself stays put.
const anchorMid = (anchor, width) => (anchor ? anchor.x + anchor.width / 2 : width / 2);
const barCentre = (win, b) => b.x + anchorMid(win.lcAnchor, b.width);

// Where each floating window first appears (DIP): pill top centre, pen bar under it, preview on the
// right below both. Nothing overlaps even with the toolbar out under the pill and a notice under it
// (pill 6 + 38, toolbar from 46, about 57 + 41 tall, so down to about 144): the toolbar window is
// raised last, and it must not lie over the pen bar's buttons.
const PEN_BAR_TOP = 160;
const VIDEOS_TOP = 242;
const homeBounds = (openerId, name, w, h, anchor) => {
    const area = sharedDisplay(openerId).workArea;
    if (name === VIDEOS) return { x: area.x + area.width - w - 16, y: area.y + VIDEOS_TOP, width: w, height: h };
    return {
        x: Math.round(area.x + area.width / 2 - anchorMid(anchor, w)),
        y: area.y + (name === ANNOT_BAR ? PEN_BAR_TOP : 6) - (anchor ? anchor.y : 0),
        width: w,
        height: h
    };
};

// Participants and Chat stand at the right edge of the shared screen like Zoom's (Chat outermost), left
// of a toolbar docked there, and the video window moves left of them, so nothing overlaps. They also
// stay clear of the pill with its toolbar and notice and of the pen bar: those are raised over them,
// so a panel under them would lose its title bar and search to their see-through windows. Windows the
// teacher has moved stay where they were put.
const PANEL_EDGE = 16;
const PANEL_GAP = 8;
const PANEL_MIN = 280;
// The toolbar (about 57) and a notice (about 41) hanging off the pill, whether out or not: the panels
// don't jump each time the toolbar comes out.
const TOOLS_ROOM = 104;
// A horizontal pen bar (its window grows with an open menu, which comes and goes).
const PEN_ROOM = 64;
const live = (w) => !!w && !w.isDestroyed();

// The screen strips the undocked pill (with its toolbar) and pen bar keep for themselves. Measured on
// the bars themselves (the anchors), so an open menu doesn't move the panels. The pen bar counts while
// hidden too: it comes back where it was whenever the teacher annotates.
function controlZones(kids) {
    const zones = [];
    const bar = kids[BAR];
    if (live(bar) && !bar.lcDock) {
        const b = bar.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        let left = b.x;
        let right = b.x + b.width;
        const tools = kids[BAR_TOOLS];
        if (live(tools) && tools.lcPlaced) {
            const t = tools.getBounds();
            const a = tools.lcAnchor;
            left = Math.min(left, t.x + (a ? a.x : 0));
            right = Math.max(right, t.x + (a ? a.x + a.width : t.width));
        }
        // Like placeTools: the toolbar hangs under the pill, or over it when the pill is at the bottom.
        const below = b.y + b.height + 2 + TOOLS_ROOM <= area.y + area.height;
        zones.push(below
            ? { left, right, top: b.y, bottom: b.y + b.height + 2 + TOOLS_ROOM }
            : { left, right, top: b.y - 2 - TOOLS_ROOM, bottom: b.y + b.height });
    }
    const pen = kids[ANNOT_BAR];
    if (live(pen) && pen.lcPlaced && !pen.lcDock) {
        const p = pen.getBounds();
        const a = pen.lcAnchor;
        const left = p.x + (a ? a.x : 0);
        const top = p.y + (a ? a.y : 0);
        zones.push({ left, right: a ? left + a.width : p.x + p.width, top, bottom: top + Math.min(p.height, PEN_ROOM) });
    }
    return zones;
}

function layoutRight(openerId) {
    const kids = children.get(openerId);
    if (!kids) return;
    const area = sharedDisplay(openerId).workArea;
    let right = area.x + area.width - PANEL_EDGE;
    [BAR, ANNOT_BAR].forEach((name) => {
        const w = kids[name];
        // The docked column itself (a notice or menu beside it comes and goes over the panels).
        if (live(w) && w.isVisible() && w.lcDock === 'right') {
            right = Math.min(right, w.getBounds().x + (w.lcAnchor ? w.lcAnchor.x : 0) - PANEL_GAP);
        }
    });
    const zones = controlZones(kids);
    const middle = area.y + area.height / 2;
    [CHAT, PEOPLE].forEach((name) => {
        const w = kids[name];
        if (!live(w) || w.lcMoved) return;
        const [width, wanted] = w.lcWanted || w.getSize();
        const x = right - width;
        // Under the controls at the top, above those at the bottom.
        let top = area.y + PANEL_EDGE;
        let bottom = area.y + area.height - PANEL_EDGE;
        zones.forEach((z) => {
            if (z.right <= x || z.left >= x + width) return;
            if ((z.top + z.bottom) / 2 < middle) top = Math.max(top, z.bottom + PANEL_GAP);
            else bottom = Math.min(bottom, z.top - PANEL_GAP);
        });
        // A screen too short for that: the panel stays usable and reaches down to the screen edge.
        const height = Math.max(Math.min(wanted, bottom - top), Math.min(PANEL_MIN, wanted));
        const y = Math.max(area.y, Math.min(top, area.y + area.height - height));
        moveQuietly(w, { x, y, width, height: Math.min(height, area.height) });
        right -= width + PANEL_GAP;
    });
    const videos = kids[VIDEOS];
    if (live(videos) && videos.lcPlaced && !videos.lcMoved) {
        const b = videos.getBounds();
        moveQuietly(videos, { x: right - b.width, y: b.y, width: b.width, height: b.height });
    }
}

// The share toolbar hangs centred just under the pill (above it when the pill is at the bottom).
function placeTools(openerId, width, height) {
    const kids = childrenOf(openerId);
    const bar = kids[BAR];
    const tools = kids[BAR_TOOLS];
    if (!tools || tools.isDestroyed()) return;
    const [w, h] = width ? [width, height] : sizeOf(tools);
    // No pill yet: just the size (the pill places the toolbar once it is set up).
    if (!bar || bar.isDestroyed()) {
        const t = tools.getBounds();
        setBoundsQuietly(tools, { x: t.x, y: t.y, width: w, height: h });
        return;
    }
    const b = bar.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    const anchor = tools.lcAnchor;
    let x = Math.round(barCentre(bar, b) - anchorMid(anchor, w));
    x = Math.max(area.x, Math.min(x, area.x + area.width - w));
    let y = b.y + b.height + 2 - (anchor ? anchor.y : 0);
    if (y + h > area.y + area.height) y = Math.max(area.y, b.y - h - 2);
    setBoundsQuietly(tools, { x, y, width: w, height: h });
}

// Our own resizes must not count as the teacher moving a toolbar.
const setBoundsQuietly = (win, bounds) => {
    win.lcResizing = true;
    try {
        win.setBounds(bounds);
        // The size we asked for: reading it back can be a pixel off at 125% or 150% scaling, and
        // feeding that back in on every drag tick would let the window creep.
        win.lcSize = [bounds.width, bounds.height];
    } finally {
        win.lcResizing = false;
    }
};

const sizeOf = (win) => win.lcSize || win.getSize();

const moveQuietly = (win, b) => {
    const o = win.getBounds();
    if (o.x !== b.x || o.y !== b.y || o.width !== b.width || o.height !== b.height) setBoundsQuietly(win, b);
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
            const panel = PANELS.includes(frameName);
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, resizable: false,
                    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, title: 'LiveClass', icon: ICON,
                    // Clicks on a toolbar must never take the focus from the shared app; Participants and
                    // Chat have fields to type in.
                    focusable: panel,
                    // The pen bar and the share toolbar open hidden; the page shows them when needed. The
                    // panels show once they are in place (setUpFloating).
                    show: frameName !== ANNOT_BAR && frameName !== BAR_TOOLS && !panel,
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
            wireWindowState(win);
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
        [...FLOATING.map((name) => kids[name]), kids.overlay, pickers.get(id)].forEach((w) => { if (w && !w.isDestroyed()) w.close(); });
        children.delete(id);
        shares.delete(id);
        stopBorder(id);
        // A page reloaded mid-share never says the share ended.
        if (sharingPages.has(id)) {
            try {
                protectWindow(BrowserWindow.fromWebContents(contents), false);
            } catch (e) {
                // The window is already gone.
            }
        }
        setSharingShortcut(id, false);
    };
    contents.on('destroyed', closeKids);
    // A crashed page takes its share windows' pages with it: their empty see-through windows (and the
    // drawing layer) would go on taking the mouse over the screen. The meeting window comes back up.
    contents.on('render-process-gone', () => {
        closeKids();
        const win = BrowserWindow.fromWebContents(contents);
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
    });
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
    wireWindowState(mainWindow);
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
// Meeting window id -> its picker standing on its own over the shared screen (raiseFloating keeps it up).
const pickers = new Map();

async function pickShare(request, callback) {
    const contents = request.frame && webContents.fromFrame(request.frame);
    const parent = contents && BrowserWindow.fromWebContents(contents);
    if (!contents || !parent || !isOurs(request.frame.url)) return callback({});
    // One picker per meeting window at a time: another click on Share brings the open one forward.
    if (picking.has(contents.id)) {
        const open = BrowserWindow.getAllWindows().find((w) => w.lcPickerFor === contents.id && !w.isDestroyed());
        if (open && open.isVisible()) open.focus();
        return callback({});
    }
    picking.add(contents.id);

    // Zoom's share dialog opens at once: the list fills in as Windows finds the screens and windows.
    let sources = [];
    const screenAccess = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';

    // New Share is asked for while the meeting is minimized: then the picker stands on its own, on top.
    const hidden = parent.isMinimized();
    // Over a share (even with the meeting window back) it stays above the floating windows.
    const overShare = hidden || sharingPages.has(contents.id);
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
    picker.lcPickerFor = contents.id;
    picker.setMenuBarVisibility(false);
    // New Share opens it over the screen being shared: students must not see it, and it stands above
    // the floating windows (an open Participants or Chat window must not cover it).
    picker.setContentProtection(true);
    if (overShare) {
        picker.setAlwaysOnTop(true, 'screen-saver');
        pickers.set(contents.id, picker);
    }
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
            const type = source.id.startsWith('screen:') ? 'screen' : 'window';
            // Windows ids are 'window:<HWND>:<n>': the green border follows that window.
            const hwnd = type === 'window' && process.platform === 'win32' ? Number(source.id.split(':')[1]) || 0 : 0;
            shares.set(contents.id, { type, displayId: source.display_id || '', hwnd });
            // A New Share while sharing moves the border (or drops it for a screen).
            updateBorder(contents.id);
            answer({ video: source, ...(choice.audio && process.platform === 'win32' ? { audio: 'loopback' } : {}) });
        } else {
            answer({});
        }
        if (!picker.isDestroyed()) picker.close();
    };
    ipcMain.on('picker:choose', onChoose);
    picker.on('closed', () => {
        ipcMain.removeListener('picker:choose', onChoose);
        if (pickers.get(contents.id) === picker) pickers.delete(contents.id);
        answer({});
    });

    let lang = 'en';
    let loaded = false;
    let loading = true;
    const push = () => {
        if (!loaded || picker.isDestroyed()) return;
        picker.webContents.send('picker:sources', {
            lang,
            platform: process.platform,
            screenAccess,
            loading,
            sources: sources.map((s) => ({
                id: s.id,
                name: s.name,
                type: s.id.startsWith('screen:') ? 'screen' : 'window',
                thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
                icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : ''
            }))
        });
    };
    picker.webContents.once('did-finish-load', async () => {
        lang = await pageLanguage(contents).catch(() => 'en');
        loaded = true;
        push();
        if (!picker.isDestroyed()) picker.show();
    });
    picker.loadFile(path.join(__dirname, 'picker.html'));

    // Our own windows (meeting, bar, drawing layer, this picker) are never offered. First the names
    // (quick), then the pictures (slow with many windows open).
    const ours = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const find = (options) => desktopCapturer.getSources({ types: ['screen', 'window'], ...options })
        .then((list) => list.filter((s) => !ours.has(s.id)))
        .catch(() => null);
    const quick = await find({ thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
    if (answered || picker.isDestroyed()) return undefined;
    if (quick) {
        sources = quick;
        push();
    }
    const full = await find({ thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
    if (answered || picker.isDestroyed()) return undefined;
    if (full) sources = full;
    loading = false;
    push();
    return undefined;
}

// ---- Zoom's green border around a shared window (Windows) ---------------------------------------
// Sharing one window, Zoom frames it in green so the teacher sees what students get. The frame is a
// click-through window of its own that follows the shared one. Where another app's window is takes
// Win32 (koffi); without koffi (not installed, macOS) there is simply no frame.
const BORDER_WIDTH = 4;
const BORDER_POLL_MS = 200;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const BORDER_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><html><head><meta charset="utf-8"><style>'
    + 'html,body{margin:0;height:100%;overflow:hidden;background:transparent}'
    + `body{box-sizing:border-box;border:${BORDER_WIDTH}px solid #23d959}</style></head><body></body></html>`)}`;

// Loaded on first use only: an app installed without koffi still runs.
let win32 = null;
const loadWin32 = () => {
    if (win32 !== null) return win32;
    win32 = false;
    if (process.platform !== 'win32') return win32;
    let dwmapi;
    try {
        const koffi = require('koffi');
        const user32 = koffi.load('user32.dll');
        dwmapi = koffi.load('dwmapi.dll');
        koffi.struct('LC_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
        win32 = {
            isWindow: user32.func('int __stdcall IsWindow(intptr_t hWnd)'),
            isIconic: user32.func('int __stdcall IsIconic(intptr_t hWnd)'),
            isVisible: user32.func('int __stdcall IsWindowVisible(intptr_t hWnd)'),
            windowRect: user32.func('int __stdcall GetWindowRect(intptr_t hWnd, _Out_ LC_RECT *lpRect)'),
            frameBounds: dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ LC_RECT *pvAttribute, uint32_t cbAttribute)'),
            cloaked: () => -1
        };
    } catch (e) {
        win32 = false;
        return win32;
    }
    // The same call again for a DWORD answer (cloaked or not); without it only that check is lost.
    try {
        win32.cloaked = dwmapi.func('long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ uint32_t *pvAttribute, uint32_t cbAttribute)');
    } catch (e) {
        win32.cloaked = () => -1;
    }
    return win32;
};

// Where the window is on screen (DIP); { hidden } while it is minimized, hidden or on another virtual
// desktop; null once it is gone.
const windowFrame = (hwnd) => {
    const api = loadWin32();
    if (!api || !api.isWindow(hwnd)) return null;
    if (api.isIconic(hwnd) || !api.isVisible(hwnd)) return { hidden: true };
    // Cloaked: on another virtual desktop (IsWindowVisible still says yes).
    const cloaked = [0];
    if (api.cloaked(hwnd, DWMWA_CLOAKED, cloaked, 4) === 0 && cloaked[0]) return { hidden: true };
    // The extended frame leaves out the invisible resize margins GetWindowRect counts (RECT: 16 bytes).
    const r = {};
    if (api.frameBounds(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, 16) !== 0 && !api.windowRect(hwnd, r)) return { hidden: true };
    const px = { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top };
    if (!(px.width > 0 && px.height > 0)) return { hidden: true };
    // Win32 gives physical pixels; windows are placed in DIP.
    return { bounds: screen.screenToDipRect(null, px) };
};

// The frame goes just outside the window, kept on its screen (a maximized window's frame would
// otherwise be off the edges). A window across two screens keeps its frame on both.
const within = (b, a) => b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
const unionOf = (rects) => {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    const right = Math.max(...rects.map((r) => r.x + r.width));
    const bottom = Math.max(...rects.map((r) => r.y + r.height));
    return { x, y, width: right - x, height: bottom - y };
};
const borderBounds = (b) => {
    const own = screen.getDisplayMatching(b).bounds;
    const area = within(b, own) ? own : unionOf(screen.getAllDisplays().map((d) => d.bounds));
    const left = Math.round(Math.max(area.x, b.x - BORDER_WIDTH));
    const top = Math.round(Math.max(area.y, b.y - BORDER_WIDTH));
    const right = Math.round(Math.min(area.x + area.width, b.x + b.width + BORDER_WIDTH));
    const bottom = Math.round(Math.min(area.y + area.height, b.y + b.height + BORDER_WIDTH));
    return { x: left, y: top, width: Math.max(right - left, 1), height: Math.max(bottom - top, 1) };
};

const makeBorder = (bounds) => {
    const win = new BrowserWindow({
        ...bounds,
        frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, focusable: false,
        resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, enableLargerThanScreen: true, show: false, title: 'LiveClass',
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    // Only a picture: clicks go through to the shared window, and students never see it.
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setContentProtection(true);
    win.loadURL(BORDER_PAGE);
    return win;
};

// Meeting window id -> { hwnd, win, timer, key } while its share is a window.
const borders = new Map();

function stopBorder(openerId) {
    const state = borders.get(openerId);
    if (!state) return;
    borders.delete(openerId);
    clearInterval(state.timer);
    if (state.win && !state.win.isDestroyed()) state.win.close();
}

const meetingCovers = (openerId, b) => {
    const contents = webContents.fromId(openerId);
    const meeting = contents && !contents.isDestroyed() && BrowserWindow.fromWebContents(contents);
    if (!meeting || meeting.isDestroyed() || meeting.isMinimized() || !meeting.isVisible()) return false;
    // Only while the teacher is in it: back in the shared app, that app is over the meeting window again.
    if (!meeting.isFocused()) return false;
    const m = meeting.getBounds();
    return m.x < b.x + b.width && b.x < m.x + m.width && m.y < b.y + b.height && b.y < m.y + m.height;
};

// Windows doesn't tell us when another app's window moves, so the frame looks every 200 ms.
function followBorder(openerId, state) {
    if (borders.get(openerId) !== state) return;
    let frame = null;
    try {
        frame = windowFrame(state.hwnd);
    } catch (e) {
        frame = null;
    }
    // The shared window was closed (the share ends with it).
    if (!frame) {
        stopBorder(openerId);
        return;
    }
    let { win } = state;
    const bounds = frame.hidden ? null : borderBounds(frame.bounds);
    // The teacher brought the meeting window back over the shared one: the frame would sit on top of it.
    if (!bounds || meetingCovers(openerId, bounds)) {
        if (win && !win.isDestroyed() && win.isVisible()) win.hide();
        return;
    }
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (!win || win.isDestroyed()) {
        win = makeBorder(bounds);
        state.win = win;
        state.key = key;
    } else if (state.key !== key) {
        state.key = key;
        win.setBounds(bounds);
    }
    if (!win.isVisible()) {
        win.showInactive();
        // The share toolbars stay above the frame.
        raiseFloating(openerId);
    }
}

// On every change of share: a frame while a window is shared, none otherwise.
function updateBorder(openerId) {
    const share = shares.get(openerId);
    const hwnd = sharingPages.has(openerId) && share && share.type === 'window' ? share.hwnd || 0 : 0;
    const current = borders.get(openerId);
    if (current && current.hwnd === hwnd) return;
    stopBorder(openerId);
    if (!hwnd || !loadWin32()) return;
    const state = { hwnd, win: null, timer: null, key: '' };
    borders.set(openerId, state);
    state.timer = setInterval(() => followBorder(openerId, state), BORDER_POLL_MS);
    followBorder(openerId, state);
}

// ---- Bridge for the meeting page (window.satDesktop, see preload.js) -----------------------------
// Like Zoom, students never see the meeting window in the share (chat, names, the waiting room),
// even when the teacher brings it back over the shared screen.
const protectWindow = (win, on) => {
    if (win && !win.isDestroyed()) win.setContentProtection(!!on);
};

// The page counts chat messages as unread while its window is down, so it is told when that changes.
// Wired when the window is made (not only at the first share), and re-read on every change of state,
// so a missed restore (shown or focused another way) never leaves the page thinking it is down.
const wireWindowState = (win) => {
    if (win.lcStateWired) return;
    win.lcStateWired = true;
    const send = () => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        win.webContents.send('lc:window-state', { minimized: win.isMinimized() || !win.isVisible() });
    };
    ['minimize', 'restore', 'show', 'hide', 'focus', 'maximize'].forEach((name) => win.on(name, send));
};

ipcMain.on('lc:sharing', (event, on) => {
    if (!fromOurs(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    setSharingShortcut(event.sender.id, !!on);
    wireWindowState(win);
    protectWindow(win, on);
    if (on) {
        if (!win.isMinimized()) win.minimize();
    } else {
        shares.delete(event.sender.id);
        if (win.isMinimized()) win.restore();
        win.focus();
    }
    updateBorder(event.sender.id);
});

// ---- The share controls never go missing ---------------------------------------------------------
// Like Zoom's, the Stop Share pill (and the other controls the page has up) stays on screen for the
// whole share. Windows can still take them away: "Show desktop" (Win+D), a full-screen app, a screen
// unplugged or rearranged. Every moment while sharing, anything the page wants shown and isn't comes
// back, on top, and anything left outside every screen goes back to where it first appeared.
const KEEP_MS = 1500;
let keepTimer = null;
const onSomeScreen = (b) => screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 20
    && b.x + b.width > a.x + 20 && b.y < a.y + a.height - 10 && b.y + b.height > a.y + 10);

function keepControls() {
    sharingPages.forEach((openerId) => {
        const kids = children.get(openerId);
        if (!kids) return;
        let raise = false;
        // The drawing layer owns the toolbars: while it is down they are down with it.
        const layer = kids.overlay;
        if (live(layer) && (layer.isMinimized() || !layer.isVisible())) {
            if (layer.isMinimized()) layer.restore();
            layer.showInactive();
            raise = true;
        }
        FLOATING.forEach((name) => {
            const w = kids[name];
            if (!live(w) || !w.lcWantShown || w.lcDrag) return;
            if (w.isMinimized() || !w.isVisible()) {
                if (w.isMinimized()) w.restore();
                w.showInactive();
                raise = true;
            }
            if (!w.isAlwaysOnTop()) raise = true;
            if (name === BAR && !onSomeScreen(w.getBounds())) {
                const [width, height] = sizeOf(w);
                w.lcDock = '';
                w.lcMoved = false;
                const home = homeBounds(openerId, BAR, width, height, w.lcAnchor);
                w.lcCenter = home.x + anchorMid(w.lcAnchor, width);
                setBoundsQuietly(w, home);
                placeTools(openerId);
                const opener = webContents.fromId(openerId);
                if (opener && !opener.isDestroyed()) opener.send('lc:dock', { name: BAR, side: '' });
            } else if (name !== BAR && name !== BAR_TOOLS && !onSomeScreen(w.getBounds())) {
                const [width, height] = sizeOf(w);
                w.lcMoved = false;
                setBoundsQuietly(w, homeBounds(openerId, name, width, height, w.lcAnchor));
                if (PANELS.includes(name) || name === VIDEOS) layoutRight(openerId);
            }
        });
        if (raise) {
            attachToLayer(openerId);
            raiseFloating(openerId);
        }
    });
}

function watchControls(on) {
    clearInterval(keepTimer);
    keepTimer = on ? setInterval(keepControls, KEEP_MS) : null;
}

// Zoom's "Hide floating meeting controls" comes back with Ctrl+Alt+Shift+H; the shortcut belongs to
// LiveClass only while a share is on.
const CONTROLS_SHORTCUT = 'Control+Alt+Shift+H';
const sharingPages = new Set();
function setSharingShortcut(id, on) {
    const had = sharingPages.size > 0;
    if (on) sharingPages.add(id);
    else sharingPages.delete(id);
    const has = sharingPages.size > 0;
    if (had === has || !app.isReady()) return;
    watchControls(has);
    if (!has) {
        if (globalShortcut.isRegistered(CONTROLS_SHORTCUT)) globalShortcut.unregister(CONTROLS_SHORTCUT);
        return;
    }
    registerControlsShortcut();
}

// False when another program holds the shortcut (the page then keeps its controls shown).
function registerControlsShortcut() {
    if (globalShortcut.isRegistered(CONTROLS_SHORTCUT)) return true;
    try {
        return globalShortcut.register(CONTROLS_SHORTCUT, () => {
            sharingPages.forEach((pageId) => {
                const page = webContents.fromId(pageId);
                if (page && !page.isDestroyed()) page.send('lc:toggle-controls');
            });
        });
    } catch (e) {
        return false;
    }
}

// Asked before hiding: tries again, in case the other program has let the shortcut go.
ipcMain.handle('lc:controls-shortcut', (event) => {
    if (!fromOurs(event) || !sharingPages.has(event.sender.id) || !app.isReady()) return false;
    return registerControlsShortcut();
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
const cleanAnchor = (a) => {
    if (!a || typeof a !== 'object' || ![a.x, a.y, a.width].every(Number.isFinite)) return undefined;
    return { x: Math.max(0, a.x), y: Math.max(0, a.y), width: Math.max(0, a.width) };
};

ipcMain.on('lc:float-size', (event, name, width, height, anchor) => {
    if (!fromOurs(event) || !FLOATING.includes(name) || !Number.isFinite(width) || !Number.isFinite(height)) return;
    const win = (children.get(event.sender.id) || {})[name];
    // Asked before the window was set up: applied by setUpFloating.
    if (!win || win.isDestroyed()) {
        pendingSizes.set(`${event.sender.id}:${name}`, [width, height, cleanAnchor(anchor)]);
        return;
    }
    applySize(win, event.sender.id, name, width, height, cleanAnchor(anchor));
});

function applySize(win, openerId, name, width, height, anchor = win.lcAnchor) {
    const w = Math.round(Math.min(Math.max(width, 40), 1600));
    const h = Math.round(Math.min(Math.max(height, 24), 1200));
    const before = win.lcAnchor;
    win.lcAnchor = anchor;
    if (name === BAR_TOOLS) {
        win.lcPlaced = true;
        placeTools(openerId, w, h);
        return;
    }
    if (PANELS.includes(name)) {
        win.lcWanted = [w, h];
        win.lcPlaced = true;
        if (!win.lcMoved) {
            layoutRight(openerId);
            return;
        }
        const b = win.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        setBoundsQuietly(win, { x: b.x, y: b.y, width: w, height: Math.min(h, area.height) });
        return;
    }
    // The first size also places the window (Chromium may still move a new popup after it opens).
    if (!win.lcPlaced) {
        win.lcPlaced = true;
        const home = homeBounds(openerId, name, w, h, anchor);
        win.lcCenter = home.x + anchorMid(anchor, w);
        setBoundsQuietly(win, home);
        if (name === BAR) placeTools(openerId);
        // Participants or Chat may already stand where the video window or a toolbar would go.
        if (name !== BAR_TOOLS) layoutRight(openerId);
        return;
    }
    const old = { ...win.getBounds() };
    [old.width, old.height] = sizeOf(win);
    // While it is being dragged the window just takes its new size; the drag keeps placing it.
    if (win.lcDrag) {
        setBoundsQuietly(win, { x: old.x, y: old.y, width: w, height: h });
        return;
    }
    const area = screen.getDisplayMatching(old).workArea;
    // Docked toolbars hug their edge (and grow away from it); the preview keeps its right edge; the
    // others keep the centre of their bar, so a menu or a longer label never shifts the bar.
    let x;
    if (win.lcDock === 'left') x = area.x + 4 - (anchor ? anchor.x : 0);
    else if (win.lcDock === 'right') x = area.x + area.width - 4 - (anchor ? anchor.x + anchor.width : w);
    else if (name === VIDEOS) x = old.x + old.width - w;
    else x = Math.round((typeof win.lcCenter === 'number' ? win.lcCenter : old.x + anchorMid(before, old.width)) - anchorMid(anchor, w));
    x = Math.max(area.x, Math.min(x, area.x + area.width - w));
    // The bar keeps its height on screen too (content above it grows the window upwards).
    const top = old.y + (before ? before.y : 0) - (anchor ? anchor.y : 0);
    let y = Math.max(area.y, Math.min(top, area.y + area.height - h));
    // Both toolbars docked on the same side: the pen bar goes under the share toolbar.
    if (name === ANNOT_BAR && win.lcDock) {
        const bar = childrenOf(openerId)[BAR];
        if (bar && !bar.isDestroyed() && bar.lcDock === win.lcDock) {
            const b = bar.getBounds();
            if (y < b.y + b.height + 8 && y + h > b.y) y = Math.min(b.y + b.height + 8, area.y + area.height - h);
        }
    }
    setBoundsQuietly(win, { x, y, width: w, height: h });
    if (name === BAR) placeTools(openerId);
    // A toolbar docking, undocking or changing size moves Participants and Chat clear of it (no move
    // when nothing changed).
    if (name === BAR || name === ANNOT_BAR) layoutRight(openerId);
}

ipcMain.on('lc:float-visible', (event, name, visible) => {
    if (!fromOurs(event) || !FLOATING.includes(name)) return;
    const win = (children.get(event.sender.id) || {})[name];
    if (!win || win.isDestroyed()) return;
    win.lcWantShown = !!visible;
    if (!visible) {
        stopDrag(win);
        return win.hide();
    }
    if (name === BAR_TOOLS) placeTools(event.sender.id);
    win.showInactive();
    if (name === ANNOT_BAR && win.lcDock === 'right') layoutRight(event.sender.id);
    return raiseFloating(event.sender.id);
});

// ---- Moving the floating windows ----------------------------------------------------------------
// Drag regions take the mouse away from the page (no hover, no cursor, and the pill folded when the
// mouse reached its grip), so the page starts and ends a drag and the window follows the cursor here,
// held at the point it was grabbed. Dragging the share toolbar moves the pill (the toolbar follows).
const DRAG_TICK = 16;
// The page ends every drag (pointer up or capture lost); this only guards against a lost message.
const DRAG_LIMIT = 60000;

function stopDrag(win) {
    if (!win.lcDrag) return false;
    clearInterval(win.lcDrag);
    win.lcDrag = null;
    return true;
}

function startDrag(win, openerId, name, offsetX, offsetY) {
    stopDrag(win);
    const started = Date.now();
    win.lcDrag = setInterval(() => {
        if (win.isDestroyed()) return;
        if (Date.now() - started > DRAG_LIMIT) {
            endDrag(win, openerId, name);
            return;
        }
        const point = screen.getCursorScreenPoint();
        const b = win.getBounds();
        const [width, height] = sizeOf(win);
        const x = Math.round(point.x - offsetX);
        const y = Math.round(point.y - offsetY);
        if (x === b.x && y === b.y) return;
        setBoundsQuietly(win, { x, y, width, height });
        if (name === BAR) placeTools(openerId);
    }, DRAG_TICK);
}

function endDrag(win, openerId, name) {
    if (win.isDestroyed() || !stopDrag(win)) return;
    // Dropped partly off the screen: back inside the work area.
    const [width, height] = sizeOf(win);
    const b = { ...win.getBounds(), width, height };
    const area = screen.getDisplayMatching(b).workArea;
    const x = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width));
    const y = Math.max(area.y, Math.min(b.y, area.y + area.height - b.height));
    const dropped = { x, y, width: b.width, height: b.height };
    if (x !== b.x || y !== b.y) setBoundsQuietly(win, dropped);
    win.lcCenter = barCentre(win, dropped);
    // Put somewhere by the teacher: the right-edge layout leaves it there.
    win.lcMoved = true;
    if (name !== VIDEOS && !PANELS.includes(name)) decideDock(win, openerId, name, dropped);
    if (name === BAR) placeTools(openerId);
    // Participants and Chat make way for a toolbar put down over them.
    if (name === BAR || name === ANNOT_BAR) layoutRight(openerId);
}

ipcMain.on('lc:float-drag', (event, drag) => {
    if (!fromOurs(event) || !drag || !FLOATING.includes(drag.name)) return;
    const openerId = event.sender.id;
    const kids = children.get(openerId) || {};
    const name = drag.name === BAR_TOOLS ? BAR : drag.name;
    const win = kids[name];
    if (!win || win.isDestroyed()) return;
    if (drag.phase !== 'start') {
        endDrag(win, openerId, name);
        return;
    }
    let offsetX = Number(drag.offsetX) || 0;
    let offsetY = Number(drag.offsetY) || 0;
    // Grabbed on the toolbar: the same grab point, measured from the pill.
    const tools = kids[BAR_TOOLS];
    if (drag.name === BAR_TOOLS && tools && !tools.isDestroyed()) {
        const t = tools.getBounds();
        const b = win.getBounds();
        offsetX += t.x - b.x;
        offsetY += t.y - b.y;
    }
    startDrag(win, openerId, name, offsetX, offsetY);
});

ipcMain.handle('lc:share-info', (event) => (fromOurs(event) ? shares.get(event.sender.id) || null : null));

// ---- Saving annotations (Zoom's Save) ------------------------------------------------------------
// Like Zoom's "Save" there is no dialog (a Save As dialog would open under the share windows, or not
// at all with the meeting minimized): Documents/LiveClass/<yyyy-MM-dd HH.mm> <course>/LiveClass
// <yyyy-MM-dd HH.mm.ss>.png (or .pdf), one folder per meeting, in local time.
const saveRoot = () => path.join(app.getPath('documents'), 'LiveClass');
const two = (n) => String(n).padStart(2, '0');
const localStamp = (d, seconds) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} `
    + `${two(d.getHours())}.${two(d.getMinutes())}${seconds ? `.${two(d.getSeconds())}` : ''}`;
// Something Windows takes as part of a file name.
const cleanName = (name) => {
    const clean = String(name || '').replace(/[\x00-\x1f<>:"/\\|?*]/g, ' ').replace(/\s+/g, ' ').trim()
        .slice(0, 80)
        .replace(/[. ]+$/, '');
    return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) ? `${clean}_` : clean;
};
// Two saves in the same second don't overwrite each other.
const freeFile = (folder, stem, ext) => {
    for (let n = 1; n < 1000; n += 1) {
        const file = path.join(folder, `${stem}${n > 1 ? ` (${n})` : ''}${ext}`);
        if (!fs.existsSync(file)) return file;
    }
    return path.join(folder, `${stem} ${Date.now()}${ext}`);
};
const insideSaves = (file) => {
    const rel = path.relative(saveRoot(), path.resolve(file));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

// Meeting page (webContents id) -> its folder, made at its first save.
const saveFolders = new Map();
const pageKey = (contents) => {
    try {
        const u = new URL(contents.getURL());
        return `${u.origin}${u.pathname}`;
    } catch (e) {
        return '';
    }
};
const meetingFolder = (contents, course) => {
    const key = pageKey(contents);
    const known = saveFolders.get(contents.id);
    if (known && known.key === key) return known.folder;
    const folder = path.join(saveRoot(), [localStamp(new Date(), false), cleanName(course)].filter(Boolean).join(' '));
    if (!known) contents.once('destroyed', () => saveFolders.delete(contents.id));
    saveFolders.set(contents.id, { key, folder });
    return folder;
};

// The PNG as a one-page PDF exactly its size (landscape when wider), printed by a hidden window.
const PDF_TIMEOUT = 20000;
async function pngToPdf(png) {
    const { width, height } = nativeImage.createFromBuffer(png).getSize();
    if (!width || !height) throw new Error('Not an image');
    const dir = await fs.promises.mkdtemp(path.join(app.getPath('temp'), 'liveclass-'));
    const page = path.join(dir, 'page.html');
    await fs.promises.writeFile(path.join(dir, 'page.png'), png);
    await fs.promises.writeFile(page, '<!doctype html><html><head><meta charset="utf-8"><style>'
        + `@page { size: ${width}px ${height}px; margin: 0; }`
        + `html, body { margin: 0; padding: 0; width: ${width}px; height: ${height}px; overflow: hidden; }`
        + `img { display: block; width: ${width}px; height: ${height}px; }`
        + '</style></head><body><img src="page.png"></body></html>');
    const win = new BrowserWindow({
        show: false,
        width: 800,
        height: 600,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false }
    });
    let timer = null;
    try {
        await win.loadFile(page);
        const inches = (px) => px / 96;
        const print = win.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            landscape: width > height,
            pageSize: { width: inches(Math.min(width, height)), height: inches(Math.max(width, height)) },
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            pageRanges: '1'
        });
        const late = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('PDF timed out')), PDF_TIMEOUT); });
        return await Promise.race([print, late]);
    } finally {
        clearTimeout(timer);
        if (!win.isDestroyed()) win.destroy();
        fs.promises.rm(dir, { recursive: true, force: true }).catch(() => null);
    }
}

// { data: PNG data URL, format: 'png' | 'pdf', name, course } -> where it was saved. Throws when the
// file wasn't written, so the page only says "Saved" once it is there.
const PNG_PREFIX = 'data:image/png;base64,';
const MAX_SAVE = 120 * 1024 * 1024;
ipcMain.handle('lc:save-annotation', async (event, request) => {
    if (!fromOurs(event)) throw new Error('Not allowed');
    const { data, format, name, course } = request || {};
    if (typeof data !== 'string' || !data.startsWith(PNG_PREFIX) || data.length > MAX_SAVE) throw new Error('Not a PNG image');
    const png = Buffer.from(data.slice(PNG_PREFIX.length), 'base64');
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG image');
    const pdf = format === 'pdf';
    const folder = meetingFolder(event.sender, course);
    await fs.promises.mkdir(folder, { recursive: true });
    const file = freeFile(folder, `${cleanName(name) || 'LiveClass'} ${localStamp(new Date(), true)}`, pdf ? '.pdf' : '.png');
    await fs.promises.writeFile(file, pdf ? await pngToPdf(png) : png);
    return file;
});

// Zoom's "Show in Folder" (only for what Save wrote).
ipcMain.on('lc:show-in-folder', (event, file) => {
    if (!fromOurs(event) || typeof file !== 'string' || !insideSaves(file) || !fs.existsSync(file)) return;
    shell.showItemInFolder(path.resolve(file));
});

// A meeting page: the meeting window, or a /live page of ours in another window.
const isMeetingPage = (contents) => {
    const win = BrowserWindow.fromWebContents(contents);
    if (win && win.lcMeeting) return true;
    const url = contents.getURL();
    try {
        return isOurs(url) && /^\/live(\/|$)/.test(new URL(url).pathname);
    } catch (e) {
        return false;
    }
};
// Pages from before saveAnnotation (and anything else a meeting downloads) save the same way, into
// the meeting's folder, instead of opening a Save As dialog behind the share windows.
const saveDownload = (event, item, contents) => {
    if (!contents || contents.isDestroyed() || !isMeetingPage(contents)) return;
    try {
        const folder = meetingFolder(contents, '');
        fs.mkdirSync(folder, { recursive: true });
        const ext = path.extname(item.getFilename());
        item.setSavePath(freeFile(folder, cleanName(path.basename(item.getFilename(), ext)) || 'LiveClass', cleanName(ext)));
    } catch (e) {
        // The usual Save As dialog then.
    }
};

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
    wireWindowState(win);
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
        ses.on('will-download', saveDownload);

        buildMenu();
        // Opened from a link: just the meeting, like Zoom (the main window opens when asked for).
        if (pendingLink) openLink(pendingLink);
        else createMainWindow();
        pendingLink = null;
        app.on('activate', () => { if (!mainWindow) createMainWindow(); });
    });

    app.on('will-quit', () => globalShortcut.unregisterAll());

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
