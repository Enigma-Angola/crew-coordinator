/**
 * Role permissions. Deny by default: anything not listed here is refused.
 *
 * Permissions are deliberately split into view / edit / export / approve / administer so that
 * a role can, for example, view crew changes without being able to approve them.
 * Record scope (organisation, asset, assignment, supplier, own record) is applied separately
 * in authz/scope.ts and in each query.
 */
export const PERMISSIONS = [
  'dashboard:management',
  'dashboard:coordination',
  'dashboard:compliance',
  'dashboard:supplier',
  'dashboard:employee',
  'personnel:view',
  'personnel:edit',
  'personnel:import',
  'identity:view',
  'identity:edit',
  'medical:view',
  'medical:edit',
  'documents:view',
  'documents:upload',
  'credentials:verify',
  'crew_change:view',
  'crew_change:edit',
  'crew_change:approve',
  'crew_change:cancel',
  'request:view',
  'request:edit',
  'request:respond',
  'costs:view',
  'task:view',
  'task:edit',
  'email:view',
  'email:prepare',
  'email:review',
  'email:send',
  'email:associate',
  'template:manage',
  'supplier:manage',
  'mailbox:manage',
  'members:view',
  'members:manage',
  'members:approve',
  'sessions:revoke',
  'settings:manage',
  'audit:view',
  'security:monitor',
  'export:run',
  'ai:use',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = 'org_admin' | 'manager' | 'coordinator' | 'hr_compliance' | 'supplier' | 'employee' | 'auditor';
export const ROLES: Role[] = ['org_admin', 'manager', 'coordinator', 'hr_compliance', 'supplier', 'employee', 'auditor'];

const coordination: Permission[] = [
  'dashboard:coordination', 'personnel:view', 'personnel:import', 'documents:view', 'crew_change:view',
  'crew_change:edit', 'crew_change:cancel', 'request:view', 'request:edit', 'task:view', 'task:edit',
  'email:view', 'email:prepare', 'email:review', 'email:send', 'email:associate', 'export:run', 'ai:use',
  'members:view', 'costs:view',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  org_admin: [
    // Administration of the workspace. Administrators do not automatically see medical data.
    'dashboard:management', 'dashboard:coordination', 'dashboard:compliance', 'personnel:view', 'personnel:edit',
    'personnel:import', 'documents:view', 'crew_change:view', 'request:view', 'task:view', 'task:edit', 'email:view',
    'template:manage', 'supplier:manage', 'mailbox:manage', 'members:view', 'members:manage', 'members:approve',
    'sessions:revoke', 'settings:manage', 'audit:view', 'security:monitor', 'export:run', 'costs:view',
  ],
  manager: [
    'dashboard:management', 'dashboard:coordination', 'dashboard:compliance', 'personnel:view', 'documents:view',
    'crew_change:view', 'crew_change:approve', 'crew_change:cancel', 'request:view', 'costs:view', 'task:view',
    'task:edit', 'email:view', 'email:review', 'members:view', 'export:run', 'ai:use', 'audit:view',
  ],
  coordinator: [...coordination, 'identity:view'],
  hr_compliance: [
    'dashboard:compliance', 'personnel:view', 'personnel:edit', 'personnel:import', 'identity:view', 'identity:edit',
    'medical:view', 'medical:edit', 'documents:view', 'documents:upload', 'credentials:verify', 'crew_change:view',
    'request:view', 'task:view', 'task:edit', 'email:view', 'email:prepare', 'members:view', 'export:run', 'ai:use',
  ],
  supplier: ['dashboard:supplier', 'request:view', 'request:respond'],
  employee: ['dashboard:employee', 'personnel:view', 'documents:view', 'documents:upload', 'crew_change:view', 'request:view', 'task:view'],
  auditor: ['dashboard:management', 'audit:view', 'security:monitor', 'members:view'],
};

/** Actions that need a recent authentication at the IdP (step-up), not just a valid session. */
export const STEP_UP_ACTIONS = new Set([
  'members:manage',
  'members:approve',
  'sessions:revoke',
  'settings:manage',
  'mailbox:manage',
  'template:manage',
  'crew_change:approve',
]);

export function permissionsFor(role: Role): Set<Permission> {
  return new Set(ROLE_PERMISSIONS[role] ?? []);
}

/**
 * A user can only assign roles whose permissions are a subset of their own, and only an
 * organisation administrator can assign roles at all. This prevents self-escalation.
 */
export function canAssignRole(actorRole: Role, targetRole: Role): boolean {
  if (actorRole !== 'org_admin') return false;
  return true;
}

/** Roles that may hold restricted personal data and therefore count as privileged for MFA. */
export function isPrivileged(role: Role, privilegedRoles: string[]) {
  return privilegedRoles.includes(role);
}
