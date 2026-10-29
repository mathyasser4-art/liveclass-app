// The share picker: screens and windows with live thumbnails, like Zoom's share dialog.
const TEXT = {
    en: {
        title: 'Choose what to share',
        screens: 'Screens',
        windows: 'Windows',
        screen: 'Screen',
        sound: 'Share computer sound',
        hint: 'Share a screen to draw anywhere on it.',
        cancel: 'Cancel',
        share: 'Share',
        empty: 'Nothing to share here.',
        macAccess: 'Allow LiveClass in System Settings → Privacy & Security → Screen Recording, then reopen the app.'
    },
    ar: {
        title: 'اختر ما تريد مشاركته',
        screens: 'الشاشات',
        windows: 'النوافذ',
        screen: 'الشاشة',
        sound: 'مشاركة صوت الكمبيوتر',
        hint: 'شارك شاشة كاملة لتتمكن من الرسم في أي مكان عليها.',
        cancel: 'إلغاء',
        share: 'مشاركة',
        empty: 'لا يوجد شيء للمشاركة هنا.',
        macAccess: 'اسمح لـ LiveClass من إعدادات النظام ← الخصوصية والأمان ← تسجيل الشاشة، ثم أعد فتح التطبيق.'
    }
};

const $ = (id) => document.getElementById(id);
let sources = [];
let tab = 'screen';
let selected = '';
let t = TEXT.en;

const choose = (id) => window.lcApp.choose(id ? { id, audio: $('sound').checked } : null);

const render = () => {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const grid = $('grid');
    grid.textContent = '';
    const list = sources.filter((s) => s.type === tab);
    if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = t.empty;
        grid.appendChild(empty);
    }
    list.forEach((s, i) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `source ${s.id === selected ? 'selected' : ''}`;
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        if (s.thumbnail) thumb.style.backgroundImage = `url("${s.thumbnail}")`;
        const name = document.createElement('div');
        name.className = 'name';
        if (s.icon) {
            const img = document.createElement('img');
            img.src = s.icon;
            img.alt = '';
            name.appendChild(img);
        }
        const label = document.createElement('span');
        // Screens are called "Entire Screen"/"Screen 1" by the system; keep them simple and translated.
        label.textContent = s.type === 'screen' ? `${t.screen} ${list.length > 1 ? i + 1 : ''}`.trim() : s.name;
        label.title = s.name;
        name.appendChild(label);
        item.append(thumb, name);
        item.addEventListener('click', () => {
            selected = s.id;
            $('share').disabled = false;
            render();
        });
        item.addEventListener('dblclick', () => choose(s.id));
        grid.appendChild(item);
    });
};

window.lcApp.onSources((data) => {
    t = TEXT[data.lang] || TEXT.en;
    document.documentElement.lang = data.lang;
    document.documentElement.dir = data.lang === 'ar' ? 'rtl' : 'ltr';
    $('title').textContent = t.title;
    $('tab-screen').textContent = t.screens;
    $('tab-window').textContent = t.windows;
    $('sound-label').textContent = t.sound;
    $('hint').textContent = t.hint;
    $('cancel').textContent = t.cancel;
    $('share').textContent = t.share;
    // Windows can share the computer's sound; macOS can't without extra drivers.
    $('sound-row').hidden = data.platform !== 'win32';
    if (data.screenAccess !== 'granted' && data.platform === 'darwin') {
        $('note').hidden = false;
        $('note').textContent = t.macAccess;
    }
    sources = data.sources;
    const screens = sources.filter((s) => s.type === 'screen');
    if (screens.length === 1) selected = screens[0].id;
    $('share').disabled = !selected;
    render();
});

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    render();
}));
$('cancel').addEventListener('click', () => choose(null));
$('share').addEventListener('click', () => choose(selected));
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') choose(null);
    if (e.key === 'Enter' && selected) choose(selected);
});
