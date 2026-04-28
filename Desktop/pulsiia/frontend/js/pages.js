/**
 * Pulsiia — pages.js
 * Connecte chaque page au backend réel.
 * Stratégie : remplace les tableaux statiques (absences, ppVars...)
 * par les données de l'API, puis appelle les render() existants.
 */
(function () {
  'use strict';

  const API = window.PulsiiaAPI;
  if (!API) return; // api.js non chargé

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function showToast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
    else console.log('[Toast]', msg);
  }

  // ── Mappings API → format statique ──────────────────────────────────────────

  const ABS_STATUT = {
    EN_ATTENTE: 'En attente',
    APPROUVE:   'Validé',
    REFUSE:     'Refusé',
  };
  const ABS_TYPE = {
    MALADIE:            'Maladie',
    CONGES_PAYES:       'Congé payé',
    RTT:                'RTT',
    EVENEMENT_FAMILIAL: 'Évènement familial',
    SANS_SOLDE:         'Sans solde',
  };
  const PP_STATUT = {
    A_VALIDER: 'À valider',
    VALIDE:    'Validé',
    ANOMALIE:  'Anomalie IA',
  };
  const TYPE_TO_API = {
    'Maladie':            'MALADIE',
    'Congé payé':         'CONGES_PAYES',
    'RTT':                'RTT',
    'Évènement familial': 'EVENEMENT_FAMILIAL',
    'Sans solde':         'SANS_SOLDE',
    'Accident travail':   'MALADIE',
  };

  function mapAbsence(a) {
    const nom = a.user ? `${a.user.prenom} ${a.user.nom[0]}.` : '—';
    return {
      id:           a.id,
      collab:       nom,
      type:         ABS_TYPE[a.type] || a.type,
      start:        a.dateDebut,
      end:          a.dateFin,
      status:       ABS_STATUT[a.statut] || a.statut,
      comment:      a.motif || '',
      pj:           null,
      refuseReason: null,
      refuseMsg:    null,
    };
  }

  function mapPPVar(v) {
    const nom = v.user ? `${v.user.prenom} ${v.user.nom[0]}.` : '—';
    return {
      id:      v.id,
      collab:  nom,
      site:    v.user?.site?.nom || '—',
      type:    v.type,
      value:   '+' + v.montant + '€',
      source:  'Planning auto',
      status:  PP_STATUT[v.statut] || v.statut,
      anomaly: v.anomalie || null,
    };
  }

  // ── Loader par page ──────────────────────────────────────────────────────────

  const loaders = {

    // Dashboard
    async dashboard() {
      try {
        const res = await API.dashboard.kpis();
        if (!res || !res.ok) return;
        const k = await res.json();

        // Mise à jour des 3 KPI cards opérationnelles
        const planningBadge = document.querySelector('#page-dashboard span[style*="FECACA"]');
        if (planningBadge) planningBadge.textContent = k.shiftsDecouverts + ' découvert' + (k.shiftsDecouverts > 1 ? 's' : '');

        const prepaieBadge = document.querySelector('#page-dashboard span[style*="D97706"][style*="à valider"], #page-dashboard span[style*="FDE68A"]');
        if (prepaieBadge) prepaieBadge.textContent = k.variablesAValider + ' à valider';

        const absencesBadge = document.querySelector('#page-dashboard span[style*="demandes"], #page-dashboard span[style*="FFFBEB"]:not([style*="D97706"])');
        // Mise à jour badge nav prépaie
        const badgePrepaie = document.getElementById('badge-prepaie');
        if (badgePrepaie) {
          badgePrepaie.textContent = k.variablesAValider;
          badgePrepaie.style.display = k.variablesAValider ? '' : 'none';
        }

        // Greeting dynamique
        const user = window.PulsiiaUser ? window.PulsiiaUser() : null;
        if (user) {
          const greet = document.querySelector('#page-dashboard h2');
          if (greet) greet.textContent = `Bonjour, ${user.prenom} 👋`;
        }
      } catch (e) { /* keep static data on error */ }

      // Notifications count
      try {
        const r2 = await API.notifications.list();
        if (r2 && r2.ok) {
          const { unread } = await r2.json();
          const badge = document.getElementById('notif-count');
          if (badge) {
            badge.textContent = unread || '';
            badge.style.display = unread ? '' : 'none';
          }
        }
      } catch(e) {}
    },

    // Absences
    async absences() {
      try {
        const res = await API.absences.list();
        if (!res || !res.ok) return;
        const data = await res.json();
        // Remplace le tableau statique global
        window.absences = data.map(mapAbsence);
        if (typeof window.renderAbsences === 'function') window.renderAbsences();
      } catch (e) { console.warn('absences load error', e); }
    },

    // Planning
    async planning() {
      try {
        const res = await API.planning.list();
        if (!res || !res.ok) return;
        const shifts = await res.json();
        // On peut juste re-render avec les données existantes ici
        // Le rendu planning est complexe, on laisse le statique mais on enrichit les KPIs
        const badge = document.getElementById('badge-planning');
        const decouverts = shifts.filter(s => s.statut === 'REMPLACEMENT_REQUIS').length;
        if (badge) {
          badge.textContent = decouverts;
          badge.style.display = decouverts ? '' : 'none';
        }
      } catch (e) {}
    },

    // Prépaie
    async prepaie() {
      try {
        const res = await API.prepaie.list();
        if (!res || !res.ok) return;
        const { variables, stats } = await res.json();
        window.ppVars = variables.map(mapPPVar);
        if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
        if (typeof window.renderMonthlyView === 'function') window.renderMonthlyView();
      } catch (e) { console.warn('prepaie load error', e); }
    },

    // Collaborateurs
    async collaborateurs() {
      try {
        const res = await API.collaborateurs.list();
        if (!res || !res.ok) return;
        const data = await res.json();
        // Remplace COLLABS global si utilisé par render
        window.COLLABS = data.map(c => ({
          name:    `${c.prenom} ${c.nom}`,
          poste:   c.poste || '—',
          site:    c.site?.nom || '—',
          email:   c.email,
          tel:     c.telephone || '—',
          contrat: 'CDI',
          id:      c.id,
        }));
        // renderCollaborateurs n'existe pas en statique, rien de plus à faire
      } catch (e) {}
    },

    // Documents
    async documents() {
      try {
        const res = await API.documents.list();
        if (!res || !res.ok) return;
        // renderDocs() utilise une variable interne docs — on la surcharge si exposée
        const data = await res.json();
        if (window.docs !== undefined) {
          window.docs = data.map(d => ({
            id:      d.id,
            name:    d.nom,
            type:    d.type,
            periode: d.periode || '—',
            size:    d.taille || '—',
            collab:  d.user ? `${d.user.prenom} ${d.user.nom}` : '—',
          }));
          if (typeof window.renderDocs === 'function') window.renderDocs();
        }
      } catch (e) {}
    },

    // Communication
    async communication() {
      try {
        const res = await API.communication.list();
        if (!res || !res.ok) return;
        const data = await res.json();
        if (data.length && window.COMM_MSGS) {
          const msgs = data.map(m => ({
            id:       m.id,
            user:     `${m.auteur?.prenom || ''} ${m.auteur?.nom || ''}`.trim(),
            initials: ((m.auteur?.prenom || 'P')[0] + (m.auteur?.nom || 'U')[0]).toUpperCase(),
            color:    '#2563EB',
            role:     m.auteur?.role === 'RH' ? 'DRH' : 'Manager',
            time:     new Date(m.createdAt).toLocaleDateString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }),
            text:     m.contenu,
            pinned:   false,
            reactions:{ '👍': { count: 0, reacted: false } },
            replies:  [],
          }));
          window.COMM_MSGS['general'] = [...msgs, ...(window.COMM_MSGS['general'] || [])];
          if (typeof window.renderChanFeed === 'function') window.renderChanFeed('general');
        }
      } catch (e) {}
    },

    // QCM / Bien-être
    async qcm() {
      try {
        const res = await API.qcm.list();
        if (!res || !res.ok) return;
        const campaigns = await res.json();
        if (campaigns.length) {
          const c = campaigns[0];
          window._activeCampaignId = c.id;
          const subtitle = document.getElementById('be-qcm-subtitle');
          if (subtitle) subtitle.textContent = `${c.questions?.length || 4} questions · ${c._count?.reponses || 0} réponses anonymisées`;
        }
      } catch (e) {}
    },

    // Notifications
    async notifications() {
      try {
        const res = await API.notifications.list();
        if (!res || !res.ok) return;
        const { notifications, unread } = await res.json();
        const badge = document.getElementById('notif-count');
        if (badge) { badge.textContent = unread || ''; badge.style.display = unread ? '' : 'none'; }
        // Injecter dans le panel notif si ouvert
        renderNotifPanel(notifications);
      } catch (e) {}
    },

    // Pages collab
    async 'mon-planning'() { await loaders.planning(); },
    async 'mes-docs'() { await loaders.documents(); },
    async 'accueil-collab'() { await loaders.dashboard(); },
  };

  function renderNotifPanel(notifications) {
    const body = document.getElementById('notif-panel-body');
    if (!body || !notifications) return;
    if (!notifications.length) {
      body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Aucune notification</div>';
      return;
    }
    body.innerHTML = notifications.slice(0, 10).map(n => `
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;background:${n.lu ? 'white' : '#EFF6FF'}"
           onclick="PulsiiaAPI.notifications.markRead('${n.id}');this.style.background='white'">
        <div style="font-size:13px;font-weight:${n.lu ? '400' : '600'};color:var(--text);margin-bottom:2px">${n.titre}</div>
        <div style="font-size:12px;color:var(--text-2)">${n.message}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">${new Date(n.createdAt).toLocaleString('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</div>
      </div>`).join('');
  }

  // ── Hook showPage ────────────────────────────────────────────────────────────

  const _origShowPage = window.showPage;
  window.showPage = function (name, navEl) {
    if (_origShowPage) _origShowPage(name, navEl);
    const loader = loaders[name];
    if (loader) loader().catch(console.warn);
  };

  // ── Override : Absences ──────────────────────────────────────────────────────

  window.quickValidate = async function (id) {
    const res = await API.absences.updateStatut(id, 'APPROUVE');
    if (res && res.ok) {
      const a = window.absences?.find(x => x.id === id);
      if (a) { a.status = 'Validé'; }
      if (typeof window.renderAbsences === 'function') window.renderAbsences();
      showToast((a?.collab || 'Absence') + ' — Demande validée ✓');
    } else {
      showToast('⚠ Erreur lors de la validation');
    }
  };

  const _origConfirmRefuse = window.confirmRefuse;
  window.confirmRefuse = async function () {
    const reason = document.getElementById('abs-refuse-reason')?.value;
    if (!reason) { showToast('Veuillez sélectionner un motif'); return; }
    const id = window.absRefuseTargetId;
    const res = await API.absences.updateStatut(id, 'REFUSE');
    if (res && res.ok) {
      const a = window.absences?.find(x => x.id === id);
      if (a) { a.status = 'Refusé'; a.refuseReason = reason; }
      if (typeof window.closeModal === 'function') window.closeModal('modal-abs-refuse');
      if (typeof window.renderAbsences === 'function') window.renderAbsences();
      showToast('Demande refusée · ' + (a?.collab || '') + ' notifié(e)');
    } else {
      showToast('⚠ Erreur lors du refus');
    }
  };

  window.validateAllPending = async function () {
    const user = window.PulsiiaUser ? window.PulsiiaUser() : null;
    if (!user || !['RH', 'MANAGER'].includes(user.role)) {
      showToast('Accès réservé aux RH');
      return;
    }
    const pending = window.absences?.filter(a => a.status === 'En attente') || [];
    if (!pending.length) { showToast('Aucune demande en attente'); return; }
    for (const a of pending) {
      const res = await API.absences.updateStatut(a.id, 'APPROUVE');
      if (res && res.ok) a.status = 'Validé';
    }
    if (typeof window.renderAbsences === 'function') window.renderAbsences();
    showToast(pending.length + ' demande(s) validée(s) ✓');
  };

  window.saveDeclare = async function () {
    const collab  = document.getElementById('dec-collab')?.value;
    const type    = document.getElementById('dec-type')?.value;
    const start   = document.getElementById('dec-start')?.value;
    const end     = document.getElementById('dec-end')?.value;
    const comment = document.getElementById('dec-comment')?.value?.trim();
    const err     = document.getElementById('dec-error');
    if (!collab || !type || !start || !end) {
      if (err) { err.style.display = 'block'; err.textContent = 'Veuillez remplir tous les champs.'; }
      return;
    }
    // Cherche l'ID du collab dans COLLABS
    const collabObj = window.COLLABS?.find(c => c.name === collab);
    const res = await API.absences.create({
      type: TYPE_TO_API[type] || 'CONGES_PAYES',
      dateDebut: start,
      dateFin: end,
      motif: comment,
      userId: collabObj?.id,
    });
    if (res && res.ok) {
      if (typeof window.closeModal === 'function') window.closeModal('modal-declare');
      await loaders.absences();
      showToast('Absence déclarée · Planning & paie mis à jour ✓');
    } else {
      if (err) { err.style.display = 'block'; err.textContent = 'Erreur lors de la déclaration.'; }
    }
  };

  window.saveDemande = async function () {
    const type    = document.getElementById('dem-type')?.value;
    const start   = document.getElementById('dem-start')?.value;
    const end     = document.getElementById('dem-end')?.value;
    const comment = document.getElementById('dem-comment')?.value?.trim();
    const err     = document.getElementById('dem-error');
    if (!type || !start || !end) {
      if (err) { err.style.display = 'block'; err.textContent = 'Veuillez remplir tous les champs.'; }
      return;
    }
    const res = await API.absences.create({
      type: TYPE_TO_API[type] || 'CONGES_PAYES',
      dateDebut: start,
      dateFin: end,
      motif: comment,
    });
    if (res && res.ok) {
      if (typeof window.closeModal === 'function') window.closeModal('modal-demande');
      await loaders.absences();
      showToast('Demande envoyée · En attente de validation ✓');
    } else {
      if (err) { err.style.display = 'block'; err.textContent = 'Erreur lors de la demande.'; }
    }
  };

  window.submitCollabAbsence = async function () {
    const start = document.getElementById('collab-abs-start')?.value;
    const end   = document.getElementById('collab-abs-end')?.value;
    if (!start || !end) { showToast('Veuillez renseigner les dates'); return; }
    const res = await API.absences.create({
      type: 'MALADIE',
      dateDebut: start,
      dateFin: end,
      motif: 'Absence maladie déclarée via app',
    });
    if (typeof window.closeModal === 'function') window.closeModal('modal-collab-absence');
    if (res && res.ok) {
      showToast('Absence déclarée ✓ · Votre manager est notifié');
    } else {
      showToast('⚠ Erreur lors de la déclaration');
    }
  };

  // ── Override : Prépaie ───────────────────────────────────────────────────────

  window.validateAll = async function () {
    const checked = document.querySelectorAll('.pp-row-check:checked');
    if (checked.length > 0) {
      // Valider les cases cochées
      let count = 0;
      for (const cb of checked) {
        const id = cb.dataset.id;
        const v = window.ppVars?.find(x => x.id === id || x.id === parseInt(id));
        if (v && v.status === 'À valider') {
          const res = await API.prepaie.updateStatut(id, 'VALIDE');
          if (res && res.ok) { v.status = 'Validé'; count++; }
        }
      }
      if (count) { if (typeof window.renderPrepaie === 'function') window.renderPrepaie(); showToast(count + ' variable(s) validée(s) ✓'); }
      else showToast('Aucune variable sélectionnée à valider');
    } else {
      // Valider tout
      const res = await API.prepaie.validerTout('mars-2026');
      if (res && res.ok) {
        await loaders.prepaie();
        const data = await res.json();
        showToast(data.message || 'Variables validées ✓');
      }
    }
  };

  window.savePPVariable = async function () {
    const collab  = document.getElementById('pp-add-collab')?.value;
    const type    = document.getElementById('pp-add-type')?.value;
    const value   = document.getElementById('pp-add-value')?.value;
    const err     = document.getElementById('pp-add-error');
    if (!collab || !type || !value) {
      if (err) { err.style.display='block'; err.textContent='Veuillez remplir tous les champs.'; }
      return;
    }
    const montant = parseFloat(value.replace(/[^0-9.,]/g,'').replace(',','.')) || 0;
    const collabObj = window.COLLABS?.find(c => c.name === collab);
    const res = await API.prepaie.create({
      userId:  collabObj?.id || collab,
      periode: 'mars-2026',
      type,
      montant,
    });
    if (res && res.ok) {
      if (typeof window.closeModal === 'function') window.closeModal('modal-pp-add');
      await loaders.prepaie();
      showToast('Variable ajoutée ✓');
    } else {
      if (err) { err.style.display='block'; err.textContent='Erreur lors de l\'ajout.'; }
    }
  };

  window.exportCSV = function () {
    API.prepaie.exportCSV('mars-2026');
    showToast('Export CSV en cours…');
  };

  window.doSilaeExport = async function () {
    const ok    = window.ppVars?.filter(v => v.status === 'Validé').length || 0;
    const modal = document.getElementById('modal-silae-export');
    if (modal) modal.classList.remove('open');
    API.prepaie.exportCSV('mars-2026');
    showToast(`Export Silae : ${ok} variable(s) validée(s) envoyées ✓`);
  };

  // Override inline valider/refuser dans les rows prépaie
  window.validerPP = async function (id) {
    const res = await API.prepaie.updateStatut(id, 'VALIDE');
    if (res && res.ok) {
      const v = window.ppVars?.find(x => x.id === id || x.id === parseInt(id));
      if (v) v.status = 'Validé';
      if (typeof window.renderPrepaie === 'function') window.renderPrepaie();
      if (typeof window.closeModal === 'function') window.closeModal('modal-pp-detail');
      showToast('Variable validée ✓');
    }
  };

  window.rejectPP = async function (id) {
    const reason = document.getElementById('pp-reject-reason')?.value?.trim() || '';
    const res = await API.prepaie.updateStatut(id, 'ANOMALIE', reason);
    if (res && res.ok) {
      await loaders.prepaie();
      if (typeof window.closeModal === 'function') window.closeModal('modal-pp-detail');
      showToast('Variable marquée comme anomalie');
    }
  };

  // ── Override : Communication ─────────────────────────────────────────────────

  window.submitAnnounce = async function () {
    const title = document.getElementById('announce-title')?.value?.trim();
    const body  = document.getElementById('announce-body')?.value?.trim();
    if (!body) { showToast('⚠ Merci de rédiger un message'); return; }
    const res = await API.communication.create({
      titre:   title || 'Annonce',
      contenu: body,
      type:    'ANNONCE',
    });
    if (res && res.ok) {
      if (typeof window.closeAnnounce === 'function') window.closeAnnounce();
      else if (typeof window.closeModal === 'function') window.closeModal('modal-announce');
      await loaders.communication();
      showToast('Message publié ✓');
    } else {
      showToast('⚠ Erreur lors de la publication');
    }
  };

  // ── Override : QCM ───────────────────────────────────────────────────────────

  const _origSubmitQCM = window.submitQCM;
  window.submitQCM = async function () {
    const campaignId = window._activeCampaignId;
    if (!campaignId) { if (_origSubmitQCM) _origSubmitQCM(); return; }

    // Récupère les réponses depuis le DOM
    const reponses = {};
    document.querySelectorAll('[data-qcm-question]').forEach(el => {
      reponses[el.dataset.qcmQuestion] = el.value || el.dataset.value || '';
    });
    // Si aucun champ data-qcm-question, appelle l'original
    if (!Object.keys(reponses).length) { if (_origSubmitQCM) _origSubmitQCM(); return; }

    const res = await API.qcm.repondre(campaignId, reponses);
    if (res && res.ok) {
      showToast('Réponses enregistrées ✓ Merci !');
      if (typeof window.renderQCMDone === 'function') window.renderQCMDone(4.2);
    } else {
      showToast('⚠ Vous avez déjà répondu à ce QCM');
    }
  };

  // ── Override : Notifications ─────────────────────────────────────────────────

  window.markAllNotifRead = async function () {
    await API.notifications.markAllRead();
    const badge = document.getElementById('notif-count');
    if (badge) { badge.textContent = ''; badge.style.display = 'none'; }
    // Vider les points non-lus dans le panel
    document.querySelectorAll('[style*="EFF6FF"]').forEach(el => el.style.background = 'white');
    showToast('Toutes les notifications lues ✓');
  };

  // Surcharge toggleNotifPanel pour charger depuis l'API
  const _origToggleNotif = window.toggleNotifPanel;
  window.toggleNotifPanel = async function () {
    if (_origToggleNotif) _origToggleNotif();
    await loaders.notifications();
  };

  // ── Override : Profil ────────────────────────────────────────────────────────

  window.saveProfile = async function () {
    const btn = event?.target;
    const nom       = document.getElementById('profile-nom')?.value?.trim();
    const prenom    = document.getElementById('profile-prenom')?.value?.trim();
    const telephone = document.getElementById('profile-tel')?.value?.trim();
    if (btn) { btn.textContent = 'Enregistrement…'; btn.disabled = true; }
    const res = await API.auth.profile({ nom, prenom, telephone });
    if (btn) { btn.textContent = 'Enregistré ✓'; btn.disabled = false; setTimeout(() => { btn.textContent = 'Enregistrer'; }, 2000); }
    if (res && res.ok) {
      const updated = await res.json();
      localStorage.setItem('pulsiia_user', JSON.stringify({ ...window.PulsiiaUser(), ...updated }));
      const nameEl = document.getElementById('sidebar-user-name');
      if (nameEl) nameEl.textContent = `${updated.prenom} ${updated.nom}`;
      showToast('Profil mis à jour ✓');
    }
  };

  window.changePassword = async function () {
    const curr = document.getElementById('pwd-current')?.value;
    const next  = document.getElementById('pwd-new')?.value;
    const conf  = document.getElementById('pwd-confirm')?.value;
    if (!curr || !next || !conf) { showToast('Veuillez remplir tous les champs'); return; }
    if (next !== conf) { showToast('⚠ Les mots de passe ne correspondent pas'); return; }
    if (next.length < 8) { showToast('⚠ Minimum 8 caractères'); return; }
    const res = await API.auth.changePassword({ currentPassword: curr, newPassword: next });
    if (res && res.ok) {
      showToast('Mot de passe modifié ✓ · Reconnexion…');
      setTimeout(() => API.auth.logout(), 1500);
    } else {
      const err = await res?.json();
      showToast('⚠ ' + (err?.error || 'Mot de passe actuel incorrect'));
    }
  };

  // ── Initialisation au chargement ─────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    // Précharger le dashboard
    loaders.dashboard().catch(() => {});

    // Wirer le bouton logout de la sidebar
    const card = document.getElementById('sidebar-user-card');
    if (card && !card._logoutWired) {
      card._logoutWired = true;
      card.style.cursor = 'pointer';
      card.title = 'Cliquer pour se déconnecter';
      card.addEventListener('click', () => {
        if (confirm('Se déconnecter de Pulsiia ?')) API.auth.logout();
      });
    }
  });

})();
