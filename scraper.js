const { t } = require('./i18n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Navigation dans une fenêtre Electron authentifiée (SPA Vue.js : il faut
// réellement naviguer, fetch() ne renvoie que le squelette).
//
// loadAndExtract charge l'URL puis attend (poll 150 ms) qu'une condition
// « page prête » soit vraie, et renvoie en UN SEUL aller-retour { url, ts, text }.
// La condition court-circuite les pages /extend.html (verrou) et /auth pour
// éviter d'attendre le timeout complet.
// ---------------------------------------------------------------------------

const POLL = 150;

async function loadAndExtract(wc, url, readyExpr, timeout) {
    try { await wc.loadURL(url); } catch { /* abort/redirection SSO : non bloquant */ }

    const probe = `(() => {
        const ready = (${readyExpr});
        if (!ready) return null;
        const t = document.querySelector('time[datetime]');
        return { url: location.href, ts: t ? parseInt(t.getAttribute('datetime'), 10) : null, text: document.body ? document.body.innerText : '' };
    })()`;

    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (wc.isDestroyed()) throw new Error('Fenêtre fermée');
        try {
            const data = await wc.executeJavaScript(probe);
            if (data) return data;
        } catch { /* navigation en cours */ }
        await sleep(POLL);
    }
    // Timeout : renvoyer l'état courant quel qu'il soit
    try {
        return await wc.executeJavaScript(
            `({ url: location.href, ts: (document.querySelector('time[datetime]') ? parseInt(document.querySelector('time[datetime]').getAttribute('datetime'),10) : null), text: document.body ? document.body.innerText : '' })`
        );
    } catch { return { url: '', ts: null, text: '' }; }
}

const READY_LOCK = `/extend\\.html|\\/auth|\\/login|signin/i.test(location.href)`;
const READY_APNS = `!!document.querySelector('time[datetime]') || ${READY_LOCK}`;
const READY_CERT = `!!document.querySelector('time[datetime]') || !!document.querySelector('.content, main') || ${READY_LOCK}`;

function daysUntil(date) {
    return Math.ceil((date - new Date()) / (1000 * 60 * 60 * 24));
}

function parseFrenchDate(text) {
    if (!text) return null;
    let m = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
    const mois = { janvier: 0, février: 1, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, août: 7, aout: 7, septembre: 8, octobre: 9, novembre: 10, décembre: 11, decembre: 11 };
    m = text.match(/(\d{1,2})\s+([a-zûéô]+)\s+(\d{4})/i);
    if (m && mois[m[2].toLowerCase()] !== undefined) return new Date(+m[3], mois[m[2].toLowerCase()], +m[1]);
    return null;
}

function isLockedOrInaccessible(url) {
    if (/extend\.html/i.test(url)) return 'locked';
    if (/\/auth|\/login|signin/i.test(url) && !/configuration|notifications|dashboard/i.test(url)) return 'inaccessible';
    return null;
}

// ---------------------------------------------------------------------------
// Collecte d'une école : APNs, VPP, DEP/ADE, notifications (toggles séparés)
// ---------------------------------------------------------------------------

