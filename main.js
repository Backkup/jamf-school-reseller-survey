const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { collectMaster } = require('./scraper');
const { generatePdf } = require('./report');
const { uploadPdf, buildSummary } = require('./slack');

// En dev : le fichier du dépôt (modifiable directement).
// En production (.app) : le bundle est en lecture seule → on persiste dans le
// dossier utilisateur, en amorçant depuis la config par défaut empaquetée.
const DEFAULT_CONFIG = path.join(__dirname, 'data', 'instances.json');
let CONFIG_PATH = DEFAULT_CONFIG;
function initConfigPath() {
    if (app.isPackaged) {
        CONFIG_PATH = path.join(app.getPath('userData'), 'instances.json');
        if (!fs.existsSync(CONFIG_PATH)) {
            try { fs.copyFileSync(DEFAULT_CONFIG, CONFIG_PATH); } catch (e) { /* premier lancement */ }
        }
    }
}

// Nombre maximum de fenêtres collectant en parallèle par revendeur.
// 4 = bon compromis vitesse / charge serveur Jamf.
const MAX_CONCURRENCY = 4;

let mainWindow;
let monitorWindow;
let loginWindow;
let scraperRunning = false;

function loadConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}
function saveConfig(config) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}
function slug(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || ('id' + Date.now());
}
// Conserve uniquement la base « https://<sous-domaine>.jamfcloud.com »
// (le scraper ajoute lui-même /configuration/apns, /vpp, /dep, /notifications)
function normalizeInstanceUrl(input) {
    let u = (input || '').trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const url = new URL(u); return url.protocol + '//' + url.host; }
    catch { return u.replace(/\/.*$/, ''); }
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 980,
        height: 760,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        title: 'Jamf School Reseller Survey',
    });
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function createMonitorWindow() {
    monitorWindow = new BrowserWindow({
        width: 740,
        height: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
        title: 'Jamf School Reseller Survey — Collecte',
    });
    monitorWindow.loadFile(path.join(__dirname, 'renderer', 'monitor.html'));
    monitorWindow.on('closed', () => { monitorWindow = null; });
}

function openLoginWindow(loginUrl) {
    return new Promise((resolve, reject) => {
        loginWindow = new BrowserWindow({
            width: 1000,
            height: 720,
            title: 'Connexion Jamf School — laissez cette fenêtre ouverte',
            webPreferences: { nodeIntegration: false, contextIsolation: true },
        });

        loginWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (/google\.com|accounts\.google|microsoftonline|okta|auth/i.test(url)) {
                return { action: 'allow', overrideBrowserWindowOptions: { width: 600, height: 720, webPreferences: { nodeIntegration: false, contextIsolation: true } } };
            }
            return { action: 'allow' };
        });

        loginWindow.loadURL(loginUrl);
        loginWindow.show();

        let resolved = false;
        const checkNav = (url) => {
            if (resolved) return;
            if (url.includes('.jamfcloud.com/dashboard') || url.includes('.jamfcloud.com/home')) {
                resolved = true;
                loginWindow.webContents.removeAllListeners('did-navigate');
                loginWindow.webContents.removeAllListeners('did-navigate-in-page');
                resolve(loginWindow);
            }
        };
        loginWindow.webContents.on('did-navigate', (_, url) => checkNav(url));
        loginWindow.webContents.on('did-navigate-in-page', (_, url) => checkNav(url));

        loginWindow.on('closed', () => {
            loginWindow = null;
            if (!resolved) reject(new Error('Fenêtre de connexion fermée avant connexion'));
        });
    });
}

