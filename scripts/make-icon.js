const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'icon.svg'), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${svg}`;

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 1024, height: 1024, x: -4000, y: -4000,
        show: true, frame: false, transparent: true, backgroundColor: '#00000000',
        useContentSize: true, webPreferences: {},
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise(r => setTimeout(r, 500));
    const img = await win.webContents.capturePage();
    const out = path.join(__dirname, '..', 'build', 'icon.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, img.toPNG());
    console.log('PNG_OUT:', out, JSON.stringify(img.getSize()));
    win.close();
    app.quit();
});
