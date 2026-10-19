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

// ===== Anti-doublons : fusionne les commandes identiques saisies sur plusieurs appareils =====
function normNomClient(n) {
  return String(n || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}
function distanceNoms(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return Math.max(m, n);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function chiffresTel(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.startsWith('228') && d.length > 8) d = d.slice(3);
  return d;
}
function telEstFactice(t) {
  const d = chiffresTel(t);
  return !d || /^(\d)\1+$/.test(d) || d === '90000000';
}
function memeClient(a, b) {
  const na = normNomClient(a.client), nb = normNomClient(b.client);
  if (!na || !nb) return false;
  return na === nb || distanceNoms(na, nb) <= 2;
}
function titreNom(n) {
  return String(n || '').trim().toLowerCase().replace(/(^|\s|-)\S/g, s => s.toUpperCase());
}
function estDoublonCommande(a, b) {
  if (String(a.id) === String(b.id)) return false;
  if (!memeClient(a, b)) return false;
  if (Number(a.tonnage) !== Number(b.tonnage)) return false;
  if (Number(a.totalVente) !== Number(b.totalVente)) return false;
  const pa = Array.isArray(a.paiements) ? a.paiements.length : 0;
  const pb = Array.isArray(b.paiements) ? b.paiements.length : 0;
  const attA = a.statutLivraison === 'EN_ATTENTE', attB = b.statutLivraison === 'EN_ATTENTE';
  if (!(attA && attB) && !(pa === 0 && pb === 0 && a.statutLivraison === b.statutLivraison)) return false;
  const fa = telEstFactice(a.telephone), fb = telEstFactice(b.telephone);
  if (fa || fb) return true; // un des numéros est un provisoire => même commande
  if (a.date === b.date && chiffresTel(a.telephone) === chiffresTel(b.telephone)) return true; // double envoi
  return false;
}
function dedoublonnerCommandes(liste) {
  const tries = liste.slice().sort((x, y) => Number(x.id) - Number(y.id));
  const res = [];
  tries.forEach(c => {
    let idx = res.findIndex(r => (r.fusionDe || []).map(String).includes(String(c.id)));
    if (idx === -1) idx = res.findIndex(r => estDoublonCommande(r, c));
    if (idx === -1) { res.push(Object.assign({}, c)); return; }
    const base = res[idx];
    const reel = !telEstFactice(c.telephone) ? c : base;
    const paiements = new Map();
    (base.paiements || []).concat(c.paiements || []).forEach(p => paiements.set(String(p.id || p.date + p.montant), p));
    res[idx] = Object.assign({}, base, {
      client: titreNom(c.client),
      telephone: telEstFactice(reel.telephone) ? (base.telephone || c.telephone) : reel.telephone,
      destination: (reel.destination && reel.destination !== 'Chantier Lomé') ? reel.destination : (base.destination || c.destination),
      paiements: Array.from(paiements.values()),
      chauffeurAssigne: base.chauffeurAssigne || c.chauffeurAssigne || null,
      fusionDe: Array.from(new Set((base.fusionDe || []).concat([c.id])))
    });
  });
  return res;
}

function fusionnerBases(dbA, dbB) {
  if (!dbA && !dbB) return {};
  if (!dbA) return JSON.parse(JSON.stringify(dbB));
  if (!dbB) return JSON.parse(JSON.stringify(dbA));

  const fusion = Object.assign({}, dbA, dbB);
  if ((Number(dbA.codePINDate) || 0) > (Number(dbB.codePINDate) || 0)) { fusion.codePIN = dbA.codePIN; fusion.codePINDate = dbA.codePINDate; }

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

  fusion.commandesClients = dedoublonnerCommandes(Array.from(mapCmds.values()));

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

  // 5. Table CHAUFFEURS (clé unique = téléphone) avec suppressions/purges propagées
  (function () {
    const resetMax = Math.max(Number(dbA.chauffeursReset) || 0, Number(dbB.chauffeursReset) || 0);
    const suppr = Object.assign({}, dbA.chauffeursSupprimes || {});
    Object.keys(dbB.chauffeursSupprimes || {}).forEach(k => {
      suppr[k] = Math.max(Number(suppr[k]) || 0, Number(dbB.chauffeursSupprimes[k]) || 0);
    });
    const mapChf = new Map();
    [].concat(dbA.chauffeurs || [], dbB.chauffeurs || []).forEach(c => {
      if (!c || !c.telephone) return;
      const ts = Number(c.maj) || Number(c.date_creation) || 0;
      if (ts <= resetMax) return;
      if (ts <= (Number(suppr[c.telephone]) || 0)) return;
      const prev = mapChf.get(c.telephone);
      if (!prev || ts >= (Number(prev.maj) || Number(prev.date_creation) || 0)) mapChf.set(c.telephone, c);
    });
    fusion.chauffeurs = Array.from(mapChf.values());
    fusion.chauffeursReset = resetMax;
    fusion.chauffeursSupprimes = suppr;
  })();

  // 6. Reçus CODIMAC & historique des commandes fournisseur : fusion sans perte
  (function () {
    const cle = r => {
      const n = String(r.numero || '').replace(/\D/g, '').replace(/^0+/, '');
      return (n ? n : 'id' + r.id) + '|' + (Number(r.montant) || 0);
    };
    const mapR = new Map();
    [].concat(dbA.recusCODIMAC || [], dbB.recusCODIMAC || []).forEach(r => {
      if (!r) return;
      const k = cle(r);
      if (!mapR.has(k)) mapR.set(k, r);
    });
    fusion.recusCODIMAC = Array.from(mapR.values()).sort((x, y) => (Number(y.id) || 0) - (Number(x.id) || 0));

    const mapH = new Map();
    [].concat(dbA.historiqueCommandes || [], dbB.historiqueCommandes || []).forEach(h => {
      if (!h || !h.ref) return;
      const p = mapH.get(h.ref);
      if (!p || (Number(h.totalPaye) || 0) > (Number(p.totalPaye) || 0)) mapH.set(h.ref, h);
    });
    const ordre = (dbA.historiqueCommandes && dbA.historiqueCommandes.length ? dbA.historiqueCommandes : (dbB.historiqueCommandes || [])).map(h => h.ref);
    fusion.historiqueCommandes = Array.from(mapH.values()).sort((x, y) => {
      const ix = ordre.indexOf(x.ref), iy = ordre.indexOf(y.ref);
      return (ix < 0 ? 999 : ix) - (iy < 0 ? 999 : iy);
    });

    // Paiements enregistrés dans l'application (ids horodatés) => jamais moins que leur somme
    const sommeNouveaux = fusion.recusCODIMAC.filter(r => Number(r.id) > 1e12).reduce((a, r) => a + (Number(r.montant) || 0), 0);
    if (fusion.detteActive) {
      const paye = Math.max(Number(fusion.detteActive.montantPaye) || 0, sommeNouveaux);
      fusion.detteActive.montantPaye = paye;
      fusion.detteActive.rapMontant = Math.max(0, (Number(fusion.detteActive.montantTotal) || 12263000) - paye);
      fusion.detteActive.rapTonnes = Math.max(0, Math.round((fusion.detteActive.rapMontant / 71000) * 10) / 10);
    }
  })();



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

// Empreinte stable d'une base (sans l'horodatage) pour ne synchroniser que s'il y a un vrai changement
function empreinteDB(o) {
  const tri = v => Array.isArray(v) ? v.map(tri)
    : (v && typeof v === 'object') ? Object.keys(v).sort().reduce((a, k) => { if (k !== 'lastUpdated') a[k] = tri(v[k]); return a; }, {})
    : v;
  return JSON.stringify(tri(o));
}

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

        // Sauvegarder en local uniquement si quelque chose a réellement changé
        const empFusion = empreinteDB(fusion);
        if (empFusion !== empreinteDB(localDB)) ecrireDB(fusion);

        // Si le cloud n'avait pas toutes nos données (ex: commandes, reçus, paiements), on le met à jour
        const cloudCount = (cloudDB.commandesClients || []).length;
        const fusionCount = (fusion.commandesClients || []).length;
        if (empFusion !== empreinteDB(cloudDB)) {
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

  // Route API : recherche STRICTE d'un chauffeur par téléphone (table Chauffeur uniquement)
  if (reqUrl === '/api/chauffeurs' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams.get('tel') || '';
    let k = q.replace(/\D/g, '');
    if (k.startsWith('228') && k.length > 8) k = k.slice(3);
    const db = lireDB() || {};
    const liste = Array.isArray(db.chauffeurs) ? db.chauffeurs : [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    if (!q) { res.end(JSON.stringify({ chauffeurs: liste })); return; }
    const ch = k.length === 8 ? liste.find(c => c.telephone === k) : null;
    res.end(JSON.stringify(ch ? { found: true, chauffeur: ch } : { found: false, message: 'Chauffeur non enregistré' }));
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
          if (!existant || empreinteDB(fusion) !== empreinteDB(existant)) ecrireDB(fusion);
          else fusion.lastUpdated = existant.lastUpdated;

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
