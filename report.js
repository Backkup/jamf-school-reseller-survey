const { BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { t } = require('./i18n');

// Palette (couleurs fixes — document imprimable)
const C = {
    navy: '#2c3e50',
    critique: '#c0392b', critiqueBg: '#fdecea',
    urgent: '#e67e22', urgentBg: '#fdf3e7',
    cgu: '#d68910', cguBg: '#fcf6e6',
    licence: '#2471a3', licenceBg: '#eaf2f8',
    inacc: '#7f8c8d', inaccBg: '#f2f3f4',
    ok: '#1e8449', okBg: '#eafaf1',
};

const LEVEL_STYLE = {
    CRITIQUE:     { color: C.critique, bg: C.critiqueBg },
    URGENT:       { color: C.urgent,   bg: C.urgentBg },
    ATTENTION:    { color: C.cgu,      bg: C.cguBg },
    LICENCE:      { color: C.licence,  bg: C.licenceBg },
    INACCESSIBLE: { color: C.inacc,    bg: C.inaccBg },
    OK:           { color: C.ok,       bg: C.okBg },
    DESACTIVE:    { color: C.inacc,    bg: C.inaccBg },
};

function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function sq(color) { return `<span style="color:${color}">■</span>`; }

function makeReport(lang) {
    const tr = (k, v) => t(lang, k, v);
    const locale = tr('rep_lang_locale');

    const dLong = (iso) => iso ? cap(new Date(iso).toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) : '—';
    const dShort = (iso) => iso ? new Date(iso).toLocaleDateString(locale) : '—';

    function delaiBadge(daysLeft) {
        if (typeof daysLeft !== 'number') return '<span class="muted">—</span>';
        if (daysLeft < 30) return `<strong style="color:${C.critique}">${tr('rep_days_crit', { n: daysLeft })}</strong>`;
        if (daysLeft < 60) return `<strong style="color:${C.urgent}">${tr('rep_days_short', { n: daysLeft })}</strong>`;
        return tr('rep_days_plain', { n: daysLeft });
    }

    function recapCert(c) {
        if (!c) return '<span class="muted">—</span>';
        if (c.expired) return `<strong style="color:${C.critique}">${tr('rep_expired')}</strong>`;
        if (typeof c.daysLeft === 'number') {
            if (c.daysLeft < 30) return `<strong style="color:${C.critique}">${dShort(c.date)}</strong>`;
            if (c.daysLeft < 60) return `<span style="color:${C.urgent}">${dShort(c.date)}</span>`;
        }
        return dShort(c.date);
    }

    const banner = (text, color) => `<div class="banner" style="background:${color}">${text}</div>`;

    function summaryTable(results) {
        const rows = Object.keys(LEVEL_STYLE).map(k => {
            const s = LEVEL_STYLE[k];
            const n = results.filter(r => r.level === k).length;
            return `<tr>
                <td style="background:${s.bg}"><strong style="color:${s.color}">${sq(s.color)} ${tr('lvl_' + k)}</strong></td>
                <td class="num" style="background:${s.bg}">${n}</td>
                <td style="background:${s.bg}">${esc(tr('desc_' + k))}</td>
            </tr>`;
        }).join('');
        return `<table class="grid summary">
            <thead><tr><th>${tr('rep_h_status')}</th><th>${tr('rep_h_count')}</th><th>${tr('rep_h_description')}</th></tr></thead>
            <tbody>${rows}</tbody></table>`;
    }

    function critiqueCards(results) {
        const items = results.filter(r => r.level === 'CRITIQUE');
        if (!items.length) return '';
        const cards = items.map(r => {
            const head = `<div class="card-title">${esc(r.prefix)} — <span class="domain">${esc(r.domain || '')}</span></div>`;

            if (r.locked) {
                return head + `<table class="grid tint-c">
                    <thead><tr><th>${tr('th_problem')}</th><th>${tr('th_detail')}</th></tr></thead>
                    <tbody>
                        <tr><td>${tr('rep_status_word')}</td><td><strong style="color:${C.critique}">${tr('rep_locked_status')}</strong></td></tr>
                        <tr><td>${tr('rep_locked_devices')}</td><td>${r.devices != null ? tr('rep_locked_devices_val', { n: r.devices }) : tr('rep_locked_nolicense')}</td></tr>
                        <tr><td>${tr('rep_locked_access')}</td><td>${tr('rep_locked_access_val')}</td></tr>
                    </tbody></table>`;
            }

            if (r.vpp && r.vpp.expired) {
                return head + `<table class="grid tint-c">
                    <thead><tr><th>${tr('th_cert')}</th><th>${tr('th_status')}</th><th>${tr('th_detail')}</th></tr></thead>
                    <tbody>
                        <tr><td>APNs</td><td>${r.apns ? sq(C.ok) + ' ' + tr('rep_ok') : '<span class="muted">—</span>'}</td><td>${r.apns ? dLong(r.apns.date) + (typeof r.apns.daysLeft === 'number' ? ` (${tr('rep_dminus', { n: r.apns.daysLeft }) || ''})` : '') : '—'}</td></tr>
                        <tr><td>VPP</td><td><strong style="color:${C.critique}">${tr('rep_expired')}</strong></td><td>${tr('rep_renew')}</td></tr>
                        <tr><td>DEP/ADE</td><td>${r.dep && r.dep.cgu ? `<strong style="color:${C.cgu}">${tr('rep_cgu_accept')}</strong>` : (r.dep ? dShort(r.dep.date) : '<span class="muted">—</span>')}</td><td>${r.dep && r.dep.cgu ? tr('rep_cgu_detail') : '—'}</td></tr>
                    </tbody></table>`;
            }

            const certRow = (name, c) => {
                if (!c) return `<tr><td>${name}</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td></tr>`;
                if (c.cgu) return `<tr><td>${name}</td><td><strong style="color:${C.cgu}">${tr('rep_cgu_accept')}</strong></td><td>—</td><td>—</td></tr>`;
                if (c.expired) return `<tr><td>${name}</td><td><strong style="color:${C.critique}">${tr('rep_expired')}</strong></td><td>—</td><td>—</td></tr>`;
                return `<tr><td>${name}</td><td>${dLong(c.date)}</td><td>${delaiBadge(c.daysLeft)}</td><td>${name === 'APNs' && r.devices != null ? r.devices : '—'}</td></tr>`;
            };
            return head + `<table class="grid tint-c">
                <thead><tr><th>${tr('th_cert')}</th><th>${tr('th_expdate')}</th><th>${tr('th_delay')}</th><th>${tr('th_devices')}</th></tr></thead>
                <tbody>${certRow('APNs', r.apns)}${certRow('VPP', r.vpp)}${certRow('DEP/ADE', r.dep)}</tbody></table>`;
        }).join('');
        return banner(tr('ban_CRITIQUE'), C.critique) + cards;
    }

    function urgentTable(results) {
        const items = results.filter(r => r.level === 'URGENT');
        if (!items.length) return '';
        const rows = [];
        items.forEach(r => {
            const add = (name, c) => {
                if (c && typeof c.daysLeft === 'number' && c.daysLeft >= 30 && c.daysLeft < 60) {
                    rows.push(`<tr>
                        <td>${esc(r.prefix)}</td><td>${esc((r.domain || '').split('.')[0])}</td>
                        <td>${name}</td><td>${dShort(c.date)}</td>
                        <td><strong style="color:${C.urgent}">${tr('rep_days_short', { n: c.daysLeft })}</strong></td>
                        <td>${name === 'APNs' && r.devices != null ? r.devices : '—'}</td></tr>`);
                }
            };
            add('APNs', r.apns); add('VPP', r.vpp); add('DEP/ADE', r.dep);
        });
        if (!rows.length) return '';
        return banner(tr('ban_URGENT'), C.urgent) +
            `<table class="grid">
                <thead><tr><th>${tr('th_instance')}</th><th>${tr('th_url')}</th><th>${tr('th_cert')}</th><th>${tr('th_expiration')}</th><th>${tr('th_delay')}</th><th>${tr('th_app')}</th></tr></thead>
                <tbody>${rows.join('')}</tbody></table>`;
    }

    function cguTable(results) {
        const items = results.filter(r => r.dep && r.dep.cgu);
        if (!items.length) return '';
        const rows = items.map(r => `<tr>
            <td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
            <td>${recapCert(r.apns)}</td><td>${recapCert(r.vpp)}</td></tr>`).join('');
        return banner(tr('ban_CGU'), C.cgu) +
            `<p class="intro">${tr('rep_cgu_intro')}</p>
            <table class="grid">
                <thead><tr><th>${tr('th_instance')}</th><th>${tr('th_url')}</th><th>APNs</th><th>VPP</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
    }

    function licenceTable(results) {
        const items = results.filter(r => r.locked || r.overuse);
        if (!items.length) return '';
        const rows = items.map(r => {
            if (r.locked) return `<tr><td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
                <td><strong style="color:${C.critique}">${tr('rep_locked_word')}</strong></td>
                <td>${r.devices != null ? tr('rep_licence_locked_val', { n: r.devices }) : tr('rep_licence_nolicense')}</td></tr>`;
            return `<tr><td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
                <td><strong style="color:${C.urgent}">${tr('rep_overuse')}</strong></td>
                <td>${tr('rep_overuse_detail')}</td></tr>`;
        }).join('');
        return banner(tr('ban_LICENCE'), C.navy) +
            `<table class="grid">
                <thead><tr><th>${tr('th_instance')}</th><th>${tr('th_url')}</th><th>${tr('th_status')}</th><th>${tr('th_detail')}</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
    }

    function inaccessibleTable(results) {
        const items = results.filter(r => r.inaccessible || r.level === 'INACCESSIBLE');
        if (!items.length) return '';
        const rows = items.map(r => `<tr>
            <td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
            <td>${esc(r.error || tr('rep_inacc_default'))}</td></tr>`).join('');
        return banner(tr('ban_INACCESSIBLE'), C.navy) +
            `<table class="grid">
                <thead><tr><th>${tr('th_instance')}</th><th>${tr('th_url')}</th><th>${tr('th_error')}</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
    }

    function disabledTable(results) {
        const items = results.filter(r => r.disabled || r.level === 'DESACTIVE');
        if (!items.length) return '';
        const rows = items.map(r => `<tr>
            <td>${esc(r.prefix)}</td><td>${esc(r.domain || '')}</td>
            <td>${r.reason ? esc(r.reason) : `<span class="muted">${tr('rep_no_reason')}</span>`}</td></tr>`).join('');
        return banner(tr('ban_DISABLED'), C.inacc) +
            `<table class="grid">
                <thead><tr><th>${tr('th_instance')}</th><th>${tr('th_url')}</th><th>${tr('th_reason')}</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
    }

    function recapTable(results) {
        const rows = results.map(r => {
            const s = LEVEL_STYLE[r.level] || LEVEL_STYLE.OK;
            let statut;
            if (r.level === 'ATTENTION') statut = `${sq(C.cgu)}${sq(C.cgu)}`;
            else if (r.level === 'LICENCE') statut = `${sq(C.licence)} ${tr('rep_licence_word')}`;
            else if (r.level === 'DESACTIVE') statut = `${sq(C.inacc)} <span style="color:${C.inacc}">${tr('rep_disabled_word')}</span>`;
            else statut = sq(s.color);

            if (r.disabled || r.level === 'DESACTIVE') {
                const reason = r.reason ? ` <span class="muted">(${esc(r.reason)})</span>` : '';
                return `<tr><td>${esc(r.prefix)}${reason}</td><td class="muted">—</td><td class="muted">—</td><td class="muted">—</td><td>${statut}</td></tr>`;
            }

            const lockedWord = `<strong style="color:${C.critique}">${tr('rep_locked_word')}</strong>`;
            const apnsCell = r.locked ? lockedWord : recapCert(r.apns);
            const vppCell = r.locked ? lockedWord : recapCert(r.vpp);
            let depCell;
            if (r.locked) depCell = lockedWord;
            else if (r.dep && r.dep.cgu) depCell = `<span style="color:${C.cgu}">${tr('rep_cgu_marker')} ${sq(C.cgu)}${sq(C.cgu)}</span>`;
            else depCell = recapCert(r.dep);

            return `<tr><td>${esc(r.prefix)}</td><td>${apnsCell}</td><td>${vppCell}</td><td>${depCell}</td><td>${statut}</td></tr>`;
        }).join('');
        return banner(tr('ban_RECAP'), C.navy) +
            `<table class="grid recap">
                <thead><tr><th>${tr('th_instance')}</th><th>APNs</th><th>VPP</th><th>DEP/ADE</th><th>${tr('th_status')}</th></tr></thead>
                <tbody>${rows}</tbody></table>`;
    }

    function buildHtml(results, masterName) {
        const dateLong = new Date().toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' });
        const anyAction = results.some(r => ['CRITIQUE', 'URGENT', 'ATTENTION', 'LICENCE', 'INACCESSIBLE'].includes(r.level));
        return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><style>
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
        <h1>${tr('rep_title')}</h1>
        ${masterName ? `<div class="master-title">${esc(masterName)}</div>` : ''}
        <div class="sub">${tr('rep_generated', { date: esc(dateLong), n: results.length })}</div>
        <hr class="rule">
        ${summaryTable(results)}
        ${critiqueCards(results)}
        ${urgentTable(results)}
        ${cguTable(results)}
        ${licenceTable(results)}
        ${inaccessibleTable(results)}
        ${disabledTable(results)}
        ${anyAction ? '' : `<p style="color:${C.ok};margin:14px 0">${tr('rep_no_action')}</p>`}
        ${recapTable(results)}
        </body></html>`;
    }

    return { buildHtml };
}

function safeName(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Jamf_School';
}

async function generatePdf(results, masterName, lang) {
    lang = lang || 'en';
    const html = makeReport(lang).buildHtml(results, masterName);

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ printBackground: true, margins: { marginType: 'none' }, pageSize: 'A4' });
    win.destroy();

    const now = new Date();
    const stamp = now.toISOString().slice(0, 10);
    const desktop = path.join(os.homedir(), 'Desktop');
    const outDir = fs.existsSync(desktop) ? desktop : os.homedir();
    const prefix = lang === 'fr' ? 'Rapport' : 'Report';
    const filePath = path.join(outDir, `${prefix}_${safeName(masterName)}_${stamp}.pdf`);
    fs.writeFileSync(filePath, pdf);
    return filePath;
}

// Pour les tests / aperçus
function buildHtml(results, masterName, lang) {
    return makeReport(lang || 'en').buildHtml(results, masterName);
}

module.exports = { generatePdf, buildHtml };
