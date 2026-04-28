/**
 * Memory Learner
 *
 * Après chaque conversation, analyse l'échange avec Claude Haiku (rapide, $)
 * et extrait automatiquement des mémoires candidates.
 *
 * Le learner est CONSERVATEUR : il ne crée une mémoire que pour des
 * informations *nouvelles, durables, et utiles* (pas du contexte transitoire).
 */

const Anthropic = require('@anthropic-ai/sdk');

const EXTRACTION_PROMPT = `Tu es un extracteur de mémoires pour Pulse, l'assistant RH de Pulsiia.

À partir d'une conversation entre Pulse et un utilisateur RH, identifie les FAITS DURABLES
qui méritent d'être mémorisés pour personnaliser les futures interactions.

Catégories valides :
- PLANNING_PATTERN : récurrence métier (ex : "le samedi en cuisine nécessite +1 personne")
- PREFERENCE_USER : préférence du manager/RH (ex : "préfère valider les remplacements en groupe le vendredi")
- PREFERENCE_COLLAB : préférence d'un collaborateur (ex : "Léa ne souhaite pas travailler le mercredi")
- DECISION : décision passée et résultat observable (ex : "Sophie a remplacé Léa le 5/3, équipe satisfaite")
- CONTEXT_TENANT : contexte entreprise stable (ex : "service brunch dimanche 11h-15h à Paris 11")

RÈGLES STRICTES :
1. N'extrait QUE des faits durables. Ignore : météo, "demain", contexte d'une seule fois, états émotionnels.
2. Une mémoire = 1 phrase claire et autonome. Max 200 caractères.
3. Si rien de durable, retourne un tableau vide [].
4. Confidence : 0.9 si l'utilisateur a explicitement énoncé le fait, 0.6 si tu l'infères.
5. Pas de données nominatives bien-être (RGPD).
6. Pas de duplication évidente avec les mémoires existantes fournies.

Réponds UNIQUEMENT avec du JSON valide, structure :
[
  {
    "category": "PREFERENCE_COLLAB",
    "content": "Léa préfère ne pas travailler le mercredi",
    "metadata": {"collaborateur": "Léa A.", "etablissement": "Paris 11"},
    "confidence": 0.9
  }
]`;

class MemoryLearner {
  constructor({ apiKey, store, logger, model = 'claude-haiku-4-5' }) {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY requis');
    this.client = new Anthropic({ apiKey });
    this.store = store;
    this.logger = logger || console;
    this.model = model;
  }

  /**
   * Analyse une conversation et stocke les mémoires extraites.
   * @param {Array} conversation — historique [{role, content}]
   * @param {object} ctx — { tenantId, userId }
   * @returns {Promise<{ extracted: number, stored: number, candidates: Array }>}
   */
  async learnFromConversation(conversation, ctx) {
    if (!conversation || conversation.length < 2) {
      return { extracted: 0, stored: 0, candidates: [] };
    }

    // Récupère les mémoires existantes pertinentes pour éviter doublons
    const lastUserMsg = this._lastUserText(conversation);
    const existing = lastUserMsg
      ? await this.store.retrieve(lastUserMsg, ctx, { k: 5 })
      : [];

    const transcript = conversation
      .filter((m) => typeof m.content === 'string')
      .map((m) => `[${m.role.toUpperCase()}] ${m.content}`)
      .join('\n');

    const existingHint = existing.length
      ? '\n\nMémoires déjà stockées (ne pas dupliquer) :\n' +
        existing.map((e) => `- (${e.category}) ${e.content}`).join('\n')
      : '';

    let candidates = [];
    try {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: EXTRACTION_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Conversation :\n${transcript}${existingHint}\n\nExtrait les mémoires durables :`,
          },
        ],
      });
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      // Strip code fences si présents
      const json = text.replace(/^```json\s*|\s*```$/g, '').trim();
      candidates = JSON.parse(json);
      if (!Array.isArray(candidates)) candidates = [];
    } catch (err) {
      this.logger.error('[learner] extraction failed', err.message);
      return { extracted: 0, stored: 0, candidates: [], error: err.message };
    }

    // Validation + stockage
    let stored = 0;
    const storedIds = [];
    for (const c of candidates) {
      try {
        const created = await this.store.create({
          tenantId: ctx.tenantId,
          userId: c.category === 'PREFERENCE_USER' ? ctx.userId : null,
          category: c.category,
          content: c.content,
          metadata: c.metadata || {},
          confidence: Math.min(0.9, Math.max(0.4, c.confidence || 0.7)),
          source: 'auto',
        });
        stored++;
        storedIds.push(created.id);
      } catch (e) {
        this.logger.warn('[learner] candidate rejected', { reason: e.message, candidate: c });
      }
    }

    return {
      extracted: candidates.length,
      stored,
      candidates,
      storedIds,
    };
  }

  _lastUserText(conversation) {
    for (let i = conversation.length - 1; i >= 0; i--) {
      const m = conversation[i];
      if (m.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return null;
  }
}

module.exports = { MemoryLearner };
