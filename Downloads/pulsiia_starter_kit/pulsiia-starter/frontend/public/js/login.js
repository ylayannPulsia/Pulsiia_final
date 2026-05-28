// Gestion connexion — fichier externe (évite blocage des scripts inline)
(function () {
  const DASHBOARD_PATH = '/dashboard';

  const form = document.getElementById('login-form');
  const btn = document.getElementById('submit-btn');
  const errorEl = document.getElementById('error');
  const forgotLink = document.getElementById('forgot-link');

  if (!form || !btn || !errorEl) return;

  const btnLabel = btn.querySelector('.btn-label');

  function apiBaseUrl() {
    return (window.__PULSIIA_CONFIG__ && window.__PULSIIA_CONFIG__.apiUrl) || 'http://localhost:3001';
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.classList.add('is-visible');
  }

  function hideError() {
    errorEl.textContent = '';
    errorEl.classList.remove('is-visible');
  }

  function setLoading(loading) {
    btn.disabled = loading;
    btn.classList.toggle('is-loading', loading);
    if (btnLabel) btnLabel.textContent = loading ? (pending2FA ? 'Validation…' : 'Connexion…') : (pending2FA ? 'Valider le code' : 'Se connecter');
    btn.setAttribute('aria-busy', loading ? 'true' : 'false');
  }

  function formatApiError(err) {
    if (!err) return 'Connexion impossible';
    if (err.status === 0) return err.message || 'Erreur réseau — lancez le backend : cd backend && npm run dev (port 3001)';
    if (err.status === 503) return err.error || 'Base de données indisponible — lancez PostgreSQL (docker compose up -d postgres).';
    if (err.status === 429) return err.error || 'Trop de tentatives. Réessayez plus tard.';
    if (err.error) return err.error;
    if (Array.isArray(err.errors) && err.errors[0] && err.errors[0].msg) return err.errors[0].msg;
    return err.message || 'Connexion impossible';
  }

  function fetchWithTimeout(url, options, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms || 15000);
    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
      .finally(function () { clearTimeout(timer); });
  }

  function postLoginTarget() {
    const next = new URLSearchParams(window.location.search).get('next');
    if (!next || !next.startsWith('/') || next.startsWith('//')) return DASHBOARD_PATH;
    if (next === '/' || next === '/login.html') return DASHBOARD_PATH;
    return next;
  }

  function storeSession(data) {
    sessionStorage.setItem('access_token', data.accessToken);
    localStorage.setItem('refresh_token', data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    if (window.Auth) {
      window.Auth.accessToken = data.accessToken;
      window.Auth.refreshToken = data.refreshToken;
      window.Auth.user = data.user;
    }
  }

  var pending2FA = null;
  var pendingCompanySelect = null;

  function show2FAStep(challengeToken, message) {
    pending2FA = challengeToken;
    var twofaField = document.getElementById('twofa-field');
    var twofaInput = document.getElementById('twofa-code');
    var passwordInput = document.getElementById('password');
    if (twofaField) twofaField.style.display = '';
    if (passwordInput) passwordInput.disabled = true;
    if (twofaInput) {
      twofaInput.focus();
      twofaInput.value = '';
    }
    if (btnLabel) btnLabel.textContent = 'Valider le code';
    if (message) showError(message);
    errorEl.style.background = '#EFF6FF';
    errorEl.style.color = '#1D4ED8';
    setLoading(false);
  }

  function showCompanyStep(selectionToken, companies, message) {
    pendingCompanySelect = { selectionToken: selectionToken, companies: companies };
    var companyField = document.getElementById('company-field');
    var companySelect = document.getElementById('company-select');
    var passwordInput = document.getElementById('password');
    if (companyField) companyField.style.display = '';
    if (passwordInput) passwordInput.disabled = true;
    if (companySelect) {
      companySelect.innerHTML = '';
      (companies || []).forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.userId;
        opt.textContent = (c.companyName || 'Entreprise') + ' — ' + (c.firstName || '') + ' ' + (c.lastName || '');
        companySelect.appendChild(opt);
      });
    }
    if (btnLabel) btnLabel.textContent = 'Continuer';
    if (message) showError(message);
    errorEl.style.background = '#EFF6FF';
    errorEl.style.color = '#1D4ED8';
    setLoading(false);
  }

  function resetCompanyStep() {
    pendingCompanySelect = null;
    var companyField = document.getElementById('company-field');
    var passwordInput = document.getElementById('password');
    if (companyField) companyField.style.display = 'none';
    if (passwordInput) passwordInput.disabled = false;
    if (btnLabel && !pending2FA) btnLabel.textContent = 'Se connecter';
    errorEl.style.background = '';
    errorEl.style.color = '';
  }

  function reset2FAStep() {
    pending2FA = null;
    var twofaField = document.getElementById('twofa-field');
    var passwordInput = document.getElementById('password');
    if (twofaField) twofaField.style.display = 'none';
    if (passwordInput) passwordInput.disabled = false;
    if (btnLabel) btnLabel.textContent = 'Se connecter';
    errorEl.style.background = '';
    errorEl.style.color = '';
  }

  function hasApiClient() {
    return typeof window.api !== 'undefined' && typeof window.api.login === 'function';
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-pulsiia-src="' + src + '"]');
      if (existing && existing.dataset.loaded === '1') {
        resolve();
        return;
      }
      var el = document.createElement('script');
      el.src = src;
      el.dataset.pulsiiaSrc = src;
      el.onload = function () {
        el.dataset.loaded = '1';
        resolve();
      };
      el.onerror = function () {
        reject(new Error(src));
      };
      document.head.appendChild(el);
    });
  }

  async function ensureApiClient() {
    if (hasApiClient()) return true;

    try {
      await loadScript('/js/pulsiia-client.js');
    } catch {
      /* rechargement dynamique échoué */
    }

    return hasApiClient();
  }

  async function loginDirect(email, password) {
    var response;
    try {
      response = await fetchWithTimeout(apiBaseUrl() + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, password: password }),
      }, 15000);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw {
          status: 0,
          message: 'Délai dépassé — vérifiez que PostgreSQL tourne (docker compose up -d postgres) et que le backend répond.',
        };
      }
      throw {
        status: 0,
        message: 'Impossible de joindre l’API sur ' + apiBaseUrl() + ' — vérifiez : cd backend && npm run dev',
      };
    }

    var data = await response.json().catch(function () {
      return {};
    });

    if (!response.ok) {
      throw {
        status: response.status,
        error: data.error || (Array.isArray(data.errors) && data.errors[0] && data.errors[0].msg) || 'Connexion refusée',
      };
    }

    if (data.requires2FA) {
      throw {
        requires2FA: true,
        challengeToken: data.challengeToken,
        message: data.message || 'Code d\'authentification requis.',
      };
    }

    if (data.requiresCompanySelection) {
      throw {
        requiresCompanySelection: true,
        selectionToken: data.selectionToken,
        companies: data.companies || [],
        message: data.message || 'Choisissez votre entreprise.',
      };
    }

    storeSession(data);
    return data.user;
  }

  async function selectCompanyDirect(selectionToken, userId) {
    var response = await fetchWithTimeout(apiBaseUrl() + '/api/auth/select-company', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectionToken: selectionToken, userId: userId }),
    }, 15000);
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw { status: response.status, error: data.error || 'Sélection refusée' };
    }
    if (data.requires2FA) {
      throw {
        requires2FA: true,
        challengeToken: data.challengeToken,
        message: data.message,
      };
    }
    storeSession(data);
    return data.user;
  }

  async function verify2FADirect(challengeToken, code) {
    var response = await fetch(apiBaseUrl() + '/api/auth/2fa/verify-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challengeToken, code: code }),
    });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw { status: response.status, error: data.error || 'Code incorrect.' };
    }
    storeSession(data);
    return data.user;
  }

  async function handleLogin() {
    hideError();

    var emailInput = document.getElementById('email');
    var passwordInput = document.getElementById('password');
    var twofaInput = document.getElementById('twofa-code');
    var email = emailInput ? emailInput.value.trim() : '';
    var password = passwordInput ? passwordInput.value : '';
    var twofaCode = twofaInput ? twofaInput.value.trim() : '';

    if (pendingCompanySelect) {
      var companySelect = document.getElementById('company-select');
      var userId = companySelect ? companySelect.value : '';
      if (!userId) {
        showError('Sélectionnez une entreprise.');
        return;
      }
      setLoading(true);
      try {
        await ensureApiClient();
        if (hasApiClient() && typeof window.api.selectCompany === 'function') {
          await window.api.selectCompany(pendingCompanySelect.selectionToken, userId);
        } else {
          await selectCompanyDirect(pendingCompanySelect.selectionToken, userId);
        }
        window.location.assign(postLoginTarget());
      } catch (err) {
        if (err.requires2FA) {
          resetCompanyStep();
          show2FAStep(err.challengeToken, err.message);
          return;
        }
        showError(formatApiError(err));
        setLoading(false);
      }
      return;
    }

    if (pending2FA) {
      if (!twofaCode) {
        showError('Saisissez le code à 6 chiffres.');
        return;
      }
      setLoading(true);
      try {
        await ensureApiClient();
        if (hasApiClient() && typeof window.api.verify2FALogin === 'function') {
          await window.api.verify2FALogin(pending2FA, twofaCode);
        } else {
          await verify2FADirect(pending2FA, twofaCode);
        }
        window.location.assign(postLoginTarget());
      } catch (err) {
        showError(formatApiError(err));
        setLoading(false);
      }
      return;
    }

    if (!email || !password) {
      showError('Email et mot de passe requis.');
      return;
    }

    setLoading(true);

    try {
      await ensureApiClient();
      if (hasApiClient()) {
        await window.api.login(email, password);
      } else {
        await loginDirect(email, password);
      }
      window.location.assign(postLoginTarget());
    } catch (err) {
      if (err.requires2FA) {
        show2FAStep(err.challengeToken, err.message);
        return;
      }
      if (err.requiresCompanySelection) {
        showCompanyStep(err.selectionToken, err.companies, err.message);
        return;
      }
      showError(formatApiError(err));
      reset2FAStep();
      resetCompanyStep();
      setLoading(false);
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    e.stopPropagation();
    handleLogin();
  });

  btn.addEventListener('click', function (e) {
    e.preventDefault();
    handleLogin();
  });

  if (forgotLink) {
    forgotLink.addEventListener('click', function (e) {
      e.preventDefault();
      hideError();
      var emailInput = document.getElementById('email');
      var email = emailInput ? emailInput.value.trim() : '';
      if (!email) {
        showError('Saisissez votre e-mail ci-dessus, puis cliquez sur « Mot de passe oublié ».');
        if (emailInput) emailInput.focus();
        return;
      }
      setLoading(true);
      fetch(apiBaseUrl() + '/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email }),
      }).then(function (res) { return res.json(); }).then(function (data) {
        showError(data.message || 'Si un compte existe, un e-mail a été envoyé.');
        errorEl.style.background = '#ECFDF5';
        errorEl.style.color = '#065F46';
      }).catch(function () {
        showError('Impossible de contacter le serveur.');
      }).finally(function () {
        setLoading(false);
      });
    });
  }

  var clientScript = document.getElementById('pulsiia-client-script');
  if (clientScript) {
    clientScript.addEventListener('load', function () {
      clientScript.dataset.loaded = '1';
    });
    clientScript.addEventListener('error', function () {
      clientScript.dataset.loaded = '0';
    });
  }

  if (window.Auth && window.Auth.isAuthenticated()) {
    (async function redirectIfSessionValid() {
      try {
        if (typeof window.api?.me === 'function') {
          await Promise.race([
            window.api.me(),
            new Promise(function (_, reject) {
              setTimeout(function () {
                reject({ status: 0, message: 'Session en cours de vérification — reconnexion…' });
              }, 15000);
            }),
          ]);
        }
        window.location.replace(postLoginTarget());
      } catch (err) {
        if (err?.status === 401 || err?.status === 403 || err?.status === 0) {
          window.Auth.clear();
        }
      }
    })();
    return;
  }

  if (window.location.protocol === 'file:') {
    showError('Ouvrez http://localhost:3000 dans le navigateur (npm run dev dans le dossier frontend).');
    return;
  }

  if (!window.location.port || (window.location.port !== '3000' && window.location.hostname === 'localhost')) {
    showError('URL incorrecte : utilisez exactement http://localhost:3000 (frontend sur le port 3000).');
  }

  if (!hasApiClient()) {
    ensureApiClient();
  }
})();
