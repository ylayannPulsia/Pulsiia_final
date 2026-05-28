// ============================================================
//  Pulsiia — Page Facturation
//  Accessible via nav → "Facturation" (ADMIN/DRH uniquement)
// ============================================================
(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function formatEuro(amount) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount);
  }

  function formatDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  function statusBadge(status) {
    const map = {
      TRIAL:     { label: 'Essai gratuit', cls: 'badge-blue' },
      ACTIVE:    { label: 'Actif',          cls: 'badge-green' },
      SUSPENDED: { label: 'Suspendu',       cls: 'badge-orange' },
      CANCELLED: { label: 'Annulé',         cls: 'badge-red' },
    };
    const s = map[status] || { label: status, cls: 'badge-grey' };
    return `<span class="badge ${s.cls}">${s.label}</span>`;
  }

  function invoiceStatusBadge(status) {
    const map = {
      DRAFT:     { label: 'Brouillon', cls: 'badge-grey' },
      PENDING:   { label: 'En attente', cls: 'badge-orange' },
      PAID:      { label: 'Payée',      cls: 'badge-green' },
      OVERDUE:   { label: 'En retard',  cls: 'badge-red' },
      CANCELLED: { label: 'Annulée',   cls: 'badge-grey' },
    };
    const s = map[status] || { label: status, cls: 'badge-grey' };
    return `<span class="badge ${s.cls}">${s.label}</span>`;
  }

  // ── Rendu de la page facturation ─────────────────────────────
  async function renderBilling(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1 class="page-title">💳 Facturation</h1>
        <p class="page-subtitle">Abonnement et historique des factures</p>
      </div>
      <div id="billing-content"><div class="loading-spinner"></div></div>
    `;

    try {
      const data = await window.api.billingStatus();

      if (!data.hasSubscription) {
        renderNoSubscription(document.getElementById('billing-content'));
        return;
      }

      renderSubscriptionDashboard(document.getElementById('billing-content'), data);

      // Charge les factures
      const invoices = await window.api.billingInvoices();
      renderInvoices(document.getElementById('billing-invoices'), invoices);

    } catch (err) {
      document.getElementById('billing-content').innerHTML = `
        <div class="alert alert-error">Erreur lors du chargement : ${esc(err.message || err.error || 'Erreur inconnue')}</div>
      `;
    }
  }

  function renderNoSubscription(el) {
    el.innerHTML = `
      <div class="card" style="text-align:center;padding:48px 32px">
        <div style="font-size:48px;margin-bottom:16px">🚀</div>
        <h2 style="margin-bottom:8px">Démarrez votre essai gratuit</h2>
        <p style="color:var(--text-2);margin-bottom:24px">
          30 jours gratuits, puis <strong>6€ par employé actif / mois</strong>.<br>
          Aucune carte bancaire requise.
        </p>
        <button class="btn btn-primary" id="btn-subscribe">Démarrer l'essai gratuit</button>
      </div>
    `;
    document.getElementById('btn-subscribe')?.addEventListener('click', async () => {
      try {
        await window.api.billingSubscribe();
        renderBilling(el.closest('.page-content') || el.parentElement);
      } catch (err) {
        alert('Erreur : ' + (err.error || err.message));
      }
    });
  }

  function renderSubscriptionDashboard(el, data) {
    const { subscription, employeeCount, monthlyAmount, trialDaysLeft, isTrialExpired, pricePerEmployee } = data;

    el.innerHTML = `
      <!-- Carte statut abonnement -->
      <div class="stats-grid" style="margin-bottom:24px">
        <div class="stat-card">
          <div class="stat-label">Statut</div>
          <div class="stat-value">${statusBadge(subscription.status)}</div>
          ${subscription.status === 'TRIAL' ? `
            <div class="stat-sub" style="color:${trialDaysLeft <= 7 ? 'var(--red)' : 'var(--text-2)'}">
              ${isTrialExpired ? '⚠️ Essai expiré' : `${trialDaysLeft} jours restants`}
            </div>
          ` : ''}
        </div>
        <div class="stat-card">
          <div class="stat-label">Employés actifs</div>
          <div class="stat-value">${employeeCount}</div>
          <div class="stat-sub">${formatEuro(pricePerEmployee)} / employé</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Montant mensuel</div>
          <div class="stat-value" style="color:var(--primary)">${formatEuro(monthlyAmount)}</div>
          <div class="stat-sub">TTC / mois</div>
        </div>
        ${subscription.status === 'TRIAL' ? `
        <div class="stat-card">
          <div class="stat-label">Fin d'essai</div>
          <div class="stat-value" style="font-size:16px">${formatDate(subscription.trialEndDate)}</div>
        </div>` : `
        <div class="stat-card">
          <div class="stat-label">Période en cours</div>
          <div class="stat-value" style="font-size:14px">
            ${formatDate(subscription.currentPeriodStart)}<br>→ ${formatDate(subscription.currentPeriodEnd)}
          </div>
        </div>`}
      </div>

      <!-- Calcul tarifaire -->
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h3 class="card-title">📊 Calcul tarifaire</h3>
        </div>
        <div class="card-body">
          <table class="table">
            <tbody>
              <tr>
                <td>Nombre d'employés actifs</td>
                <td><strong>${employeeCount} employés</strong></td>
              </tr>
              <tr>
                <td>Tarif unitaire</td>
                <td>${formatEuro(pricePerEmployee)} / employé / mois</td>
              </tr>
              <tr style="font-size:18px;font-weight:700;color:var(--primary)">
                <td>Total mensuel</td>
                <td>${formatEuro(monthlyAmount)}</td>
              </tr>
            </tbody>
          </table>
          <p style="font-size:12px;color:var(--text-3);margin-top:12px">
            * Facturé le 1er de chaque mois selon le nombre d'employés actifs à cette date.
          </p>
        </div>
      </div>

      <!-- Factures -->
      <div class="card">
        <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
          <h3 class="card-title">📄 Factures</h3>
          <button class="btn btn-secondary btn-sm" id="btn-gen-invoice">Générer la facture du mois</button>
        </div>
        <div class="card-body">
          <div id="billing-invoices"><div class="loading-spinner"></div></div>
        </div>
      </div>
    `;

    document.getElementById('btn-gen-invoice')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-gen-invoice');
      btn.disabled = true;
      btn.textContent = 'Génération…';
      try {
        await window.api.billingGenerateInvoice();
        const invoices = await window.api.billingInvoices();
        renderInvoices(document.getElementById('billing-invoices'), invoices);
        btn.textContent = '✅ Facture générée';
      } catch (err) {
        alert('Erreur : ' + (err.error || err.message));
        btn.disabled = false;
        btn.textContent = 'Générer la facture du mois';
      }
    });
  }

  function renderInvoices(el, invoices) {
    if (!el) return;
    if (!invoices || invoices.length === 0) {
      el.innerHTML = '<p style="color:var(--text-2);text-align:center;padding:24px">Aucune facture pour l\'instant.</p>';
      return;
    }

    el.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Période</th>
            <th>Employés</th>
            <th>Montant</th>
            <th>Échéance</th>
            <th>Statut</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${invoices.map(inv => `
            <tr>
              <td>${formatDate(inv.periodStart)} → ${formatDate(inv.periodEnd)}</td>
              <td>${inv.employeeCount} emp.</td>
              <td><strong>${formatEuro(inv.totalAmount)}</strong></td>
              <td>${formatDate(inv.dueDate)}</td>
              <td>${invoiceStatusBadge(inv.status)}</td>
              <td>
                ${inv.status === 'PENDING' || inv.status === 'OVERDUE' ? `
                  <button class="btn btn-sm btn-primary" onclick="markPaid('${inv.id}')">
                    Marquer payée
                  </button>
                ` : inv.status === 'PAID' ? `<span style="color:var(--green)">✅ ${formatDate(inv.paidAt)}</span>` : '—'}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // Exposé globalement pour les onclick inline
  window.markPaid = async function (invoiceId) {
    try {
      await window.api.billingPayInvoice(invoiceId);
      const invoices = await window.api.billingInvoices();
      renderInvoices(document.getElementById('billing-invoices'), invoices);
    } catch (err) {
      alert('Erreur : ' + (err.error || err.message));
    }
  };

  // ── Enregistrement de la page ─────────────────────────────────
  window.PulsiiaPages = window.PulsiiaPages || {};
  window.PulsiiaPages.billing = renderBilling;

})();
