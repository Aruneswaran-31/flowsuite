import type { Role } from '@prisma/client';

export type Permission = 'workspace.read' | 'workspace.manage' | 'members.invite' | 'members.role.change' | 'members.remove' | 'projects.create' | 'projects.manage' | 'tasks.assign' | 'tasks.update.assigned' | 'customers.manage' | 'billing.manage' | 'audit.read' | 'analytics.read';

const permissions: Record<Role, Permission[]> = {
  OWNER: ['workspace.read', 'workspace.manage', 'members.invite', 'members.role.change', 'members.remove', 'projects.create', 'projects.manage', 'tasks.assign', 'tasks.update.assigned', 'customers.manage', 'billing.manage', 'audit.read', 'analytics.read'],
  ADMIN: ['workspace.read', 'members.invite', 'projects.create', 'projects.manage', 'tasks.assign', 'tasks.update.assigned', 'customers.manage', 'audit.read', 'analytics.read'],
  MANAGER: ['workspace.read', 'projects.create', 'projects.manage', 'tasks.assign', 'tasks.update.assigned', 'customers.manage'],
  MEMBER: ['workspace.read', 'tasks.update.assigned'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return permissions[role].includes(permission);
}

export function canReadProject(role: Role, isAssignedToProject: boolean): boolean {
  return role !== 'MEMBER' || isAssignedToProject;
}

export function canUpdateTask(role: Role, userId: string, assigneeId: string | null): boolean {
  return role !== 'MEMBER' || (assigneeId !== null && assigneeId === userId);
}
