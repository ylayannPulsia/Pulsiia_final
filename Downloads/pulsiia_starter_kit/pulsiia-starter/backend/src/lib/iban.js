// lib/iban.js — Normalisation et validation IBAN (ISO 13616)

function normalizeIban(value) {
  if (value == null || value === '') return null;
  return String(value).replace(/\s+/g, '').toUpperCase();
}

function formatIban(value) {
  const normalized = normalizeIban(value);
  if (!normalized) return '';
  return normalized.replace(/(.{4})/g, '$1 ').trim();
}

function isValidIban(value) {
  const iban = normalizeIban(value);
  if (!iban) return true;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let numeric = '';
  for (const ch of rearranged) {
    if (ch >= 'A' && ch <= 'Z') numeric += String(ch.charCodeAt(0) - 55);
    else numeric += ch;
  }

  let remainder = 0;
  for (let i = 0; i < numeric.length; i += 7) {
    remainder = Number(String(remainder) + numeric.slice(i, i + 7)) % 97;
  }
  return remainder === 1;
}

module.exports = { normalizeIban, formatIban, isValidIban };
