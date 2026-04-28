/**
 * Pulsiia — pages.js
 * Connecte l'UI de Maquettes.html au backend via PulsiiaAPI.
 * Chargé en `defer` → tous les scripts inline sont déjà exécutés.
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 1 — Sidebar mobile (injection dynamique, pas de modif HTML)
  // ─────────────────────────────────────────────────────────────────────────────

  function initMobileSidebar() {
    // Overlay arrière
    var overlay = document.createElement('div');
    overlay.id = 'pls-overlay';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:199';
    overlay.onclick = closeSidebar;
    document.body.appendChild(overlay);

    // Bouton hamburger
    var topbar = document.querySelector('.topbar');
    if (topbar) {
      var ham = document.createElement('button');
      ham.id  = 'pls-ham';
      ham.title = 'Menu';
      ham.innerHTML = '☰';
      ham.style.cssText = [
        'display:none;width:36px;height:36px;border:1px solid #E5E7EB',
        'border-radius:8px;background:white;cursor:pointer;font-size:18px',
        'align-items:center;justify-content:center;margin-right:8px;flex-shrink:0;color:#6B7280',
      ].join(';');
      ham.onclick = toggleSidebar;
      topbar.insertBefore(ham, topbar.firstChild);
    }

    // CSS responsive
    var style = document.createElement('style');
    style.textContent = [
      '@media(max-width:900px){',
      '  #pls-ham{display:flex!important}',
      '  .sidebar{position:fixed!important;left:-260px!important;top:0;bottom:0;z-index:200;transition:left .25s ease;height:100vh!important}',
      '  .sidebar.pls-open{left:0!important;box-shadow:4px 0 24px rgba(0,0,0,.3)}',
      '  .main{width:100%!important}',
      '  .content{padding:16px!important}',
      '  .topbar{padding:0 12px!important;position:sticky;top:0;z-index:100}',
      '  .kpi-grid{grid-template-columns:repeat(2,1fr)!important;gap:10px!important}',
      '  .modal{width:95vw!important;max-width:95vw!important;padding:20px!important}',
      '  .table-wrap{overflow-x:auto}',
      '}',
    ].join('');
    document.head.appendChild(style);

    // Fermer sur clic nav (mobile)
    document.querySelectorAll('.nav-item').forEach(function (el) {
      el.addEventListener('click', function () {
        if (window.innerWidth <= 900) closeSidebar();
      });
    });
  }

  function toggleSidebar() {
    var sb = document.querySelector('.sidebar');
    var ov = document.getElementById('pls-overlay');
    if (!sb) return;
    var open = sb.classList.contains('pls-open');
    sb.classList.toggle('pls-open', !open);
    if (ov) ov.style.display = open ? 'none' : 'block';
  }

  function closeSidebar() {
    var sb = document.querySelector('.sidebar');
    var ov = document.getElementById('pls-overlay');
    if (sb) sb.classList.remove('pls-open');
    if (ov) ov.style.display = 'none';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 2 — Initialisation principale
  // ─────────────────────────────────────────────────────────────────────────────

  function init() {
    initMobileSidebar();

    var API = window.PulsiiaAPI;
    if (!API) {
      // Pas de backend → mode démo statique (les boutons inline Maquettes.html fonctionnent)
      return;
    }

    // Afficher les infos utilisateur dans la sidebar
    var user = window.PulsiiaUser ? window.PulsiiaUser() : null;
    if (user) {
      renderUserInfo(user);
    } else {
      API.auth.me().then(function (res) {
        if (!res || !res.ok) return;
        return res.json().then(function (u) {
          localStorage.setItem('pulsiia_user', JSON.stringify(u));
          renderUserInfo(u);
        });
      }).catch(noop);
    }

    // Logout sur clic carte utilisateur sidebar
    var userCard = document.getElementById('sidebar-user-card');
    if (userCard && !userCard._pls) {
      userCard._pls = true;
      userCard.style.cursor = 'pointer';
      userCard.title = 'Se déconnecter';
      userCard.addEventListener('click', function () {
        if (confirm('Se déconnecter ?')) API.auth.logout();
      });
    }

    // Chargement initial du dashboard
    loadKpis(API);
    loadNotifBadge(API);

    // Hook sur showPage (non-destructif)
    hookShowPage(API);

    // Câbler tous les boutons d'action
    wireButtons(API);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 3 — Infos utilisateur
  // ─────────────────────────────────────────────────────────────────────────────

  function renderUserInfo(u) {
    var nameEl   = document.getElementById('sidebar-user-name');
    var roleEl   = document.getElementById('sidebar-user-role');
    var avatarEl = document.getElementById('sidebar-avatar');
    if (nameEl)   nameEl.textContent   = u.prenom + ' ' + u.nom;
    if (roleEl)   roleEl.textContent   = (u.role === 'RH' ? 'DRH' : u.role) + ' · ' + (u.siteNom || (u.site && u.site.nom) || 'Siège');
    if (avatarEl) avatarEl.textContent = ((u.prenom || 'P')[0] + (u.nom || 'U')[0]).toUpperCase();
    var greet = document.querySelector('#page-dashboard h2');
    if (greet) greet.textContent = 'Bonjour, ' + u.prenom + ' 👋';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 4 — Hook showPage
  // ─────────────────────────────────────────────────────────────────────────────

  function hookShowPage(API) {
    var orig = window.showPage;
    if (typeof orig !== 'function') return;

    window.showPage = function (name, navEl) {
      // Toujours appeler l'original en premier
      try { orig.call(this, name, navEl); } catch (e) { console.warn('[Pulsiia] showPage:', e); }
      // Charger les données API en arrière-plan
      setTimeout(function () { loadPageData(API, name); }, 0);
    };
  }

  function loadPageData(API, page) {
    try {
      if (page === 'dashboard' || page === 'accueil-collab') { loadKpis(API); loadNotifBadge(API); return; }
      if (page === 'absences')       return loadAbsences(API);
      if (page === 'prepaie')        return loadPrepaie(API);
      if (page === 'planning' || page === 'mon-planning') return loadPlanning(API);
      if (page === 'documents' || page === 'mes-docs')    return loadDocuments(API);
      if (page === 'communication')  return loadCommunication(API);
      if (page === 'collaborateurs') return loadCollaborateurs(API);
      if (page === 'bienetre' || page === 'qcm') return loadQcm(API);
      if (page === 'notifications')  return loadNotifications(API);
    } catch (e) { console.warn('[Pulsiia] loadPageData:', page, e); }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 5 — Loaders par page
  // ─────────────────────────────────────────────────────────────────────────────

  function loadKpis(API) {
    API.dashboard.kpis().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (k) {
        setBadge('badge-prepaie',  k.variablesAValider);
        setBadge('badge-planning', k.shiftsDecouverts);
      });
    }).catch(noop);
  }

  function loadNotifBadge(API) {
    API.notifications.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (d) { setBadge('notif-count', d.unread); });
    }).catch(noop);
  }

  // Mappings statuts / types
  var TYPE_L = { MALADIE:'Maladie', CONGES_PAYES:'Congé payé', RTT:'RTT', EVENEMENT_FAMILIAL:'Évènement familial', SANS_SOLDE:'Sans solde' };
  var ABS_S  = { EN_ATTENTE:'En attente', APPROUVE:'Validé', REFUSE:'Refusé' };
  var PP_S   = { A_VALIDER:'À valider', VALIDE:'Validé', ANOMALIE:'Anomalie IA' };
  var TYPE_A = { 'Maladie':'MALADIE','Congé payé':'CONGES_PAYES','RTT':'RTT','Accident travail':'MALADIE','Évènement familial':'EVENEMENT_FAMILIAL','Sans solde':'SANS_SOLDE' };

  function mapAbs(a) {
    return {
      id: a.id,
      collab: a.user ? a.user.prenom + ' ' + a.user.nom[0] + '.' : '—',
      type: TYPE_L[a.type] || a.type,
      start: a.dateDebut, end: a.dateFin,
      status: ABS_S[a.statut] || a.statut,
      comment: a.motif || '',
      pj: null, refuseReason: null, refuseMsg: null,
    };
  }

  function mapPP(v) {
    return {
      id: v.id,
      collab: v.user ? v.user.prenom + ' ' + v.user.nom[0] + '.' : '—',
      site:   v.user && v.user.site ? v.user.site.nom : '—',
      type:   v.type,
      value:  '+' + v.montant + '€',
      source: 'Planning auto',
      status: PP_S[v.statut] || v.statut,
      anomaly: v.anomalie || null,
    };
  }

  function loadAbsences(API) {
    API.absences.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) {
        window.absences = data.map(mapAbs);
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
      });
    }).catch(noop);
  }

  function loadPrepaie(API) {
    API.prepaie.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (d) {
        window.ppVars = d.variables.map(mapPP);
        if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
      });
    }).catch(noop);
  }

  function loadPlanning(API) {
    API.planning.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (shifts) {
        var n = shifts.filter(function (s) { return s.statut === 'REMPLACEMENT_REQUIS'; }).length;
        setBadge('badge-planning', n);
      });
    }).catch(noop);
  }

  function loadDocuments(API) {
    API.documents.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) {
        window.docs = data.map(function (d) {
          return { id: d.id, name: d.nom, type: d.type, periode: d.periode || '—', size: d.taille || '—', collab: d.user ? d.user.prenom + ' ' + d.user.nom : '—' };
        });
        if (typeof window.renderDocs === 'function') window.renderDocs();
      });
    }).catch(noop);
  }

  function loadCommunication(API) {
    API.communication.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) {
        if (!data.length || !window.COMM_MSGS) return;
        var msgs = data.map(function (m) {
          var auteur  = m.auteur || {};
          var prenom  = auteur.prenom || 'P';
          var nom     = auteur.nom    || 'U';
          return {
            id: m.id,
            user: prenom + ' ' + nom,
            initials: (prenom[0] + nom[0]).toUpperCase(),
            color: '#2563EB',
            role: auteur.role === 'RH' ? 'DRH' : 'Manager',
            time: new Date(m.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
            text: m.contenu.replace(/</g, '&lt;').replace(/\n/g, '<br>'),
            pinned: false,
            reactions: { '👍': { count: 0, reacted: false } },
            replies: [],
          };
        });
        window.COMM_MSGS['general'] = msgs.concat((window.COMM_MSGS['general'] || []).slice(0, 3));
        if (typeof window.renderChanFeed === 'function') window.renderChanFeed('general');
      });
    }).catch(noop);
  }

  function loadCollaborateurs(API) {
    API.collaborateurs.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) { window.COLLABS_API = data; });
    }).catch(noop);
  }

  function loadQcm(API) {
    API.qcm.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (camps) {
        if (!camps.length) return;
        window._activeCampaignId = camps[0].id;
        var sub = document.getElementById('be-qcm-subtitle');
        if (sub) sub.textContent = (camps[0].questions ? camps[0].questions.length : 4) + ' questions · ' + ((camps[0]._count && camps[0]._count.reponses) || 0) + ' réponses anonymisées';
      });
    }).catch(noop);
  }

  function loadNotifications(API) {
    API.notifications.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (d) {
        setBadge('notif-count', d.unread);
        renderNotifPanel(d.notifications);
      });
    }).catch(noop);
  }

  function renderNotifPanel(notifs) {
    var body = document.getElementById('notif-panel-body');
    if (!body || !notifs) return;
    if (!notifs.length) {
      body.innerHTML = '<div style="padding:24px;text-align:center;color:#9CA3AF;font-size:13px">Aucune notification</div>';
      return;
    }
    body.innerHTML = notifs.slice(0, 15).map(function (n) {
      var bg = n.lu ? 'white' : '#EFF6FF';
      var fw = n.lu ? 400 : 600;
      var date = new Date(n.createdAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      return '<div onclick="PulsiiaAPI.notifications.markRead(\'' + n.id + '\');this.style.background=\'white\'" style="padding:12px 16px;border-bottom:1px solid #E5E7EB;cursor:pointer;background:' + bg + '">' +
        '<div style="font-size:13px;font-weight:' + fw + ';color:#111827;margin-bottom:2px">' + n.titre + '</div>' +
        '<div style="font-size:12px;color:#6B7280">' + n.message + '</div>' +
        '<div style="font-size:11px;color:#9CA3AF;margin-top:4px">' + date + '</div>' +
        '</div>';
    }).join('');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 6 — Boutons câblés sur l'API
  // ─────────────────────────────────────────────────────────────────────────────

  function wireButtons(API) {

    // ── Absences ──────────────────────────────────────────────────────────────

    window.quickValidate = function (id) {
      API.absences.updateStatut(id, 'APPROUVE').then(function (res) {
        if (!res || !res.ok) { toast('Erreur de validation'); return; }
        var a = findById(window.absences, id);
        if (a) a.status = 'Validé';
        rerender('renderAbsences');
        toast((a ? a.collab : 'Absence') + ' — Validée ✓');
      }).catch(function () { toast('Erreur réseau'); });
    };

    window.confirmRefuse = function () {
      var reason = field('abs-refuse-reason');
      if (!reason) { toast('Veuillez sélectionner un motif'); return; }
      var id = window.absRefuseTargetId;
      API.absences.updateStatut(id, 'REFUSE').then(function (res) {
        if (!res || !res.ok) { toast('Erreur'); return; }
        var a = findById(window.absences, id);
        if (a) { a.status = 'Refusé'; a.refuseReason = reason; }
        closeModal('modal-abs-refuse');
        rerender('renderAbsences');
        toast('Demande refusée ✓');
      }).catch(function () { toast('Erreur réseau'); });
    };

    window.validateAllPending = function () {
      var pending = (window.absences || []).filter(function (a) { return a.status === 'En attente'; });
      if (!pending.length) { toast('Aucune demande en attente'); return; }
      var done = 0, total = pending.length;
      pending.forEach(function (a) {
        API.absences.updateStatut(a.id, 'APPROUVE').then(function (res) {
          if (res && res.ok) { a.status = 'Validé'; done++; }
          if (done === total) { rerender('renderAbsences'); toast(done + ' demande(s) validée(s) ✓'); }
        }).catch(noop);
      });
    };

    window.saveDeclare = function () {
      var collab = field('dec-collab'), type = field('dec-type'), start = field('dec-start'), end = field('dec-end'), comment = field('dec-comment');
      if (!collab || !type || !start || !end) { showErr('dec-error', 'Veuillez remplir tous les champs.'); return; }
      var cObj = findByName(window.COLLABS_API, collab);
      API.absences.create({ type: TYPE_A[type] || 'CONGES_PAYES', dateDebut: start, dateFin: end, motif: comment, userId: cObj ? cObj.id : undefined })
        .then(function (res) {
          if (res && res.ok) { closeModal('modal-declare'); loadAbsences(API); toast('Absence déclarée ✓'); }
          else showErr('dec-error', 'Erreur lors de la déclaration.');
        }).catch(function () { showErr('dec-error', 'Erreur réseau.'); });
    };

    window.saveDemande = function () {
      var type = field('dem-type'), start = field('dem-start'), end = field('dem-end'), comment = field('dem-comment');
      if (!type || !start || !end) { showErr('dem-error', 'Veuillez remplir tous les champs.'); return; }
      API.absences.create({ type: TYPE_A[type] || 'CONGES_PAYES', dateDebut: start, dateFin: end, motif: comment })
        .then(function (res) {
          if (res && res.ok) { closeModal('modal-demande'); loadAbsences(API); toast('Demande envoyée ✓'); }
          else showErr('dem-error', 'Erreur.');
        }).catch(function () { showErr('dem-error', 'Erreur réseau.'); });
    };

    window.submitCollabAbsence = function () {
      var start = field('collab-abs-start'), end = field('collab-abs-end');
      if (!start || !end) { toast('Veuillez renseigner les dates'); return; }
      API.absences.create({ type: 'MALADIE', dateDebut: start, dateFin: end, motif: 'Absence maladie' })
        .then(function (res) {
          closeModal('modal-collab-absence');
          toast(res && res.ok ? 'Absence déclarée ✓ · Manager notifié' : 'Erreur');
        }).catch(function () { closeModal('modal-collab-absence'); toast('Erreur réseau'); });
    };

    // ── Prépaie ───────────────────────────────────────────────────────────────

    window.validateAll = function () {
      var checked = document.querySelectorAll('.pp-row-check:checked');
      if (checked.length > 0) {
        checked.forEach(function (cb) {
          API.prepaie.updateStatut(cb.dataset.id, 'VALIDE').then(function (res) {
            if (res && res.ok) { var v = findById(window.ppVars, cb.dataset.id); if (v) v.status = 'Validé'; }
            rerender('renderPrepaie');
          }).catch(noop);
        });
        toast('Variables validées ✓');
      } else {
        API.prepaie.validerTout('mars-2026').then(function (res) {
          if (res && res.ok) res.json().then(function (d) { toast(d.message || 'Variables validées ✓'); loadPrepaie(API); });
        }).catch(function () { toast('Erreur réseau'); });
      }
    };

    window.validerPP = function (id) {
      API.prepaie.updateStatut(id, 'VALIDE').then(function (res) {
        if (!res || !res.ok) { toast('Erreur'); return; }
        var v = findById(window.ppVars, id); if (v) v.status = 'Validé';
        closeModal('modal-pp-detail');
        rerender('renderPrepaie');
        toast('Variable validée ✓');
      }).catch(function () { toast('Erreur réseau'); });
    };

    window.rejectPP = function (id) {
      var reason = field('pp-reject-reason');
      API.prepaie.updateStatut(id, 'ANOMALIE', reason).then(function (res) {
        if (res && res.ok) { closeModal('modal-pp-detail'); loadPrepaie(API); toast('Anomalie signalée'); }
      }).catch(noop);
    };

    window.savePPVariable = function () {
      var collab = field('pp-add-collab'), type = field('pp-add-type'), raw = field('pp-add-value');
      if (!type || !raw) { showErr('pp-add-error', 'Veuillez remplir tous les champs.'); return; }
      var montant = parseFloat(raw.replace(/[^0-9.,]/g, '').replace(',', '.')) || 0;
      var cObj = findByName(window.COLLABS_API, collab);
      API.prepaie.create({ userId: cObj ? cObj.id : collab, periode: 'mars-2026', type: type, montant: montant })
        .then(function (res) {
          if (res && res.ok) { closeModal('modal-pp-add'); loadPrepaie(API); toast('Variable ajoutée ✓'); }
          else showErr('pp-add-error', "Erreur lors de l'ajout.");
        }).catch(function () { showErr('pp-add-error', 'Erreur réseau.'); });
    };

    window.exportCSV = function () { API.prepaie.exportCSV('mars-2026'); toast('Export CSV en cours…'); };
    window.doSilaeExport = function () {
      var m = document.getElementById('modal-silae-export'); if (m) m.classList.remove('open');
      API.prepaie.exportCSV('mars-2026');
      toast('Export Silae en cours ✓');
    };

    // ── Communication ─────────────────────────────────────────────────────────

    window.submitAnnounce = function () {
      var title = field('announce-title'), body = field('announce-body');
      if (!body) { toast('Merci de rédiger un message'); return; }
      API.communication.create({ titre: title || 'Annonce', contenu: body, type: 'ANNONCE' })
        .then(function (res) {
          if (res && res.ok) {
            if (typeof window.closeAnnounce === 'function') window.closeAnnounce();
            loadCommunication(API);
            toast('Message publié ✓');
          } else toast('Erreur de publication');
        }).catch(function () { toast('Erreur réseau'); });
    };

    // ── Notifications ─────────────────────────────────────────────────────────

    window.markAllNotifRead = function () {
      API.notifications.markAllRead().then(function () {
        setBadge('notif-count', 0);
        toast('Tout marqué comme lu ✓');
      }).catch(noop);
    };

    var _origToggleNotif = window.toggleNotifPanel;
    window.toggleNotifPanel = function () {
      if (typeof _origToggleNotif === 'function') _origToggleNotif();
      loadNotifications(API);
    };

    // ── Profil ────────────────────────────────────────────────────────────────

    window.saveProfile = function () {
      var btn = document.querySelector('[onclick*="saveProfile"]');
      if (btn) btn.textContent = 'Enregistrement…';
      API.auth.profile({ nom: field('profile-nom'), prenom: field('profile-prenom'), telephone: field('profile-tel') })
        .then(function (res) {
          if (btn) btn.textContent = res && res.ok ? 'Enregistré ✓' : 'Erreur';
          setTimeout(function () { if (btn) btn.textContent = 'Enregistrer'; }, 2000);
          if (res && res.ok) {
            res.json().then(function (u) {
              var cur = (window.PulsiiaUser && window.PulsiiaUser()) || {};
              var merged = Object.assign({}, cur, u);
              localStorage.setItem('pulsiia_user', JSON.stringify(merged));
              renderUserInfo(merged);
            });
            toast('Profil mis à jour ✓');
          }
        }).catch(function () { if (btn) btn.textContent = 'Enregistrer'; });
    };

    window.changePassword = function () {
      var curr = field('pwd-current'), next = field('pwd-new'), conf = field('pwd-confirm');
      if (!curr || !next) { toast('Veuillez remplir tous les champs'); return; }
      if (next !== conf)  { toast('Mots de passe différents'); return; }
      if (next.length < 8){ toast('Minimum 8 caractères'); return; }
      API.auth.password({ currentPassword: curr, newPassword: next })
        .then(function (res) {
          if (res && res.ok) { toast('Mot de passe modifié ✓ · Reconnexion…'); setTimeout(function () { API.auth.logout(); }, 1500); }
          else toast('Mot de passe actuel incorrect');
        }).catch(function () { toast('Erreur réseau'); });
    };

    // ── QCM ──────────────────────────────────────────────────────────────────

    var _origSubmitQCM = window.submitQCM;
    window.submitQCM = function () {
      if (typeof _origSubmitQCM === 'function') _origSubmitQCM();
      var cid = window._activeCampaignId;
      if (cid) API.qcm.repondre(cid, {}).catch(noop);
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 7 — Utilitaires
  // ─────────────────────────────────────────────────────────────────────────────

  function noop() {}

  function field(id) {
    var el = document.getElementById(id);
    return el ? (el.value || '').trim() : '';
  }

  function findById(arr, id) {
    if (!arr) return null;
    return arr.find(function (x) { return x.id == id; }) || null;
  }

  function findByName(arr, fullName) {
    if (!arr || !fullName) return null;
    return arr.find(function (c) { return (c.prenom + ' ' + c.nom) === fullName; }) || null;
  }

  function showErr(id, msg) {
    var el = document.getElementById(id);
    if (el) { el.style.display = 'block'; el.textContent = msg; }
  }

  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }

  function setBadge(id, count) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = count || '';
    el.style.display = count ? '' : 'none';
  }

  function rerender(fnName) {
    if (typeof window[fnName] === 'function') window[fnName]();
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#0F1117;color:white;padding:10px 18px;border-radius:8px;font-size:13px;font-family:inherit;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 8 — Démarrage (après chargement complet du DOM + scripts inline)
  // ─────────────────────────────────────────────────────────────────────────────

  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

})();
