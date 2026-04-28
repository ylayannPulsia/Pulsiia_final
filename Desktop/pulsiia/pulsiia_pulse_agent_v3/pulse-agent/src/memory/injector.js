/**
 * Memory Injector
 *
 * Avant chaque appel à Claude, on injecte dans le system prompt
 * un bloc <pulse_memories> contenant les K mémoires les plus pertinentes
 * pour la query utilisateur.
 */

/**
 * Formate les mémoires pour injection dans le prompt.
 */
function formatMemoriesBlock(memories) {
  if (!memories || memories.length === 0) return '';

  const byCategory = memories.reduce((acc, m) => {
    (acc[m.category] = acc[m.category] || []).push(m);
    return acc;
  }, {});

  const sections = [];
  const labels = {
    PLANNING_PATTERN: 'Patterns récurrents planning',
    PREFERENCE_USER: 'Vos préférences',
    PREFERENCE_COLLAB: 'Préférences collaborateurs',
    DECISION: 'Décisions passées notables',
    CONTEXT_TENANT: 'Contexte entreprise',
  };

  for (const [cat, items] of Object.entries(byCategory)) {
    sections.push(
      `### ${labels[cat] || cat}\n` +
        items
          .map((m) => `- ${m.content}${m.confidence < 0.7 ? ' (à confirmer)' : ''}`)
          .join('\n')
    );
  }

  return `\n\n# Mémoire long terme (rappel contextuel)
Voici ce que tu as appris au fil des conversations précédentes. Utilise ces éléments
quand ils sont pertinents pour la question courante. Si une mémoire semble dépassée
ou incorrecte, signale-le poliment à l'utilisateur.

${sections.join('\n\n')}`;
}

/**
 * Augmente le system prompt avec les mémoires pertinentes pour la dernière query.
 * @param {string} basePrompt
 * @param {Array} messages — historique conversation
 * @param {MemoryStore} store
 * @param {object} ctx — { tenantId, userId }
 * @returns {Promise<{ prompt: string, retrievedCount: number }>}
 */
async function augmentPromptWithMemories(basePrompt, messages, store, ctx, opts = {}) {
  const { k = 6, minConfidence = 0.4 } = opts;

  if (!store) return { prompt: basePrompt, retrievedCount: 0 };

  // Trouve la dernière query utilisateur
  const lastUser = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && typeof m.content === 'string');

  if (!lastUser) return { prompt: basePrompt, retrievedCount: 0 };

  let memories = [];
  try {
    memories = await store.retrieve(lastUser.content, ctx, { k, minConfidence });
  } catch (err) {
    // Mémoire optionnelle — ne casse jamais le chat
    return { prompt: basePrompt, retrievedCount: 0, error: err.message };
  }

  if (memories.length === 0) {
    return { prompt: basePrompt, retrievedCount: 0 };
  }

  return {
    prompt: basePrompt + formatMemoriesBlock(memories),
    retrievedCount: memories.length,
    memories,
  };
}

module.exports = { formatMemoriesBlock, augmentPromptWithMemories };
