# LiveClass desktop app (teachers)

**Download:** [Windows](https://github.com/mathyasser4-art/liveclass-app/releases/latest/download/LiveClass-Setup.exe) ·
[Mac](https://github.com/mathyasser4-art/liveclass-app/releases/latest/download/LiveClass.dmg) ·
[all versions](https://github.com/mathyasser4-art/liveclass-app/releases)

A Windows / macOS app around the live website, for teachers who want the Zoom-app experience.
It loads the site itself, so every website update reaches the app without reinstalling. On top it
adds what a browser can't do:

- **Own share picker** (screens and windows, optional computer sound on Windows) and **no browser
  "Stop sharing / Hide" bar**.
- **Zoom's sharing layout**: the meeting window minimizes when sharing starts and comes back when
  it stops; a "You are screen sharing · Stop Share" pill sits at the top and opens into the full
  toolbar (mute, video, participants, New Share, pause, annotate, chat, more) on hover; a small
  video window shows who's talking; a green border marks the shared screen, or follows the shared
  window on Windows (it needs the `koffi` dependency; without it a shared window has no border).
- **Annotate anywhere** with Zoom's toolbar (mouse, text, pen/highlighter/line/arrow/rectangle/oval,
  stamps, spotlight, eraser, colour and thickness, undo/redo, clear, save): when a whole screen is
  shared, a see-through drawing layer covers it, so the teacher draws on any program. The mouse goes
  through the layer unless a tool is picked. When one window is shared, drawing happens on its
  picture in the meeting window.
- **Platforms**: SATAREA, Mr. Shahin, AIS and IGCSE (chosen on first launch).
- **Opens from the website**: "Start LiveClass" on the site (Windows/Mac) opens a
  `liveclass://open?url=…` link, so the meeting opens straight in the app (signed in once with the
  app's own login). Set `REACT_APP_LIVECLASS_DOWNLOAD_URL` on the website to show a download link.
- The bar and the drawing layer are left out of the screen capture. Students (in the browser) and
  cloud recordings get the strokes over the data channel, as with every annotation, so nothing is
  drawn twice.

Students and guests keep using the website.

## How it works

- `src/main.js` (Electron main process): windows, the site choice (SATAREA / Mr. Shahin / AIS on
  first launch, LiveClass → Change site… later), permissions, the share picker, and the floating
  bar / drawing layer windows. Only our sites (`*.satarea.tech`, `*.mrshahin.com`) get camera,
  microphone, screen and the bridge; other links open in the normal browser.
- `src/preload.js` exposes `window.satDesktop` to the site. The website's side is
  `src/pages/liveClass/desktopApp.js` in the SAT and IGCSE website repos: meetings open in their own window, and the meeting renders
  the bar (`lc-bar`) and drawing layer (`lc-annotate`) into windows the app places and styles.
- `src/picker.*`, `src/site.*`: the app's own pages.

## Run and build

```bash
npm install
npm start -- --site=http://localhost:3007   # against a local site (any URL; dev tools in the menu)
npm start                                   # against the real sites
npm run dist:win                            # dist/LiveClass-Setup-<version>.exe
npm run dist:mac                            # dist/LiveClass-<version>.dmg (must run on a Mac)
```

**Releases are automatic**: raise `version` in `package.json` and push to `main`. GitHub builds the
Windows and Mac installers (`.github/workflows/release.yml`) and publishes them as the latest
release, with `RELEASE_NOTES.md` as its text; the websites' download links always get the latest.
Actions → Release → Run workflow rebuilds the current version.

`assets/icon.png` is rendered from `assets/icon.svg` with `npx electron scripts/make-icon.js`.

## Before handing it to teachers

- **Signing** (not set up yet): without a code-signing certificate, Windows shows "Windows protected your PC"
  (More info → Run anyway) and macOS blocks the app. Windows: an OV certificate or Azure Trusted
  Signing; macOS: an Apple Developer account (signing + notarization, plus camera/microphone
  entitlements for the hardened runtime).
- **Updates**: the site updates itself; the app only needs a new installer when `desktop/` changes.
  Auto-update (electron-updater) can be added on top of the GitHub releases.
- **macOS**: the first share asks for Screen Recording permission in System Settings.
