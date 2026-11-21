// The app's own sign-in, classes and class links (src/account.js), against two fake platform servers.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createAccount } = require('../src/account');

const COURSE_A = 'a'.repeat(24);
const COURSE_B = 'b'.repeat(24);
const CODE = 'C'.repeat(32);

// A fake platform server: users { login: { password, role, ... } }, what it answers, and what it was asked.
const makeServer = (users) => {
    const state = { users, calls: [], live: [], courses: [], tokens: new Map(), dead: new Set() };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const data = body ? JSON.parse(body) : {};
            const url = new URL(req.url, 'http://x');
            const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
            state.calls.push({ method: req.method, path: url.pathname + url.search, data, token, headers: req.headers });
            const send = (status, out) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(out));
            };
            const who = state.tokens.get(token);
            if (url.pathname === '/auth/login') {
                const u = state.users[data.email];
                if (!u) return send(200, { message: 'this email or username is not registered' });
                if (u.unverified) return send(200, { message: 'not verified', isVerify: false });
                if (u.password !== data.password) return send(200, { message: 'wrong password' });
                const t = `tok-${Math.random().toString(36).slice(2)}`;
                state.tokens.set(t, u);
                return send(200, { message: 'success', userToken: t, userName: u.userName, role: u.role, id: u.id, targetDomain: u.targetDomain || null });
            }
            if (url.pathname === '/live/app-link/redeem') {
                if (data.code !== CODE) return send(410, { message: 'This link has expired.' });
                state.tokens.set('web-token', state.users.teacher);
                return send(200, { message: 'success', token: 'web-token', id: 't1', userName: 'Mr T', role: 'Teacher' });
            }
            if (!who || state.dead.has(token)) return send(401, { message: 'Please log in again' });
            if (url.pathname === '/sessions/logout') return send(200, { message: 'success' });
            if (url.pathname === '/live/app-link') return send(200, { message: 'success', code: CODE });
            if (url.pathname === '/live/active') return send(200, { message: 'success', enabled: true, live: state.live });
            if (url.pathname === '/course/teacher' || url.pathname === '/course/student') return send(200, { courses: state.courses });
            return send(404, { message: 'not found' });
        });
    });
    return { server, state };
};

const igcse = makeServer({
    teacher: { password: 'pw', role: 'Teacher', userName: 'Mr T', id: 't1' },
    both: { password: 'pw', role: 'Teacher', userName: 'Both I', id: 'b1' },
    sleepy: { password: 'pw', role: 'Student', userName: 'S', id: 's0', unverified: true }
});
const sat = makeServer({
    student: { password: 'pw', role: 'Student', userName: 'Sara', id: 's1', targetDomain: 'mrshahin.com' },
    both: { password: 'pw', role: 'Student', userName: 'Both S', id: 'b2' }
});

let platforms;
before(async () => {
    await Promise.all([igcse, sat].map(({ server }) => new Promise((r) => server.listen(0, r))));
    platforms = {
        igcse: { name: 'IGCSE', api: `http://127.0.0.1:${igcse.server.address().port}`, site: 'https://igschools.tech', hosts: (h) => h === 'igschools.tech' },
        sat: { name: 'SAT', api: `http://127.0.0.1:${sat.server.address().port}`, site: 'https://satarea.tech', hosts: (h) => /(^|\.)(satarea\.tech|mrshahin\.com)$/.test(h) }
    };
});
after(() => {
    igcse.server.close();
    sat.server.close();
});

const memoryStore = (initial = null) => {
    let value = initial;
    return { load: () => value, save: (v) => { value = v; }, get: () => value };
};
let store;
let account;
beforeEach(() => {
    [igcse, sat].forEach(({ state }) => { state.calls = []; state.live = []; state.courses = []; state.dead = new Set(); });
    store = memoryStore();
    account = createAccount({ fetch, store, deviceId: 'device-123456', deviceName: 'LiveClass app (Windows)', platforms });
});

test('signing in finds the account on its platform and keeps it; the device is named', async () => {
    const r = await account.signIn('teacher', 'pw');
    assert.deepEqual(r.user, { platform: 'igcse', platformName: 'IGCSE', userName: 'Mr T', role: 'Teacher', id: 't1' });
    assert.equal(store.get().platform, 'igcse');
    assert.ok(store.get().token);
    const login = igcse.state.calls.find((c) => c.path === '/auth/login');
    assert.equal(login.headers['x-device-id'], 'device-123456');
    assert.equal(login.headers['x-device-name'], 'LiveClass app (Windows)');
    // The next app start remembers it
    assert.equal(createAccount({ fetch, store, platforms }).user().userName, 'Mr T');
});

test('a wrong password, an unknown account and an unverified one each say so', async () => {
    await assert.rejects(account.signIn('teacher', 'nope'), { code: 'wrong_password' });
    await assert.rejects(account.signIn('nobody', 'pw'), { code: 'not_found' });
    await assert.rejects(account.signIn('sleepy', 'pw'), { code: 'unverified' });
    await assert.rejects(account.signIn('', 'pw'), { code: 'missing' });
    assert.equal(account.user(), null);
});

test('no internet: the sign-in says so', async () => {
    const offline = createAccount({
        fetch,
        store: memoryStore(),
        platforms: { igcse: { ...platforms.igcse, api: 'http://127.0.0.1:9' }, sat: { ...platforms.sat, api: 'http://127.0.0.1:9' } }
    });
    await assert.rejects(offline.signIn('teacher', 'pw'), { code: 'offline' });
});

