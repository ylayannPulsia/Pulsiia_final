// rgpd-api.js — RGPD (consentements, export, suppression) + profil
(function () {
  'use strict';

  function apiBase() {
    return (window.__PULSIIA_CONFIG__ && window.__PULSIIA_CONFIG__.apiUrl) || 'http://localhost:3001';
  }

  async function loadRgpdPanel(containerId) {
    const body = document.getElementById(containerId || 'params-rgpd-body');
    if (!body || typeof api.rgpdConsents !== 'function') return;

    try {
      const [consentsRes, deletionRes] = await Promise.all([
        api.rgpdConsents(),
        api.rgpdDeletionStatus(),
      ]);

      const consents = consentsRes.consents || [];
      const deletion = deletionRes.request;

      const consentHtml = consents.map(function (c) {
        const checked = c.accepted ? ' checked' : '';
        return `<label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;cursor:pointer">
          <input type="checkbox"${checked} onchange="toggleRgpdConsent('${c.type}', this.checked)">
          <span>${c.type === 'terms' ? 'CGU' : c.type === 'privacy' ? 'Politique de confidentialité' : c.type === 'push' ? 'Notifications push' : 'Analytics'} (v${c.version})</span>
        </label>`;
      }).join('');

      let deletionHtml = '';
      if (deletion && deletion.status === 'PENDING') {
        const d = new Date(deletion.scheduledAt);
        deletionHtml = `<div style="margin-top:12px;padding:10px;background:#FEF2F2;border-radius:8px;font-size:12px;color:#B91C1C">
          Suppression prévue le ${d.toLocaleDateString('fr-FR')}
          <button type="button" class="btn btn-ghost" style="margin-top:8px;padding:4px 10px;font-size:12px" onclick="cancelRgpdDeletion()">Annuler la demande</button>
        </div>`;
      }

      body.innerHTML = `
        <div style="margin-bottom:14px">${consentHtml}</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button type="button" class="btn btn-ghost" style="justify-content:flex-start" onclick="exportRgpdData()">↓ Télécharger mes données</button>
          <button type="button" class="btn btn-ghost" style="justify-content:flex-start;color:var(--red)" onclick="requestRgpdDeletion()">Demander la suppression du compte</button>
        </div>
        ${deletionHtml}
        <p style="font-size:11px;color:var(--text-3);margin-top:12px">Conservation : ${consentsRes.dataRetentionDays || 730} jours · Export valable 7 jours.</p>`;
    } catch (err) {
      body.innerHTML = `<span style="color:var(--red)">${err.error || err.message || 'Erreur'}</span>`;
    }
  }

  function reloadAllRgpdPanels() {
    loadRgpdPanel('params-rgpd-body');
    loadRgpdPanel('settings-rgpd-body');
  }

  window.toggleRgpdConsent = async function (type, accepted) {
    try {
      await api.rgpdSetConsent(type, accepted);
      if (typeof showToast === 'function') showToast('Préférence enregistrée');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
      reloadAllRgpdPanels();
    }
  };

  window.exportRgpdData = async function () {
    try {
      const res = await api.rgpdExportData();
      const url = apiBase() + (res.downloadUrl || '');
      const headers = {};
      if (typeof Auth !== 'undefined' && Auth.accessToken) {
        headers.Authorization = 'Bearer ' + Auth.accessToken;
      }
      const response = await fetch(url, { headers });
      if (!response.ok) throw new Error('Téléchargement impossible');
      const blob = await response.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pulsiia-export.json';
      a.click();
      URL.revokeObjectURL(a.href);
      if (typeof showToast === 'function') showToast(res.message || 'Export téléchargé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || err.error || 'Erreur export');
    }
  };

  window.requestRgpdDeletion = async function () {
    if (!confirm('Demander la suppression de votre compte ? Délai de 30 jours avant effacement.')) return;
    const reason = prompt('Motif (optionnel) :') || undefined;
    try {
      const res = await api.rgpdRequestDeletion(reason);
      if (typeof showToast === 'function') showToast(res.message || 'Demande enregistrée');
      reloadAllRgpdPanels();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  };

  window.cancelRgpdDeletion = async function () {
    try {
      await api.rgpdCancelDeletion();
      if (typeof showToast === 'function') showToast('Demande annulée');
      reloadAllRgpdPanels();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  };

  function loadMesParamsRgpd() {
    return loadRgpdPanel('params-rgpd-body');
  }

  window.loadRgpdPanel = loadRgpdPanel;
  window.loadMesParamsRgpd = loadMesParamsRgpd;
})();
