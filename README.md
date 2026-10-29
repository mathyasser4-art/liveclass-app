# LiveClass desktop app (teachers)

A Windows / macOS app around the live website, for teachers who want the Zoom-app experience.
It loads the site itself, so every website update reaches the app without reinstalling. On top it
adds what a browser can't do:

- **Own share picker** (screens and windows, optional computer sound on Windows) and **no browser
  "Stop sharing / Hide" bar**.
- **The meeting window minimizes when sharing starts** and comes back when it stops; the floating
  control bar stays on top of everything.
- **Annotate anywhere**: when a whole screen is shared, a see-through drawing layer covers it, so
  the teacher draws on any program (PowerPoint, PDF, browser…). The mouse goes through the layer
  unless a pen is picked. When one window is shared, drawing happens in the floating bar, as on the
  website.
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
  `src/pages/liveClass/desktopApp.js`: meetings open in their own window, and the meeting renders
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

`assets/icon.png` is rendered from `assets/icon.svg` with `npx electron scripts/make-icon.js`.

## Before handing it to teachers

- **Signing**: without a code-signing certificate, Windows shows "Windows protected your PC"
  (More info → Run anyway) and macOS blocks the app. Windows: an OV certificate or Azure Trusted
  Signing; macOS: an Apple Developer account (signing + notarization, plus camera/microphone
  entitlements for the hardened runtime).
- **Updates**: the site updates itself; the app only needs a new installer when `desktop/` changes.
  Auto-update (electron-updater) can be added once the installers are hosted (e.g. on R2).
- **macOS**: the first share asks for Screen Recording permission in System Settings.