app.whenReady().then(() => { initConfigPath(); createMainWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

// ---- IPC config ----

ipcMain.handle('get-config', () => {
    try { return loadConfig(); }
    catch (err) { return { error: err.message, masters: [], delivery: { mode: 'local' } }; }
});

ipcMain.handle('save-config', (_, config) => { saveConfig(config); return { ok: true }; });

ipcMain.handle('add-master', (_, { name, loginUrl }) => {
    const config = loadConfig();
    config.masters.push({ id: slug(name), name, loginUrl, enabled: true, instances: [] });
    saveConfig(config);
    return config;
});

ipcMain.handle('remove-master', (_, masterId) => {
    const config = loadConfig();
    config.masters = config.masters.filter(m => m.id !== masterId);
    saveConfig(config);
    return config;
});

ipcMain.handle('add-instance', (_, { masterId, prefix, url }) => {
    const config = loadConfig();
    const master = config.masters.find(m => m.id === masterId);
    if (master) {
        master.instances.push({
            id: slug(prefix), prefix, url: normalizeInstanceUrl(url),
            enabled: true, collectApns: true, collectVpp: true, collectDep: true, collectNotifications: true,
        });
        saveConfig(config);
    }
    return config;
});

ipcMain.handle('remove-instance', (_, { masterId, id }) => {
    const config = loadConfig();
    const master = config.masters.find(m => m.id === masterId);
    if (master) master.instances = master.instances.filter(i => i.id !== id);
    saveConfig(config);
    return config;
});

ipcMain.handle('update-instance', (_, { masterId, id, prefix, url }) => {
    const config = loadConfig();
    const master = config.masters.find(m => m.id === masterId);
    const inst = master && master.instances.find(i => i.id === id);
    if (inst) {
        if (prefix) inst.prefix = prefix;
        if (url) inst.url = normalizeInstanceUrl(url);
    }
    saveConfig(config);
    return config;
});

ipcMain.handle('update-master', (_, { masterId, name, loginUrl }) => {
    const config = loadConfig();
    const master = config.masters.find(m => m.id === masterId);
    if (master) {
        if (name) master.name = name;
        if (loginUrl) master.loginUrl = loginUrl.trim();
    }
    saveConfig(config);
    return config;
});

ipcMain.handle('set-reason', (_, { masterId, id, reason }) => {
    const config = loadConfig();
    const master = config.masters.find(m => m.id === masterId);
    const inst = master && master.instances.find(i => i.id === id);
    if (inst) inst.disabledReason = reason;
    saveConfig(config);
    return { ok: true };
});

// ---- IPC collecte ----

ipcMain.handle('start-scraper', async (_, opts) => {
    if (scraperRunning) return { error: 'Collecte déjà en cours' };

    const masterId = opts && opts.masterId;
    const config = loadConfig();
    let masters = config.masters || [];
    masters = masterId
        ? masters.filter(m => m.id === masterId)
        : masters.filter(m => m.enabled);
    masters = masters.filter(m => (m.instances || []).some(i => i.enabled));
    if (!masters.length) return { error: 'Aucune instance à collecter (maître désactivé ou aucune instance activée)' };

    if (!monitorWindow) createMonitorWindow();
    await new Promise(r => setTimeout(r, 400));

    scraperRunning = true;
    const send = (event) => { if (monitorWindow) monitorWindow.webContents.send('progress', event); };

    const totalInstances = masters.reduce((n, m) => n + m.instances.filter(i => i.enabled).length, 0);
    send({ type: 'start', total: totalInstances, masters: masters.length });

    const delivery = config.delivery || { mode: 'local' };

    try {
        const reports = []; // { master, pdfPath, delivered }

        for (const master of masters) {
            send({ type: 'log', message: `Connexion à « ${master.name} »...` });
            const win = await openLoginWindow(master.loginUrl);

            // Workers parallèles partageant la session SSO (cookies de la session
            // par défaut, communs à toutes les BrowserWindow sans partition).
            const enabledCount = master.instances.filter(i => i.enabled).length;
            const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, enabledCount));
            const extraWins = [];
            for (let k = 1; k < concurrency; k++) {
                extraWins.push(new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } }));
            }
            const workers = [win.webContents, ...extraWins.map(w => w.webContents)];
            send({ type: 'log', message: `Connecté à « ${master.name} » — collecte parallèle sur ${concurrency} fenêtre(s)...` });

            const results = await collectMaster(workers, master, send);

            extraWins.forEach(w => { if (!w.isDestroyed()) w.close(); });

            // Inclure les instances désactivées (avec leur raison) dans le rapport
            master.instances.filter(i => !i.enabled).forEach(i => {
                results.push({
                    master: master.name,
                    prefix: i.prefix,
                    domain: i.url.replace(/^https?:\/\//, '').replace(/\/.*$/, ''),
                    disabled: true,
                    reason: i.disabledReason || '',
                    notifications: [],
                    level: 'DESACTIVE',
                });
            });

            if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }

            // Un rapport PDF propre à ce maître
            send({ type: 'log', message: `Génération du rapport PDF pour « ${master.name} »...` });
            const pdfPath = await generatePdf(results, master.name);

            let delivered = 'local';
            if (delivery.mode === 'slack') {
                try {
                    await uploadPdf(delivery.botToken, delivery.channelId, pdfPath, `*${master.name}* — ${buildSummary(results)}`);
                    delivered = 'slack';
                    send({ type: 'log', message: `« ${master.name} » publié sur Slack.` });
                } catch (err) {
                    send({ type: 'error', prefix: 'Slack', message: `${master.name} : ${err.message} — PDF conservé en local.` });
                    shell.openPath(pdfPath);
                }
            } else {
                shell.openPath(pdfPath);
            }

            reports.push({ master: master.name, pdfPath, delivered });
        }

        scraperRunning = false;
        const done = { success: true, reports, mode: delivery.mode };
        if (monitorWindow) monitorWindow.webContents.send('done', done);
        if (mainWindow) mainWindow.webContents.send('scraper-done', done);
        return { ok: true };

    } catch (err) {
        scraperRunning = false;
        if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }
        send({ type: 'error', prefix: 'Collecte', message: err.message });
        const done = { success: false, error: err.message };
        if (monitorWindow) monitorWindow.webContents.send('done', done);
        if (mainWindow) mainWindow.webContents.send('scraper-done', done);
        return { error: err.message };
    }
});
