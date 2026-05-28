/**
 * Yousign API v3 — signature électronique eIDAS (prestataire français agréé).
 * Sandbox : https://developers.yousign.com/
 * Production : https://api.yousign.app/v3
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://api-sandbox.yousign.app/v3';

function isConfigured() {
  return Boolean(process.env.YOUSIGN_API_KEY?.trim());
}

function baseUrl() {
  return (process.env.YOUSIGN_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

function signatureLevel() {
  const level = process.env.YOUSIGN_SIGNATURE_LEVEL || 'advanced_electronic_signature';
  const allowed = ['electronic_signature', 'advanced_electronic_signature', 'qualified_electronic_signature'];
  return allowed.includes(level) ? level : 'advanced_electronic_signature';
}

async function apiRequest(method, apiPath, { json, formData } = {}) {
  const url = `${baseUrl()}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  const headers = {
    Authorization: `Bearer ${process.env.YOUSIGN_API_KEY}`,
  };
  const options = { method, headers };

  if (formData) {
    options.body = formData;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(json);
  }

  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const msg = data.detail || data.message || data.title || text || res.statusText;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    err.data = data;
    throw err;
  }

  return data;
}

/**
 * Crée une procédure de signature Yousign pour un PDF et retourne le lien signataire.
 * @param {{ filePath: string, fileName: string, signer: { firstName, lastName, email, phone? }, documentName?: string }} opts
 */
async function createSignatureProcedure(opts) {
  const { filePath: diskPath, fileName, signer, documentName } = opts;

  if (!isConfigured()) {
    return {
      provider: 'yousign',
      mode: 'simulation',
      requestId: null,
      signerId: null,
      signatureLink: null,
      level: signatureLevel(),
      message:
        'YOUSIGN_API_KEY non configurée. Créez un compte sur https://yousign.com (sandbox gratuit) et ajoutez la clé API dans .env.',
    };
  }

  if (!fs.existsSync(diskPath)) {
    throw new Error('Fichier introuvable pour la signature électronique.');
  }

  const ext = path.extname(fileName).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error('Yousign requiert un document PDF pour la signature eIDAS.');
  }

  const request = await apiRequest('POST', '/signature_requests', {
    json: {
      name: documentName || fileName,
      delivery_mode: 'email',
      timezone: 'Europe/Paris',
    },
  });

  const requestId = request.id;
  const buffer = fs.readFileSync(diskPath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
  form.append('nature', 'signable_document');

  const doc = await apiRequest('POST', `/signature_requests/${requestId}/documents`, {
    formData: form,
  });

  const documentId = doc.id;
  const level = signatureLevel();
  const authMode = process.env.YOUSIGN_AUTH_MODE || 'otp_email';

  const signerBody = {
    info: {
      first_name: signer.firstName,
      last_name: signer.lastName,
      email: signer.email,
      phone_number: signer.phone || undefined,
      locale: 'fr',
    },
    signature_level: level,
    signature_authentication_mode: authMode,
    fields: [
      {
        document_id: documentId,
        type: 'signature',
        page: 1,
        width: 180,
        height: 60,
        x: 400,
        y: 650,
      },
    ],
  };

  const signerRes = await apiRequest('POST', `/signature_requests/${requestId}/signers`, {
    json: signerBody,
  });

  const activated = await apiRequest('POST', `/signature_requests/${requestId}/activate`, {
    json: {},
  });

  const activatedSigner = (activated.signers || []).find((s) => s.id === signerRes.id)
    || activated.signers?.[0]
    || signerRes;

  return {
    provider: 'yousign',
    mode: 'live',
    requestId,
    signerId: signerRes.id,
    documentId,
    signatureLink: activatedSigner.signature_link || signerRes.signature_link || null,
    level,
    status: activated.status || 'ongoing',
  };
}

async function fetchSignatureRequest(requestId) {
  if (!isConfigured() || !requestId) return null;
  try {
    return await apiRequest('GET', `/signature_requests/${requestId}`);
  } catch {
    return null;
  }
}

function mapYousignStatusToLocal(yousignStatus) {
  const s = (yousignStatus || '').toLowerCase();
  if (s === 'done' || s === 'signed') return 'signed';
  if (s === 'ongoing' || s === 'pending' || s === 'active') return 'pending';
  if (s === 'declined' || s === 'refused') return 'declined';
  if (s === 'expired' || s === 'canceled' || s === 'cancelled') return 'expired';
  if (s === 'draft') return 'initiated';
  return 'pending';
}

module.exports = {
  isConfigured,
  signatureLevel,
  createSignatureProcedure,
  fetchSignatureRequest,
  mapYousignStatusToLocal,
  PROVIDER_NAME: 'Yousign',
  PROVIDER_URL: 'https://yousign.com',
};
