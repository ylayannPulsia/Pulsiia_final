/**
 * /health endpoint enrichi
 *
 * Vérifie que tous les sous-systèmes critiques répondent :
 *  - DB Postgres
 *  - Redis
 *  - Anthropic API (cache 5 min)
 *  - Voyage embeddings (cache 5 min)
 *
 * Retourne 200 si tout OK, 503 si un système critique est down.
 *
 * À monter dans le monorepo Pulsiia :
 *   const { createHealthRouter } = require('./monitoring/health');
 *   app.use(createHealthRouter({ prisma, redis, logger }));
 */

const express = require('express');

const CACHE_TTL = 5 * 60 * 1000; // 5 min pour les checks API externe

class HealthChecker {
  constructor({ prisma, redis, logger }) {
    this.prisma = prisma;
    this.redis = redis;
    this.logger = logger || console;
    this.cache = new Map(); // key → { value, expiresAt }
  }

  async checkDatabase() {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { ok: true, latency_ms: Date.now() - start };
    } catch (err) {
      return { ok: false, error: err.message, latency_ms: Date.now() - start };
    }
  }

  async checkRedis() {
    if (!this.redis) return { ok: true, skipped: true };
    const start = Date.now();
    try {
      await this.redis.ping();
      return { ok: true, latency_ms: Date.now() - start };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async checkAnthropic() {
    return this._cached('anthropic', async () => {
      // Healthcheck léger : on ne fait PAS un vrai chat (coûteux)
      // On ping juste l'endpoint de status
      const start = Date.now();
      try {
        const res = await fetch('https://status.anthropic.com/api/v2/status.json', {
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json();
        return {
          ok: data.status?.indicator === 'none' || data.status?.indicator === 'minor',
          status: data.status?.description || 'unknown',
          latency_ms: Date.now() - start,
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  async checkVoyage() {
    return this._cached('voyage', async () => {
      // Voyage n'a pas de status page publique simple — on teste un embed minimal
      if (!process.env.VOYAGE_API_KEY) return { ok: true, skipped: true };
      const start = Date.now();
      try {
        const res = await fetch('https://api.voyageai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: ['ping'], model: 'voyage-3-lite' }),
          signal: AbortSignal.timeout(5000),
        });
        return { ok: res.ok, status: res.status, latency_ms: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }

  async _cached(key, fn) {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const value = await fn();
    this.cache.set(key, { value, expiresAt: now + CACHE_TTL });
    return value;
  }

  async runAll() {
    const [db, redis, anthropic, voyage] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
      this.checkAnthropic(),
      this.checkVoyage(),
    ]);

    // Critique = DB et Redis. Externes = best effort, n'échouent pas le health
    const critical_ok = db.ok && redis.ok;

    return {
      ok: critical_ok,
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
      version: process.env.PULSIIA_VERSION || 'unknown',
      checks: { db, redis, anthropic, voyage },
    };
  }
}

function createHealthRouter({ prisma, redis, logger }) {
  const router = express.Router();
  const checker = new HealthChecker({ prisma, redis, logger });

  // /health — quick check (DB only, < 100ms)
  router.get('/health', async (req, res) => {
    const db = await checker.checkDatabase();
    if (!db.ok) {
      return res.status(503).json({ ok: false, db });
    }
    res.json({ ok: true, version: process.env.PULSIIA_VERSION });
  });

  // /health/detailed — full diagnostics (slower, auth-protected)
  router.get('/health/detailed', async (req, res) => {
    // Token-protected pour ne pas exposer publiquement les détails
    const token = req.headers['x-health-token'];
    if (token !== process.env.HEALTH_TOKEN) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const result = await checker.runAll();
    res.status(result.ok ? 200 : 503).json(result);
  });

  // /metrics — Prometheus format (optionnel)
  router.get('/metrics', async (req, res) => {
    if (process.env.METRICS_ENABLED !== 'true') {
      return res.status(404).end();
    }
    // Si tu utilises prom-client, expose ici
    res.set('Content-Type', 'text/plain');
    res.send(`# HELP pulsiia_uptime_seconds Process uptime
# TYPE pulsiia_uptime_seconds gauge
pulsiia_uptime_seconds ${process.uptime()}
`);
  });

  return router;
}

module.exports = { HealthChecker, createHealthRouter };
