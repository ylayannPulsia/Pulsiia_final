/**
 * Embedder — provider d'embeddings pour la mémoire long terme.
 *
 * Anthropic ne fournit pas d'API d'embeddings native. On utilise donc :
 *  - Voyage AI (recommandé par Anthropic, voyage-3-lite : 1536 dims, $0.02/1M tokens)
 *  - ou OpenAI text-embedding-3-small (1536 dims, $0.02/1M tokens) en fallback
 *
 * L'interface est identique, configurable via PULSE_EMBEDDER_PROVIDER.
 */

const EMBEDDING_DIM = 1536;

class VoyageEmbedder {
  constructor({ apiKey, model = 'voyage-3-lite' }) {
    if (!apiKey) throw new Error('VOYAGE_API_KEY requis');
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = 'https://api.voyageai.com/v1/embeddings';
  }

  async embed(text, { inputType = 'document' } = {}) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: [text],
        model: this.model,
        input_type: inputType, // 'document' ou 'query'
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Voyage embed failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.data[0].embedding;
  }
}

class OpenAIEmbedder {
  constructor({ apiKey, model = 'text-embedding-3-small' }) {
    if (!apiKey) throw new Error('OPENAI_API_KEY requis');
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = 'https://api.openai.com/v1/embeddings';
  }

  async embed(text) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: text,
        model: this.model,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embed failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.data[0].embedding;
  }
}

/**
 * Mock pour les tests (déterministe, basé sur hash du texte).
 */
class MockEmbedder {
  async embed(text) {
    const vec = new Array(EMBEDDING_DIM).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % EMBEDDING_DIM] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return vec.map((x) => x / norm);
  }
}

function createEmbedder() {
  const provider = (process.env.PULSE_EMBEDDER_PROVIDER || 'voyage').toLowerCase();
  if (provider === 'voyage') {
    return new VoyageEmbedder({ apiKey: process.env.VOYAGE_API_KEY });
  }
  if (provider === 'openai') {
    return new OpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY });
  }
  if (provider === 'mock') {
    return new MockEmbedder();
  }
  throw new Error(`Provider d'embedding inconnu : ${provider}`);
}

module.exports = {
  VoyageEmbedder,
  OpenAIEmbedder,
  MockEmbedder,
  createEmbedder,
  EMBEDDING_DIM,
};
