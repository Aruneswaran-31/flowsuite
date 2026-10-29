import { describe, expect, it } from 'vitest';
import { canReadProject, canUpdateTask } from '../src/services/authorization.js';

type MockProject = { id: string; organizationId: string; assignedMembers: string[] };
type MockTask = { id: string; organizationId: string; assigneeId: string | null };

function listProjects(records: MockProject[], organizationId: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER', userId: string) {
  return records.filter((record) => record.organizationId === organizationId && canReadProject(role, record.assignedMembers.includes(userId)));
}

function readTask(records: MockTask[], organizationId: string, id: string, role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER', userId: string) {
  const task = records.find((record) => record.id === id && record.organizationId === organizationId);
  if (!task || (role === 'MEMBER' && !canUpdateTask(role, userId, task.assigneeId))) return null;
  return task;
}

describe('tenant isolation', () => {
  const projects = [
    { id: 'project-a', organizationId: 'org-a', assignedMembers: ['user-a'] },
    { id: 'project-b', organizationId: 'org-b', assignedMembers: ['user-b'] },
  ];
  const tasks = [
    { id: 'task-a', organizationId: 'org-a', assigneeId: 'user-a' },
    { id: 'task-b', organizationId: 'org-b', assigneeId: 'user-b' },
  ];

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const)('prevents a %s from reading another tenant project', (role) => {
    const ownProjects = listProjects(projects, 'org-a', role, role === 'MEMBER' ? 'user-a' : 'admin-a');
    expect(ownProjects.map((project) => project.id)).toEqual(role === 'MEMBER' ? ['project-a'] : ['project-a']);
    expect(ownProjects.some((project) => project.organizationId === 'org-b')).toBe(false);
  });

  it.each(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const)('prevents a %s from reading another tenant task by id', (role) => {
    expect(readTask(tasks, 'org-a', 'task-b', role, role === 'MEMBER' ? 'user-a' : 'admin-a')).toBeNull();
    expect(readTask(tasks, 'org-a', 'task-a', role, role === 'MEMBER' ? 'user-a' : 'admin-a')?.organizationId).toBe('org-a');
  });
});
