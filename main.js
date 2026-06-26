const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { collectMaster } = require('./scraper');
const { generatePdf } = require('./report');
const { uploadPdf, buildSummary } = require('./slack');
const { t, detectLang } = require('./i18n');

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


let mainWindow;
let monitorWindow;
let loginWindow;
let scraperRunning = false;
let stopRequested = false;

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
            sandbox: false,
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
            sandbox: false,
            preload: path.join(__dirname, 'preload.js'),
        },
        title: 'Jamf School Reseller Survey — Collecte',
    });
    monitorWindow.loadFile(path.join(__dirname, 'renderer', 'monitor.html'));
    monitorWindow.on('closed', () => { monitorWindow = null; });
}

function openLoginWindow(loginUrl, partition) {
    return new Promise((resolve, reject) => {
        loginWindow = new BrowserWindow({
            width: 1000,
            height: 720,
            title: 'Connexion Jamf School — laissez cette fenêtre ouverte',
            webPreferences: { nodeIntegration: false, contextIsolation: true, partition },
        });

        loginWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (/google\.com|accounts\.google|microsoftonline|okta|auth/i.test(url)) {
                return { action: 'allow', overrideBrowserWindowOptions: { width: 600, height: 720, webPreferences: { nodeIntegration: false, contextIsolation: true, partition } } };
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
            if (!resolved) reject(new Error('err_login_closed'));
        });
    });
}

app.whenReady().then(() => {
    // En dev, l'icône du Dock vient du PNG (en prod, c'est le .icns du bundle).
    if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
        try { app.dock.setIcon(path.join(__dirname, 'build', 'icon.png')); } catch {}
    }
    initConfigPath();
    createMainWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });

// ---- IPC config ----

ipcMain.handle('get-config', () => {
    try {
        const config = loadConfig();
        if (!config.language) {
            config.language = detectLang(app.getLocale()); // anglais par défaut, fr si appareil en français
            saveConfig(config);
        }
        return config;
    }
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

ipcMain.handle('stop-scraper', () => {
    if (scraperRunning) stopRequested = true;
    return { ok: true };
});

ipcMain.handle('start-scraper', async (_, opts) => {
    const config = loadConfig();
    const lang = config.language || detectLang(app.getLocale());
    if (scraperRunning) return { error: t(lang, 'err_busy') };
    stopRequested = false;

    const masterId = opts && opts.masterId;
    let masters = config.masters || [];
    masters = masterId
        ? masters.filter(m => m.id === masterId)
        : masters.filter(m => m.enabled);
    masters = masters.filter(m => (m.instances || []).some(i => i.enabled));
    if (!masters.length) return { error: t(lang, 'err_no_instances') };

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
            send({ type: 'log', message: t(lang, 'log_connecting', { name: master.name }) });

            const win = await openLoginWindow(master.loginUrl);
            // Laisse la session SSO s'établir complètement avant de lancer la collecte.
            await new Promise(r => setTimeout(r, 1200));

            // Collecte en FENÊTRE UNIQUE (séquentielle). Pas de parallélisme :
            // une seule fenêtre conserve la session SSO d'une école à l'autre.
            const workers = [win.webContents];
            send({ type: 'log', message: t(lang, 'log_connected', { name: master.name, n: 1 }) });

            const results = await collectMaster(workers, master, send, lang, () => stopRequested);

            // Si aucune donnée collectée et arrêt immédiat, on saute le rapport.
            const collectedSomething = results.length > 0;

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

            // Rapport (partiel si arrêt, tant qu'au moins une école a été collectée)
            if (collectedSomething) {
                send({ type: 'log', message: t(lang, 'log_generating', { name: master.name }) });
                const pdfPath = await generatePdf(results, master.name, lang);

                let delivered = 'local';
                if (delivery.mode === 'slack') {
                    try {
                        await uploadPdf(delivery.botToken, delivery.channelId, pdfPath, `*${master.name}* — ${buildSummary(results, lang)}`);
                        delivered = 'slack';
                        send({ type: 'log', message: t(lang, 'log_slack_ok', { name: master.name }) });
                    } catch (err) {
                        send({ type: 'error', prefix: 'Slack', message: t(lang, 'err_slack_fail', { name: master.name, err: err.message }) });
                        shell.openPath(pdfPath);
                    }
                } else {
                    shell.openPath(pdfPath);
                }
                reports.push({ master: master.name, pdfPath, delivered });
            }

            if (stopRequested) break; // arrêt demandé : on ne traite pas les revendeurs suivants
        }

        scraperRunning = false;
        const done = { success: true, reports, mode: delivery.mode, stopped: stopRequested };
        if (monitorWindow) monitorWindow.webContents.send('done', done);
        if (mainWindow) mainWindow.webContents.send('scraper-done', done);
        return { ok: true };

    } catch (err) {
        scraperRunning = false;
        if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }
        const msg = t(lang, err.message); // traduit si err.message est une clé connue, sinon tel quel
        send({ type: 'error', prefix: 'Collecte', message: msg });
        const done = { success: false, error: msg };
        if (monitorWindow) monitorWindow.webContents.send('done', done);
        if (mainWindow) mainWindow.webContents.send('scraper-done', done);
        return { error: msg };
    }
});
