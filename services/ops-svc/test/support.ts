// ops-svc 단위 시험 공용 도우미.
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { AdminAuthz, AdminAuthzPort } from '@peaket/platform';

export class FakeIdentity implements AdminAuthzPort {
  readonly answers = new Map<string, AdminAuthz>();
  async getAdminAuthz(q: { adminAccountId: string; sessionId: string }): Promise<AdminAuthz> {
    return this.answers.get(`${q.adminAccountId}/${q.sessionId}`) ?? { valid: false, role: '' };
  }

  ops(role: 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead' = 'operator'): Record<string, string> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role });
    return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '' };
  }

  /** 파트너 계정 하나(BAT-420 GAT-110 P). tenantId가 undefined면 테넌트 없는 세션이다 */
  partner(tenantId: string | undefined, role: 'partner_admin' | 'partner_member' = 'partner_admin'): Record<string, string> {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    this.answers.set(`${accountId}/${sessionId}`, { valid: true, role, ...(tenantId !== undefined ? { tenantId } : {}) });
    return { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'partner', 'x-user-scope': '' };
  }
}

export const quiet = (): Writable => new Writable({ write: (_c, _e, cb) => cb() });
