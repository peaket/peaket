// 이의 제기·소명 계류 알림(AccountHoldService.SetAccountHold, ops-svc만, docs/data.md account_hold, ADR-0148 결정 5, BUILD_ORDER BOT-042).
// 판 번호가 저장한 판보다 클 때만 쓴다. 같은 건에 다른 계정·종류면 CONFLICT(ALREADY_EXISTS). identity에 없는 계정이면 NOT_FOUND(외래키, BOT-042가 넘긴 것).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_STORE, type SessionStore } from '../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class SetAccountHold {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** @throws Error 값 모양이 틀림(받는 층이 INVALID_ARGUMENT로) */
  async run(i: { sourceRef: string; accountId: string; kind: 'VERIFICATION_APPEAL' | 'DISPUTE' | 'APPEAL'; state: 'OPEN' | 'CLOSED'; sourceVersion: number }): Promise<'APPLIED' | 'STALE' | 'CONFLICT' | 'NOT_FOUND'> {
    const sourceRef = i.sourceRef.toLowerCase();
    const accountId = i.accountId.toLowerCase();
    if (!UUID.test(sourceRef) || !UUID.test(accountId)) throw new Error('source_ref·account_id는 UUID다');
    if (!Number.isSafeInteger(i.sourceVersion) || i.sourceVersion < 0) throw new Error('source_version이 틀렸다');
    return this.store.transaction((tx) => tx.setAccountHold({ ...i, sourceRef, accountId, now: this.clock.now() }));
  }
}
