-- ─────────────────────────────────────────────────────────────
-- Pulsiia — Postgres initialization
-- Exécuté automatiquement au premier démarrage du container
-- ─────────────────────────────────────────────────────────────

-- pgvector pour la mémoire long terme Pulse
CREATE EXTENSION IF NOT EXISTS vector;

-- pgcrypto pour gen_random_uuid() si besoin côté Prisma
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- pg_stat_statements pour observabilité (slow queries, top queries)
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
