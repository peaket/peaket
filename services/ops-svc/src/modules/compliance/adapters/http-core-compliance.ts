// core-svc 내부 통보 경로 클라이언트(F-07-11). 서비스 사이 공유 토큰을 쓴다.
import type { ExternalHttpClient } from '@peaket/platform';
import type { ComplianceApplyInput, ComplianceApplyResult, ComplianceCore, ComplianceWithdrawInput, ComplianceWithdrawResult } from '../domain/ports.js';

const TIMEOUT_MS = 5_000;

export class HttpCoreCompliance implements ComplianceCore {
  constructor(
    private readonly client: Pick<ExternalHttpClient, 'request'>,
    private readonly internalToken?: string,
  ) {}

  async applyNotice(input: ComplianceApplyInput): Promise<ComplianceApplyResult> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/reviews/notice-takedowns',
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify(input),
      timeoutCapMs: TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`core-svc notice takedown ${res.status}`);
    const body = (await res.json()) as Partial<ComplianceApplyResult>;
    if (typeof body.applied !== 'number' || typeof body.skipped !== 'number' || typeof body.deadlineAt !== 'string') throw new Error('core-svc notice takedown 응답 모양이 다르다');
    return { applied: body.applied, skipped: body.skipped, deadlineAt: body.deadlineAt };
  }

  async withdrawNotice(input: ComplianceWithdrawInput): Promise<ComplianceWithdrawResult> {
    const res = await this.client.request({
      method: 'POST',
      path: '/internal/v1/reviews/notice-takedowns/{noticeId}/withdrawal',
      params: { noticeId: input.noticeId },
      headers: { 'content-type': 'application/json', ...(this.internalToken ? { 'x-peaket-internal-token': this.internalToken } : {}) },
      body: JSON.stringify({ reason: input.reason }),
      timeoutCapMs: TIMEOUT_MS,
    });
    if (!res.ok) throw new Error(`core-svc notice withdrawal ${res.status}`);
    const body = (await res.json()) as Partial<ComplianceWithdrawResult>;
    if (typeof body.restored !== 'number' || typeof body.sameContentRestored !== 'number' || typeof body.fingerprintsCleared !== 'number') throw new Error('core-svc notice withdrawal 응답 모양이 다르다');
    return { restored: body.restored, sameContentRestored: body.sameContentRestored, fingerprintsCleared: body.fingerprintsCleared };
  }
}
