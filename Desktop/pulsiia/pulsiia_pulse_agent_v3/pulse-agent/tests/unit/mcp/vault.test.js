/**
 * Unit tests — TokenVault
 */

const crypto = require('crypto');
const { TokenVault } = require('../../../src/mcp/vault');

const TEST_KEY = crypto.randomBytes(32).toString('hex');

describe('TokenVault', () => {
  describe('constructor', () => {
    it('exige la clé maître', () => {
      const orig = process.env.PULSE_VAULT_KEY;
      delete process.env.PULSE_VAULT_KEY;
      expect(() => new TokenVault()).toThrow(/PULSE_VAULT_KEY/);
      if (orig) process.env.PULSE_VAULT_KEY = orig;
    });

    it("rejette une clé de mauvaise taille", () => {
      expect(() => new TokenVault({ masterKey: 'tooshort' })).toThrow(/64 caractères/);
    });

    it("accepte une clé valide", () => {
      expect(() => new TokenVault({ masterKey: TEST_KEY })).not.toThrow();
    });
  });

  describe('encrypt/decrypt', () => {
    let vault;
    beforeEach(() => {
      vault = new TokenVault({ masterKey: TEST_KEY });
    });

    it("chiffre puis déchiffre un token simple", () => {
      const original = {
        access_token: 'sl_xyz123',
        refresh_token: 'sl_ref456',
        expires_at: '2026-04-28T10:00:00Z',
      };
      const blob = vault.encrypt(original);
      expect(typeof blob).toBe('string');
      expect(blob).not.toContain('sl_xyz123'); // doit être chiffré

      const decrypted = vault.decrypt(blob);
      expect(decrypted).toEqual(original);
    });

    it("génère des blobs différents pour un même token (IV unique)", () => {
      const token = { access_token: 'abc' };
      const b1 = vault.encrypt(token);
      const b2 = vault.encrypt(token);
      expect(b1).not.toBe(b2);
      // Mais déchiffrement identique
      expect(vault.decrypt(b1)).toEqual(vault.decrypt(b2));
    });

    it("rejette un blob altéré (auth tag check)", () => {
      const token = { access_token: 'abc' };
      const blob = vault.encrypt(token);
      // Flip un caractère
      const tampered = blob.slice(0, -2) + (blob.slice(-2) === 'AA' ? 'BB' : 'AA');
      expect(() => vault.decrypt(tampered)).toThrow();
    });

    it("rejette un blob déchiffré avec une autre clé", () => {
      const otherVault = new TokenVault({ masterKey: crypto.randomBytes(32).toString('hex') });
      const blob = vault.encrypt({ access_token: 'abc' });
      expect(() => otherVault.decrypt(blob)).toThrow();
    });

    it("refuse encrypt sans token", () => {
      expect(() => vault.encrypt(null)).toThrow(/token requis/);
    });

    it("refuse decrypt blob trop court", () => {
      expect(() => vault.decrypt('AAAA')).toThrow(/corrompu/);
    });
  });

  describe('PKCE generation', () => {
    it("génère verifier+challenge valides", () => {
      const { verifier, challenge, method } = TokenVault.generatePKCE();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(method).toBe('S256');
      expect(verifier.length).toBeGreaterThanOrEqual(43);
    });

    it("vérifie que challenge = SHA256(verifier)", () => {
      const { verifier, challenge } = TokenVault.generatePKCE();
      const expected = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');
      expect(challenge).toBe(expected);
    });

    it("génère des paires différentes", () => {
      const a = TokenVault.generatePKCE();
      const b = TokenVault.generatePKCE();
      expect(a.verifier).not.toBe(b.verifier);
    });
  });

  describe('state generation', () => {
    it("génère un state unique base64url", () => {
      const a = TokenVault.generateState();
      const b = TokenVault.generateState();
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(32);
    });
  });
});
