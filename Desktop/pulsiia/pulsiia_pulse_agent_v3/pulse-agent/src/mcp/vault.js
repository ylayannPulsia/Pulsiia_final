/**
 * Token Vault
 *
 * Stockage chiffré des tokens OAuth pour les connexions MCP.
 *
 * Sécurité :
 *  - Chiffrement AES-256-GCM avec clé maître (PULSE_VAULT_KEY) en variable env
 *  - IV unique par enregistrement (12 bytes)
 *  - Tag d'authentification stocké (16 bytes)
 *  - Aucune fuite via les logs (jamais de console.log du token clair)
 *
 * La clé maître doit être :
 *  - Une chaîne de 32 bytes (64 caractères hex)
 *  - Générable via : node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *  - Stockée dans un secret manager (AWS Secrets, Vault, K8s secrets)
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

class TokenVault {
  constructor({ masterKey } = {}) {
    const key = masterKey || process.env.PULSE_VAULT_KEY;
    if (!key) {
      throw new Error('PULSE_VAULT_KEY requis (32 bytes hex)');
    }
    if (key.length !== 64) {
      throw new Error('PULSE_VAULT_KEY doit être 64 caractères hex (32 bytes)');
    }
    this.key = Buffer.from(key, 'hex');
  }

  /**
   * Chiffre un objet token (sérialisé JSON puis AES-GCM).
   * @param {object} token — { access_token, refresh_token, expires_at, scope, ... }
   * @returns {string} — base64 de IV(12) || TAG(16) || CIPHERTEXT
   */
  encrypt(token) {
    if (!token) throw new Error('token requis');
    const plaintext = Buffer.from(JSON.stringify(token), 'utf8');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString('base64');
  }

  /**
   * Déchiffre un blob produit par encrypt().
   */
  decrypt(blob) {
    if (!blob) throw new Error('blob requis');
    const buf = Buffer.from(blob, 'base64');
    if (buf.length < IV_LEN + TAG_LEN + 1) {
      throw new Error('blob corrompu');
    }
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  /**
   * Génère un PKCE pair (code_verifier + code_challenge).
   * @returns {{ verifier: string, challenge: string, method: 'S256' }}
   */
  static generatePKCE() {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    return { verifier, challenge, method: 'S256' };
  }

  /**
   * Génère un state OAuth aléatoire (anti-CSRF).
   */
  static generateState() {
    return crypto.randomBytes(24).toString('base64url');
  }
}

module.exports = { TokenVault };
