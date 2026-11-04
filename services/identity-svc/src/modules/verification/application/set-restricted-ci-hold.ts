// 이용 제한 중 탈퇴의 대조값 보관(gRPC RestrictedCiHoldService.SetRestrictedCiHold, docs/features/identity.md §8 '대조값 보관의 첫 구현',
// BUILD_ORDER BOT-035, I-T68, ADR-0171 결정 5, ADR-0173 결정 7). ops-svc가 상태 셋(CASE_OPEN·RESTRICTED·RELEASED)으로 부른다.
// 그 계정의 연계정보 HMAC과 키 판으로 (연계정보 HMAC, 사건) 행을 두고, 저장한 판보다 큰 판일 때만 반영한다. RELEASED는 행을 지운다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { type HoldRow, VERIFICATION_STORE, type VerificationStore } from '../domain/ports.js';

/** until의 상한 [가정]: 부정 예매 이용 제한은 건 날 + 1년을 넘지 못한다(ops-svc가 막는다). 이 서비스도 하루 여유를 두고 막는다 */
export const HOLD_MAX_MS = 366 * 86_400_000;

export type HoldState = 'CASE_OPEN' | 'RESTRICTED' | 'RELEASED';
export type HoldResult = 'OK' | 'NO_VERIFICATION' | 'STALE';

/** 요청 모양이 틀렸다(gRPC INVALID_ARGUMENT) */
export class RestrictedCiHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestrictedCiHoldError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SetRestrictedCiHold {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { accountId: string; fraudCaseId: string; state: HoldState; until: number | null; version: number }): Promise<HoldResult> {
    if (!UUID.test(i.accountId) || !UUID.test(i.fraudCaseId)) throw new RestrictedCiHoldError('account_id·fraud_case_id는 UUID다');
    if (!Number.isSafeInteger(i.version) || i.version < 1) throw new RestrictedCiHoldError('version은 1 이상의 정수다');
    const now = this.clock.now();
    if (i.state !== 'RELEASED') {
      if (i.until === null) throw new RestrictedCiHoldError('CASE_OPEN·RESTRICTED에는 until이 있어야 한다');
      if (i.until <= now || i.until > now + HOLD_MAX_MS) throw new RestrictedCiHoldError('until은 지금 뒤, 지금 + 366일 안이어야 한다');
    }
    const accountId = i.accountId.toLowerCase();
    const caseId = i.fraudCaseId.toLowerCase();
    return this.store.transaction(async (tx) => {
      // 계정 행을 공유 잠금으로 읽어 탈퇴의 쓰기 잠금과 순서를 맞춘다: 이 호출이 먼저면 탈퇴는 이 행을 보고 409로 안내한다(새 맥락 리뷰 L4)
      await tx.lockAccountForShare(accountId);
      const v = await tx.verificationOf(accountId);
      // 행은 멱등 키 (사건, 계정)으로 찾는다. 처음 계정의 연계정보가 새 키 판으로 바뀌어도 한 행이다(M2)
      let existing = await tx.holdBySource(accountId, caseId);
      // 끝이 지난 행은 정비 전이라도 없는 것으로 본다(되살리지 않는다, L1)
      if (existing && existing.until <= now) {
        await tx.deleteHold(accountId, caseId);
        existing = null;
      }
      if (!v && !existing) return 'NO_VERIFICATION';
      if (existing) {
        if (existing.version > i.version) return 'STALE';
        // 같은 판의 재전송: 내용이 같으면 OK(응답을 잃은 다시 보내기가 Done에 닿게), 다르면 STALE이다(M3)
        if (existing.version === i.version) return i.state !== 'RELEASED' && existing.state === i.state && existing.until === i.until ? 'OK' : 'STALE';
      }
      if (i.state === 'RELEASED') {
        if (existing) await tx.deleteHold(accountId, caseId);
        return 'OK';
      }
      // 본인확인 기록이 있으면 지금의 연계정보 HMAC·키 판으로 맞춘다(없으면, 즉 탈퇴했으면 남은 행의 값 그대로)
      const ci = v ? { ciHmac: v.ciHmac, ciHmacKeyVersion: v.ciHmacKeyVersion } : { ciHmac: existing!.ciHmac, ciHmacKeyVersion: existing!.ciHmacKeyVersion };
      // 행은 (계정, 사건)마다 하나다. 같은 사람의 다른 계정(다시 가입한 계정)이 같은 사건에 들어도 처음 계정의 행을 덮지 않는다(다시 보기 중간)
      const row: HoldRow = { ...ci, fraudCaseId: caseId, state: i.state, until: i.until!, sourceAccountId: accountId, carriedAccountId: existing?.carriedAccountId ?? null, version: i.version };
      await tx.upsertHold(row);
      return 'OK';
    });
  }
}
