// ops-svc 단위 시험 공용 도우미.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { AdminAuthz, AdminAuthzPort } from '@peaket/platform';

export class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }

  ops(role: 'viewer' | 'operator' | 'commander' = 'operator'): Record<string, string> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role });
    return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '' };
  }
}

export const quiet = (): Writable => new Writable({ write: (_c, _e, cb) => cb() });
