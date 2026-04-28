/**
 * Unit tests — Memory injector
 */

const { formatMemoriesBlock, augmentPromptWithMemories } = require('../../../src/memory/injector');

describe('formatMemoriesBlock', () => {
  it('retourne une chaîne vide si aucune mémoire', () => {
    expect(formatMemoriesBlock([])).toBe('');
    expect(formatMemoriesBlock(null)).toBe('');
  });

  it('regroupe les mémoires par catégorie', () => {
    const block = formatMemoriesBlock([
      { category: 'PLANNING_PATTERN', content: 'samedi cuisine = +1', confidence: 0.9 },
      { category: 'PREFERENCE_COLLAB', content: 'Léa pas mercredi', confidence: 0.8 },
      { category: 'PLANNING_PATTERN', content: 'lundi 6h–8h fort', confidence: 0.7 },
    ]);
    expect(block).toContain('Patterns récurrents planning');
    expect(block).toContain('Préférences collaborateurs');
    expect(block).toContain('Léa pas mercredi');
  });

  it("marque les mémoires faibles confiance avec '(à confirmer)'", () => {
    const block = formatMemoriesBlock([
      { category: 'DECISION', content: 'Sophie OK', confidence: 0.5 },
      { category: 'DECISION', content: 'Thomas OK', confidence: 0.9 },
    ]);
    expect(block).toMatch(/Sophie OK \(à confirmer\)/);
    expect(block).not.toMatch(/Thomas OK \(à confirmer\)/);
  });
});

describe('augmentPromptWithMemories', () => {
  const mockStore = (memories) => ({
    retrieve: jest.fn().mockResolvedValue(memories),
  });

  it("retourne le prompt brut si aucun store", async () => {
    const result = await augmentPromptWithMemories(
      'BASE',
      [{ role: 'user', content: 'test' }],
      null,
      { tenantId: 't1' }
    );
    expect(result.prompt).toBe('BASE');
    expect(result.retrievedCount).toBe(0);
  });

  it("retourne le prompt brut si pas de message user", async () => {
    const store = mockStore([]);
    const result = await augmentPromptWithMemories('BASE', [], store, { tenantId: 't1' });
    expect(result.prompt).toBe('BASE');
  });

  it("retourne le prompt brut si retrieve ne renvoie rien", async () => {
    const store = mockStore([]);
    const result = await augmentPromptWithMemories(
      'BASE',
      [{ role: 'user', content: 'test' }],
      store,
      { tenantId: 't1' }
    );
    expect(result.prompt).toBe('BASE');
    expect(result.retrievedCount).toBe(0);
  });

  it("augmente le prompt avec un bloc mémoires", async () => {
    const store = mockStore([
      { category: 'PLANNING_PATTERN', content: 'samedi +1', confidence: 0.9 },
    ]);
    const result = await augmentPromptWithMemories(
      'BASE',
      [{ role: 'user', content: 'planning samedi ?' }],
      store,
      { tenantId: 't1', userId: 'u1' }
    );
    expect(result.prompt).toContain('BASE');
    expect(result.prompt).toContain('samedi +1');
    expect(result.retrievedCount).toBe(1);
  });

  it("ne casse pas si retrieve échoue", async () => {
    const store = { retrieve: jest.fn().mockRejectedValue(new Error('DB down')) };
    const result = await augmentPromptWithMemories(
      'BASE',
      [{ role: 'user', content: 'test' }],
      store,
      { tenantId: 't1' }
    );
    expect(result.prompt).toBe('BASE');
    expect(result.error).toBe('DB down');
  });
});
