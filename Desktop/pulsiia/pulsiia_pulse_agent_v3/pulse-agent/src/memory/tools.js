/**
 * Memory tools — Pulse peut explicitement gérer sa propre mémoire.
 */

const MEMORY_TOOL_DEFINITIONS = [
  {
    name: 'enregistrer_memoire',
    description:
      'Enregistre une information durable et utile pour les futures conversations. ' +
      'Utiliser quand l\'utilisateur énonce explicitement une préférence, une règle, ou un pattern récurrent ' +
      "(ex : 'retiens que Léa préfère ne pas travailler le mercredi'). " +
      "À NE PAS utiliser pour des informations transitoires ou ponctuelles.",
    input_schema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: [
            'PLANNING_PATTERN',
            'PREFERENCE_USER',
            'PREFERENCE_COLLAB',
            'DECISION',
            'CONTEXT_TENANT',
          ],
        },
        content: {
          type: 'string',
          description: 'Phrase claire et autonome (max 200 caractères)',
        },
        metadata: {
          type: 'object',
          description: 'JSON libre (ex : { collaborateur, etablissement, scope })',
        },
      },
      required: ['category', 'content'],
    },
  },
  {
    name: 'oublier_memoire',
    description:
      "RGPD Article 17 — supprime définitivement une mémoire. À utiliser quand l'utilisateur " +
      "demande explicitement d'oublier une information (ex : 'oublie que Léa préfère le matin').",
    input_schema: {
      type: 'object',
      properties: {
        memoire_id: {
          type: 'string',
          description: 'ID de la mémoire à supprimer (visible dans le contexte injecté)',
        },
      },
      required: ['memoire_id'],
    },
  },
  {
    name: 'corriger_memoire',
    description:
      "Marque une mémoire comme inexacte. Décroît sa confiance ; si elle tombe trop bas, elle est supprimée. " +
      "Utiliser quand l'utilisateur dit 'non, c'est faux' ou 'ça a changé' à propos d'une mémoire affichée.",
    input_schema: {
      type: 'object',
      properties: {
        memoire_id: { type: 'string' },
      },
      required: ['memoire_id'],
    },
  },
];

/**
 * Handlers — à brancher dans ToolExecutor.
 */
function buildMemoryHandlers(store) {
  return {
    enregistrer_memoire: async (input, ctx) => {
      const { category, content, metadata = {} } = input;
      return store.create({
        tenantId: ctx.tenantId,
        userId: category === 'PREFERENCE_USER' ? ctx.user.id : null,
        category,
        content,
        metadata,
        confidence: 0.95,
        source: 'user', // explicitement validé par l'utilisateur
      });
    },
    oublier_memoire: async (input, ctx) => {
      return store.forget(input.memoire_id, {
        tenantId: ctx.tenantId,
        userId: ctx.user.id,
      });
    },
    corriger_memoire: async (input, ctx) => {
      return store.demote(input.memoire_id, {
        tenantId: ctx.tenantId,
        userId: ctx.user.id,
      });
    },
  };
}

module.exports = { MEMORY_TOOL_DEFINITIONS, buildMemoryHandlers };
