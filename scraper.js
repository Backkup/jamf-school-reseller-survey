const { t } = require('./i18n');
const { BrowserWindow } = require('electron');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const POLL = 100;
const LOGIN_WAIT = 180000; // timeout de sécurité max si login manuel requis

// Attend qu'un sélecteur apparaisse, en pollant toutes les POLL ms.
//
// Détection SSO :
//   – Page de login détectée → prévient (onLogin), étend le délai.
//   – Retour sur Jamf après login (dashboard) → re-navigue immédiatement
//     vers targetUrl sans attendre la fin du timeout.
async function waitForSelector(wc, selector, timeout, stop, onLogin, targetUrl) {
    let deadline = Date.now() + timeout;
    let prompted = false;
    let wasOnLogin = false;

    while (Date.now() < deadline) {
        if (wc.isDestroyed()) throw new Error('Fenêtre fermée');
        if (stop && stop()) return false;
        try {
            const s = await wc.executeJavaScript(
                `(() => ({
                    ok:    !!document.querySelector(${JSON.stringify(selector)}),
                    login: !!document.querySelector('input[type="password"]') ||
                           /us\\.auth\\.jamf\\.com|\\/u\\/login|\\/authorize|signin/i.test(location.href),
                    jamf:  /\\.jamfcloud\\.com/.test(location.href) &&
                           !/us\\.auth\\.jamf\\.com|\\/u\\/login|\\/authorize|signin/i.test(location.href)
                }))()`
            );
            if (s.ok) return true;
            if (s.login) {
                wasOnLogin = true;
                if (!prompted) {
                    prompted = true;
                    if (onLogin) onLogin();
                    deadline = Date.now() + LOGIN_WAIT;
                }
            } else if (wasOnLogin && s.jamf && targetUrl) {
                // Login terminé, Jamf a renvoyé vers le dashboard.
                // Re-navigation immédiate vers la page cible.
                wasOnLogin = false;
                try { await wc.loadURL(targetUrl); } catch {}
            }
        } catch { /* navigation en cours */ }
        await sleep(POLL);
    }
    return false;
}

async function gotoAndWait(wc, url, selector, timeout, stop, onLogin) {
    try { await wc.loadURL(url); } catch { /* redirection SSO : non bloquant */ }
    return waitForSelector(wc, selector, timeout, stop, onLogin, url);
}

// Récupère url + texte + timestamp en un seul aller-retour IPC.
async function pageSnapshot(wc) {
    try {
        return await wc.executeJavaScript(`(() => {
            const el = document.querySelector('time[datetime]');
            return {
                url: location.href,
                txt: document.body ? document.body.innerText : '',
                ts:  el ? parseInt(el.getAttribute('datetime'), 10) : null
            };
        })()`);
    } catch { return { url: '', txt: '', ts: null }; }
}

function daysUntil(date) {
    return Math.ceil((date - new Date()) / (1000 * 60 * 60 * 24));
}

function parseFrenchDate(text) {
    if (!text) return null;
    let m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    const mois = { janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
                   juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11 };
    m = text.match(/(\d{1,2})\s+([a-zûéô]+)\s+(\d{4})/i);
    if (m && mois[m[2].toLowerCase()] !== undefined) return new Date(+m[3], mois[m[2].toLowerCase()], +m[1]);
    return null;
}

// ---------------------------------------------------------------------------
// Collecte d'une école — 2 phases :
//   Phase 1 : APNs dans la fenêtre principale (gère SSO si nécessaire)
//   Phase 2 : VPP + DEP + Notifications en parallèle dans les fenêtres du
//             pool (même sous-domaine → mêmes cookies → SSO déjà établi)
// ---------------------------------------------------------------------------

