// audit-api.js — Page Historique des actions (AuditLog)
(function () {
  'use strict';

  let auditPage = 1;
  let auditCategory = 'all';
  let auditLoading = false;

  const ACTION_COLORS = {
    'auth.login': { bg: '#F1F5F9', color: '#64748B', icon: '🔐' },
    'pay_variable.create': { bg: '#EFF6FF', color: '#2563EB', icon: '➕' },
    'pay_variable.update': { bg: '#FFFBEB', color: '#D97706', icon: '✏' },
    'pay_variable.sync': { bg: '#EFF6FF', color: '#2563EB', icon: '↻' },
    'pay_variable.validate': { bg: '#ECFDF5', color: '#059669', icon: '✓' },
    'pay_variable.unvalidate': { bg: '#FFFBEB', color: '#D97706', icon: '↩' },
    'pay_variable.reject': { bg: '#FEF2F2', color: '#DC2626', icon: '✕' },
    'pay_variable.delete': { bg: '#FEF2F2', color: '#DC2626', icon: '🗑' },
    'pay_variable.validate_all': { bg: '#ECFDF5', color: '#059669', icon: '✓✓' },
    'pay_variable.export': { bg: '#F5F3FF', color: '#7C3AED', icon: '↓' },
    'absence.create': { bg: '#EFF6FF', color: '#2563EB', icon: '📅' },
    'absence.approve': { bg: '#ECFDF5', color: '#059669', icon: '✓' },
    'absence.refuse': { bg: '#FEF2F2', color: '#DC2626', icon: '✕' },
    'absence.cancel': { bg: '#FFFBEB', color: '#D97706', icon: '↩' },
    'shift.create': { bg: '#EFF6FF', color: '#2563EB', icon: '📋' },
    'shift.update': { bg: '#FFFBEB', color: '#D97706', icon: '✏' },
    'shift.delete': { bg: '#FEF2F2', color: '#DC2626', icon: '🗑' },
    'planning.publish': { bg: '#ECFDF5', color: '#059669', icon: '📅' },
    'planning_ai.generate': { bg: '#F5F3FF', color: '#7C3AED', icon: '✨' },
    'planning_ai.validate': { bg: '#ECFDF5', color: '#059669', icon: '✓' },
    'planning_ai.publish': { bg: '#ECFDF5', color: '#059669', icon: '📤' },
    'planning_ai.delete': { bg: '#FEF2F2', color: '#DC2626', icon: '🗑' },
  };

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('fr-FR', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'à l\'instant';
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `il y a ${h}h`;
    const days = Math.floor(h / 24);
    if (days < 7) return `il y a ${days} jour${days > 1 ? 's' : ''}`;
    return fmtDateTime(iso);
  }

  function actionStyle(action) {
    return ACTION_COLORS[action] || { bg: '#F1F5F9', color: '#64748B', icon: '•' };
  }

  function avatarColor(name) {
    const colors = ['#3B82F6', '#059669', '#7C3AED', '#D97706', '#DC2626', '#0891B2'];
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = (h + name.charCodeAt(i)) % colors.length;
    return colors[h];
  }

  function renderAuditRow(log) {
    const st = actionStyle(log.action);
    const color = avatarColor(log.userName);
    return `<tr style="border-bottom:1px solid var(--border)" onmouseover="this.style.background='#FAFBFC'" onmouseout="this.style.background=''">
      <td style="padding:12px 16px;white-space:nowrap;font-size:12.5px;color:var(--text-2)">
        <div style="font-weight:500;color:var(--text)">${esc(fmtDateTime(log.createdAt))}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(fmtRelative(log.createdAt))}</div>
      </td>
      <td style="padding:12px 16px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:28px;height:28px;border-radius:50%;background:${color};font-size:10px;font-weight:700;color:white;display:flex;align-items:center;justify-content:center;flex-shrink:0">${esc(log.userInitials)}</div>
          <span style="font-size:13px;font-weight:500">${esc(log.userName)}</span>
        </div>
      </td>
      <td style="padding:12px 16px">
        <span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:3px 10px;border-radius:20px;background:${st.bg};color:${st.color}">
          <span>${st.icon}</span>${esc(log.actionLabel)}
        </span>
      </td>
      <td style="padding:12px 16px;font-size:13px;color:var(--text-2);max-width:320px">${esc(log.description)}</td>
      <td style="padding:12px 16px;font-size:11.5px;color:var(--text-3);font-family:'DM Mono',monospace">${esc(log.ipAddress || '—')}</td>
    </tr>`;
  }

  function renderPagination(pagination) {
    const el = document.getElementById('audit-pagination');
    if (!el || !pagination) return;
    const { page, pages, total } = pagination;
    if (pages <= 1) {
      el.innerHTML = `<span style="font-size:12.5px;color:var(--text-2)">${total} action${total !== 1 ? 's' : ''}</span>`;
      return;
    }
    let btns = '';
    btns += `<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px${page === 1 ? ';opacity:.35;pointer-events:none' : ''}" onclick="auditGoPage(${page - 1})">‹</button>`;
    for (let i = 1; i <= pages; i++) {
      if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - page) > 1) {
        if (i === 3 || i === pages - 2) btns += '<span style="padding:0 4px;color:var(--text-3)">…</span>';
        continue;
      }
      const active = i === page ? 'background:var(--blue-light);color:var(--blue);border-color:var(--blue-mid)' : '';
      btns += `<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px;${active}" onclick="auditGoPage(${i})">${i}</button>`;
    }
    btns += `<button class="btn btn-ghost" style="padding:5px 10px;font-size:12px${page === pages ? ';opacity:.35;pointer-events:none' : ''}" onclick="auditGoPage(${page + 1})">›</button>`;
    el.innerHTML = `<span style="font-size:12.5px;color:var(--text-2);margin-right:8px">${total} action${total !== 1 ? 's' : ''}</span>${btns}`;
  }

  async function loadAuditPage() {
    const tbody = document.getElementById('audit-tbody');
    const summary = document.getElementById('audit-summary');
    if (!tbody) return;

    auditLoading = true;
    tbody.innerHTML = '<tr><td colspan="5" style="padding:32px;text-align:center;color:var(--text-3);font-size:13px">Chargement de l\'historique…</td></tr>';
    if (summary) summary.textContent = 'Chargement…';

    try {
      const filters = { page: auditPage, limit: 50 };
      if (auditCategory && auditCategory !== 'all') filters.category = auditCategory;

      const data = await api.auditLogs(filters);
      const logs = data.logs || [];

      document.getElementById('audit-kpi-total').textContent = data.pagination?.total ?? logs.length;

      const today = new Date().toDateString();
      const todayCount = logs.filter((l) => new Date(l.createdAt).toDateString() === today).length;
      const kpiToday = document.getElementById('audit-kpi-today');
      if (kpiToday) kpiToday.textContent = todayCount;

      const prepaieOnPage = logs.filter((l) => l.action?.startsWith('pay_variable.')).length;
      const kpiPrepaie = document.getElementById('audit-kpi-prepaie');
      if (kpiPrepaie) kpiPrepaie.textContent = prepaieOnPage;

      if (!logs.length) {
        tbody.innerHTML = '<tr><td colspan="5" style="padding:40px;text-align:center;color:var(--text-3);font-size:13px">Aucune action enregistrée pour le moment.<br><span style="font-size:12px;margin-top:6px;display:inline-block">Les validations, absences et modifications apparaîtront ici.</span></td></tr>';
      } else {
        tbody.innerHTML = logs.map(renderAuditRow).join('');
      }

      if (summary) {
        const base = data.scope?.label || 'Historique des actions';
        const total = data.pagination?.total ?? 0;
        summary.textContent = total
          ? `${base} · ${total} action${total > 1 ? 's' : ''}`
          : `${base} · aucune action`;
      }

      renderPagination(data.pagination);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="padding:32px;text-align:center;font-size:13px"><div style="color:#991B1B;margin-bottom:12px">${esc(err.error || err.message || 'Impossible de charger l\'historique')}</div><button type="button" class="btn btn-ghost" onclick="loadAuditPage()">Réessayer</button></td></tr>`;
      if (summary) summary.textContent = 'Erreur de chargement';
    } finally {
      auditLoading = false;
    }
  }

  window.auditSetCategory = function (cat, el) {
    auditCategory = cat;
    auditPage = 1;
    document.querySelectorAll('#audit-category-filter .filter-pill').forEach((p) => p.classList.remove('active'));
    if (el) el.classList.add('active');
    loadAuditPage();
  };

  window.auditGoPage = function (p) {
    if (auditLoading || p < 1) return;
    auditPage = p;
    loadAuditPage();
  };

  window.loadAuditPage = loadAuditPage;
})();
