const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

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

const DB_FILE = path.join(PUBLIC_DIR, 'db.json');

const server = http.createServer((req, res) => {
  // CORS & Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqUrl = req.url.split('?')[0];

  // Log pour diagnostic de synchronisation
  if (reqUrl.startsWith('/api/')) {
    if (reqUrl !== '/api/sync') { // Ne pas flooder les logs avec le heartbeat sync
      console.log(`[API ${new Date().toLocaleTimeString()}] ${req.method} ${reqUrl}`);
    }
  }

  // Route API : Horodatage pour détection ultra-rapide des changements (PC <-> Smartphone)
  if (reqUrl === '/api/sync') {
    let lastUpdated = 0;
    try {
      if (fs.existsSync(DB_FILE)) {
        lastUpdated = fs.statSync(DB_FILE).mtimeMs;
      }
    } catch (e) {}
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(JSON.stringify({ lastUpdated }));
    return;
  }

  // Route API : Lecture et Écriture de la Base de Données Commune
  if (reqUrl === '/api/db') {
    if (req.method === 'GET') {
      fs.readFile(DB_FILE, 'utf8', (err, data) => {
        if (err || !data) {
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
        res.end(data);
      });
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          parsed.lastUpdated = Date.now();
          fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2), 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          });
          res.end(JSON.stringify({ success: true, lastUpdated: parsed.lastUpdated }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Données invalides' }));
        }
      });
      return;
    }
  }

  // Fichiers statiques web
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
  console.log(`🏗️  CIM-PRO GESTION EST EN LIGNE !`);
  console.log(`-------------------------------------------------------`);
  console.log(`💻 Sur votre ordinateur : http://localhost:${PORT}`);
  ips.forEach(i => {
    console.log(`📱 Sur votre smartphone (${i.name}) : http://${i.ip}:${PORT}`);
  });
  console.log(`=======================================================`);
});
