/**
 * Pulse Memory Store
 *
 * Mémoires long terme avec embeddings pgvector pour rappel sémantique.
 *
 * Catégories de mémoires :
 *  - PLANNING_PATTERN : récurrences (ex : "samedi cuisine = +1 personne")
 *  - PREFERENCE_USER  : préférences de l'utilisateur RH (ex : "Marie privilégie ancienneté")
 *  - PREFERENCE_COLLAB: préférences d'un collaborateur (ex : "Léa préfère ne pas mercredi")
 *  - DECISION         : décisions passées et leur résultat (ex : "Sophie remplace Léa = OK")
 *  - CONTEXT_TENANT   : contexte entreprise (ex : "service brunch dim 11h-15h")
 *
 * Permissions :
 *  - Memories scopées par tenantId (multi-tenant)
 *  - Memories USER scopées en plus par userId
 *  - RGPD : Article 17 (oubli) → tool `oublier_memoire` disponible
 */

const EMBEDDING_DIM = 1536; // OpenAI text-embedding-3-small / Voyage voyage-3-lite

const CATEGORIES = Object.freeze({
  PLANNING_PATTERN: 'PLANNING_PATTERN',
  PREFERENCE_USER: 'PREFERENCE_USER',
  PREFERENCE_COLLAB: 'PREFERENCE_COLLAB',
  DECISION: 'DECISION',
  CONTEXT_TENANT: 'CONTEXT_TENANT',
});

class MemoryStore {
  constructor({ prisma, embedder, logger }) {
    this.prisma = prisma;
    this.embedder = embedder; // injecté : { embed(text) → Promise<number[]> }
    this.logger = logger || console;
  }

  /**
   * Crée une nouvelle mémoire.
   * @param {object} m
   * @param {string} m.tenantId
   * @param {string} [m.userId] — pour les mémoires USER-scoped
   * @param {string} m.category — voir CATEGORIES
   * @param {string} m.content — texte court (1-3 phrases)
   * @param {object} [m.metadata] — JSON libre (ex : { etablissementId, equipeId, scope_dates })
   * @param {number} [m.confidence] — 0-1, score de confiance (défaut 0.7)
   * @param {string} [m.source] — 'auto' (extraite par learner) ou 'user' (validée)
   */
  async create({ tenantId, userId, category, content, metadata = {}, confidence = 0.7, source = 'auto' }) {
    if (!CATEGORIES[category]) {
      throw new Error(`Catégorie invalide : ${category}`);
    }
    if (!content || content.length > 500) {
      throw new Error('content requis, max 500 caractères');
    }

    const embedding = await this.embedder.embed(content);
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIM) {
      throw new Error(`Embedding invalide (attendu ${EMBEDDING_DIM} dims)`);
    }

    // pgvector : on insert via raw SQL pour le type vector
    const id = this._cuid();
    await this.prisma.$executeRaw`
      INSERT INTO "PulseMemory"
        (id, "tenantId", "userId", category, content, metadata, confidence, source, embedding, "createdAt", "lastUsedAt")
      VALUES
        (${id}, ${tenantId}, ${userId || null}, ${category}, ${content},
         ${JSON.stringify(metadata)}::jsonb, ${confidence}, ${source},
         ${this._vec(embedding)}::vector, NOW(), NOW())
    `;

    return { id, content, category, confidence, source };
  }

  /**
   * Recherche sémantique : retourne les K mémoires les plus pertinentes pour une query.
   * @param {string} query — texte de recherche
   * @param {object} ctx — { tenantId, userId }
   * @param {object} opts — { k, categories, minConfidence }
   */
  async retrieve(query, ctx, opts = {}) {
    const { tenantId, userId } = ctx;
    const { k = 6, categories = null, minConfidence = 0.4 } = opts;

    if (!tenantId) throw new Error('tenantId requis');

    const queryEmbedding = await this.embedder.embed(query);
    const vec = this._vec(queryEmbedding);

    // Filtre tenant + scope (memories tenant-wide OR userId-scoped to this user)
    // Filtre catégories optionnel
    const catFilter = categories
      ? `AND category = ANY(ARRAY[${categories.map((c) => `'${c}'`).join(',')}]::text[])`
      : '';

    const results = await this.prisma.$queryRawUnsafe(
      `
      SELECT id, category, content, metadata, confidence, source,
             "createdAt", "lastUsedAt", "useCount",
             1 - (embedding <=> $1::vector) AS similarity
      FROM "PulseMemory"
      WHERE "tenantId" = $2
        AND ("userId" IS NULL OR "userId" = $3)
        AND confidence >= $4
        ${catFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $5
      `,
      vec,
      tenantId,
      userId || null,
      minConfidence,
      k
    );

    // Mark as used (touch lastUsedAt + increment useCount) — async, fire-and-forget
    if (results.length > 0) {
      const ids = results.map((r) => r.id);
      this.prisma.$executeRaw`
        UPDATE "PulseMemory"
        SET "lastUsedAt" = NOW(), "useCount" = "useCount" + 1
        WHERE id = ANY(${ids}::text[])
      `.catch((e) => this.logger.error('[memory] touch failed', e.message));
    }

    return results;
  }

  /**
   * Récupère par ID (pour vérification ou suppression).
   */
  async getById(id, ctx) {
    return this.prisma.pulseMemory.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
  }

  /**
   * RGPD Article 17 — droit à l'oubli.
   * @param {string} id
   * @param {object} ctx — { tenantId, userId }
   */
  async forget(id, ctx) {
    const mem = await this.getById(id, ctx);
    if (!mem) throw new Error('Mémoire introuvable');
    // Si la mémoire est userId-scoped, vérifier le owner
    if (mem.userId && mem.userId !== ctx.userId) {
      throw new Error('Accès refusé : cette mémoire appartient à un autre utilisateur');
    }
    await this.prisma.pulseMemory.delete({ where: { id } });
    return { ok: true, deletedId: id };
  }

  /**
   * Liste paginée — pour UI "ma mémoire" côté Marie.
   */
  async list({ tenantId, userId, category, limit = 50, offset = 0 }) {
    return this.prisma.pulseMemory.findMany({
      where: {
        tenantId,
        ...(userId !== undefined && { OR: [{ userId }, { userId: null }] }),
        ...(category && { category }),
      },
      orderBy: [{ lastUsedAt: 'desc' }],
      take: limit,
      skip: offset,
    });
  }

  /**
   * Décroît la confiance d'une mémoire qui s'est avérée fausse (correction utilisateur).
   * Si confidence tombe < 0.2, la mémoire est purgée.
   */
  async demote(id, ctx, delta = 0.2) {
    const mem = await this.getById(id, ctx);
    if (!mem) return null;
    const newConf = Math.max(0, mem.confidence - delta);
    if (newConf < 0.2) {
      await this.prisma.pulseMemory.delete({ where: { id } });
      return { id, deleted: true };
    }
    return this.prisma.pulseMemory.update({
      where: { id },
      data: { confidence: newConf },
    });
  }

  /**
   * Promeut une mémoire (utilisateur la confirme explicitement).
   * Passe source='user' et confidence à 0.95.
   */
  async promote(id, ctx) {
    const mem = await this.getById(id, ctx);
    if (!mem) throw new Error('Mémoire introuvable');
    return this.prisma.pulseMemory.update({
      where: { id },
      data: { confidence: 0.95, source: 'user' },
    });
  }

  // ─── helpers ─────────────────────────────────
  _vec(arr) {
    return `[${arr.join(',')}]`;
  }

  _cuid() {
    return 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
}

module.exports = { MemoryStore, CATEGORIES, EMBEDDING_DIM };
