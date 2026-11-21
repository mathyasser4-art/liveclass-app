# LiveClass desktop app

**Download:** [Windows](https://github.com/mathyasser4-art/liveclass-app/releases/latest/download/LiveClass-Setup.exe) ·
[Mac](https://github.com/mathyasser4-art/liveclass-app/releases/latest/download/LiveClass.dmg) ·
[all versions](https://github.com/mathyasser4-art/liveclass-app/releases)

A Windows / macOS app that works like the Zoom app, for teachers and students:

- **Its own home (1.9.0 on)**: sign in, **New Meeting** (teachers), **Join**, the time, and your classes
  with the live ones first (`src/home.*`). It never shows a website: the app talks to the platforms'
  servers itself (`src/account.js`): IGCSE and SAT (which also serves Mr. Shahin and AIS).
- **Its own sign-in**: email, username or phone and password, tried on every platform (an account on
  two is asked which one). Google accounts use **Sign in with your browser**: the platform's
  `/live/app-signin` page hands the app a one-time pass as `liveclass://signin?code=…&site=…`. The
  sign-in is kept in the app's folder, encrypted with the computer's keychain where there is one.
- **The class** opens in its own window showing only the class screen, loaded from the platform (so
  class updates reach the app without reinstalling) with a fresh one-time pass (`#lc=…`), already
  signed in. After the class, home comes back.

On top it adds what a browser can't do:

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
- **One app for every platform**: its windows keep the name LiveClass, and any page that is not a
  class opens in the browser.
- **One-time passes**: a one-time code (`POST /live/app-link`, two minutes, used once) is traded
  (`POST /live/app-link/redeem`) for the same sign-in. Start or Join on a website opens
  `liveclass://open?url=…&code=…`: the app trades the code (and is then signed in, sharing the
  website's session, so no extra device), and the class page gets a fresh one.
- **Update notice**: on launch (and LiveClass → Check for updates…) the app compares itself with the
  latest GitHub release and offers the download.
- **Opens from the website**: Start or Join on the site (Windows/Mac) opens the class straight in the
  app, signed in. Set `REACT_APP_LIVECLASS_DOWNLOAD_URL` on the website to show a download link.
- The bar and the drawing layer are left out of the screen capture. Students (in the browser) and
  cloud recordings get the strokes over the data channel, as with every annotation, so nothing is
  drawn twice.

Anyone without the app can still join from the browser (the website offers it).

## How it works

- `src/main.js` (Electron main process): windows, liveclass:// links, permissions, the share picker, and the floating
  bar / drawing layer windows. Only our sites (`*.satarea.tech`, `*.mrshahin.com`) get camera,
  microphone, screen and the bridge; other links open in the normal browser.
- `src/preload.js` exposes `window.satDesktop` to the site. The website's side is
  `src/pages/liveClass/desktopApp.js` in the SAT and IGCSE website repos: meetings open in their own window, and the meeting renders
  the bar (`lc-bar`) and drawing layer (`lc-annotate`) into windows the app places and styles.
- `src/account.js`: the app's account (sign-in, classes, one-time passes, Join links), plain Node so
  `npm test` checks it against fake servers. `src/home.*` and `src/home-preload.js` (`window.lcHome`):
  the home window. `src/picker.*`: the share picker.

## Run and build

```bash
npm install
npm test                                    # the account (sign-in, classes, links)
npm start -- --site=http://localhost:3007/live/<courseId>   # a class on a local site (dev tools in the menu)
npm start                                   # against the real platforms
# home against local servers (development only):
LIVECLASS_PLATFORMS='{"igcse":{"api":"http://localhost:54112","site":"http://localhost:3007"}}' npm start
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
