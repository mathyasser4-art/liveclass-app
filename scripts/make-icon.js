// Renders assets/icon.svg to assets/icon.png (512 px) for the installers: npx electron scripts/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
    const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
    const win = new BrowserWindow({ width: 512, height: 512, show: false, enableLargerThanScreen: true, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
    await win.loadURL(`data:text/html,<style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block;width:512px;height:512px}</style>${encodeURIComponent(svg)}`);
    await new Promise((r) => setTimeout(r, 300));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG());
    app.quit();
});
