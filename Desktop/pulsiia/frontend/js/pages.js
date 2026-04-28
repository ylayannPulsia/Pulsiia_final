/**
 * Pulsiia — pages.js
 * S'active uniquement si l'utilisateur est connecté.
 * Ne casse JAMAIS le demo statique existant.
 * Toutes les opérations sont try/catch'd.
 */
(function () {
  'use strict';

  // ── Attendre que tout soit chargé ──────────────────────────────────────────
  window.addEventListener('load', init);

  function init() {
    const API  = window.PulsiiaAPI;
    const user = window.PulsiiaUser ? window.PulsiiaUser() : null;

    if (!API) return; // api.js non chargé

    // ── Mode connecté : injecter les infos utilisateur dans la sidebar ────────
    if (user) {
      injectUserUI(user);
    } else {
      // Pas de session → vérifier silencieusement
      checkSession(API);
    }

    // ── Hooker les boutons spéciaux qui nécessitent l'API ────────────────────
    wireButtons(API, user);

    // ── Charger les KPIs du dashboard ────────────────────────────────────────
    loadDashboard(API);

    // ── Hook showPage (non-destructif) ───────────────────────────────────────
    hookShowPage(API);
  }

  // ── Injecte le nom/rôle dans la sidebar ──────────────────────────────────────
  function injectUserUI(user) {
    const nameEl   = document.getElementById('sidebar-user-name');
    const roleEl   = document.getElementById('sidebar-user-role');
    const avatarEl = document.getElementById('sidebar-avatar');
    if (nameEl)   nameEl.textContent   = user.prenom + ' ' + user.nom;
    if (roleEl)   roleEl.textContent   = (user.role === 'RH' ? 'DRH' : user.role) + ' · ' + (user.siteNom || user.site?.nom || 'Siège');
    if (avatarEl) avatarEl.textContent = ((user.prenom || 'P')[0] + (user.nom || 'U')[0]).toUpperCase();

    // Greeting dashboard
    const greet = document.querySelector('#page-dashboard h2');
    if (greet) greet.textContent = 'Bonjour, ' + user.prenom + ' 👋';

    // Logout sur clic sidebar
    const card = document.getElementById('sidebar-user-card');
    if (card && !card._logoutWired) {
      card._logoutWired = true;
      card.style.cursor = 'pointer';
      card.title = 'Se déconnecter';
      card.addEventListener('click', function () {
        if (confirm('Se déconnecter de Pulsiia ?')) {
          window.PulsiiaAPI.auth.logout();
        }
      });
    }
  }

  async function checkSession(API) {
    try {
      const res = await API.auth.me();
      if (res && res.ok) {
        const user = await res.json();
        localStorage.setItem('pulsiia_user', JSON.stringify(user));
        injectUserUI(user);
      }
    } catch {}
  }

  // ── KPIs dashboard ────────────────────────────────────────────────────────────
  async function loadDashboard(API) {
    try {
      const res = await API.dashboard.kpis();
      if (!res || !res.ok) return;
      const k = await res.json();

      // Notifications badge
      const notifRes = await API.notifications.list();
      if (notifRes && notifRes.ok) {
        const { unread } = await notifRes.json();
        const badge = document.getElementById('notif-count');
        if (badge) { badge.textContent = unread || ''; badge.style.display = unread ? '' : 'none'; }
      }

      // Badge prépaie sidebar
      const bp = document.getElementById('badge-prepaie');
      if (bp) { bp.textContent = k.variablesAValider; bp.style.display = k.variablesAValider ? '' : 'none'; }

    } catch (e) { /* garder le demo statique */ }
  }

  // ── Hook showPage — ajoute le chargement API sans casser l'existant ──────────
  function hookShowPage(API) {
    const _orig = window.showPage;
    if (!_orig) return;
    window.showPage = function (name, navEl) {
      // Appel original en premier — garanti
      try { _orig(name, navEl); } catch(e) { console.warn('showPage original error:', e); }
      // Chargement API en arrière-plan
      loadPage(API, name);
    };
  }

  async function loadPage(API, name) {
    try {
      switch (name) {
        case 'absences':      await loadAbsences(API);      break;
        case 'prepaie':       await loadPrepaie(API);       break;
        case 'dashboard':     await loadDashboard(API);     break;
        case 'planning':      await loadPlanning(API);      break;
        case 'documents':     await loadDocuments(API);     break;
        case 'communication': await loadCommunication(API); break;
        case 'collaborateurs':await loadCollaborateurs(API);break;
        case 'qcm':           await loadQCM(API);           break;
        case 'bienetre':      await loadBienetre(API);      break;
        case 'notifications': await loadNotifications(API); break;
        case 'mes-docs':      await loadDocuments(API);     break;
        case 'mon-planning':  await loadPlanning(API);      break;
        case 'accueil-collab':await loadDashboard(API);     break;
      }
    } catch(e) { console.warn('[pages.js] loadPage error:', name, e); }
  }

  // ── Mappings API → format statique ──────────────────────────────────────────

  const TYPE_LABEL = { MALADIE:'Maladie', CONGES_PAYES:'Congé payé', RTT:'RTT', EVENEMENT_FAMILIAL:'Évènement familial', SANS_SOLDE:'Sans solde' };
  const ABS_STATUS = { EN_ATTENTE:'En attente', APPROUVE:'Validé', REFUSE:'Refusé' };
  const PP_STATUS  = { A_VALIDER:'À valider', VALIDE:'Validé', ANOMALIE:'Anomalie IA' };

  function mapAbsence(a) {
    return {
      id:           a.id,
      collab:       a.user ? a.user.prenom + ' ' + a.user.nom[0] + '.' : '—',
      type:         TYPE_LABEL[a.type] || a.type,
      start:        a.dateDebut,
      end:          a.dateFin,
      status:       ABS_STATUS[a.statut] || a.statut,
      comment:      a.motif || '',
      pj:           null,
      refuseReason: null,
      refuseMsg:    null,
    };
  }

  function mapPP(v) {
    return {
      id:      v.id,
      collab:  v.user ? v.user.prenom + ' ' + v.user.nom[0] + '.' : '—',
      site:    v.user && v.user.site ? v.user.site.nom : '—',
      type:    v.type,
      value:   '+' + v.montant + '€',
      source:  'Planning auto',
      status:  PP_STATUS[v.statut] || v.statut,
      anomaly: v.anomalie || null,
    };
  }

  // ── Loaders par page ────────────────────────────────────────────────────────

  async function loadAbsences(API) {
    const res = await API.absences.list();
    if (!res || !res.ok) return;
    const data = await res.json();
    window.absences = data.map(mapAbsence);
    if (typeof window.renderAbsences === 'function') window.renderAbsences();
  }

  async function loadPrepaie(API) {
    const res = await API.prepaie.list();
    if (!res || !res.ok) return;
    const { variables } = await res.json();
    window.ppVars = variables.map(mapPP);
    if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
  }

  async function loadPlanning(API) {
    const res = await API.planning.list();
    if (!res || !res.ok) return;
    const shifts = await res.json();
    const decouverts = shifts.filter(s => s.statut === 'REMPLACEMENT_REQUIS').length;
    const bp = document.getElementById('badge-planning');
    if (bp) { bp.textContent = decouverts; bp.style.display = decouverts ? '' : 'none'; }
  }

  async function loadDocuments(API) {
    const res = await API.documents.list();
    if (!res || !res.ok) return;
    const data = await res.json();
    if (window.docs !== undefined) {
      window.docs = data.map(d => ({
        id:     d.id, name: d.nom, type: d.type,
        periode:d.periode || '—', size: d.taille || '—',
        collab: d.user ? d.user.prenom + ' ' + d.user.nom : '—',
      }));
      if (typeof window.renderDocs === 'function') window.renderDocs();
    }
  }

  async function loadCommunication(API) {
    const res = await API.communication.list();
    if (!res || !res.ok) return;
    const data = await res.json();
    if (!data.length || !window.COMM_MSGS) return;
    const msgs = data.map(m => ({
      id:       m.id,
      user:     (m.auteur?.prenom || '') + ' ' + (m.auteur?.nom || ''),
      initials: ((m.auteur?.prenom||'P')[0] + (m.auteur?.nom||'U')[0]).toUpperCase(),
      color:    '#2563EB',
      role:     m.auteur?.role === 'RH' ? 'DRH' : 'Manager',
      time:     new Date(m.createdAt).toLocaleDateString('fr-FR', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),
      text:     m.contenu.replace(/</g,'&lt;').replace(/\n/g,'<br>'),
      pinned:   false,
      reactions:{'👍':{count:0,reacted:false}},
      replies:  [],
    }));
    window.COMM_MSGS['general'] = [...msgs, ...(window.COMM_MSGS['general'] || []).slice(-5)];
    if (typeof window.renderChanFeed === 'function') window.renderChanFeed('general');
  }

  async function loadCollaborateurs(API) {
    const res = await API.collaborateurs.list();
    if (!res || !res.ok) return;
    const data = await res.json();
    window.COLLABS_API = data;
  }

  async function loadQCM(API) {
    const res = await API.qcm.list();
    if (!res || !res.ok) return;
    const campaigns = await res.json();
    if (campaigns.length) {
      window._activeCampaignId = campaigns[0].id;
      const sub = document.getElementById('be-qcm-subtitle');
      if (sub) sub.textContent = campaigns[0].questions?.length + ' questions · ' + (campaigns[0]._count?.reponses || 0) + ' réponses anonymisées';
    }
  }

  async function loadBienetre(API) {
    try {
      const res = await API.bienetre.stats();
      if (!res || !res.ok) return;
      const stats = await res.json();
      const scoreEl = document.querySelector('.be-score-big, [id*="be-score"]');
      if (scoreEl) scoreEl.textContent = stats.scoreMoyen;
    } catch {}
  }

  async function loadNotifications(API) {
    const res = await API.notifications.list();
    if (!res || !res.ok) return;
    const { notifications, unread } = await res.json();
    const badge = document.getElementById('notif-count');
    if (badge) { badge.textContent = unread||''; badge.style.display = unread ? '' : 'none'; }
    renderNotifPanel(notifications);
  }

  function renderNotifPanel(notifs) {
    const body = document.getElementById('notif-panel-body');
    if (!body || !notifs) return;
    if (!notifs.length) { body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Aucune notification</div>'; return; }
    body.innerHTML = notifs.slice(0,15).map(n => `
      <div onclick="PulsiiaAPI.notifications.markRead('${n.id}');this.style.background='white'"
           style="padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;background:${n.lu?'white':'#EFF6FF'}">
        <div style="font-size:13px;font-weight:${n.lu?400:600};color:var(--text);margin-bottom:2px">${n.titre}</div>
        <div style="font-size:12px;color:var(--text-2)">${n.message}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">${new Date(n.createdAt).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
      </div>`).join('');
  }

  // ── Wirer les boutons d'action ──────────────────────────────────────────────

  function wireButtons(API, user) {
    const isRH = user && ['RH','MANAGER'].includes(user.role);

    // ── Absences ──────────────────────────────────────────────────────────────
    window.quickValidate = async function (id) {
      const res = await API.absences.updateStatut(id, 'APPROUVE');
      if (res && res.ok) {
        const a = (window.absences||[]).find(x => x.id == id);
        if (a) a.status = 'Validé';
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
        toast((a?.collab||'Absence') + ' — Validée ✓');
      } else toast('⚠ Erreur validation');
    };

    window.confirmRefuse = async function () {
      const reason = document.getElementById('abs-refuse-reason')?.value;
      if (!reason) { toast('Veuillez sélectionner un motif'); return; }
      const id = window.absRefuseTargetId;
      const res = await API.absences.updateStatut(id, 'REFUSE');
      if (res && res.ok) {
        const a = (window.absences||[]).find(x => x.id == id);
        if (a) { a.status = 'Refusé'; a.refuseReason = reason; }
        if (typeof window.closeModal === 'function') window.closeModal('modal-abs-refuse');
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
        toast('Demande refusée ✓');
      } else toast('⚠ Erreur refus');
    };

    window.validateAllPending = async function () {
      const pending = (window.absences||[]).filter(a => a.status === 'En attente');
      if (!pending.length) { toast('Aucune demande en attente'); return; }
      for (const a of pending) {
        const r = await API.absences.updateStatut(a.id, 'APPROUVE');
        if (r && r.ok) a.status = 'Validé';
      }
      if (typeof window.renderAbsences === 'function') window.renderAbsences();
      toast(pending.length + ' demande(s) validée(s) ✓');
    };

    window.saveDeclare = async function () {
      const collab  = document.getElementById('dec-collab')?.value;
      const type    = document.getElementById('dec-type')?.value;
      const start   = document.getElementById('dec-start')?.value;
      const end     = document.getElementById('dec-end')?.value;
      const comment = document.getElementById('dec-comment')?.value?.trim();
      const err     = document.getElementById('dec-error');
      if (!collab || !type || !start || !end) {
        if (err) { err.style.display='block'; err.textContent='Veuillez remplir tous les champs.'; } return;
      }
      const apiType = { 'Maladie':'MALADIE','Congé payé':'CONGES_PAYES','RTT':'RTT','Accident travail':'MALADIE','Évènement familial':'EVENEMENT_FAMILIAL','Sans solde':'SANS_SOLDE' }[type] || 'CONGES_PAYES';
      const collabObj = (window.COLLABS_API||[]).find(c => (c.prenom+' '+c.nom) === collab || c.nom.includes(collab));
      const res = await API.absences.create({ type: apiType, dateDebut: start, dateFin: end, motif: comment, ...(collabObj && { userId: collabObj.id }) });
      if (res && res.ok) {
        if (typeof window.closeModal === 'function') window.closeModal('modal-declare');
        await loadAbsences(API);
        toast('Absence déclarée ✓');
      } else if (err) { err.style.display='block'; err.textContent='Erreur lors de la déclaration.'; }
    };

    window.saveDemande = async function () {
      const type    = document.getElementById('dem-type')?.value;
      const start   = document.getElementById('dem-start')?.value;
      const end     = document.getElementById('dem-end')?.value;
      const comment = document.getElementById('dem-comment')?.value?.trim();
      const err     = document.getElementById('dem-error');
      if (!type || !start || !end) {
        if (err) { err.style.display='block'; err.textContent='Veuillez remplir tous les champs.'; } return;
      }
      const apiType = { 'Maladie':'MALADIE','Congé payé':'CONGES_PAYES','RTT':'RTT','Évènement familial':'EVENEMENT_FAMILIAL','Sans solde':'SANS_SOLDE' }[type] || 'CONGES_PAYES';
      const res = await API.absences.create({ type: apiType, dateDebut: start, dateFin: end, motif: comment });
      if (res && res.ok) {
        if (typeof window.closeModal === 'function') window.closeModal('modal-demande');
        await loadAbsences(API);
        toast('Demande envoyée ✓ · En attente de validation');
      } else if (err) { err.style.display='block'; err.textContent='Erreur lors de la demande.'; }
    };

    window.submitCollabAbsence = async function () {
      const start = document.getElementById('collab-abs-start')?.value;
      const end   = document.getElementById('collab-abs-end')?.value;
      if (!start || !end) { toast('Veuillez renseigner les dates'); return; }
      const res = await API.absences.create({ type:'MALADIE', dateDebut: start, dateFin: end, motif: 'Absence maladie' });
      if (typeof window.closeModal === 'function') window.closeModal('modal-collab-absence');
      toast(res && res.ok ? 'Absence déclarée ✓ · Manager notifié' : '⚠ Erreur de déclaration');
    };

    // ── Prépaie ───────────────────────────────────────────────────────────────
    window.validateAll = async function () {
      const checked = document.querySelectorAll('.pp-row-check:checked');
      if (checked.length > 0) {
        let count = 0;
        for (const cb of checked) {
          const r = await API.prepaie.updateStatut(cb.dataset.id, 'VALIDE');
          if (r && r.ok) { const v = (window.ppVars||[]).find(x=>x.id==cb.dataset.id); if(v) { v.status='Validé'; count++; } }
        }
        if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
        toast(count + ' variable(s) validée(s) ✓');
      } else {
        const res = await API.prepaie.validerTout('mars-2026');
        if (res && res.ok) {
          await loadPrepaie(API);
          const d = await res.json();
          toast(d.message || 'Variables validées ✓');
        }
      }
    };

    window.validerPP = async function (id) {
      const res = await API.prepaie.updateStatut(id, 'VALIDE');
      if (res && res.ok) {
        const v = (window.ppVars||[]).find(x=>x.id==id); if(v) v.status='Validé';
        if (typeof window.closeModal === 'function') window.closeModal('modal-pp-detail');
        if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
        toast('Variable validée ✓');
      }
    };

    window.rejectPP = async function (id) {
      const reason = document.getElementById('pp-reject-reason')?.value?.trim();
      const res = await API.prepaie.updateStatut(id, 'ANOMALIE', reason);
      if (res && res.ok) {
        await loadPrepaie(API);
        if (typeof window.closeModal === 'function') window.closeModal('modal-pp-detail');
        toast('Anomalie signalée');
      }
    };

    window.exportCSV = function () { API.prepaie.exportCSV('mars-2026'); toast('Export CSV en cours…'); };

    window.doSilaeExport = async function () {
      const modal = document.getElementById('modal-silae-export');
      if (modal) modal.classList.remove('open');
      API.prepaie.exportCSV('mars-2026');
      toast('Export vers Silae en cours ✓');
    };

    // ── Communication ─────────────────────────────────────────────────────────
    window.submitAnnounce = async function () {
      const title = document.getElementById('announce-title')?.value?.trim();
      const body  = document.getElementById('announce-body')?.value?.trim();
      if (!body) { toast('⚠ Merci de rédiger un message'); return; }
      const res = await API.communication.create({ titre: title || 'Annonce', contenu: body, type: 'ANNONCE' });
      if (res && res.ok) {
        if (typeof window.closeAnnounce === 'function') window.closeAnnounce();
        await loadCommunication(API);
        toast('Message publié ✓');
      } else toast('⚠ Erreur de publication');
    };

    // ── QCM ───────────────────────────────────────────────────────────────────
    const _origSubmitQCM = window.submitQCM;
    window.submitQCM = async function () {
      const campaignId = window._activeCampaignId;
      if (!campaignId) { if (_origSubmitQCM) _origSubmitQCM(); return; }
      // Récupère les réponses depuis le DOM
      const reponses = {};
      document.querySelectorAll('[data-qcm-q]').forEach(el => { reponses[el.dataset.qcmQ] = el.value || el.dataset.val || ''; });
      const res = await API.qcm.repondre(campaignId, reponses);
      if (res && res.ok) { toast('Merci ! Réponses enregistrées ✓'); if (typeof window.renderQCMDone === 'function') window.renderQCMDone(4.2); }
      else if (res && res.status === 409) toast('⚠ Vous avez déjà répondu à ce QCM');
      else if (_origSubmitQCM) _origSubmitQCM();
    };

    // ── Notifications ─────────────────────────────────────────────────────────
    const _origMarkAll = window.markAllNotifRead;
    window.markAllNotifRead = async function () {
      await API.notifications.markAllRead();
      const badge = document.getElementById('notif-count');
      if (badge) { badge.textContent=''; badge.style.display='none'; }
      toast('Tout marqué comme lu ✓');
    };

    const _origToggle = window.toggleNotifPanel;
    window.toggleNotifPanel = async function () {
      if (_origToggle) _origToggle();
      await loadNotifications(API);
    };

    // ── Profil ────────────────────────────────────────────────────────────────
    window.saveProfile = async function () {
      const btn = event?.currentTarget || event?.target;
      const nom       = document.getElementById('profile-nom')?.value?.trim();
      const prenom    = document.getElementById('profile-prenom')?.value?.trim();
      const telephone = document.getElementById('profile-tel')?.value?.trim();
      if (btn) btn.textContent = 'Enregistrement…';
      const res = await API.auth.profile({ nom, prenom, telephone });
      if (res && res.ok) {
        const updated = await res.json();
        localStorage.setItem('pulsiia_user', JSON.stringify({ ...(window.PulsiiaUser()||{}), ...updated }));
        injectUserUI({ ...(window.PulsiiaUser()||{}), ...updated });
        if (btn) { btn.textContent = 'Enregistré ✓'; setTimeout(()=>{ if(btn) btn.textContent='Enregistrer'; }, 2000); }
        toast('Profil mis à jour ✓');
      } else { if (btn) btn.textContent = 'Enregistrer'; toast('⚠ Erreur de mise à jour'); }
    };

    window.changePassword = async function () {
      const curr = document.getElementById('pwd-current')?.value;
      const next  = document.getElementById('pwd-new')?.value;
      const conf  = document.getElementById('pwd-confirm')?.value;
      if (!curr || !next) { toast('Veuillez remplir tous les champs'); return; }
      if (next !== conf)  { toast('⚠ Les mots de passe ne correspondent pas'); return; }
      if (next.length < 8){ toast('⚠ Minimum 8 caractères'); return; }
      const res = await API.auth.password({ currentPassword: curr, newPassword: next });
      if (res && res.ok) { toast('Mot de passe modifié ✓ · Reconnexion…'); setTimeout(() => API.auth.logout(), 1500); }
      else { const d = await res?.json(); toast('⚠ ' + (d?.error || 'Mot de passe actuel incorrect')); }
    };
  }

  // ── Utilitaire toast ──────────────────────────────────────────────────────────
  function toast(msg) {
    if (typeof window.showToast === 'function') { window.showToast(msg); return; }
    // Fallback toast minimal
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, { position:'fixed', bottom:'24px', right:'24px', background:'#0F1117', color:'white', padding:'10px 18px', borderRadius:'8px', fontSize:'13px', zIndex:'9999', boxShadow:'0 4px 16px rgba(0,0,0,.3)' });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

})();
