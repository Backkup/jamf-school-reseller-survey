const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Palette reprise du rapport de référence
const C = {
    navy: '#2c3e50',
    critique: '#c0392b',
    critiqueBg: '#fdecea',
    urgent: '#e67e22',
    urgentBg: '#fdf3e7',
    cgu: '#d68910',
    cguBg: '#fcf6e6',
    licence: '#2471a3',
    licenceBg: '#eaf2f8',
    inacc: '#7f8c8d',
    inaccBg: '#f2f3f4',
    ok: '#1e8449',
    okBg: '#eafaf1',
};

const LEVELS = {
    CRITIQUE:     { color: C.critique, bg: C.critiqueBg, label: 'CRITIQUE',     desc: 'Action immédiate requise (licence bloquée, VPP expiré, APNs < 30j)' },
    URGENT:       { color: C.urgent,   bg: C.urgentBg,   label: 'URGENT',       desc: 'Certificats expirant dans les 60 prochains jours' },
    ATTENTION:    { color: C.cgu,      bg: C.cguBg,      label: 'ATTENTION',    desc: 'CGU Apple à accepter sur le token DEP/ADE' },
    LICENCE:      { color: C.licence,  bg: C.licenceBg,  label: 'LICENCE',      desc: 'Surutilisation de licences' },
    INACCESSIBLE: { color: C.inacc,    bg: C.inaccBg,    label: 'INACCESSIBLE', desc: 'Instance inaccessible (erreur de page)' },
    OK:           { color: C.ok,       bg: C.okBg,       label: 'OK',           desc: 'Aucun problème détecté' },
    DESACTIVE:    { color: C.inacc,    bg: C.inaccBg,    label: 'DÉSACTIVÉE',   desc: 'Collecte désactivée par l’utilisateur' },
};

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function frLong(iso) {
    if (!iso) return '—';
    return cap(new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
}
function frShort(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('fr-FR');
}
function sq(color) { return `<span style="color:${color}">■</span>`; }

// ---- Cellules certificats ----------------------------------------------------

function delaiBadge(daysLeft) {
    if (typeof daysLeft !== 'number') return '<span class="muted">—</span>';
    if (daysLeft < 30) return `<strong style="color:${C.critique}">${daysLeft} JOURS</strong>`;
    if (daysLeft < 60) return `<strong style="color:${C.urgent}">${daysLeft}j</strong>`;
    return `${daysLeft} jours`;
}

function recapCert(c) {
    if (!c) return '<span class="muted">—</span>';
    if (c.expired) return `<strong style="color:${C.critique}">EXPIRÉ</strong>`;
    if (typeof c.daysLeft === 'number') {
        if (c.daysLeft < 30) return `<strong style="color:${C.critique}">${frShort(c.date)}</strong>`;
        if (c.daysLeft < 60) return `<span style="color:${C.urgent}">${frShort(c.date)}</span>`;
    }
    return frShort(c.date);
}

// ---- Bandeaux & sections -----------------------------------------------------

function banner(text, color) {
    return `<div class="banner" style="background:${color}">${text}</div>`;
}

function summaryTable(results) {
    const rows = Object.keys(LEVELS).map(k => {
        const m = LEVELS[k];
        const n = results.filter(r => r.level === k).length;
        return `<tr>
            <td style="background:${m.bg}"><strong style="color:${m.color}">${sq(m.color)} ${m.label}</strong></td>
            <td class="num" style="background:${m.bg}">${n}</td>
            <td style="background:${m.bg}">${esc(m.desc)}</td>
        </tr>`;
    }).join('');
    return `<table class="grid summary">
        <thead><tr><th>Statut</th><th>Nombre</th><th>Description</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
}

// Fiches CRITIQUE (3 gabarits selon le problème)
function critiqueCards(results) {
    const items = results.filter(r => r.level === 'CRITIQUE');
    if (!items.length) return '';
    const cards = items.map(r => {
        const head = `<div class="card-title">${esc(r.prefix)} — <span class="domain">${esc(r.domain || '')}</span></div>`;

        if (r.locked) {
            return head + `<table class="grid tint-c">
                <thead><tr><th>Problème</th><th>Détail</th></tr></thead>
                <tbody>
                    <tr><td>Statut</td><td><strong style="color:${C.critique}">INSTANCE VERROUILLÉE — Aucune licence active</strong></td></tr>
                    <tr><td>Appareils bloqués</td><td>${r.devices != null ? r.devices + ' appareils enrôlés / 0 licence active' : 'Aucune licence active'}</td></tr>
                    <tr><td>Accès</td><td>Toutes les pages redirigent vers /extend.html</td></tr>
                </tbody></table>`;
        }

        if (r.vpp && r.vpp.expired) {
            return head + `<table class="grid tint-c">
                <thead><tr><th>Certificat</th><th>Statut</th><th>Détail</th></tr></thead>
                <tbody>
                    <tr><td>APNs</td><td>${r.apns ? sq(C.ok) + ' OK' : '<span class="muted">—</span>'}</td><td>${r.apns ? frLong(r.apns.date) + (typeof r.apns.daysLeft === 'number' ? ` (J-${r.apns.daysLeft})` : '') : '—'}</td></tr>
                    <tr><td>VPP</td><td><strong style="color:${C.critique}">EXPIRÉ</strong></td><td>Renouvellement requis</td></tr>
                    <tr><td>DEP/ADE</td><td>${r.dep && r.dep.cgu ? `<strong style="color:${C.cgu}">CGU à accepter</strong>` : (r.dep ? frShort(r.dep.date) : '<span class="muted">—</span>')}</td><td>${r.dep && r.dep.cgu ? 'Accepter les nouvelles CGU Apple dans ASM' : '—'}</td></tr>
                </tbody></table>`;
        }

        // Gabarit certificat expirant
        const certRow = (name, c) => {
            if (!c) return `<tr><td>${name}</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td></tr>`;
            if (c.cgu) return `<tr><td>${name}</td><td><strong style="color:${C.cgu}">CGU à accepter</strong></td><td>—</td><td>—</td></tr>`;
            if (c.expired) return `<tr><td>${name}</td><td><strong style="color:${C.critique}">EXPIRÉ</strong></td><td>—</td><td>—</td></tr>`;
            return `<tr><td>${name}</td><td>${frLong(c.date)}</td><td>${delaiBadge(c.daysLeft)}</td><td>${name === 'APNs' && r.devices != null ? r.devices : '—'}</td></tr>`;
        };
        return head + `<table class="grid tint-c">
            <thead><tr><th>Certificat</th><th>Date d'expiration</th><th>Délai</th><th>Appareils</th></tr></thead>
            <tbody>${certRow('APNs', r.apns)}${certRow('VPP', r.vpp)}${certRow('DEP/ADE', r.dep)}</tbody></table>`;
    }).join('');
    return banner('■ CRITIQUE — Action immédiate requise', C.critique) + cards;
}

// Tableau à plat URGENT (une ligne par certificat 30–60j)
function urgentTable(results) {
    const items = results.filter(r => r.level === 'URGENT');
    if (!items.length) return '';
    const rows = [];
    items.forEach(r => {
        const add = (name, c) => {
            if (c && typeof c.daysLeft === 'number' && c.daysLeft >= 30 && c.daysLeft < 60) {
                rows.push(`<tr>
                    <td>${esc(r.prefix)}</td><td>${esc((r.domain || '').split('.')[0])}</td>
                    <td>${name}</td><td>${frShort(c.date)}</td>
                    <td><strong style="color:${C.urgent}">${c.daysLeft}j</strong></td>
                    <td>${name === 'APNs' && r.devices != null ? r.devices : '—'}</td></tr>`);
            }
        };
        add('APNs', r.apns); add('VPP', r.vpp); add('DEP/ADE', r.dep);
    });
    if (!rows.length) return '';
    return banner('■ URGENT — Certificats expirant dans les 60 prochains jours', C.urgent) +
        `<table class="grid">
            <thead><tr><th>Instance</th><th>URL</th><th>Certificat</th><th>Expiration</th><th>Délai</th><th>App.</th></tr></thead>
            <tbody>${rows.join('')}</tbody></table>`;
}

function cguTable(results) {
    const items = results.filter(r => r.dep && r.dep.cgu);
    if (!items.length) return '';
    const rows = items.map(r => `<tr>
        <td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
        <td>${recapCert(r.apns)}</td><td>${recapCert(r.vpp)}</td></tr>`).join('');
    return banner('■■ CGU Apple à accepter — Token DEP/ADE', C.cgu) +
        `<p class="intro">Les instances suivantes affichent « Veuillez accepter les nouvelles Conditions générales » sur la page DEP/ADE. L'enrôlement automatisé des appareils est potentiellement interrompu. Action requise : se connecter à Apple School Manager et accepter les nouvelles CGU.</p>
        <table class="grid">
            <thead><tr><th>Instance</th><th>URL</th><th>APNs</th><th>VPP</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
}

function licenceTable(results) {
    const items = results.filter(r => r.locked || r.overuse);
    if (!items.length) return '';
    const rows = items.map(r => {
        if (r.locked) return `<tr><td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
            <td><strong style="color:${C.critique}">VERROUILLÉ</strong></td>
            <td>${r.devices != null ? r.devices + ' app. bloqués / 0 licence active' : '0 licence active'}</td></tr>`;
        return `<tr><td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
            <td><strong style="color:${C.urgent}">Surutilisation</strong></td>
            <td>Surutilisation de licences détectée</td></tr>`;
    }).join('');
    return banner('■ Problèmes de Licences', C.navy) +
        `<table class="grid">
            <thead><tr><th>Instance</th><th>URL</th><th>Statut</th><th>Détail</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
}

function inaccessibleTable(results) {
    const items = results.filter(r => r.inaccessible || r.level === 'INACCESSIBLE');
    if (!items.length) return '';
    const rows = items.map(r => `<tr>
        <td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
        <td>${esc(r.error || "Page d'erreur — instance inexistante ou supprimée")}</td></tr>`).join('');
    return banner('■ Instances inaccessibles', C.navy) +
        `<table class="grid">
            <thead><tr><th>Instance</th><th>URL</th><th>Erreur</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
}

function disabledTable(results) {
    const items = results.filter(r => r.disabled || r.level === 'DESACTIVE');
    if (!items.length) return '';
    const rows = items.map(r => `<tr>
        <td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
        <td>${r.reason ? esc(r.reason) : '<span class="muted">— (aucune raison indiquée)</span>'}</td></tr>`).join('');
    return banner('■ Instances désactivées', C.inacc) +
        `<table class="grid">
            <thead><tr><th>Instance</th><th>URL</th><th>Raison de la désactivation</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
}

function recapTable(results) {
    const rows = results.map(r => {
        const m = LEVELS[r.level] || LEVELS.OK;
        let statut;
        if (r.level === 'ATTENTION') statut = `${sq(C.cgu)}${sq(C.cgu)}`;
        else if (r.level === 'LICENCE') statut = `${sq(C.licence)} Licence`;
        else if (r.level === 'DESACTIVE') statut = `${sq(C.inacc)} <span style="color:${C.inacc}">Désactivée</span>`;
        else statut = sq(m.color);

        if (r.disabled || r.level === 'DESACTIVE') {
            const reason = r.reason ? ` <span class="muted">(${esc(r.reason)})</span>` : '';
            return `<tr><td>${esc(r.prefix)}${reason}</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td>${statut}</td></tr>`;
        }

        let apnsCell = r.locked ? `<strong style="color:${C.critique}">VERROUILLÉ</strong>` : recapCert(r.apns);
        let vppCell = r.locked ? `<strong style="color:${C.critique}">VERROUILLÉ</strong>` : recapCert(r.vpp);
        let depCell;
        if (r.locked) depCell = `<strong style="color:${C.critique}">VERROUILLÉ</strong>`;
        else if (r.dep && r.dep.cgu) depCell = `<span style="color:${C.cgu}">CGU ${sq(C.cgu)}${sq(C.cgu)}</span>`;
        else depCell = recapCert(r.dep);

        return `<tr><td>${esc(r.prefix)}</td><td>${apnsCell}</td><td>${vppCell}</td><td>${depCell}</td><td>${statut}</td></tr>`;
    }).join('');
    return banner('■ Récapitulatif complet — toutes les instances', C.navy) +
        `<table class="grid recap">
            <thead><tr><th>Instance</th><th>APNs</th><th>VPP</th><th>DEP/ADE</th><th>Statut</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
}

function buildHtml(results, dateLong, masterName) {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; color: #222; font-size: 11px; margin: 0; padding: 30px 36px; }
    h1 { text-align: center; font-size: 22px; margin: 0 0 2px; color: #1a1a1a; }
    .master-title { text-align: center; font-size: 16px; font-weight: 700; color: #2e6da4; margin: 0 0 4px; }
    .sub { text-align: center; color: #888; font-size: 11px; margin-bottom: 12px; }
    .rule { border: none; border-top: 2px solid #2e6da4; margin: 0 0 18px; }

    .banner { color: #fff; font-weight: 700; font-size: 13px; padding: 8px 14px; border-radius: 3px; margin: 20px 0 10px; }

    .intro { color: #555; font-size: 11px; line-height: 1.5; margin: 6px 0 10px; }

    table.grid { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
    table.grid th { background: ${C.navy}; color: #fff; font-weight: 600; font-size: 10px; text-align: left; padding: 7px 9px; }
    table.grid td { border-bottom: 1px solid #e3e6ea; padding: 6px 9px; vertical-align: top; }
    table.grid .num { text-align: center; font-weight: 700; }
    .summary td:nth-child(2) { text-align: center; font-weight: 700; }
    .recap tbody tr:nth-child(even) td { background: #f8f9fb; }
    .tint-c td { background: #fdf1ef; }

    .card-title { font-weight: 700; font-size: 13px; margin: 14px 0 6px; }
    .domain { color: #2e6da4; font-weight: 600; }
    .muted { color: #aaa; }

    section, .card, table.grid thead { page-break-inside: avoid; }
    </style></head><body>
    <h1>Rapport de Supervision Jamf School</h1>
    ${masterName ? `<div class="master-title">${esc(masterName)}</div>` : ''}
    <div class="sub">Généré le ${esc(dateLong)} | ${results.length} instance(s) auditée(s)</div>
    <hr class="rule">

    ${summaryTable(results)}
    ${critiqueCards(results)}
    ${urgentTable(results)}
    ${cguTable(results)}
    ${licenceTable(results)}
    ${inaccessibleTable(results)}
    ${disabledTable(results)}
    ${recapTable(results)}
    </body></html>`;
}

function safeName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Jamf_School';
}

async function generatePdf(results, masterName) {
    const now = new Date();
    const dateLong = now.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const html = buildHtml(results, dateLong, masterName);

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    const pdf = await win.webContents.printToPDF({
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize: 'A4',
    });
    win.destroy();

    const stamp = now.toISOString().slice(0, 10);
    const desktop = path.join(os.homedir(), 'Desktop');
    const outDir = fs.existsSync(desktop) ? desktop : os.homedir();
    const filePath = path.join(outDir, `Rapport_${safeName(masterName)}_${stamp}.pdf`);
    fs.writeFileSync(filePath, pdf);
    return filePath;
}

module.exports = { generatePdf, buildHtml };
