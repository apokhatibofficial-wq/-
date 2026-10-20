/**
 * API client. The session lives in an HttpOnly cookie the page cannot read; the CSRF token is
 * held in memory only and sent on every state-changing request.
 */
const BASE: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

let csrf: string | null = null;
export const setCsrf = (v: string | null) => { csrf = v; };

export class ApiError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ApiError(res.status, (data.error as string) ?? 'HTTP_' + res.status, data.detail ?? data);
  return data as T;
}

export type Me = {
  id: string; email: string; scope: 'company' | 'hospital'; hospitalId: string | null;
  roles: string[]; permissions: string[];
};

export type Names = { ar: string; en: string; tr: string | null };
export type Status = 'active' | 'suspended' | 'pending';

export type Hospital = {
  id: string; name: Names; status: Status; slug: string; users: number;
  createdAt: string; timezone: string; lastSyncAt: string | null; bookings30d: number;
};

export type HospitalDetail = {
  hospital: Hospital;
  oldSlugs: { slug: string; retiredAt: string; redirectUntil: string }[];
  nextSlugChangeAt: string | null;
};

export type AuditEntry = {
  at: string; action: string; target: string; hospitalId: string | null; actor: string | null;
  meta: Record<string, unknown>;
};

export type Reports = {
  totalBookings: number; averageAttendance: number | null; activeHospitals: number;
  hospitals: { id: string; name: Names; bookings: number; attendance: number | null; noShow: number | null }[];
};

export type LinkInfo = {
  purpose: 'setup' | 'activation' | 'reset'; scope: 'company' | 'hospital'; email: string; totpRequired: boolean;
  totpUri: string | null; totpSecret: string | null; passwordMinLength: number;
};
