const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3005;
const PUBLIC_DIR = __dirname;
const DB_FILE = path.join(PUBLIC_DIR, 'db.json');
const CLOUD_URL = 'https://ciment-pro.onrender.com';
const IS_RENDER = process.env.RENDER || false;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, ip: iface.address });
      }
    }
  }
  return ips;
}

// ==================== ALGORITHME DE FUSION INTELLIGENTE (SMART MERGE PRO) ====================
function fusionnerBases(dbA, dbB) {
  if (!dbA && !dbB) return {};
  if (!dbA) return JSON.parse(JSON.stringify(dbB));
  if (!dbB) return JSON.parse(JSON.stringify(dbA));

  const fusion = Object.assign({}, dbA, dbB);

  // 1. Commandes clients
  const cmdsA = Array.isArray(dbA.commandesClients) ? dbA.commandesClients : [];
  const cmdsB = Array.isArray(dbB.commandesClients) ? dbB.commandesClients : [];
  const mapCmds = new Map();

  cmdsA.forEach(c => {
    mapCmds.set(String(c.id || c.client), Object.assign({}, c));
  });

  cmdsB.forEach(cB => {
    const cle = String(cB.id || cB.client);
    if (!mapCmds.has(cle)) {
      mapCmds.set(cle, Object.assign({}, cB));
    } else {
      const cA = mapCmds.get(cle);
      const paiementsA = Array.isArray(cA.paiements) ? cA.paiements : [];
      const paiementsB = Array.isArray(cB.paiements) ? cB.paiements : [];
      const mapP = new Map();
      paiementsA.forEach(p => mapP.set(String(p.id || p.date + p.montant), p));
      paiementsB.forEach(p => mapP.set(String(p.id || p.date + p.montant), p));

      const statutLivraison = (cA.statutLivraison === 'LIVRE' || cB.statutLivraison === 'LIVRE')
        ? 'LIVRE'
        : (cB.statutLivraison || cA.statutLivraison);

      mapCmds.set(cle, Object.assign({}, cA, cB, {
        paiements: Array.from(mapP.values()),
        statutLivraison: statutLivraison,
        telephone: cB.telephone || cA.telephone,
        chauffeurAssigne: cB.chauffeurAssigne || cA.chauffeurAssigne
      }));
    }
  });

  fusion.commandesClients = Array.from(mapCmds.values());

  // 2. Dette CODIMAC (Fixée à 12 263 000 FCFA avec le plus grand montant payé)
  const detteA = dbA.detteActive || {};
  const detteB = dbB.detteActive || {};
  const paye = Math.max(Number(detteA.montantPaye) || 0, Number(detteB.montantPaye) || 0);
  const detteTotale = 12263000;
  fusion.detteActive = Object.assign({}, detteA, detteB, {
    detteAnterieure: 5163000,
    detteAnterieureTonnes: 73,
    nouvelleCommandeMontant: 7100000,
    nouvelleCommandeTonnes: 100,
    tonnageTotal: 173,
    montantTotal: detteTotale,
    montantPaye: paye,
    rapMontant: Math.max(0, detteTotale - paye),
    rapTonnes: Math.max(0, Math.round(((detteTotale - paye) / 71000) * 10) / 10)
  });

  // 3. Stock Usine
  const stockA = dbA.stockUsine || {};
  const stockB = dbB.stockUsine || {};
  const mvtsA = Array.isArray(stockA.mouvements) ? stockA.mouvements : [];
  const mvtsB = Array.isArray(stockB.mouvements) ? stockB.mouvements : [];
  const mapM = new Map();
  mvtsA.forEach(m => mapM.set(String(m.id || m.reference), m));
  mvtsB.forEach(m => mapM.set(String(m.id || m.reference), m));

  const dispo = (stockB.disponible !== undefined && stockA.disponible !== undefined)
    ? Math.min(stockA.disponible, stockB.disponible)
    : (stockB.disponible !== undefined ? stockB.disponible : (stockA.disponible !== undefined ? stockA.disponible : 40));

  fusion.stockUsine = Object.assign({}, stockA, stockB, {
    disponible: dispo,
    mouvements: Array.from(mapM.values())
  });

  // 4. Chauffeurs
  const chA = Array.isArray(dbA.repertoireChauffeurs) ? dbA.repertoireChauffeurs : [];
  const chB = Array.isArray(dbB.repertoireChauffeurs) ? dbB.repertoireChauffeurs : [];
  const mapCh = new Map();
  chA.forEach(c => mapCh.set(String(c.nom || c.tel).toLowerCase(), c));
  chB.forEach(c => mapCh.set(String(c.nom || c.tel).toLowerCase(), c));
  fusion.repertoireChauffeurs = Array.from(mapCh.values());

  fusion.lastUpdated = Date.now();
  return fusion;
}

function lireDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Erreur lecture db.json:', e);
  }
  return null;
}

function ecrireDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Erreur écriture db.json:', e);
    return false;
  }
}

// ==================== SYNCHRONISATION BIDIRECTIONNELLE CLOUD (PC <-> RENDER) ====================
let synchroEnCours = false;

async function synchroniserAvecCloud() {
  if (IS_RENDER || synchroEnCours) return;
  synchroEnCours = true;
  try {
    // 1. Récupérer l'état du Cloud
    const res = await fetch(`${CLOUD_URL}/api/db`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const cloudDB = await res.json();
      const localDB = lireDB();

      if (cloudDB && localDB) {
        // Fusionner local et cloud
        const fusion = fusionnerBases(localDB, cloudDB);

        // Sauvegarder en local
        ecrireDB(fusion);

        // Si le cloud n'avait pas toutes nos données (ex: Eric Bukpessi ou paiements), on le met à jour
        const cloudCount = (cloudDB.commandesClients || []).length;
        const fusionCount = (fusion.commandesClients || []).length;
        if (fusionCount > cloudCount || fusion.lastUpdated > (cloudDB.lastUpdated || 0)) {
          console.log(`[SYNCHRO CLOUD] 📤 Envoi de la base fusionnée (${fusionCount} commandes) vers Render...`);
          await fetch(`${CLOUD_URL}/api/db`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fusion),
            signal: AbortSignal.timeout(8000)
          });
          console.log(`[SYNCHRO CLOUD] ✅ Cloud Render mis à jour avec succès !`);
        }
      }
    }
  } catch (err) {
    // Render peut être en train de démarrer ou hors-ligne, ce n'est pas bloquant
    // console.log('[SYNCHRO CLOUD] En attente connexion Render...');
  } finally {
    synchroEnCours = false;
  }
}

// Lancer la synchro avec Render toutes les 15 secondes si on est sur le PC
if (!IS_RENDER) {
  setInterval(synchroniserAvecCloud, 15000);
  // Premier appel après 3 secondes de démarrage
  setTimeout(synchroniserAvecCloud, 3000);
}

// Anti-Sleep Keep-Alive pour Render (Toutes les 8 minutes)
setInterval(() => {
  fetch(`${CLOUD_URL}/api/sync`, { signal: AbortSignal.timeout(5000) }).catch(() => {});
}, 8 * 60 * 1000);

// ==================== SERVEUR HTTP ====================
const server = http.createServer((req, res) => {
  // En-têtes CORS universels pour synchronisation fluide
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqUrl = req.url.split('?')[0];

  // Route API : Statut et Horodatage ultra-rapide
  if (reqUrl === '/api/sync') {
    let lastUpdated = 0;
    try {
      const db = lireDB();
      lastUpdated = db && db.lastUpdated ? db.lastUpdated : (fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).mtimeMs : Date.now());
    } catch (e) {}

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(JSON.stringify({
      status: 'online',
      lastUpdated: lastUpdated,
      isCloud: !!IS_RENDER,
      time: new Date().toLocaleTimeString('fr-FR')
    }));
    return;
  }

  // Route API : Lecture et Écriture Fusionnée de la Base
  if (reqUrl === '/api/db') {
    if (req.method === 'GET') {
      const data = lireDB();
      if (!data) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'DB non trouvée' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const entrant = JSON.parse(body);
          const existant = lireDB();

          // FUSION INTELLIGENTE : Aucun écrasement destructeur !
          const fusion = fusionnerBases(existant, entrant);
          ecrireDB(fusion);

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          res.end(JSON.stringify({
            success: true,
            lastUpdated: fusion.lastUpdated,
            commandesCount: fusion.commandesClients.length
          }));

          // Si on est sur PC et qu'on reçoit une mise à jour, propager immédiatement au Cloud
          if (!IS_RENDER) {
            setTimeout(synchroniserAvecCloud, 500);
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Données invalides' }));
        }
      });
      return;
    }
  }

  // Fichiers statiques
  if (reqUrl === '/') reqUrl = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqUrl);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Non Trouvé');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`=======================================================`);
  console.log(`🏗️  CIM-PRO GESTION : SERVEUR DE SYNCHRONISATION PRO EN LIGNE !`);
  console.log(`-------------------------------------------------------`);
  console.log(`💻 Sur votre ordinateur : http://localhost:${PORT}`);
  ips.forEach(i => {
    console.log(`📱 Sur votre smartphone (${i.name}) : http://${i.ip}:${PORT}`);
  });
  console.log(`☁️  Connecté au Hub Cloud : ${CLOUD_URL}`);
  console.log(`=======================================================`);
});
