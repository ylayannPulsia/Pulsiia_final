-- ─────────────────────────────────────────────────────────────
-- Pulse Memory — pgvector setup
-- À exécuter APRÈS `prisma migrate dev --name add_pulse_memory`
-- (Prisma ne gère pas nativement le type vector, on l'ajoute en raw SQL)
-- ─────────────────────────────────────────────────────────────

-- 1. Activer l'extension pgvector si pas déjà fait
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Ajouter la colonne embedding (1536 dims pour OpenAI / Voyage)
ALTER TABLE "PulseMemory"
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- 3. Créer un index ivfflat pour recherche rapide
-- (lists = sqrt(N) recommandé ; 100 convient pour 10k-100k vecteurs)
CREATE INDEX IF NOT EXISTS pulsememory_embedding_idx
  ON "PulseMemory"
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 4. Index couvrant pour le filtrage tenant + scope
CREATE INDEX IF NOT EXISTS pulsememory_tenant_user_idx
  ON "PulseMemory" ("tenantId", "userId", confidence)
  WHERE confidence >= 0.4;

-- 5. (optionnel) Trigger de purge auto des mémoires non utilisées depuis > 1 an
-- À activer selon politique de rétention
-- DELETE FROM "PulseMemory" WHERE "lastUsedAt" < NOW() - INTERVAL '1 year' AND source = 'auto';
