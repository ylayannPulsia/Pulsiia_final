/**
 * Pulsiia — pages.js
 * Chargé en defer après tous les scripts inline.
 * Ne modifie AUCUN code existant dans Maquettes.html.
 * Injecte le mobile sidebar et connecte les actions à l'API.
 */
(function () {
  'use strict';

  /* ─── 1. Mobile sidebar (injecté dynamiquement) ─────────────────────────── */

  function setupMobileSidebar() {
    // Overlay cliquable pour fermer la sidebar
    var overlay = document.createElement('div');
    overlay.id = 'pls-overlay';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:199';
    overlay.onclick = closeSidebar;
    document.body.appendChild(overlay);

    // Bouton hamburger dans la topbar
    var topbar = document.querySelector('.topbar');
    if (topbar) {
      var ham = document.createElement('button');
      ham.innerHTML = '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M2.5 12a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5zm0-4a.5.5 0 0 1 .5-.5h10a.5.5 0 0 1 0 1H3a.5.5 0 0 1-.5-.5z"/></svg>';
      ham.style.cssText = 'display:none;width:36px;height:36px;border:1px solid #E5E7EB;border-radius:8px;background:white;cursor:pointer;align-items:center;justify-content:center;margin-right:8px;flex-shrink:0;color:#6B7280';
      ham.id = 'pls-ham';
      ham.title = 'Menu';
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

    // Fermer sidebar sur clic nav item (mobile)
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

  /* ─── 2. Initialisation ──────────────────────────────────────────────────── */

  function init() {
    setupMobileSidebar();

    var API  = window.PulsiiaAPI;
    var user = window.PulsiiaUser ? window.PulsiiaUser() : null;

    // Mode demo sans backend → on s'arrête ici, les boutons statiques fonctionnent
    if (!API) return;

    // Injecter les infos utilisateur
    if (user) {
      injectUserUI(user);
    } else {
      // Essayer de récupérer la session silencieusement
      API.auth.me().then(function (res) {
        if (res && res.ok) {
          res.json().then(function (u) {
            localStorage.setItem('pulsiia_user', JSON.stringify(u));
            injectUserUI(u);
          });
        }
      }).catch(function () {});
    }

    // Bouton logout sidebar
    var card = document.getElementById('sidebar-user-card');
    if (card && !card._pw) {
      card._pw = true;
      card.style.cursor = 'pointer';
      card.title = 'Se déconnecter';
      card.addEventListener('click', function () {
        if (confirm('Se déconnecter ?')) API.auth.logout();
      });
    }

    // KPIs dashboard
    loadDashboardKpis(API);

    // Hooker showPage pour charger les données par page
    hookShowPage(API);

    // Câbler tous les boutons d'action sur l'API
    wireApiButtons(API);
  }

  /* ─── 3. UI utilisateur ──────────────────────────────────────────────────── */

  function injectUserUI(user) {
    var nameEl   = document.getElementById('sidebar-user-name');
    var roleEl   = document.getElementById('sidebar-user-role');
    var avatarEl = document.getElementById('sidebar-avatar');
    if (nameEl)   nameEl.textContent   = user.prenom + ' ' + user.nom;
    if (roleEl)   roleEl.textContent   = (user.role === 'RH' ? 'DRH' : user.role) + ' · ' + (user.siteNom || (user.site && user.site.nom) || 'Siège');
    if (avatarEl) avatarEl.textContent = ((user.prenom || 'P')[0] + (user.nom || 'U')[0]).toUpperCase();
    var greet = document.querySelector('#page-dashboard h2');
    if (greet) greet.textContent = 'Bonjour, ' + user.prenom + ' 👋';
  }

  /* ─── 4. Hook showPage (non-destructif) ──────────────────────────────────── */

  function hookShowPage(API) {
    var _orig = window.showPage;
    if (typeof _orig !== 'function') return;
    window.showPage = function (name, navEl) {
      // Appel original en priorité absolue
      try { _orig.call(this, name, navEl); } catch (e) { console.warn('[Pulsiia] showPage error:', e); }
      // Chargement API en arrière-plan, sans bloquer
      setTimeout(function () { loadPageData(API, name); }, 0);
    };
  }

  function loadPageData(API, page) {
    try {
      switch (page) {
        case 'dashboard':      loadDashboardKpis(API); break;
        case 'absences':       loadAbsences(API);       break;
        case 'prepaie':        loadPrepaie(API);        break;
        case 'planning':       loadPlanning(API);       break;
        case 'documents':      loadDocuments(API);      break;
        case 'communication':  loadCommunication(API);  break;
        case 'collaborateurs': loadCollaborateurs(API); break;
        case 'bienetre':
        case 'qcm':            loadQcm(API);            break;
        case 'notifications':  loadNotifications(API);  break;
        case 'mes-docs':       loadDocuments(API);      break;
        case 'mon-planning':   loadPlanning(API);       break;
        case 'accueil-collab': loadDashboardKpis(API);  break;
      }
    } catch (e) { console.warn('[Pulsiia] loadPageData error:', page, e); }
  }

  /* ─── 5. Loaders par page ────────────────────────────────────────────────── */

  function loadDashboardKpis(API) {
    API.dashboard.kpis().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (k) {
        var bp = document.getElementById('badge-prepaie');
        if (bp) { bp.textContent = k.variablesAValider || ''; bp.style.display = k.variablesAValider ? '' : 'none'; }
        var bpl = document.getElementById('badge-planning');
        if (bpl) { bpl.textContent = k.shiftsDecouverts || ''; bpl.style.display = k.shiftsDecouverts ? '' : 'none'; }
      });
    }).catch(function () {});

    API.notifications.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (d) {
        var badge = document.getElementById('notif-count');
        if (badge) { badge.textContent = d.unread || ''; badge.style.display = d.unread ? '' : 'none'; }
      });
    }).catch(function () {});
  }

  var TYPE_L = { MALADIE:'Maladie', CONGES_PAYES:'Congé payé', RTT:'RTT', EVENEMENT_FAMILIAL:'Évènement familial', SANS_SOLDE:'Sans solde' };
  var ABS_S  = { EN_ATTENTE:'En attente', APPROUVE:'Validé', REFUSE:'Refusé' };
  var PP_S   = { A_VALIDER:'À valider', VALIDE:'Validé', ANOMALIE:'Anomalie IA' };
  var TYPE_A = { 'Maladie':'MALADIE','Congé payé':'CONGES_PAYES','RTT':'RTT','Accident travail':'MALADIE','Évènement familial':'EVENEMENT_FAMILIAL','Sans solde':'SANS_SOLDE' };

  function mapAbs(a) {
    return { id:a.id, collab:a.user?a.user.prenom+' '+a.user.nom[0]+'.':'—', type:TYPE_L[a.type]||a.type, start:a.dateDebut, end:a.dateFin, status:ABS_S[a.statut]||a.statut, comment:a.motif||'', pj:null, refuseReason:null, refuseMsg:null };
  }
  function mapPP(v) {
    return { id:v.id, collab:v.user?v.user.prenom+' '+v.user.nom[0]+'.':'—', site:v.user&&v.user.site?v.user.site.nom:'—', type:v.type, value:'+'+v.montant+'€', source:'Planning auto', status:PP_S[v.statut]||v.statut, anomaly:v.anomalie||null };
  }

  function loadAbsences(API) {
    API.absences.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) {
        window.absences = data.map(mapAbs);
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
      });
    }).catch(function () {});
  }

  function loadPrepaie(API) {
    API.prepaie.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (d) {
        window.ppVars = d.variables.map(mapPP);
        if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
      });
    }).catch(function () {});
  }

  function loadPlanning(API) {
    API.planning.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (shifts) {
        var n = shifts.filter(function (s) { return s.statut === 'REMPLACEMENT_REQUIS'; }).length;
        var b = document.getElementById('badge-planning');
        if (b) { b.textContent = n; b.style.display = n ? '' : 'none'; }
      });
    }).catch(function () {});
  }

  function loadDocuments(API) {
    API.documents.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) {
        if (window.docs === undefined) return;
        window.docs = data.map(function (d) {
          return { id:d.id, name:d.nom, type:d.type, periode:d.periode||'—', size:d.taille||'—', collab:d.user?d.user.prenom+' '+d.user.nom:'—' };
        });
        if (typeof window.renderDocs === 'function') window.renderDocs();
      });
    }).catch(function () {});
  }

  function loadCommunication(API) {
    API.communication.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) {
        if (!data.length || !window.COMM_MSGS) return;
        var msgs = data.map(function (m) {
          return { id:m.id, user:(m.auteur?m.auteur.prenom+' '+m.auteur.nom:'Pulsiia'), initials:((m.auteur?m.auteur.prenom:'P')[0]+(m.auteur?m.auteur.nom:'U')[0]).toUpperCase(), color:'#2563EB', role:m.auteur&&m.auteur.role==='RH'?'DRH':'Manager', time:new Date(m.createdAt).toLocaleDateString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}), text:m.contenu.replace(/</g,'&lt;').replace(/\n/g,'<br>'), pinned:false, reactions:{'👍':{count:0,reacted:false}}, replies:[] };
        });
        window.COMM_MSGS['general'] = msgs.concat((window.COMM_MSGS['general']||[]).slice(0,3));
        if (typeof window.renderChanFeed === 'function') window.renderChanFeed('general');
      });
    }).catch(function () {});
  }

  function loadCollaborateurs(API) {
    API.collaborateurs.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (data) { window.COLLABS_API = data; });
    }).catch(function () {});
  }

  function loadQcm(API) {
    API.qcm.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (camps) {
        if (!camps.length) return;
        window._activeCampaignId = camps[0].id;
        var sub = document.getElementById('be-qcm-subtitle');
        if (sub) sub.textContent = (camps[0].questions?camps[0].questions.length:4) + ' questions · ' + ((camps[0]._count&&camps[0]._count.reponses)||0) + ' réponses anonymisées';
      });
    }).catch(function () {});
  }

  function loadNotifications(API) {
    API.notifications.list().then(function (res) {
      if (!res || !res.ok) return;
      res.json().then(function (d) {
        var badge = document.getElementById('notif-count');
        if (badge) { badge.textContent = d.unread||''; badge.style.display = d.unread?'':'none'; }
        renderNotifPanel(d.notifications);
      });
    }).catch(function () {});
  }

  function renderNotifPanel(notifs) {
    var body = document.getElementById('notif-panel-body');
    if (!body || !notifs) return;
    if (!notifs.length) { body.innerHTML = '<div style="padding:24px;text-align:center;color:#9CA3AF;font-size:13px">Aucune notification</div>'; return; }
    body.innerHTML = notifs.slice(0,15).map(function (n) {
      return '<div onclick="PulsiiaAPI.notifications.markRead(\''+n.id+'\');this.style.background=\'white\'" style="padding:12px 16px;border-bottom:1px solid #E5E7EB;cursor:pointer;background:'+(n.lu?'white':'#EFF6FF')+'">' +
        '<div style="font-size:13px;font-weight:'+(n.lu?400:600)+';color:#111827;margin-bottom:2px">'+n.titre+'</div>' +
        '<div style="font-size:12px;color:#6B7280">'+n.message+'</div>' +
        '<div style="font-size:11px;color:#9CA3AF;margin-top:4px">'+new Date(n.createdAt).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})+'</div>' +
        '</div>';
    }).join('');
  }

  /* ─── 6. Boutons d'action câblés sur l'API ───────────────────────────────── */

  function wireApiButtons(API) {

    /* ── Absences ── */
    window.quickValidate = function (id) {
      API.absences.updateStatut(id, 'APPROUVE').then(function (res) {
        if (!res || !res.ok) { toast('⚠ Erreur de validation'); return; }
        var a = find(window.absences, id);
        if (a) a.status = 'Validé';
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
        toast((a ? a.collab : 'Absence') + ' — Validée ✓');
      }).catch(function () { toast('⚠ Erreur réseau'); });
    };

    window.confirmRefuse = function () {
      var reason = val('abs-refuse-reason');
      if (!reason) { toast('Veuillez sélectionner un motif'); return; }
      var id = window.absRefuseTargetId;
      API.absences.updateStatut(id, 'REFUSE').then(function (res) {
        if (!res || !res.ok) { toast('⚠ Erreur de refus'); return; }
        var a = find(window.absences, id);
        if (a) { a.status = 'Refusé'; a.refuseReason = reason; }
        closeModal('modal-abs-refuse');
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
        toast('Demande refusée ✓');
      }).catch(function () { toast('⚠ Erreur réseau'); });
    };

    window.validateAllPending = function () {
      var pending = (window.absences || []).filter(function (a) { return a.status === 'En attente'; });
      if (!pending.length) { toast('Aucune demande en attente'); return; }
      var done = 0;
      pending.forEach(function (a) {
        API.absences.updateStatut(a.id, 'APPROUVE').then(function (res) {
          if (res && res.ok) { a.status = 'Validé'; done++; }
          if (done === pending.length) {
            if (typeof window.renderAbsences === 'function') window.renderAbsences();
            toast(done + ' demande(s) validée(s) ✓');
          }
        });
      });
    };

    window.saveDeclare = function () {
      var collab  = val('dec-collab');
      var type    = val('dec-type');
      var start   = val('dec-start');
      var end     = val('dec-end');
      var comment = val('dec-comment');
      if (!collab || !type || !start || !end) { setErr('dec-error', 'Veuillez remplir tous les champs.'); return; }
      var apiType = TYPE_A[type] || 'CONGES_PAYES';
      var cObj = (window.COLLABS_API || []).find(function (c) { return (c.prenom + ' ' + c.nom) === collab; });
      API.absences.create({ type: apiType, dateDebut: start, dateFin: end, motif: comment, userId: cObj ? cObj.id : undefined }).then(function (res) {
        if (res && res.ok) { closeModal('modal-declare'); loadAbsences(API); toast('Absence déclarée ✓'); }
        else setErr('dec-error', 'Erreur lors de la déclaration.');
      }).catch(function () { setErr('dec-error', 'Erreur réseau.'); });
    };

    window.saveDemande = function () {
      var type    = val('dem-type');
      var start   = val('dem-start');
      var end     = val('dem-end');
      var comment = val('dem-comment');
      if (!type || !start || !end) { setErr('dem-error', 'Veuillez remplir tous les champs.'); return; }
      API.absences.create({ type: TYPE_A[type] || 'CONGES_PAYES', dateDebut: start, dateFin: end, motif: comment }).then(function (res) {
        if (res && res.ok) { closeModal('modal-demande'); loadAbsences(API); toast('Demande envoyée ✓'); }
        else setErr('dem-error', 'Erreur.');
      }).catch(function () { setErr('dem-error', 'Erreur réseau.'); });
    };

    window.submitCollabAbsence = function () {
      var start = val('collab-abs-start');
      var end   = val('collab-abs-end');
      if (!start || !end) { toast('Veuillez renseigner les dates'); return; }
      API.absences.create({ type: 'MALADIE', dateDebut: start, dateFin: end, motif: 'Absence maladie' }).then(function (res) {
        closeModal('modal-collab-absence');
        toast(res && res.ok ? 'Absence déclarée ✓ · Manager notifié' : '⚠ Erreur');
      }).catch(function () { closeModal('modal-collab-absence'); toast('⚠ Erreur réseau'); });
    };

    /* ── Prépaie ── */
    window.validateAll = function () {
      var checked = document.querySelectorAll('.pp-row-check:checked');
      if (checked.length > 0) {
        var count = 0;
        checked.forEach(function (cb) {
          API.prepaie.updateStatut(cb.dataset.id, 'VALIDE').then(function (res) {
            if (res && res.ok) { var v = find(window.ppVars, cb.dataset.id); if (v) { v.status = 'Validé'; count++; } }
            if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
          });
        });
        toast('Variables validées ✓');
      } else {
        API.prepaie.validerTout('mars-2026').then(function (res) {
          if (res && res.ok) { res.json().then(function (d) { toast(d.message || 'Variables validées ✓'); loadPrepaie(API); }); }
        }).catch(function () { toast('⚠ Erreur réseau'); });
      }
    };

    window.validerPP = function (id) {
      API.prepaie.updateStatut(id, 'VALIDE').then(function (res) {
        if (!res || !res.ok) { toast('⚠ Erreur'); return; }
        var v = find(window.ppVars, id); if (v) v.status = 'Validé';
        closeModal('modal-pp-detail');
        if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
        toast('Variable validée ✓');
      }).catch(function () { toast('⚠ Erreur réseau'); });
    };

    window.rejectPP = function (id) {
      var reason = val('pp-reject-reason');
      API.prepaie.updateStatut(id, 'ANOMALIE', reason).then(function (res) {
        if (res && res.ok) { closeModal('modal-pp-detail'); loadPrepaie(API); toast('Anomalie signalée'); }
      }).catch(function () {});
    };

    window.exportCSV = function () {
      API.prepaie.exportCSV('mars-2026');
      toast('Export CSV en cours…');
    };

    window.doSilaeExport = function () {
      var modal = document.getElementById('modal-silae-export');
      if (modal) modal.classList.remove('open');
      API.prepaie.exportCSV('mars-2026');
      toast('Export Silae en cours ✓');
    };

    window.savePPVariable = function () {
      var collab = val('pp-add-collab');
      var type   = val('pp-add-type');
      var raw    = val('pp-add-value');
      if (!type || !raw) { setErr('pp-add-error', 'Veuillez remplir tous les champs.'); return; }
      var montant = parseFloat(raw.replace(/[^0-9.,]/g,'').replace(',','.')) || 0;
      var cObj = (window.COLLABS_API || []).find(function (c) { return (c.prenom+' '+c.nom) === collab; });
      API.prepaie.create({ userId: cObj ? cObj.id : collab, periode: 'mars-2026', type: type, montant: montant }).then(function (res) {
        if (res && res.ok) { closeModal('modal-pp-add'); loadPrepaie(API); toast('Variable ajoutée ✓'); }
        else setErr('pp-add-error', 'Erreur lors de l\'ajout.');
      }).catch(function () { setErr('pp-add-error', 'Erreur réseau.'); });
    };

    /* ── Communication ── */
    window.submitAnnounce = function () {
      var title = val('announce-title');
      var body  = val('announce-body');
      if (!body) { toast('⚠ Merci de rédiger un message'); return; }
      API.communication.create({ titre: title || 'Annonce', contenu: body, type: 'ANNONCE' }).then(function (res) {
        if (res && res.ok) {
          if (typeof window.closeAnnounce === 'function') window.closeAnnounce();
          loadCommunication(API);
          toast('Message publié ✓');
        } else toast('⚠ Erreur de publication');
      }).catch(function () { toast('⚠ Erreur réseau'); });
    };

    /* ── Notifications ── */
    window.markAllNotifRead = function () {
      API.notifications.markAllRead().then(function () {
        var badge = document.getElementById('notif-count');
        if (badge) { badge.textContent = ''; badge.style.display = 'none'; }
        toast('Tout marqué comme lu ✓');
      }).catch(function () {});
    };

    var _origToggleNotif = window.toggleNotifPanel;
    window.toggleNotifPanel = function () {
      if (typeof _origToggleNotif === 'function') _origToggleNotif();
      loadNotifications(API);
    };

    /* ── Profil ── */
    window.saveProfile = function () {
      var btn = document.querySelector('[onclick*="saveProfile"]');
      var nom       = val('profile-nom');
      var prenom    = val('profile-prenom');
      var telephone = val('profile-tel');
      if (btn) btn.textContent = 'Enregistrement…';
      API.auth.profile({ nom: nom, prenom: prenom, telephone: telephone }).then(function (res) {
        if (btn) btn.textContent = res && res.ok ? 'Enregistré ✓' : 'Erreur';
        setTimeout(function () { if (btn) btn.textContent = 'Enregistrer'; }, 2000);
        if (res && res.ok) {
          res.json().then(function (u) {
            var cur = (window.PulsiiaUser && window.PulsiiaUser()) || {};
            localStorage.setItem('pulsiia_user', JSON.stringify(Object.assign({}, cur, u)));
            injectUserUI(Object.assign({}, cur, u));
          });
          toast('Profil mis à jour ✓');
        }
      }).catch(function () { if (btn) btn.textContent = 'Enregistrer'; });
    };

    window.changePassword = function () {
      var curr = val('pwd-current');
      var next  = val('pwd-new');
      var conf  = val('pwd-confirm');
      if (!curr || !next) { toast('Veuillez remplir tous les champs'); return; }
      if (next !== conf)  { toast('⚠ Mots de passe différents'); return; }
      if (next.length < 8){ toast('⚠ Minimum 8 caractères'); return; }
      API.auth.password({ currentPassword: curr, newPassword: next }).then(function (res) {
        if (res && res.ok) { toast('Mot de passe modifié ✓ · Reconnexion…'); setTimeout(function () { API.auth.logout(); }, 1500); }
        else toast('⚠ Mot de passe actuel incorrect');
      }).catch(function () { toast('⚠ Erreur réseau'); });
    };

    /* ── QCM ── */
    var _origSubmitQCM = window.submitQCM;
    window.submitQCM = function () {
      var cid = window._activeCampaignId;
      if (!cid) { if (typeof _origSubmitQCM === 'function') _origSubmitQCM(); return; }
      if (typeof _origSubmitQCM === 'function') _origSubmitQCM(); // garder le rendu statique
      API.qcm.repondre(cid, {}).then(function () {}).catch(function () {});
    };
  }

  /* ─── 7. Utilitaires ─────────────────────────────────────────────────────── */

  function val(id) {
    var el = document.getElementById(id);
    return el ? (el.value || '').trim() : '';
  }
  function find(arr, id) {
    if (!arr) return null;
    return arr.find(function (x) { return x.id == id; }) || null;
  }
  function setErr(id, msg) {
    var el = document.getElementById(id);
    if (el) { el.style.display = 'block'; el.textContent = msg; }
  }
  function closeModal(id) {
    var el = document.getElementById(id);
    if (el) el.classList.remove('open');
  }
  function toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#0F1117;color:white;padding:10px 18px;border-radius:8px;font-size:13px;font-family:inherit;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  /* ─── 8. Démarrage après chargement complet ──────────────────────────────── */
  // "defer" garantit que les scripts inline sont déjà exécutés
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }

})();
