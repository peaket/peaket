// 우선 구매 권리 사본 쓰기 유스케이스(queue.proto SetPriorityGrant, docs/features/queue-admission.md §6 '우선 구매 입장', ADR-0171).
// 부르는 쪽은 ops-svc만이다. 요청 모양이 틀리면 저장소를 읽지 않고 INVALID로 끝내고, 판 번호가 저장한 판보다 클 때만 반영한다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { PRIORITY_GRANT_ID, PRIORITY_GRANT_KEY_PART, type PriorityGrantState } from '../domain/priority-grant.js';
import { PRIORITY_GRANTS, type PriorityGrantStore } from '../domain/ports.js';

export type PriorityGrantErrorCode = 'INVALID';

export class PriorityGrantError extends Error {
  constructor(readonly code: PriorityGrantErrorCode) {
    super(`우선 구매 권리 요청 오류: ${code}`);
    this.name = 'PriorityGrantError';
  }
}

export interface SetPriorityGrantInput {
  readonly accountId: string;
  readonly eventId: string;
  readonly grantId: string;
  readonly state: PriorityGrantState;
  readonly expiresAtMs: number;
  readonly version: number;
}

@Injectable()
export class SetPriorityGrant {
  constructor(
    @Inject(PRIORITY_GRANTS) private readonly store: PriorityGrantStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: SetPriorityGrantInput): Promise<{ changed: boolean }> {
    if (!PRIORITY_GRANT_KEY_PART.test(i.accountId) || !PRIORITY_GRANT_KEY_PART.test(i.eventId)) throw new PriorityGrantError('INVALID');
    if (!PRIORITY_GRANT_ID.test(i.grantId)) throw new PriorityGrantError('INVALID');
    if (i.state !== 'OFFERED' && i.state !== 'WITHDRAWN') throw new PriorityGrantError('INVALID');
    if (!Number.isSafeInteger(i.expiresAtMs) || i.expiresAtMs <= 0) throw new PriorityGrantError('INVALID');
    if (!Number.isSafeInteger(i.version) || i.version < 0) throw new PriorityGrantError('INVALID');
    return this.store.set({ ...i, nowMs: this.clock.now() });
  }
}
