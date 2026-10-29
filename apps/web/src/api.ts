export type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
export type User = { userId: string; name: string; email: string; organizationId: string; organizationName: string; role: Role };
export type Plan = { code: string; name: string; monthlyPrice: number; status?: string; limits: { seats: number; projects: number; apiRequests: number }; entitlements?: Record<string, boolean> };
export type Dashboard = {
  workspace: { name: string; slug: string; createdAt: string };
  plan: Plan;
  usage: { seats: number; projects: number; apiRequests: number };
  stats: { tasks: number; customers: number };
  taskDistribution: { name: string; value: number }[];
  recentActivity: { id: string; action: string; targetType: string; metadata: Record<string, unknown>; createdAt: string; actor?: { name: string } | null }[];
};
export type Page<T> = { data: T[]; pagination: { page: number; pageSize: number; total: number; pages: number } };

const API = '/api';
let accessToken: string | null = localStorage.getItem('flowsuite_access');
let refreshPromise: Promise<boolean> | null = null;
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(handler: () => void) { unauthorizedHandler = handler; }
export function saveAccessToken(token: string | null) {
  accessToken = token;
  if (token) localStorage.setItem('flowsuite_access', token);
  else localStorage.removeItem('flowsuite_access');
}

async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetch(`${API}/auth/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return false;
      const data = await res.json();
      saveAccessToken(data.accessToken);
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers, credentials: 'include' });
  } catch {
    throw Object.assign(new Error('Cannot reach the FlowSuite API. Check that the API server is running and try again.'), { code: 'NETWORK_ERROR' });
  }
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    if (await refreshSession()) return request<T>(path, init, false);
    saveAccessToken(null);
    unauthorizedHandler?.();
  }
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error?.message ?? body.message ?? `Request failed with status ${response.status}.`), { code: body.error?.code, status: response.status });
  return body as T;
}

export const json = (method: string, data?: unknown): RequestInit => ({ method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
