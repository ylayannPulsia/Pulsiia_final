// security-api.js — 2FA, mot de passe, sessions
(function () {
  'use strict';

  async function loadSettingsSecurity() {
    const body = document.getElementById('settings-2fa-body');
    const btn2fa = document.getElementById('settings-2fa-btn');
    if (!body || typeof api.twoFactorStatus !== 'function') {
      if (body) body.textContent = 'Connectez-vous pour gérer la sécurité du compte.';
      return;
    }
    try {
      const res = await api.twoFactorStatus();
      body.innerHTML = res.enabled
        ? '<span style="color:var(--green);font-weight:600">✓ Double authentification activée</span>'
        : '<span style="color:var(--text-3)">Double authentification désactivée — recommandée pour les comptes DRH/RH.</span>';
      if (btn2fa) {
        btn2fa.textContent = res.enabled
          ? '🛡️ Désactiver la double authentification'
          : '🛡️ Activer la double authentification';
      }
    } catch (err) {
      body.innerHTML = '<span style="color:var(--red)">' + (err.error || err.message || 'Erreur') + '</span>';
    }
  }

  window.changePassword = function changePassword() {
    const existing = document.getElementById('modal-change-password');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    modal.id = 'modal-change-password';
    modal.style.zIndex = '500';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:400px">
        <div class="modal-header">
          <div class="modal-title">Changer le mot de passe</div>
          <div class="modal-header-close" onclick="document.getElementById('modal-change-password').remove()">✕</div>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Mot de passe actuel</label>
            <input type="password" class="form-input" id="pwd-current" placeholder="••••••••" autocomplete="current-password">
          </div>
          <div class="form-group">
            <label class="form-label">Nouveau mot de passe</label>
            <input type="password" class="form-input" id="pwd-new" placeholder="Min. 8 caractères" autocomplete="new-password">
          </div>
          <div class="form-group">
            <label class="form-label">Confirmer</label>
            <input type="password" class="form-input" id="pwd-confirm" placeholder="••••••••" autocomplete="new-password">
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" onclick="document.getElementById('modal-change-password').remove()">Annuler</button>
          <button type="button" class="btn btn-primary" id="pwd-submit-btn" onclick="confirmChangePassword(this)">Modifier le mot de passe</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });

    const submit = function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('pwd-submit-btn')?.click();
      }
    };
    modal.querySelectorAll('input').forEach(function (input) {
      input.addEventListener('keydown', submit);
    });
    document.getElementById('pwd-current')?.focus();
  };

  function qrImgUrl(otpauthUrl) {
    return 'https://quickchart.io/qr?size=180&margin=1&text=' + encodeURIComponent(otpauthUrl);
  }

  function open2FAModal(mode, setupData) {
    const existing = document.getElementById('modal-2fa');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    modal.id = 'modal-2fa';
    modal.style.zIndex = '500';

    if (mode === 'enable') {
      modal.innerHTML = `
        <div class="modal-box" style="max-width:420px">
          <div class="modal-header">
            <div class="modal-title">Activer la 2FA</div>
            <div class="modal-header-close" onclick="document.getElementById('modal-2fa').remove()">✕</div>
          </div>
          <div class="modal-body">
            <p style="font-size:13px;color:var(--text-2);margin-bottom:14px">Scannez ce QR code avec Google Authenticator, Authy ou une app TOTP compatible.</p>
            <div style="text-align:center;margin-bottom:14px">
              <img src="${qrImgUrl(setupData.otpauthUrl)}" alt="QR code 2FA" width="180" height="180" style="border-radius:8px;border:1px solid var(--border)">
            </div>
            <p style="font-size:11px;color:var(--text-3);word-break:break-all;margin-bottom:14px">Clé manuelle : <code>${setupData.secret}</code></p>
            <div class="form-group">
              <label class="form-label">Code à 6 chiffres</label>
              <input class="form-input" id="2fa-enable-code" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="one-time-code">
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="document.getElementById('modal-2fa').remove()">Annuler</button>
            <button class="btn btn-primary" onclick="confirmEnable2FA()">Activer</button>
          </div>
        </div>`;
    } else {
      modal.innerHTML = `
        <div class="modal-box" style="max-width:400px">
          <div class="modal-header">
            <div class="modal-title">Désactiver la 2FA</div>
            <div class="modal-header-close" onclick="document.getElementById('modal-2fa').remove()">✕</div>
          </div>
          <div class="modal-body">
            <div class="form-group"><label class="form-label">Mot de passe</label><input type="password" class="form-input" id="2fa-disable-pwd"></div>
            <div class="form-group"><label class="form-label">Code 2FA</label><input class="form-input" id="2fa-disable-code" inputmode="numeric" maxlength="6"></div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="document.getElementById('modal-2fa').remove()">Annuler</button>
            <button class="btn btn-primary" style="background:var(--red)" onclick="confirmDisable2FA()">Désactiver</button>
          </div>
        </div>`;
    }

    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
  }

  window.toggle2FA = async function () {
    if (typeof api.twoFactorStatus !== 'function') {
      if (typeof showToast === 'function') showToast('API non disponible');
      return;
    }
    try {
      const status = await api.twoFactorStatus();
      if (status.enabled) {
        open2FAModal('disable');
        return;
      }
      const setup = await api.twoFactorSetup();
      open2FAModal('enable', setup);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur');
    }
  };

  window.confirmEnable2FA = async function () {
    const code = document.getElementById('2fa-enable-code')?.value.trim();
    if (!code) return showToast?.('Saisissez le code à 6 chiffres');
    try {
      const res = await api.twoFactorEnable(code);
      document.getElementById('modal-2fa')?.remove();
      if (typeof showToast === 'function') showToast(res.message || '2FA activée');
      loadSettingsSecurity();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Code incorrect');
    }
  };

  window.confirmDisable2FA = async function () {
    const password = document.getElementById('2fa-disable-pwd')?.value;
    const code = document.getElementById('2fa-disable-code')?.value.trim();
    if (!password || !code) return showToast?.('Mot de passe et code requis');
    try {
      const res = await api.twoFactorDisable(password, code);
      document.getElementById('modal-2fa')?.remove();
      if (typeof showToast === 'function') showToast(res.message || '2FA désactivée');
      loadSettingsSecurity();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  };

  window.confirmChangePassword = async function (btn) {
    const curr = document.getElementById('pwd-current')?.value;
    const next = document.getElementById('pwd-new')?.value;
    const conf = document.getElementById('pwd-confirm')?.value;
    if (!curr || !next || !conf) return showToast?.('⚠️ Tous les champs sont obligatoires');
    if (next.length < 8) return showToast?.('⚠️ Le mot de passe doit faire au moins 8 caractères');
    if (next !== conf) return showToast?.('⚠️ Les mots de passe ne correspondent pas');
    if (btn) { btn.disabled = true; btn.textContent = 'Enregistrement…'; }
    try {
      const res = typeof api.changePassword === 'function'
        ? await api.changePassword(curr, next)
        : null;
      btn?.closest('.modal-overlay')?.remove();
      if (typeof showToast === 'function') showToast(res?.message || '✅ Mot de passe modifié');
      if (typeof Auth !== 'undefined') Auth.clear?.();
      setTimeout(function () { window.location.href = '/login.html'; }, 1500);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
      if (btn) { btn.disabled = false; btn.textContent = 'Modifier le mot de passe'; }
    }
  };

  window.disconnectAllSessions = async function () {
    if (!confirm('Déconnecter tous les appareils ? Vous devrez vous reconnecter.')) return;
    try {
      if (typeof api.revokeSessions === 'function') await api.revokeSessions();
      if (typeof Auth !== 'undefined') Auth.clear?.();
      if (typeof showToast === 'function') showToast('Sessions déconnectées — redirection…');
      setTimeout(function () { window.location.href = '/login.html'; }, 1200);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  };

  window.loadSettingsSecurity = loadSettingsSecurity;
})();
