const { normalizeIban, formatIban, isValidIban } = require('../src/lib/iban');

describe('iban helpers', () => {
  test('normalizeIban strips spaces and uppercases', () => {
    expect(normalizeIban(' fr76 3000 6000 0112 3456 7890 189 ')).toBe('FR7630006000011234567890189');
    expect(normalizeIban('')).toBeNull();
    expect(normalizeIban(null)).toBeNull();
  });

  test('formatIban groups by 4 characters', () => {
    expect(formatIban('FR7630006000011234567890189')).toBe('FR76 3000 6000 0112 3456 7890 189');
  });

  test('isValidIban accepts known valid IBAN', () => {
    expect(isValidIban('FR7630006000011234567890189')).toBe(true);
  });

  test('isValidIban rejects invalid checksum', () => {
    expect(isValidIban('FR7630006000011234567890180')).toBe(false);
    expect(isValidIban('FR76')).toBe(false);
  });
});
