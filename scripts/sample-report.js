const { app, shell } = require('electron');
const path = require('path');
const { generatePdf } = require('../report');

const day = 1000 * 60 * 60 * 24;
const iso = (d) => new Date(Date.now() + d * day).toISOString();

// Jeu de données 100 % fictif (aucune donnée client réelle) couvrant chaque statut
const results = [
    { prefix: 'École Démo Alpha', domain: 'demo-alpha.jamfcloud.com', devices: 320, apns: { date: iso(16), daysLeft: 16 }, vpp: { date: iso(16), daysLeft: 16 }, dep: { date: iso(92), daysLeft: 92 }, notifications: [], level: 'CRITIQUE' },
    { prefix: 'École Démo Bravo', domain: 'demo-bravo.jamfcloud.com', devices: 16, locked: true, apns: null, vpp: null, dep: null, notifications: [], level: 'CRITIQUE' },
    { prefix: 'École Démo Charlie', domain: 'demo-charlie.jamfcloud.com', devices: 240, apns: { date: iso(310), daysLeft: 310 }, vpp: { expired: true }, dep: { cgu: true }, notifications: [], level: 'CRITIQUE' },
    { prefix: 'École Démo Delta', domain: 'demo-delta.jamfcloud.com', devices: 75, apns: { date: iso(34), daysLeft: 34 }, vpp: { date: iso(34), daysLeft: 34 }, dep: { date: iso(34), daysLeft: 34 }, notifications: [], level: 'URGENT' },
    { prefix: 'École Démo Echo', domain: 'demo-echo.jamfcloud.com', devices: 130, apns: { date: iso(48), daysLeft: 48 }, vpp: { date: iso(48), daysLeft: 48 }, dep: { date: iso(200), daysLeft: 200 }, notifications: [], level: 'URGENT' },
    { prefix: 'École Démo Foxtrot', domain: 'demo-foxtrot.jamfcloud.com', devices: 410, apns: { date: iso(280), daysLeft: 280 }, vpp: { date: iso(280), daysLeft: 280 }, dep: { cgu: true }, notifications: [], level: 'ATTENTION' },
    { prefix: 'École Démo Golf', domain: 'demo-golf.jamfcloud.com', devices: 95, apns: { date: iso(150), daysLeft: 150 }, vpp: { date: iso(150), daysLeft: 150 }, dep: { cgu: true }, notifications: [], level: 'ATTENTION' },
    { prefix: 'École Démo Hotel', domain: 'demo-hotel.jamfcloud.com', devices: 60, overuse: true, apns: { date: iso(220), daysLeft: 220 }, vpp: { date: iso(220), daysLeft: 220 }, dep: { date: iso(220), daysLeft: 220 }, notifications: [], level: 'LICENCE' },
    { prefix: 'École Démo India', domain: 'demo-india.jamfcloud.com', inaccessible: true, error: "Page d'erreur — instance inexistante ou supprimée", notifications: [], level: 'INACCESSIBLE' },
    { prefix: 'École Démo Juliett', domain: 'demo-juliett.jamfcloud.com', disabled: true, reason: 'Contrat résilié — instance conservée pour archive', notifications: [], level: 'DESACTIVE' },
    { prefix: 'École Démo Kilo', domain: 'demo-kilo.jamfcloud.com', devices: 40, apns: { date: iso(380), daysLeft: 380 }, vpp: { date: iso(380), daysLeft: 380 }, dep: { date: iso(380), daysLeft: 380 }, notifications: [], level: 'OK' },
    { prefix: 'École Démo Lima', domain: 'demo-lima.jamfcloud.com', devices: 520, apns: { date: iso(420), daysLeft: 420 }, vpp: { date: iso(420), daysLeft: 420 }, dep: { date: iso(420), daysLeft: 420 }, notifications: [], level: 'OK' },
];

app.whenReady().then(async () => {
    try {
        const filePath = await generatePdf(results, 'Revendeur Démo');
        console.log('PDF généré :', filePath);
        await shell.openPath(filePath);
        setTimeout(() => app.quit(), 1500);
    } catch (err) {
        console.error('Erreur :', err);
        app.quit();
    }
});
