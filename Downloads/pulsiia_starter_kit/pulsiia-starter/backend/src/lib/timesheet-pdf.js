// Génération PDF minimal pour feuilles d'heures (sans dépendance externe)

function pdfEscape(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function wrapLines(text, maxLen) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxLen) {
      if (current) lines.push(current);
      current = word.length > maxLen ? word.slice(0, maxLen) : word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function buildTextStream(commands) {
  return commands.join('\n');
}

function createSimplePdf({ title, subtitle, sections, footerLines }) {
  const commands = [];
  let y = 790;

  const addLine = (text, opts = {}) => {
    const size = opts.size || 10;
    const x = opts.x || 50;
    const lines = opts.wrap ? wrapLines(text, opts.wrap) : [text];
    for (const line of lines) {
      if (y < 60) break;
      commands.push(`BT /F1 ${size} Tf ${x} ${y} Td (${pdfEscape(line)}) Tj ET`);
      y -= opts.spacing || (size + 4);
    }
  };

  addLine(title, { size: 16, spacing: 22 });
  if (subtitle) addLine(subtitle, { size: 11, spacing: 18, x: 50 });

  y -= 6;
  for (const section of sections || []) {
    if (section.heading) {
      addLine(section.heading, { size: 12, spacing: 16 });
    }
    for (const row of section.rows || []) {
      addLine(row, { size: 9, spacing: 12, wrap: 90 });
    }
    y -= 8;
  }

  y = Math.max(y, 80);
  for (const line of footerLines || []) {
    addLine(line, { size: 8, spacing: 10, x: 50 });
  }

  const stream = buildTextStream(commands);
  const streamLen = Buffer.byteLength(stream, 'utf8');

  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj',
    `4 0 obj<< /Length ${streamLen} >>stream\n${stream}\nendstream\nendobj`,
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${obj}\n`;
  }

  const xrefPos = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;

  return Buffer.from(pdf, 'utf8');
}

const { periodLabel } = require('./period-utils');

function formatPeriodLabel(period) {
  return periodLabel(period);
}

function formatShiftLine(shift) {
  const date = shift.date instanceof Date
    ? shift.date.toISOString().slice(0, 10)
    : String(shift.date).slice(0, 10);
  const day = new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  if (shift.type === 'OFF') {
    return `${day} — Repos`;
  }
  const times = [shift.startTime, shift.endTime].filter(Boolean).join(' – ');
  const pause = shift.breakMin ? ` (pause ${shift.breakMin} min)` : '';
  return `${day} — ${shift.type}${times ? ` ${times}` : ''}${pause}`;
}

function formatVariableLine(v, typeLabels) {
  const label = typeLabels[v.type] || v.type;
  const sign = v.value >= 0 ? '+' : '−';
  const abs = Math.abs(v.value);
  let val = `${sign}${abs}`;
  if (v.unit === 'h') val += 'h';
  else if (v.unit === '€') val += '€';
  else if (v.unit === 'jours') val += ' j';
  return `${label} : ${val} (${v.status || '—'})`;
}

function buildTimesheetPdf({
  companyName,
  user,
  period,
  reference,
  variables,
  shifts,
  typeLabels,
  statusLabels,
}) {
  const periodLabel = formatPeriodLabel(period);
  const collabName = `${user.firstName} ${user.lastName}`;
  const siteName = user.site?.name || '—';
  const generatedAt = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

  const varRows = (variables || []).map((v) => formatVariableLine({
    ...v,
    status: statusLabels[v.status] || v.status,
  }, typeLabels));

  const shiftRows = (shifts || [])
    .filter((s) => s.type !== 'OFF')
    .slice(0, 31)
    .map(formatShiftLine);

  const sections = [
    {
      heading: 'Collaborateur',
      rows: [
        `Nom : ${collabName}`,
        `Établissement : ${siteName}`,
        `Période : ${periodLabel}`,
        `Référence : ${reference || '—'}`,
      ],
    },
    {
      heading: 'Variables de paie (pré-paie)',
      rows: varRows.length ? varRows : ['Aucune variable pour cette période.'],
    },
  ];

  if (shiftRows.length) {
    sections.push({
      heading: 'Planning — créneaux travaillés',
      rows: shiftRows,
    });
  }

  sections.push({
    heading: 'Attestation',
    rows: [
      'Je soussigné(e) atteste l\'exactitude des heures et variables ci-dessus pour la période indiquée.',
      'Signature collaborateur : ________________________________    Date : ____________',
      'Visa responsable / RH : ________________________________    Date : ____________',
    ],
  });

  return createSimplePdf({
    title: 'Feuille d\'heures',
    subtitle: `${companyName || 'Pulsiia'} · ${periodLabel}`,
    sections,
    footerLines: [
      `Document généré le ${generatedAt} par Pulsiia · Confidentiel RH`,
      'Signature électronique eIDAS via Yousign (prestataire agréé).',
    ],
  });
}

module.exports = {
  createSimplePdf,
  buildTimesheetPdf,
  formatPeriodLabel,
};