test('an account on both platforms is asked which one; the other is signed out again', async () => {
    const r = await account.signIn('both', 'pw');
    assert.deepEqual(r.choose.map((c) => c.platform).sort(), ['igcse', 'sat']);
    assert.equal(account.user(), null);
    const picked = await account.choose('sat');
    assert.equal(picked.user.userName, 'Both S');
    assert.equal(store.get().platform, 'sat');
    const logout = igcse.state.calls.find((c) => c.path === '/sessions/logout');
    assert.ok(logout && logout.token, 'the IGCSE sign-in was ended');
});

test('a SAT student belongs to their own site (mrshahin.com): their class pages open there', async () => {
    await account.signIn('student', 'pw');
    assert.equal(store.get().site, 'https://mrshahin.com');
    sat.state.live = [{ courseId: COURSE_A, courseName: 'Maths', isHost: false }];
    assert.equal(await account.classUrl(COURSE_A), `https://mrshahin.com/live/${COURSE_A}#lc=${CODE}`);
});

test("a website's one-time pass signs the app in with the website's own sign-in (Sign out leaves the website signed in)", async () => {
    const r = await account.redeem('igcse', CODE, 'https://igschools.tech');
    assert.equal(r.user.userName, 'Mr T');
    assert.equal(store.get().shared, true);
    await account.signOut();
    assert.equal(account.user(), null);
    assert.equal(igcse.state.calls.filter((c) => c.path === '/sessions/logout').length, 0);
    await assert.rejects(account.redeem('igcse', 'D'.repeat(32), 'https://igschools.tech'), { status: 410 });
    await assert.rejects(account.redeem('igcse', 'short', 'https://igschools.tech'), { code: 'invalid' });
});

test('Sign out of an app sign-in ends it on the server too', async () => {
    await account.signIn('teacher', 'pw');
    const token = store.get().token;
    await account.signOut();
    assert.equal(account.user(), null);
    assert.equal(igcse.state.calls.find((c) => c.path === '/sessions/logout').token, token);
});

test("a teacher's classes: their courses, the live one first and marked live", async () => {
    await account.signIn('teacher', 'pw');
    igcse.state.courses = [{ _id: COURSE_B, name: 'Biology' }, { _id: COURSE_A, name: 'Algebra' }];
    igcse.state.live = [{ courseId: COURSE_B, courseName: 'Biology', isHost: true }];
    const r = await account.classes();
    assert.deepEqual(r.classes.map((c) => [c.name, c.live, c.isHost]), [['Biology', true, true], ['Algebra', false, true]]);
    assert.ok(igcse.state.calls.some((c) => c.path === '/course/teacher?summary=1' && c.headers.authorization.startsWith('Bearer ')));
});

test('when the sign-in has ended on the server, the app forgets it', async () => {
    await account.signIn('teacher', 'pw');
    igcse.state.dead.add(store.get().token);
    await assert.rejects(account.classes(), { code: 'signed_out' });
    assert.equal(account.user(), null);
    assert.equal(store.get(), null);
});

test('Start and Join open the class page with a fresh one-time pass', async () => {
    await account.signIn('teacher', 'pw');
    assert.equal(await account.classUrl(COURSE_A), `https://igschools.tech/live/${COURSE_A}#lc=${CODE}`);
    await assert.rejects(Promise.resolve().then(() => account.classUrl('nope')), { code: 'invalid' });
});

test('Join: a class link, an invite link or a code', async () => {
    // Signed out: invite links open as a guest; a course's own class needs its account
    assert.equal(await account.joinUrl('https://satarea.tech/live/join/abcdefghijklmnopqrst'), 'https://satarea.tech/live/join/abcdefghijklmnopqrst');
    await assert.rejects(account.joinUrl(`https://igschools.tech/live/${COURSE_A}`), { code: 'sign_in' });
    await assert.rejects(account.joinUrl('https://example.com/live/x'), { code: 'not_class' });
    await assert.rejects(account.joinUrl('https://igschools.tech/homework/1'), { code: 'not_class' });
    await assert.rejects(account.joinUrl(COURSE_A), { code: 'missing' });

    await account.signIn('teacher', 'pw');
    assert.equal(await account.joinUrl(`igschools.tech/live/${COURSE_A}`), `https://igschools.tech/live/${COURSE_A}#lc=${CODE}`);
    assert.equal(await account.joinUrl(COURSE_A), `https://igschools.tech/live/${COURSE_A}#lc=${CODE}`);
    // Another platform's class: its account is needed
    await assert.rejects(account.joinUrl(`https://satarea.tech/live/${COURSE_A}`), { code: 'sign_in' });
});

test('which platform a class page or website belongs to', () => {
    assert.equal(account.platformOf('https://mrshahin.com/live/x'), 'sat');
    assert.equal(account.platformOf('https://igschools.tech/live/x'), 'igcse');
    assert.equal(account.platformOf('https://evil.example/live/x'), '');
    assert.equal(account.platformOf('not a url'), '');
});

test("signing in again (or a website's Start as someone else) ends the app's old sign-in on its server", async () => {
    await account.signIn('teacher', 'pw');
    const old = store.get().token;
    await account.redeem('igcse', CODE, 'https://igschools.tech');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(igcse.state.calls.filter((c) => c.path === '/sessions/logout' && c.token === old).length, 1);
    assert.equal(store.get().token, 'web-token');
});
