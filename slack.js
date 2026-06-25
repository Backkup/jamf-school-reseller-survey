const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

// Upload d'un fichier (PDF) sur Slack via l'API moderne (3 étapes).
// Un webhook ne peut PAS envoyer de fichier : il faut un bot token (xoxb-...).
// Scopes requis sur l'app Slack : files:write, chat:write.
async function uploadPdf(botToken, channelId, filePath, comment) {
    if (!botToken) throw new Error('Bot token Slack manquant');
    if (!channelId) throw new Error('ID de canal Slack manquant');

    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);

    // 1) Obtenir une URL d'upload
    const getRes = await fetch(
        `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${buffer.length}`,
        { method: 'GET', headers: { Authorization: `Bearer ${botToken}` } }
    );
    const getJson = await getRes.json();
    if (!getJson.ok) throw new Error(`Slack getUploadURL: ${getJson.error}`);

    // 2) Envoyer les octets vers l'URL fournie
    const putRes = await fetch(getJson.upload_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer,
    });
    if (!putRes.ok) throw new Error(`Slack upload HTTP ${putRes.status}`);

    // 3) Finaliser et publier dans le canal
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${botToken}`,
            'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
            files: [{ id: getJson.file_id, title: filename }],
            channel_id: channelId,
            initial_comment: comment || '',
        }),
    });
    const completeJson = await completeRes.json();
    if (!completeJson.ok) throw new Error(`Slack completeUpload: ${completeJson.error}`);

    return true;
}

function buildSummary(results, lang) {
    const by = (lvl) => results.filter(r => r.level === lvl).length;
    return [
        t(lang, 'slack_title'),
        t(lang, 'slack_summary', {
            crit: by('CRITIQUE'), urg: by('URGENT'), att: by('ATTENTION'),
            lic: by('LICENCE'), inacc: by('INACCESSIBLE'), ok: by('OK'),
        }),
    ].join('\n');
}

module.exports = { uploadPdf, buildSummary };