async function collectInstance(wc, inst, masterName, lang) {
    const base = inst.url.replace(/\/configuration\/apns$/, '').replace(/\/+$/, '');
    const result = {
        master: masterName || '',
        prefix: inst.prefix,
        domain: base.replace(/^https?:\/\//, ''),
        devices: null,
        apns: null, vpp: null, dep: null,
        notifications: [],
        locked: false, overuse: false, inaccessible: false,
        error: null,
    };

    // --- APNs --- (détecte aussi verrouillage / inaccessibilité)
    if (inst.collectApns) {
        const { url, ts, text } = await loadAndExtract(wc, base + '/configuration/apns', READY_APNS, 15000);
        const state = isLockedOrInaccessible(url);
        if (state === 'locked') {
            result.locked = true;
        } else if (state === 'inaccessible') {
            result.inaccessible = true;
            result.error = t(lang, 'err_session');
        } else if (/surutilisation|0 licence/i.test(text)) {
            result.overuse = true;
        } else {
            const date = ts ? new Date(ts) : parseFrenchDate(text);
            if (date && !isNaN(date)) result.apns = { date: date.toISOString(), daysLeft: daysUntil(date) };
            const dm = text.match(/([\d][\d\s. ]*)\s*appareils/i);
            if (dm) { const n = parseInt(dm[1].replace(/[^\d]/g, ''), 10); if (!isNaN(n)) result.devices = n; }
        }
    }

    // --- VPP ---
    if (inst.collectVpp && !result.locked && !result.inaccessible) {
        const { url, ts, text } = await loadAndExtract(wc, base + '/configuration/vpp', READY_CERT, 12000);
        if (/extend\.html/i.test(url)) result.locked = true;
        else {
            const date = ts ? new Date(ts) : parseFrenchDate(text);
            if (/expiré|expired/i.test(text) && !date) result.vpp = { expired: true };
            else if (date && !isNaN(date)) result.vpp = { date: date.toISOString(), daysLeft: daysUntil(date) };
        }
    }

    // --- DEP / ADE ---
    if (inst.collectDep && !result.locked && !result.inaccessible) {
        const { url, ts, text } = await loadAndExtract(wc, base + '/configuration/dep', READY_CERT, 12000);
        if (/extend\.html/i.test(url)) result.locked = true;
        else if (/accepter les nouvelles conditions|nouvelles conditions générales|terms and conditions/i.test(text)) {
            result.dep = { cgu: true };
        } else {
            const date = ts ? new Date(ts) : parseFrenchDate(text);
            if (date && !isNaN(date)) result.dep = { date: date.toISOString(), daysLeft: daysUntil(date) };
        }
    }

    // --- Notifications --- (poll des lignes du tableau, sans sleep fixe)
    if (inst.collectNotifications && !result.inaccessible) {
        try { await wc.loadURL(base + '/notifications'); } catch {}
        const start = Date.now();
        let notifs = [];
        while (Date.now() - start < 10000) {
            if (wc.isDestroyed()) break;
            try {
                const r = await wc.executeJavaScript(`(() => {
                    if (!document.querySelector('table tr, .content, main')) return null;
                    const rows = [...document.querySelectorAll('table tr')].slice(1);
                    return rows.filter(r => r.textContent && !r.textContent.includes('Fermé') && r.textContent.trim().length > 10)
                               .slice(0, 8).map(r => r.textContent.trim().replace(/\\s+/g, ' ').substring(0, 180));
                })()`);
                if (r !== null) { notifs = r; break; }
            } catch {}
            await sleep(POLL);
        }
        result.notifications = notifs;
    }

    result.level = computeLevel(result);
    return result;
}

// Niveaux d'alerte (repris du skill jamf-school-audit)
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
// Collecte parallèle : plusieurs fenêtres (workers) partageant la session SSO
// se répartissent les écoles via une file de travail commune.
// ---------------------------------------------------------------------------

async function collectMaster(workers, master, onProgress, lang) {
    const queue = (master.instances || []).filter(i => i.enabled);
    const results = [];
    let idx = 0; // incrément synchrone = work-stealing sûr (JS mono-thread)

    async function runWorker(wc) {
        while (true) {
            const inst = queue[idx++];
            if (!inst) break;
            if (wc.isDestroyed()) break;

            onProgress({ type: 'instance', master: master.name, prefix: inst.prefix });
            let result;
            try {
                result = await collectInstance(wc, inst, master.name, lang);
            } catch (err) {
                result = { master: master.name, prefix: inst.prefix, error: err.message, level: 'INACCESSIBLE', notifications: [] };
            }
            onProgress({ type: 'result', result });
            results.push(result);
        }
    }

    await Promise.all(workers.map(wc => runWorker(wc)));
    return results;
}

module.exports = { collectMaster };
