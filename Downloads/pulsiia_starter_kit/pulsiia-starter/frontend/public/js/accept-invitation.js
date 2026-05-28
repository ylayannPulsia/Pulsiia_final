(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const intro = document.getElementById('intro');
  const badge = document.getElementById('company-badge');
  const acceptBtn = document.getElementById('accept-btn');
  const loginLink = document.getElementById('login-link');
  const messageEl = document.getElementById('message');

  function apiBase() {
    return (window.__PULSIIA_CONFIG__ && window.__PULSIIA_CONFIG__.apiUrl) || 'http://localhost:3001';
  }

  function showMsg(text, type) {
    messageEl.textContent = text;
    messageEl.className = 'msg is-visible ' + (type || 'info');
  }

  if (!token) {
    intro.textContent = 'Lien d\'invitation invalide.';
    showMsg('Demandez un nouveau lien à votre service RH.', 'error');
    return;
  }

  async function loadInvitation() {
    try {
      const res = await fetch(apiBase() + '/api/auth/invitation?token=' + encodeURIComponent(token));
      const data = await res.json();
      if (!res.ok) {
        intro.textContent = data.error || 'Invitation introuvable.';
        showMsg('Ce lien n\'est plus valide.', 'error');
        return;
      }

      const inv = data.invitation;
      if (!data.valid) {
        intro.textContent = 'Cette invitation n\'est plus valide.';
        showMsg(data.reason === 'expired'
          ? 'Le lien a expiré — demandez une nouvelle invitation.'
          : 'L\'invitation a déjà été utilisée ou annulée.', 'error');
        loginLink.style.display = '';
        loginLink.href = '/login.html';
        return;
      }

      intro.textContent = 'Bonjour ' + (inv.firstName || '') + ', vous êtes invité(e) à rejoindre :';
      badge.textContent = inv.companyName || 'Nouvelle entreprise';
      badge.style.display = 'inline-block';
      acceptBtn.style.display = '';
      loginLink.style.display = '';
      loginLink.href = '/login.html?next=' + encodeURIComponent('/accept-invitation.html?token=' + token);

      if (window.Auth && window.Auth.isAuthenticated()) {
        showMsg('Connecté — cliquez pour rejoindre cette entreprise.', 'info');
      } else {
        showMsg('Utilisez votre e-mail et mot de passe Pulsiia existants. Vous pouvez vous connecter puis accepter.', 'info');
      }
    } catch {
      intro.textContent = 'Impossible de charger l\'invitation.';
      showMsg('Vérifiez votre connexion et réessayez.', 'error');
    }
  }

  async function accept() {
    acceptBtn.disabled = true;
    acceptBtn.textContent = 'Traitement…';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (window.Auth && window.Auth.accessToken) {
        headers.Authorization = 'Bearer ' + window.Auth.accessToken;
      }
      const res = await fetch(apiBase() + '/api/auth/accept-invitation', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token }),
      });
      const data = await res.json();

      if (res.ok && data.accessToken) {
        sessionStorage.setItem('access_token', data.accessToken);
        localStorage.setItem('refresh_token', data.refreshToken);
        localStorage.setItem('user', JSON.stringify(data.user));
        if (window.Auth) {
          window.Auth.accessToken = data.accessToken;
          window.Auth.refreshToken = data.refreshToken;
          window.Auth.user = data.user;
        }
        showMsg('Bienvenue chez ' + (data.user?.companyName || 'votre entreprise') + ' !', 'success');
        setTimeout(function () { window.location.href = '/dashboard'; }, 800);
        return;
      }

      if (res.ok) {
        showMsg(data.message || 'Invitation acceptée.', 'success');
        acceptBtn.style.display = 'none';
        loginLink.textContent = 'Se connecter';
        loginLink.classList.remove('btn-ghost');
        loginLink.style.background = '#5B5BF7';
        loginLink.style.color = '#fff';
        loginLink.style.border = 'none';
        return;
      }

      if (res.status === 403) {
        showMsg(data.error || 'Connectez-vous avec le bon compte.', 'error');
        loginLink.style.display = '';
        return;
      }

      showMsg(data.error || 'Erreur lors de l\'acceptation.', 'error');
    } catch {
      showMsg('Impossible de contacter le serveur.', 'error');
    } finally {
      acceptBtn.disabled = false;
      acceptBtn.textContent = 'Accepter l\'invitation';
    }
  }

  acceptBtn.addEventListener('click', accept);
  loadInvitation();
})();