async function collectInstance(wc, inst, masterName, lang, onProgress, stop, pool) {
    const base = inst.url.replace(/\/configuration\/apns$/, '').replace(/\/+$/, '');
    const loginPrompt = () => onProgress && onProgress({
        type: 'log',
        message: `🔐 ${inst.prefix} — connectez-vous dans la fenêtre Jamf…`,
    });
    const result = {
        master: masterName || '',
        prefix: inst.prefix,
        domain: base.replace(/^https?:\/\//, ''),
        devices: null, apns: null, vpp: null, dep: null,
        notifications: [],
        locked: false, overuse: false, inaccessible: false, error: null,
    };

    // --- Phase 1 : APNs (fenêtre principale, gère le SSO) ---
    if (inst.collectApns) {
        await gotoAndWait(wc, base + '/configuration/apns', 'time[datetime]', 15000, stop, loginPrompt);
        const { url, txt, ts } = await pageSnapshot(wc);
        if (/extend\.html/i.test(url)) {
            result.locked = true;
        } else if (/\/u\/login|\/authorize|us\.auth\.jamf\.com|\/auth|signin/i.test(url) && !/configuration/i.test(url)) {
            result.inaccessible = true;
            result.error = t(lang, 'err_session');
        } else if (/surutilisation|0 licence/i.test(txt)) {
            result.overuse = true;
        } else {
            const date = ts ? new Date(ts) : parseFrenchDate(txt);
            if (date && !isNaN(date)) result.apns = { date: date.toISOString(), daysLeft: daysUntil(date) };
            const dm = txt.match(/([\d][\d\s. ]*)\s*appareils/i);
            if (dm) { const n = parseInt(dm[1].replace(/[^\d]/g, ''), 10); if (!isNaN(n)) result.devices = n; }
        }
    }

    // Verrouillé ou inaccessible : inutile d'aller plus loin.
    if (result.locked || result.inaccessible) {
        result.level = computeLevel(result);
        return result;
    }

    // --- Phase 2 : VPP + DEP + Notifications en parallèle ---
    // SSO déjà établi par phase 1 sur ce sous-domaine → pas de collision.
    const tasks = [];
    if (inst.collectVpp)           tasks.push({ key: 'vpp',   url: base + '/configuration/vpp', sel: 'time[datetime], .content, main', timeout: 10000, win: pool[0] });
    if (inst.collectDep)           tasks.push({ key: 'dep',   url: base + '/configuration/dep', sel: '.content, main, time[datetime]', timeout: 10000, win: pool[1] });
    if (inst.collectNotifications) tasks.push({ key: 'notif', url: base + '/notifications',      sel: 'table, .content, main',          timeout:  8000, win: pool[2] });

    const outcomes = await Promise.all(tasks.map(async ({ key, url, sel, timeout, win }) => {
        const wct = win.webContents;
        if (wct.isDestroyed()) return { key, data: null };

        await gotoAndWait(wct, url, sel, timeout, stop);
        if (wct.isDestroyed()) return { key, data: null };

        if (key === 'notif') {
            for (let i = 0; i < 6; i++) {
                await sleep(100);
                const ready = await wct.executeJavaScript(`document.querySelectorAll('table tr').length > 1`).catch(() => false);
                if (ready) break;
            }
            const notifs = await wct.executeJavaScript(`(() => {
                const rows = [...document.querySelectorAll('table tr')].slice(1);
                return rows.filter(r => r.textContent && !r.textContent.includes('Fermé') && r.textContent.trim().length > 10)
                           .slice(0, 8).map(r => r.textContent.trim().replace(/\\s+/g, ' ').substring(0, 180));
            })()`).catch(() => []);
            return { key, data: notifs };
        }

        return { key, data: await pageSnapshot(wct) };
    }));

    for (const { key, data } of outcomes) {
        if (!data) continue;
        if (key === 'vpp') {
            const { url, txt, ts } = data;
            if (/extend\.html/i.test(url)) result.locked = true;
            else {
                const date = ts ? new Date(ts) : parseFrenchDate(txt);
                if (/expiré|expired/i.test(txt) && !date) result.vpp = { expired: true };
                else if (date && !isNaN(date)) result.vpp = { date: date.toISOString(), daysLeft: daysUntil(date) };
            }
        } else if (key === 'dep') {
            const { url, txt, ts } = data;
            if (/extend\.html/i.test(url)) result.locked = true;
            else if (/accepter les nouvelles conditions|nouvelles conditions générales|terms and conditions/i.test(txt)) {
                result.dep = { cgu: true };
            } else {
                const ddate = ts ? new Date(ts) : parseFrenchDate(txt);
                if (ddate && !isNaN(ddate)) result.dep = { date: ddate.toISOString(), daysLeft: daysUntil(ddate) };
            }
        } else if (key === 'notif') {
            result.notifications = data;
        }
    }

    result.level = computeLevel(result);
    return result;
}

function computeLevel(r) {
    if (r.inaccessible) return 'INACCESSIBLE';
    if (r.locked) return 'CRITIQUE';
    if (r.vpp && r.vpp.expired) return 'CRITIQUE';
    if (r.apns && r.apns.daysLeft < 30) return 'CRITIQUE';
    if (r.vpp && typeof r.vpp.daysLeft === 'number' && r.vpp.daysLeft < 30) return 'CRITIQUE';
    if (r.apns && r.apns.daysLeft < 60) return 'URGENT';
    if (r.vpp && typeof r.vpp.daysLeft === 'number' && r.vpp.daysLeft < 60) return 'URGENT';
    if (r.dep && r.dep.cgu) return 'ATTENTION';
    if (r.overuse) return 'LICENCE';
    return 'OK';
}

// ---------------------------------------------------------------------------
// Collecte de toutes les écoles d'un revendeur.
// Pool de 3 fenêtres cachées créé une fois, réutilisé entre les écoles.
// ---------------------------------------------------------------------------

async function collectMaster(workers, master, onProgress, lang, shouldStop) {
    const queue = (master.instances || []).filter(i => i.enabled);
    const results = [];
    let idx = 0;
    const stop = () => (shouldStop ? shouldStop() : false);

    const pool = [
        new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { nodeIntegration: false, contextIsolation: true } }),
        new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { nodeIntegration: false, contextIsolation: true } }),
        new BrowserWindow({ show: false, width: 1024, height: 768, webPreferences: { nodeIntegration: false, contextIsolation: true } }),
    ];

    try {
        async function runWorker(wc) {
            while (true) {
                if (stop()) break;
                const inst = queue[idx++];
                if (!inst) break;
                if (wc.isDestroyed()) break;

                onProgress({ type: 'instance', master: master.name, prefix: inst.prefix });
                let result;
                try {
                    result = await collectInstance(wc, inst, master.name, lang, onProgress, stop, pool);
                } catch (err) {
                    result = { master: master.name, prefix: inst.prefix, error: err.message, level: 'INACCESSIBLE', notifications: [] };
                }
                onProgress({ type: 'result', result });
                results.push(result);
            }
        }

        await Promise.all(workers.map(wc => runWorker(wc)));
    } finally {
        pool.forEach(w => { try { if (!w.isDestroyed()) w.close(); } catch {} });
    }

    return results;
}

module.exports = { collectMaster };
