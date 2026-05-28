// server.js — Sert le SPA + proxy API intégré
// Le proxy fait passer toutes les requêtes /api/* par ce serveur (port 3000)
// vers le backend (port 3001) en interne — le téléphone n'a besoin d'accéder
// qu'au port 3000, le port 3001 reste purement local.

const express = require('express');
const http    = require('http');
const path    = require('path');
const app     = express();
const PORT    = process.env.PORT || 3000;
const BACKEND = process.env.BACKEND_URL || 'http://localhost:3001';

// Pages HTML / JS applicatif — jamais mis en cache navigateur
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
};

// ── Proxy /api/* et /health vers le backend ─────────────────────────────────
// Utilise http natif Node.js — aucune dépendance supplémentaire
function proxyToBackend(req, res) {
  const backendUrl  = new URL(BACKEND);
  const options = {
    hostname: backendUrl.hostname,
    port:     backendUrl.port || 3001,
    path:     req.url,
    method:   req.method,
    headers: {
      ...req.headers,
      host: backendUrl.host,
    },
  };

  // Lire le body si nécessaire (POST/PUT/PATCH)
  let body = [];
  req.on('data', chunk => body.push(chunk));
  req.on('end', () => {
    const bodyBuffer = Buffer.concat(body);
    if (bodyBuffer.length > 0) {
      options.headers['content-length'] = bodyBuffer.length;
    }

    const proxy = http.request(options, (backendRes) => {
      // Ajouter les headers CORS pour le téléphone
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Credentials', 'true');

      res.writeHead(backendRes.statusCode, backendRes.headers);
      backendRes.pipe(res);
    });

    proxy.on('error', (err) => {
      console.error('[Proxy] Backend inaccessible :', err.message);
      res.status(503).json({
        error: 'Backend indisponible — assurez-vous que le backend tourne (port 3001)',
      });
    });

    if (bodyBuffer.length > 0) proxy.write(bodyBuffer);
    proxy.end();
  });
}

// Préflight CORS (OPTIONS)
app.options('/api/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.sendStatus(204);
});

// Toutes les routes API et health sont proxifiées
app.all('/api/*', proxyToBackend);
app.all('/health', proxyToBackend);

// ── Config dynamique ─────────────────────────────────────────────────────────
// L'API URL pointe maintenant vers ce même serveur (port 3000) qui proxifie
// → fonctionne depuis localhost ET depuis n'importe quel appareil sur le réseau
app.get('/config.js', noCache, (req, res) => {
  const host = req.headers.host || `localhost:${PORT}`;
  const forwarded = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded || (req.secure ? 'https' : 'http');
  // L'API passe par le même serveur (proxy intégré) sauf si API_URL explicite (prod)
  const apiUrl = process.env.API_URL || `${protocol}://${host}`;

  const config = { apiUrl, appVersion: '1.1.0' };
  res.type('application/javascript');
  res.send(`window.__PULSIIA_CONFIG__ = ${JSON.stringify(config)};`);
});

// ── Pages statiques ──────────────────────────────────────────────────────────

// Ancien nom souvent bloqué par AdBlock → redirection
app.get('/js/api.js', noCache, (req, res) => {
  res.redirect(302, '/js/pulsiia-client.js');
});

app.get('/', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/reset-password.html', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset-password.html'));
});

app.get('/landing', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/dashboard', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'maquette.html'));
});

app.get(/^\/js\/.+\.js$/, noCache, (req, res, next) => {
  const filePath = path.join(__dirname, 'public', req.path);
  res.sendFile(filePath, (err) => { if (err) next(); });
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
  },
}));

app.get('/maquette.html', (req, res) => res.redirect(302, '/dashboard'));

app.get('*', (req, res) => {
  if (req.path.includes('.')) return res.status(404).send('Not found');
  res.redirect(302, '/dashboard');
});

// ── Démarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🟢 Pulsiia Frontend  — http://localhost:${PORT}`);
  console.log(`🔀 Proxy API         — ${BACKEND} → /api/*`);
  console.log(`📱 Accès téléphone   — http://192.168.1.10:${PORT}\n`);
});
