// LiveClass's home window, like the Zoom app's:
//  - signed out: Join a class / Sign in (with a password, or through the browser for Google accounts),
//  - signed in: New Meeting (teachers) and Join tiles, the time, and your classes with the live ones first.
// Pages are built with DOM calls (never HTML strings), so course and people names are only ever text.
(() => {
    const api = window.lcHome;
    const root = document.getElementById('app');

    // ---- Words (the computer's language: English or Arabic) --------------------------------------
    const TEXT = {
        en: {
            joinClass: 'Join a class',
            signIn: 'Sign in',
            back: 'Back',
            login: 'Email, username or phone',
            password: 'Password',
            signingIn: 'Signing in…',
            or: 'or',
            browserSignIn: 'Signed up with Google? Sign in with your browser on:',
            browserWaiting: 'Finish signing in in your browser. LiveClass comes back here by itself.',
            cancel: 'Cancel',
            chooseTitle: 'Your account is on two platforms. Which one do you want?',
            newMeeting: 'New Meeting',
            join: 'Join',
            start: 'Start',
            returnTo: 'Return',
            live: 'LIVE',
            yourClasses: 'Your classes',
            noClasses: 'You have no classes yet.',
            noneLive: 'No class is live right now. When your teacher starts one, it shows here.',
            classesFailed: "Your classes couldn't be loaded.",
            retry: 'Try again',
            joinTitle: 'Join a class',
            joinPlaceholder: 'Class link or code',
            joinHint: 'Paste the link your teacher sent you.',
            opening: 'Opening…',
            startTitle: 'Start a class for',
            noCourses: 'You have no courses yet. Create a course on your platform first.',
            signOut: 'Sign out',
            updates: 'Check for updates',
            notConfigured: 'LiveClass is not set up on this platform yet.',
            version: 'Version',
            teacher: 'Teacher',
            student: 'Student'
        },
        ar: {
            joinClass: 'انضم إلى حصة',
            signIn: 'تسجيل الدخول',
            back: 'رجوع',
            login: 'البريد الإلكتروني أو اسم المستخدم أو الهاتف',
            password: 'كلمة المرور',
            signingIn: 'جارٍ تسجيل الدخول…',
            or: 'أو',
            browserSignIn: 'سجّلت بحساب Google؟ سجّل الدخول عبر المتصفح على:',
            browserWaiting: 'أكمل تسجيل الدخول في المتصفح، وسيعود LiveClass إلى هنا تلقائيًا.',
            cancel: 'إلغاء',
            chooseTitle: 'لديك حساب على منصتين. أيهما تريد؟',
            newMeeting: 'حصة جديدة',
            join: 'انضمام',
            start: 'ابدأ',
            returnTo: 'العودة',
            live: 'مباشر',
            yourClasses: 'حصصك',
            noClasses: 'ليس لديك حصص بعد.',
            noneLive: 'لا توجد حصة مباشرة الآن. عندما يبدأ معلمك حصة ستظهر هنا.',
            classesFailed: 'تعذّر تحميل حصصك.',
            retry: 'حاول مرة أخرى',
            joinTitle: 'انضم إلى حصة',
            joinPlaceholder: 'رابط الحصة أو رمزها',
            joinHint: 'الصق الرابط الذي أرسله معلمك.',
            opening: 'جارٍ الفتح…',
            startTitle: 'ابدأ حصة لـ',
            noCourses: 'ليس لديك دورات بعد. أنشئ دورة على منصتك أولًا.',
            signOut: 'تسجيل الخروج',
            updates: 'التحقق من التحديثات',
            notConfigured: 'LiveClass غير مُعدّ على هذه المنصة بعد.',
            version: 'الإصدار',
            teacher: 'معلم',
            student: 'طالب'
        }
    };
    const lang = String(navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
    const t = (key) => TEXT[lang][key] || TEXT.en[key] || key;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

    // ---- Little DOM helpers ---------------------------------------------------------------------
    const h = (tag, props = {}, ...kids) => {
        const el = document.createElement(tag);
        Object.entries(props).forEach(([k, v]) => {
            if (v === undefined || v === null || v === false) return;
            if (k === 'class') el.className = v;
            else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
            else if (k === 'text') el.textContent = v;
            else el.setAttribute(k, v === true ? '' : v);
        });
        kids.flat().forEach((kid) => {
            if (kid === null || kid === undefined || kid === false) return;
            el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
        });
        return el;
    };
    // Lucide icons (stroke paths)
    const ICONS = {
        video: ['m16 13 5.2 3.5a.5.5 0 0 0 .8-.4V7.9a.5.5 0 0 0-.8-.4L16 11', 'M2 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z'],
        plus: ['M5 12h14', 'M12 5v14'],
        back: ['m15 18-6-6 6-6'],
        globe: ['M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
        refresh: ['M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'M8 16H3v5'],
        out: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9']
    };
    const icon = (name, size = 20) => {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', size);
        svg.setAttribute('height', size);
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        ICONS[name].forEach((d) => {
            const p = document.createElementNS(ns, 'path');
            p.setAttribute('d', d);
            svg.append(p);
        });
        return svg;
    };
    const logo = (size) => h('span', { class: `logo logo-${size}` }, icon('video', size === 'big' ? 34 : 16));
    const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';

    // ---- State ----------------------------------------------------------------------------------
    const state = {
        view: 'loading', // loading | welcome | signin | browser | choose | home
        user: null,
        platforms: [],
        choices: [],
        error: '',
        busy: '',
        classes: null, // null: loading; [] once loaded
        classesFailed: false,
        enabled: true,
        modal: null, // 'join' | 'start'
        menu: false,
        // What has been typed, kept across re-renders
        form: { login: '', password: '', link: '' }
    };
    // A text field bound to state.form[name]
    const field = (name, props) => h('input', {
        class: 'field', name, value: state.form[name], 'aria-label': props.placeholder, ...props,
        oninput: (e) => { state.form[name] = e.target.value; }
    });
    const set = (changes) => {
        Object.assign(state, changes);
        render();
    };
    // Every answer is { ok, ... }; a sign-in that ended sends you back to the start, saying so.
    const ask = async (promise) => {
        const r = await promise;
        if (!r.ok && r.code === 'signed_out') {
            set({ user: null, view: 'welcome', error: r.message, modal: null, busy: '', classes: null });
        }
        return r;
    };

    const loadClasses = async () => {
        if (!state.user) return;
        const r = await ask(api.classes());
        if (!state.user) return;
        if (r.ok) set({ classes: r.classes, classesFailed: !!r.coursesFailed, enabled: r.enabled !== false });
        else if (r.code !== 'signed_out') set({ classes: state.classes || [], classesFailed: true });
    };

    const refreshState = async () => {
        const r = await api.state();
        state.platforms = r.platforms || [];
        if (r.user) {
            const changed = !state.user || state.user.id !== r.user.id;
            set({ user: r.user, view: 'home', classes: changed ? null : state.classes, error: changed ? '' : state.error });
            loadClasses();
        } else {
            set({ user: null, view: ['signin', 'browser', 'choose'].includes(state.view) ? state.view : 'welcome', classes: null });
        }
    };

    // ---- Actions --------------------------------------------------------------------------------
    const openClass = async (courseId) => {
        set({ busy: courseId, error: '' });
        const r = await ask(api.openClass(courseId));
        set({ busy: '', modal: r.ok ? null : state.modal, error: r.ok ? '' : r.message });
        if (r.ok) setTimeout(loadClasses, 4000);
    };
    const join = async () => {
        set({ busy: 'join', error: '' });
        const r = await ask(api.join(state.form.link));
        if (r.ok) state.form.link = '';
        set({ busy: '', modal: r.ok ? null : state.modal, error: r.ok ? '' : r.message });
    };
    const newMeeting = () => {
        const mine = (state.classes || []).filter((c) => c.isHost);
        if (mine.length === 1) return openClass(mine[0].courseId);
        return set({ modal: 'start', error: mine.length ? '' : t('noCourses') });
    };
    const signIn = async () => {
        set({ busy: 'signin', error: '' });
        const r = await api.signIn(state.form.login, state.form.password);
        if (!r.ok) return set({ busy: '', error: r.message });
        state.form.password = '';
        if (r.choose) return set({ busy: '', view: 'choose', choices: r.choose });
        set({ busy: '' });
        return refreshState();
    };
    const choose = async (platform) => {
        set({ busy: platform, error: '' });
        const r = await api.choose(platform);
        set({ busy: '', error: r.ok ? '' : r.message, view: r.ok ? state.view : 'signin' });
        if (r.ok) refreshState();
    };
    const browserSignIn = async (platform) => {
        const r = await api.browserSignIn(platform);
        if (!r.ok) set({ error: r.message });
        else set({ view: 'browser', busy: 'browser', error: '' });
    };
    const signOut = async () => {
        set({ menu: false });
        await api.signOut();
        set({ user: null, view: 'welcome', classes: null, error: '' });
    };

    // ---- Screens --------------------------------------------------------------------------------
    const errorLine = () => (state.error ? h('p', { class: 'error', role: 'alert', text: state.error }) : null);
    const footer = () => h('p', { class: 'version', text: `LiveClass · ${t('version')} ${api.version || ''}` });
    const backButton = (to) => h('button', { type: 'button', class: 'back', onclick: () => set({ view: to, error: '', busy: '' }) }, icon('back', 18), t('back'));

    const welcome = () => h('div', { class: 'center-page' },
        h('div', { class: 'welcome' },
            logo('big'),
            h('h1', { text: 'LiveClass' }),
            h('button', { type: 'button', class: 'btn primary wide', onclick: () => set({ modal: 'join', error: '' }) }, t('joinClass')),
            h('button', { type: 'button', class: 'btn wide', onclick: () => set({ view: 'signin', error: '' }) }, t('signIn')),
            errorLine()),
        footer());

    const signInPage = () => {
        const busy = state.busy === 'signin';
        const form = h('form', {
            class: 'card form',
            onsubmit: (e) => {
                e.preventDefault();
                signIn();
            }
        },
        h('h1', { text: t('signIn') }),
        field('login', { type: 'text', autocomplete: 'username', placeholder: t('login') }),
        field('password', { type: 'password', autocomplete: 'current-password', placeholder: t('password') }),
        errorLine(),
        h('button', { type: 'submit', class: 'btn primary wide', disabled: busy }, busy ? t('signingIn') : t('signIn')),
        h('div', { class: 'divider' }, h('span', { text: t('or') })),
        h('div', { class: 'where' },
            h('p', { class: 'dim small google' }, icon('globe', 14), h('span', { text: t('browserSignIn') })),
            h('div', { class: 'platforms' },
                state.platforms.map((p) => h('button', { type: 'button', class: 'btn', onclick: () => browserSignIn(p.id) }, p.name)))));
        return h('div', { class: 'center-page' }, backButton('welcome'), form, footer());
    };

    const browserPage = () => h('div', { class: 'center-page' },
        h('div', { class: 'card form' },
            logo('big'),
            h('p', { text: t('browserWaiting') }),
            h('div', { class: 'spinner', 'aria-hidden': 'true' }),
            errorLine(),
            h('button', { type: 'button', class: 'btn wide', onclick: () => set({ view: 'signin', busy: '' }) }, t('cancel'))),
        footer());

    const choosePage = () => h('div', { class: 'center-page' },
        backButton('signin'),
        h('div', { class: 'card form' },
            h('h1', { class: 'small-title', text: t('chooseTitle') }),
            state.choices.map((c) => h('button', {
                type: 'button', class: 'btn wide choice', disabled: !!state.busy, onclick: () => choose(c.platform)
            }, h('strong', { text: c.platformName }), h('span', { class: 'dim', text: ` · ${c.userName} · ${c.role}` }))),
            errorLine()),
        footer());

    const roleName = (role) => (role === 'Teacher' ? t('teacher') : ['Student', 'User'].includes(role) ? t('student') : role);

    const topbar = () => h('header', { class: 'topbar' },
        h('div', { class: 'brand' }, logo('small'), h('span', { text: 'LiveClass' })),
        h('div', { class: 'account' },
            h('button', {
                type: 'button', class: 'avatar', title: state.user.userName, 'aria-haspopup': 'menu', 'aria-expanded': String(state.menu),
                onclick: (e) => { e.stopPropagation(); set({ menu: !state.menu }); }
            }, initials(state.user.userName)),
            state.menu && h('div', { class: 'menu', role: 'menu', onclick: (e) => e.stopPropagation() },
                h('div', { class: 'menu-head' },
                    h('span', { class: 'avatar big', text: initials(state.user.userName) }),
                    h('div', {}, h('strong', { text: state.user.userName, dir: 'auto' }), h('span', { class: 'dim', text: `${roleName(state.user.role)} · ${state.user.platformName}` }))),
                h('button', { type: 'button', role: 'menuitem', onclick: () => { set({ menu: false }); api.checkForUpdates(); } }, icon('refresh', 16), t('updates')),
                h('button', { type: 'button', role: 'menuitem', onclick: signOut }, icon('out', 16), t('signOut')))));

    const tile = (kind, label, onClick, busy) => h('div', { class: 'tile-wrap' },
        h('button', { type: 'button', class: `tile tile-${kind}`, onclick: onClick, disabled: busy, 'aria-label': label }, icon(kind === 'new' ? 'video' : 'plus', 30)),
        h('span', { class: 'tile-label', text: busy ? t('opening') : label }));

    const clock = () => {
        const now = new Date();
        const locale = lang === 'ar' ? 'ar' : undefined;
        return h('div', { class: 'clock' },
            h('div', { class: 'time', text: now.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) }),
            h('div', { class: 'date', text: now.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' }) }));
    };

    const classRow = (c) => {
        const busy = state.busy === c.courseId;
        const label = busy ? t('opening') : c.isHost ? (c.live ? t('returnTo') : t('start')) : t('join');
        return h('li', { class: `class-row ${c.live ? 'is-live' : ''}` },
            h('div', { class: 'class-text' },
                h('strong', { text: c.name, dir: 'auto' }),
                c.teacherName && !c.isHost ? h('span', { class: 'dim', text: c.teacherName }) : null),
            c.live ? h('span', { class: 'live-tag' }, h('span', { class: 'dot' }), t('live')) : null,
            (c.live || c.isHost) ? h('button', {
                type: 'button', class: `btn small ${c.live ? 'primary' : ''}`, disabled: !!state.busy, onclick: () => openClass(c.courseId)
            }, label) : null);
    };

    const classesPanel = () => {
        const isTeacher = state.user.role === 'Teacher';
        let body;
        if (!state.enabled) body = h('p', { class: 'dim empty', text: t('notConfigured') });
        else if (state.classes === null) body = h('div', { class: 'spinner' });
        else {
            // Students see the classes they can join now; teachers all of theirs
            const shown = isTeacher ? state.classes : state.classes.filter((c) => c.live);
            body = shown.length
                ? h('ul', { class: 'classes' }, shown.map(classRow))
                : h('p', { class: 'dim empty', text: isTeacher ? t('noClasses') : t('noneLive') });
        }
        return h('section', { class: 'panel' },
            clock(),
            h('div', { class: 'panel-head' },
                h('h2', { text: t('yourClasses') }),
                h('button', { type: 'button', class: 'icon-btn', title: t('retry'), 'aria-label': t('retry'), onclick: () => { set({ classes: null }); loadClasses(); } }, icon('refresh', 16))),
            state.classesFailed ? h('p', { class: 'error small', text: t('classesFailed') }) : null,
            body);
    };

    const homePage = () => {
        const isTeacher = state.user.role === 'Teacher';
        return h('div', { class: 'home' },
            topbar(),
            h('main', { class: 'home-main' },
                h('section', { class: 'tiles' },
                    isTeacher ? tile('new', t('newMeeting'), newMeeting, false) : null,
                    tile('join', t('join'), () => set({ modal: 'join', error: '' }), state.busy === 'join'),
                    state.error && !state.modal ? errorLine() : null),
                classesPanel()));
    };

    // ---- Dialogs --------------------------------------------------------------------------------
    const modal = (title, ...body) => h('div', { class: 'backdrop', onclick: () => set({ modal: null, error: '' }) },
        h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', onclick: (e) => e.stopPropagation() },
            h('h2', { text: title }),
            ...body));

    const joinDialog = () => {
        const busy = state.busy === 'join';
        return modal(t('joinTitle'),
            h('form', {
                class: 'form', onsubmit: (e) => {
                    e.preventDefault();
                    join();
                }
            },
            field('link', { type: 'text', placeholder: t('joinPlaceholder') }),
            h('p', { class: 'dim small', text: t('joinHint') }),
            errorLine(),
            h('div', { class: 'actions' },
                h('button', { type: 'button', class: 'btn', onclick: () => set({ modal: null, error: '' }) }, t('cancel')),
                h('button', { type: 'submit', class: 'btn primary', disabled: busy }, busy ? t('opening') : t('join')))));
    };

    const startDialog = () => {
        const mine = (state.classes || []).filter((c) => c.isHost);
        return modal(t('startTitle'),
            mine.length ? h('ul', { class: 'classes' }, mine.map(classRow)) : null,
            errorLine(),
            h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onclick: () => set({ modal: null, error: '' }) }, t('cancel'))));
    };

    // ---- Render ---------------------------------------------------------------------------------
    // Each render rebuilds the screen; the field you were typing in keeps the focus, and a newly shown
    // screen or dialog puts it in its first field.
    let shownAs = '';
    function render() {
        const pages = { welcome, signin: signInPage, browser: browserPage, choose: choosePage, home: homePage };
        const page = state.view === 'loading' ? h('div', { class: 'center-page' }, h('div', { class: 'spinner' })) : pages[state.view]();
        const dialog = state.modal === 'join' ? joinDialog() : state.modal === 'start' && state.user ? startDialog() : null;
        const active = document.activeElement && document.activeElement.name;
        root.replaceChildren(page, ...(dialog ? [dialog] : []));
        const now = `${state.view}/${state.modal || ''}`;
        const again = active && root.querySelector(`input[name="${active}"]`);
        const first = (dialog || page).querySelector('input');
        const target = shownAs === now ? again : first;
        shownAs = now;
        if (target) {
            target.focus();
            const end = target.value.length;
            if (target.type !== 'password') target.setSelectionRange(end, end);
        }
    }

    document.addEventListener('click', () => { if (state.menu) set({ menu: false }); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && (state.modal || state.menu)) set({ modal: null, menu: false, error: '' });
    });
    // Keep the clock and the live classes fresh
    setInterval(() => {
        if (state.view !== 'home' || state.modal) return;
        loadClasses();
    }, 30000);
    window.addEventListener('focus', () => { if (state.view === 'home' && !state.modal) loadClasses(); });
    // The sign-in changed outside this window (a website's Start, the browser sign-in), maybe with a problem to show
    api.onChange(async (change) => {
        await refreshState();
        if (change && change.error) set({ error: change.error, busy: '' });
    });
    refreshState();
})();
