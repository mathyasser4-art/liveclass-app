// window.lcHome: what the app's own home window (home.html) asks the main process for. Every answer is
// { ok: true, ... } or { ok: false, code, message }.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => {
    const found = (process.argv || []).find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : '';
};

contextBridge.exposeInMainWorld('lcHome', {
    version: arg('lc-version'),
    platform: process.platform,
    // { user, platforms }: who is signed in (null when nobody) and where accounts can be
    state: () => ipcRenderer.invoke('home:state'),
    signIn: (login, password) => ipcRenderer.invoke('home:sign-in', String(login || ''), String(password || '')),
    // After a sign-in that matched an account on two platforms
    choose: (platform) => ipcRenderer.invoke('home:choose', String(platform || '')),
    signOut: () => ipcRenderer.invoke('home:sign-out'),
    // { classes: [{ courseId, name, teacherName, live, isHost }] }
    classes: () => ipcRenderer.invoke('home:classes'),
    // Start (your course) or Join from the list: the class opens in the meeting window
    openClass: (courseId) => ipcRenderer.invoke('home:open-class', String(courseId || '')),
    // Join with a class link, invite link or code
    join: (text) => ipcRenderer.invoke('home:join', String(text || '')),
    // Sign in with Google or a school account: the platform's sign-in opens in the browser and comes back
    browserSignIn: (platform) => ipcRenderer.invoke('home:browser-sign-in', String(platform || '')),
    checkForUpdates: () => ipcRenderer.send('home:check-updates'),
    // Called when the sign-in changed from outside this window (a website's Start, the browser sign-in),
    // with { error } when it did not work
    onChange: (fn) => {
        const listener = (event, change) => fn(change || {});
        ipcRenderer.on('home:changed', listener);
        return () => ipcRenderer.removeListener('home:changed', listener);
    }
});
