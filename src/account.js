// LiveClass's own account, like the Zoom app's: the app signs in by itself and talks to the platforms'
// servers (their APIs), never to their websites. It knows which classes you teach or are in, which are
// live, and makes the one-time pass that opens a class already signed in.
// Plain Node (no Electron here), so it can be tested on its own: main.js gives it `fetch` and a store.

// Each platform: its server, the class pages' address (the class screen the meeting window shows) and
// the addresses its class links come from.
const PLATFORMS = {
    igcse: {
        name: 'IGCSE',
        api: 'https://new-igcse-backend-production.up.railway.app',
        site: 'https://igschools.tech',
        hosts: (host) => ['igschools.tech', 'www.igschools.tech', 'new-igcse-frontend.vercel.app'].includes(host)
    },
    sat: {
        name: 'SAT',
        api: 'https://sat-backend-production.up.railway.app',
        site: 'https://satarea.tech',
        hosts: (host) => /(^|\.)(satarea\.tech|mrshahin\.com)$/.test(host)
    }
};

const COURSE_ID = /^[0-9a-fA-F]{24}$/;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const APP_CODE = /^[A-Za-z0-9_-]{20,64}$/;
const TIMEOUT_MS = 15000;
const TEACHING_ROLES = ['Teacher'];
const STUDENT_ROLES = ['Student', 'User'];

const failure = (code, message, status = 0) => Object.assign(new Error(message), { code, status });
const MESSAGES = {
    offline: "LiveClass can't reach the internet. Check your connection and try again.",
    signedOut: 'You were signed out. Please sign in again.',
    wrongPassword: 'Wrong password. Please try again.',
    notFound: 'There is no account with this email, username or phone number.',
    unverified: 'This account is not verified yet. Open the email we sent you and verify it, then sign in.',
    needLink: 'Paste the whole class link (it starts with https://).',
    notAClassLink: 'This is not a LiveClass link.',
    signInFirst: 'Sign in first: this class is for its students and teacher. (Guests join with an invite link.)'
};

