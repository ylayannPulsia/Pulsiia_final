// tests/users.helpers.test.js — helpers users (sans DB)
const {
  buildUserWhere,
  parseListParam,
  csvEscape,
  buildUserOrderBy,
} = require('../src/routes/users.helpers');

describe('users helpers', () => {
  test('parseListParam splits comma values', () => {
    expect(parseListParam('CDI,CDD')).toEqual(['CDI', 'CDD']);
    expect(parseListParam('')).toEqual([]);
  });

  test('buildUserWhere supports multiple contract types', () => {
    const where = buildUserWhere({ query: { contractTypes: 'CDI,CDD' } }, 'co1');
    expect(where.companyId).toBe('co1');
    expect(where.isActive).toBe(true);
    expect(where.contractType).toEqual({ in: ['CDI', 'CDD'] });
  });

  test('buildUserWhere supports multiple site ids', () => {
    const where = buildUserWhere({ query: { siteIds: 's1,s2' } }, 'co1');
    expect(where.siteId).toEqual({ in: ['s1', 's2'] });
  });

  test('csvEscape quotes special chars', () => {
    expect(csvEscape('hello')).toBe('hello');
    expect(csvEscape('a,b')).toBe('"a,b"');
  });

  test('buildUserOrderBy defaults to lastName', () => {
    expect(buildUserOrderBy('lastName', 'asc')).toEqual([{ lastName: 'asc' }, { firstName: 'asc' }]);
  });
});
