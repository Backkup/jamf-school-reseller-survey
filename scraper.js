const { t } = require('./i18n');
const { BrowserWindow } = require('electron');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

const POLL = 100;
const LOGIN_WAIT = 180000;

async function waitForSelector(wc, selector, timeout, stop, onLogin, targetUrl) {
    let deadline = Date.now() + timeout;
    let prompted = false;
    // Délai initial pour laisser loadURL s'établir avant de contrôler l'URL cible.
    let lastRedirect = Date.now();
    let dashHits = 0; // debounce : n'agir qu'après 2 détections consécutives

    const targetCheck = targetUrl
        ? `location.href.startsWith(${JSON.stringify(targetUrl.replace(/\/$/, ''))})`
        : 'true';

    while (Date.now() < deadline) {
        if (wc.isDestroyed()) throw new Error('Fenêtre fermée');
        if (stop && stop()) return false;
        try {
            const s = await wc.executeJavaScript(
                `(() => ({
                    ok:       !!document.querySelector(${JSON.stringify(selector)}),
                    login:    !!document.querySelector('input[type="password"]') ||
                              /us\\.auth\\.jamf\\.com|\\/u\\/login|\\/authorize|signin/i.test(location.href),
                    jamf:     /\\.jamfcloud\\.com/.test(location.href) &&
                              !/us\\.auth\\.jamf\\.com|\\/u\\/login|\\/authorize|signin/i.test(location.href),
                    onTarget: ${targetCheck},
                    isDash:   /\\/(dashboard|home)(\\?|$|\\/)/i.test(location.pathname),
                }))()`
            );
            if (s.ok) return true;
            if (s.login) {
                if (!prompted) {
                    prompted = true;
                    if (onLogin) onLogin();
                    deadline = Date.now() + LOGIN_WAIT;
                }
            } else if (s.jamf && s.isDash && !s.onTarget && targetUrl) {
                dashHits++;
                // Redirigé vers /dashboard ou /home (SSO déjà actif ou post-login).
                // On exige 2 détections consécutives (200ms) avant de re-naviguer,
                // pour ignorer les URLs transitoires d'une chaîne de redirection
                // OAuth, et on ne le fait que depuis ces pages stables — jamais
                // depuis les pages intermédiaires (/callback, /authorize…) — pour
                // ne pas interrompre une saisie d'identifiants en cours.
                if (dashHits >= 2 && Date.now() - lastRedirect > 1500) {
                    lastRedirect = Date.now();
                    dashHits = 0;
                    try { await wc.loadURL(targetUrl); } catch {}
                }
            } else {
                dashHits = 0;
            }
        } catch { /* navigation en cours */ }
        await sleep(POLL);
    }
    return false;
}

async function gotoAndWait(wc, url, selector, timeout, stop, onLogin) {
    try { await wc.loadURL(url); } catch {}
    return waitForSelector(wc, selector, timeout, stop, onLogin, url);
}

async function pageSnapshot(wc) {
    try {
        return await wc.executeJavaScript(`(() => {
            const el = document.querySelector('time[datetime]');
            return { url: location.href, txt: document.body ? document.body.innerText : '', ts: el ? parseInt(el.getAttribute('datetime'), 10) : null };
        })()`);
    } catch { return { url: '', txt: '', ts: null }; }
}

function daysUntil(date) { return Math.ceil((date - new Date()) / (1000 * 60 * 60 * 24)); }

function parseFrenchDate(text) {
    if (!text) return null;
    // DD/MM/YYYY
    let m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    // YYYY-MM-DD (ISO)
    m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    // D mois YYYY (français)
    const mois = { janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5,
                   juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11 };
    m = text.match(/(\d{1,2})\s+([a-zûéôà]+)\s+(\d{4})/i);
    if (m && mois[m[2].toLowerCase()] !== undefined) return new Date(+m[3], mois[m[2].toLowerCase()], +m[1]);
    // Month D, YYYY (anglais)
    const months = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7,
                     september:8, october:9, november:10, december:11,
                     jan:0, feb:1, mar:2, apr:3, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    m = text.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
    if (m && months[m[1].toLowerCase()] !== undefined) return new Date(+m[3], months[m[1].toLowerCase()], +m[2]);
    return null;
}

// ---------------------------------------------------------------------------
// Collecte APNs (navigation + snapshot)
// ---------------------------------------------------------------------------

async function fetchApns(wc, base, inst, stop, onLogin) {
    if (!inst.collectApns) return null;
    await gotoAndWait(wc, base + '/configuration/apns', 'time[datetime], .v-card, main', 15000, stop, onLogin);
    return pageSnapshot(wc);
}

function applyApns(snap, result, lang) {
    if (!snap) return;
    const { url, txt, ts } = snap;
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

// ---------------------------------------------------------------------------
// Phase 2 : VPP + DEP + Notifications en parallèle (fenêtres du pool)
// ---------------------------------------------------------------------------

async function fetchPhase2(pool, base, inst, stop) {
    const tasks = [];
    if (inst.collectVpp)           tasks.push({ key: 'vpp',   url: base + '/configuration/vpp', sel: 'time[datetime], .content, main', timeout: 10000, win: pool[0] });
    if (inst.collectDep)           tasks.push({ key: 'dep',   url: base + '/configuration/dep', sel: '.content, main, time[datetime]', timeout: 10000, win: pool[1] });
    if (inst.collectNotifications) tasks.push({ key: 'notif', url: base + '/notifications',      sel: 'table, .content, main',          timeout:  8000, win: pool[2] });

    return Promise.all(tasks.map(async ({ key, url, sel, timeout, win }) => {
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
}

function applyPhase2(outcomes, result) {
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
// Pipeline par école (séquentiel, une seule école à la fois par fenêtre) :
//   École N : APNs (fenêtre principale, gère la SSO) → VPP+DEP+Notif (pool, parallèle)
//
// Aucune navigation croisée : la fenêtre principale (visible, utilisée pour la
// connexion) n'est JAMAIS sollicitée pour une autre école tant que l'école
// courante n'est pas entièrement traitée. Un pré-chargement croisé a été tenté
// (build 13-17) mais provoquait des redirections de la fenêtre de connexion
// pendant la saisie de l'utilisateur (champ mot de passe vidé, collecte
// repartant avant la fin de l'authentification) — abandonné définitivement.
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

                const base = inst.url.replace(/\/configuration\/apns$/, '').replace(/\/+$/, '');
                const loginPrompt = () => onProgress && onProgress({ type: 'login', message: `🔐 ${inst.prefix} — connectez-vous dans la fenêtre Jamf…` });

                onProgress({ type: 'instance', master: master.name, prefix: inst.prefix });

                const result = {
                    master: master.name, prefix: inst.prefix,
                    domain: base.replace(/^https?:\/\//, ''),
                    devices: null, apns: null, vpp: null, dep: null,
                    notifications: [], locked: false, overuse: false, inaccessible: false, error: null,
                };

                try {
                    // Phase 1 : APNs (bloquant, gère la SSO si nécessaire)
                    const apnsSnap = await fetchApns(wc, base, inst, stop, loginPrompt);
                    applyApns(apnsSnap, result, lang);

                    if (!result.locked && !result.inaccessible) {
                        // Phase 2 : VPP + DEP + Notifications, en parallèle sur le pool
                        const outcomes = await fetchPhase2(pool, base, inst, stop);
                        applyPhase2(outcomes, result);
                    }
                } catch (err) {
                    result.error = err.message;
                    result.level = 'INACCESSIBLE';
                    onProgress({ type: 'result', result });
                    results.push(result);
                    continue;
                }

                result.level = computeLevel(result);
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