// platforms: replaced in tests (and in development); store: { load(), save(value) }.
function createAccount({ fetch: fetchImpl, store, deviceId = '', deviceName = 'LiveClass app', platforms = PLATFORMS }) {
    let session = null;
    try {
        const saved = store.load();
        if (saved && saved.token && platforms[saved.platform]) session = saved;
    } catch (e) {
        session = null;
    }
    // Sign-ins that matched on more than one platform, until one is picked: platform -> session
    let pending = null;

    const save = (next) => {
        session = next;
        store.save(next);
    };
    // A new sign-in replacing the app's own one ends the old one on its server, so it doesn't keep
    // taking one of the account's devices. (A website's sign-in the app only borrowed is left alone.)
    const replace = (next) => {
        const was = session;
        save(next);
        if (was && !was.shared && was.token !== next.token) {
            call(was.platform, 'POST', '/sessions/logout', { token: was.token }).catch(() => null);
        }
    };
    const publicUser = (s) => (s ? { platform: s.platform, platformName: platforms[s.platform].name, userName: s.userName, role: s.role, id: s.id } : null);

    // One request to a platform's server. A 401 on the saved sign-in means it ended (signed out on the
    // website, or by the device limit): the app forgets it.
    const call = async (platformId, method, pathname, { token, body } = {}) => {
        const platform = platforms[platformId];
        const headers = { accept: 'application/json', 'x-device-name': deviceName };
        if (deviceId) headers['x-device-id'] = deviceId;
        if (body) headers['content-type'] = 'application/json';
        if (token) headers.authorization = `Bearer ${token}`;
        let res;
        try {
            res = await fetchImpl(`${platform.api}${pathname}`, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });
        } catch (e) {
            throw failure('offline', MESSAGES.offline);
        }
        let data = {};
        try {
            data = await res.json();
        } catch (e) {
            data = {};
        }
        if (res.status === 401 && token && session && session.token === token) {
            save(null);
            throw failure('signed_out', MESSAGES.signedOut, 401);
        }
        if (!res.ok) throw failure(data.status || 'error', data.message || `The server answered ${res.status}`, res.status);
        return data;
    };

    // Where a platform's class pages are for this account (SAT students may belong to mrshahin.com or AIS).
    const siteFor = (platformId, targetDomain) => {
        const platform = platforms[platformId];
        const host = String(targetDomain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
        return host && platform.hosts(host) ? `https://${host}` : platform.site;
    };

    // ---- Signing in ---------------------------------------------------------------------------
    // Email, username or phone and password, like on the websites. Tried on every platform at once; an
    // account on two platforms is asked which one (choose()).
    const signIn = async (login, password) => {
        const name = String(login || '').trim();
        if (!name || !password) throw failure('missing', 'Enter your email, username or phone, and your password.');
        const ids = Object.keys(platforms);
        const answers = await Promise.all(ids.map(async (id) => {
            try {
                return { id, data: await call(id, 'POST', '/auth/login', { body: { email: name, password } }) };
            } catch (e) {
                return { id, error: e };
            }
        }));
        const found = answers.filter((a) => a.data && a.data.message === 'success' && a.data.userToken);
        if (found.length === 0) {
            if (answers.some((a) => a.data && a.data.isVerify === false)) throw failure('unverified', MESSAGES.unverified);
            if (answers.some((a) => a.data && /wrong password/i.test(a.data.message || ''))) throw failure('wrong_password', MESSAGES.wrongPassword);
            if (answers.every((a) => a.error && a.error.code === 'offline')) throw failure('offline', MESSAGES.offline);
            throw failure('not_found', MESSAGES.notFound);
        }
        const sessions = found.map(({ id, data }) => ({
            platform: id,
            site: siteFor(id, data.targetDomain),
            token: data.userToken,
            id: String(data.id || ''),
            userName: data.userName || name,
            role: data.role || '',
            // Its own sign-in: Sign out ends it on the server too
            shared: false
        }));
        if (sessions.length === 1) {
            pending = null;
            replace(sessions[0]);
            return { user: publicUser(session) };
        }
        pending = Object.fromEntries(sessions.map((s) => [s.platform, s]));
        return { choose: sessions.map(publicUser) };
    };

    // The account picked after a sign-in matched on several platforms; the others are signed out again.
    const choose = async (platformId) => {
        if (!pending || !pending[platformId]) throw failure('missing', 'Please sign in again.');
        const others = Object.values(pending).filter((s) => s.platform !== platformId);
        replace(pending[platformId]);
        pending = null;
        await Promise.all(others.map((s) => call(s.platform, 'POST', '/sessions/logout', { token: s.token }).catch(() => null)));
        return { user: publicUser(session) };
    };

    // A one-time pass from a website (its Start button, or "Sign in with your browser"): the app gets the
    // website's own sign-in (the same device, so no extra one). site: where it came from.
    const redeem = async (platformId, code, site) => {
        if (!platforms[platformId] || !APP_CODE.test(String(code || ''))) throw failure('invalid', 'This sign-in link is not valid.');
        const data = await call(platformId, 'POST', '/live/app-link/redeem', { body: { code } });
        if (!data.token) throw failure('invalid', data.message || 'This sign-in link has expired.');
        pending = null;
        let origin = '';
        try {
            const u = new URL(site);
            if (platforms[platformId].hosts(u.hostname)) origin = u.origin;
        } catch (e) {
            origin = '';
        }
        replace({
            platform: platformId,
            site: origin || platforms[platformId].site,
            token: data.token,
            id: String(data.id || ''),
            userName: data.userName || '',
            role: data.role || '',
            // The website's own sign-in: signing out of the app must not sign the website out
            shared: true
        });
        return { user: publicUser(session) };
    };

    const signOut = async () => {
        const was = session;
        pending = null;
        save(null);
        if (was && !was.shared) await call(was.platform, 'POST', '/sessions/logout', { token: was.token }).catch(() => null);
    };

    // ---- Classes ------------------------------------------------------------------------------
    // Your courses (a teacher's to start, a student's to join), each saying whether it is live now.
    const classes = async () => {
        if (!session) throw failure('signed_out', MESSAGES.signedOut, 401);
        const s = session;
        const coursesPath = TEACHING_ROLES.includes(s.role) ? '/course/teacher?summary=1'
            : STUDENT_ROLES.includes(s.role) ? '/course/student?summary=1' : '';
        const [courses, active] = await Promise.all([
            coursesPath ? call(s.platform, 'GET', coursesPath, { token: s.token }).catch((e) => (e.code === 'signed_out' ? Promise.reject(e) : null)) : null,
            call(s.platform, 'GET', '/live/active', { token: s.token })
        ]);
        const live = new Map(((active && active.live) || []).map((l) => [String(l.courseId), l]));
        const list = [];
        const seen = new Set();
        (((courses && (courses.courses || courses.data)) || [])).forEach((c) => {
            if (!c || !c._id || seen.has(String(c._id))) return;
            seen.add(String(c._id));
            const l = live.get(String(c._id));
            list.push({
                courseId: String(c._id),
                name: c.name || 'Untitled course',
                teacherName: (c.teacher && c.teacher.userName) || (l && l.teacherName) || '',
                live: !!l,
                isHost: l ? !!l.isHost : TEACHING_ROLES.includes(s.role)
            });
        });
        // A live class that isn't in the list (a course reached another way) is still shown
        live.forEach((l, id) => {
            if (seen.has(id)) return;
            list.push({ courseId: id, name: l.courseName || 'LiveClass', teacherName: l.teacherName || '', live: true, isHost: !!l.isHost });
        });
        list.sort((a, b) => (b.live - a.live) || a.name.localeCompare(b.name));
        return { enabled: !(active && active.enabled === false), classes: list, coursesFailed: !!coursesPath && !courses };
    };

    // ---- Opening a class ----------------------------------------------------------------------
    // The class page with a fresh one-time pass (#lc=...), so it opens signed in as this account. Without
    // a pass (the server could not make one) the page still opens, as a guest link would.
    const meetingUrl = async (path, site) => {
        const base = site || (session && session.site);
        if (!base) throw failure('signed_out', MESSAGES.signedOut, 401);
        if (!session) return `${base}${path}`;
        try {
            const data = await call(session.platform, 'POST', '/live/app-link', { token: session.token });
            if (data.code && APP_CODE.test(data.code)) return `${base}${path}#lc=${data.code}`;
        } catch (e) {
            if (e.code === 'signed_out') throw e;
        }
        return `${base}${path}`;
    };

    // What was typed or pasted in Join: a class link (a course's own or a guest invite), or with an
    // account, a course code. { platform, site, path, guest }
    const parseJoin = (text) => {
        const raw = String(text || '').trim();
        if (!raw) throw failure('missing', MESSAGES.needLink);
        let url = null;
        try {
            url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
        } catch (e) {
            url = null;
        }
        const platformId = url && Object.keys(platforms).find((id) => platforms[id].hosts(url.hostname));
        if (platformId) {
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts[0] === 'live' && parts[1] === 'join' && INVITE_TOKEN.test(parts[2] || '')) {
                return { platform: platformId, site: url.origin, path: `/live/join/${parts[2]}`, guest: true };
            }
            if (parts[0] === 'live' && COURSE_ID.test(parts[1] || '') && parts.length === 2) {
                return { platform: platformId, site: url.origin, path: `/live/${parts[1]}`, guest: false };
            }
            throw failure('not_class', MESSAGES.notAClassLink);
        }
        // A bare code belongs to the platform you are signed in to
        if (session && COURSE_ID.test(raw)) return { platform: session.platform, site: session.site, path: `/live/${raw}`, guest: false };
        if (session && INVITE_TOKEN.test(raw)) return { platform: session.platform, site: session.site, path: `/live/join/${raw}`, guest: true };
        if (url && /\./.test(url.hostname) && raw.includes('/')) throw failure('not_class', MESSAGES.notAClassLink);
        throw failure('missing', MESSAGES.needLink);
    };

    // The page to open for Join. A course's own class needs its account; a guest link opens for anyone
    // (signed in to that platform, it opens as you).
    const joinUrl = async (text) => {
        const target = parseJoin(text);
        const mine = session && session.platform === target.platform;
        if (!target.guest && !mine) throw failure('sign_in', MESSAGES.signInFirst);
        if (!mine) return `${target.site}${target.path}`;
        return meetingUrl(target.path, target.site);
    };

    // Start (a teacher's own course) or Join from the list.
    const classUrl = (courseId) => {
        if (!COURSE_ID.test(String(courseId || ''))) throw failure('invalid', 'This class is not valid.');
        return meetingUrl(`/live/${courseId}`);
    };

    // The platform a class page or website address belongs to ('' when none).
    const platformOf = (address) => {
        try {
            const host = new URL(address).hostname;
            return Object.keys(platforms).find((id) => platforms[id].hosts(host)) || '';
        } catch (e) {
            return '';
        }
    };

    return {
        user: () => publicUser(session),
        signIn,
        choose,
        redeem,
        signOut,
        classes,
        classUrl,
        joinUrl,
        parseJoin,
        platformOf,
        siteOf: (platformId) => (platforms[platformId] ? platforms[platformId].site : ''),
        platformList: () => Object.keys(platforms).map((id) => ({ id, name: platforms[id].name, site: platforms[id].site }))
    };
}

module.exports = { createAccount, PLATFORMS };
