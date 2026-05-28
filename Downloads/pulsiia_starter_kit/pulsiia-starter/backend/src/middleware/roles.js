// Rôles RBAC — source unique pour authorize()
const MANAGER_ROLES = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
const RH_PAY_ROLES = ['RH', 'DRH', 'ADMIN'];
const ANALYTICS_ROLES = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
const ADMIN_ROLES = ['DRH', 'ADMIN'];
const BATCH_VALIDATE_ROLES = ['DRH', 'ADMIN'];
const STATUS_APPROVERS = ['MANAGER', 'RH', 'DRH', 'ADMIN'];

module.exports = {
  MANAGER_ROLES,
  RH_PAY_ROLES,
  ANALYTICS_ROLES,
  ADMIN_ROLES,
  BATCH_VALIDATE_ROLES,
  STATUS_APPROVERS,
};
