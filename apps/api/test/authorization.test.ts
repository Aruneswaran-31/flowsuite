import { describe, expect, it } from 'vitest';
import { canReadProject, canUpdateTask, hasPermission } from '../src/services/authorization.js';

describe('role-based permissions', () => {
  it('keeps billing and organization-level member controls exclusive to Owners', () => {
    expect(hasPermission('OWNER', 'billing.manage')).toBe(true);
    expect(hasPermission('ADMIN', 'billing.manage')).toBe(false);
    expect(hasPermission('OWNER', 'members.remove')).toBe(true);
    expect(hasPermission('ADMIN', 'members.remove')).toBe(false);
  });

  it('grants workspace operations progressively by role', () => {
    expect(hasPermission('ADMIN', 'customers.manage')).toBe(true);
    expect(hasPermission('MANAGER', 'projects.create')).toBe(true);
    expect(hasPermission('MANAGER', 'members.invite')).toBe(false);
    expect(hasPermission('MEMBER', 'projects.create')).toBe(false);
  });

  it('limits Member project visibility to assigned work', () => {
    expect(canReadProject('MEMBER', false)).toBe(false);
    expect(canReadProject('MEMBER', true)).toBe(true);
    expect(canReadProject('MANAGER', false)).toBe(true);
  });

  it('lets Members update only their own assigned tasks', () => {
    expect(canUpdateTask('MEMBER', 'user-a', 'user-a')).toBe(true);
    expect(canUpdateTask('MEMBER', 'user-a', 'user-b')).toBe(false);
    expect(canUpdateTask('MEMBER', 'user-a', null)).toBe(false);
    expect(canUpdateTask('MANAGER', 'user-a', null)).toBe(true);
  });
});
