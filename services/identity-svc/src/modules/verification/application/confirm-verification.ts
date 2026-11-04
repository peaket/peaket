// 본인확인 결과 확정(openapi POST /v1/identity/verifications/{verificationId}/result, docs/features/identity.md §5, I-T6·I-T42·I-T65).
// 기관 값을 확인하고 연계정보 HMAC(보존 중인 모든 판)을 계산한 뒤(트랜잭션 밖, KMS를 기다리는 동안 행을 잡지 않는다) 건을 잠그고 결과를 정한다.
// pid는 새 기록을 저장할 때만, 트랜잭션을 한 번 되돌린 뒤 밖에서 계산한다(NeedPid).
// - 같은 연계정보가 다른 계정에 있으면 저장하지 않고 DUPLICATE_ACCOUNT이고, 그 시도를 identity_conflict_attempt에 한 줄 남긴다(연계정보 없이)
// - pid는 계정의 첫 본인확인 때 한 번 계산하고 다시 본인확인해도 바꾸지 않는다. 기록이 쓰기 판보다 옛 판이면 그 자리에서 쓰기 판 값으로 바꾼다(ADR-0050 결정 5)
// - 만 14세 미만이면 연계정보를 계산·저장하지 않고 UNDER_14(403)이며 계정 정리를 시작한다(ADR-0062). 생년월일은 계산에만 쓴다
// - 기관이나 연계정보 키(KMS)를 쓸 수 없으면 그 건을 PROVIDER_DOWN으로 마친다(503)
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { ACCOUNT_CLOSURE, type AccountClosure } from '../../session/index.js';
import { IDENTITY_HASHERS, type IdentityHashers, PHONE_REFS, type PhoneRefs, VERIFICATION_PROVIDER, VERIFICATION_STORE, type VerificationProvider, type VerificationStore } from '../domain/ports.js';
import {
  acceptsResult,
  ageOnKst,
  type Attempt,
  type AttemptStatus,
  CiAlreadyLinked,
  isAttemptId,
  KeyServiceUnavailable,
  MIN_AGE,
  ProviderUnavailable,
  VerificationRaced,
} from '../domain/verification.js';
import { VerificationError } from './verification-error.js';

export interface VerificationResultView {
  verificationId: string;
  purpose: Attempt['purpose'];
  status: AttemptStatus;
  next: string;
  /** 부정 예매 이용 제한이 이어진 사람의 제한 끝(openapi). 그 확인은 BUILD_ORDER BOT-030이 붙이고 그 전에는 늘 null */
  restrictedUntil: string | null;
}

export const viewOf = (a: Attempt, restrictedUntil: number | null = null): VerificationResultView => ({
  verificationId: a.id,
  purpose: a.purpose,
  status: a.status,
  next: a.next,
  restrictedUntil: restrictedUntil === null ? null : new Date(restrictedUntil).toISOString(),
});

/** FIRST·REVERIFY로 VERIFIED면 같은 연계정보에서 이은 이용 제한의 끝(identity §8 '대조값 보관의 첫 구현', openapi VerificationResult.restrictedUntil) */
export async function restrictedUntilFor(store: Pick<VerificationStore, 'restrictedUntilOf'>, a: Attempt, now: number): Promise<number | null> {
  if (a.status !== 'VERIFIED' || (a.purpose !== 'FIRST' && a.purpose !== 'REVERIFY')) return null;
  return store.restrictedUntilOf(a.accountId, now);
}

/** 기관 확인과 키 계산을 마친 값(트랜잭션 안에서 쓴다). pid는 새로 저장할 때만 계산해 채운다 */
type Checked =
  | { outcome: 'CANCELLED' | 'FAILED' }
  | { outcome: 'UNDER_14' }
  | { outcome: 'VERIFIED'; hmacs: { hmac: Buffer; version: number }[]; pid: { pid: Buffer; version: number } | null; phoneRef?: string; phoneRefPrev?: string };

/** 트랜잭션 안에서 새로 저장해야 하는데 아직 pid가 없다: 트랜잭션을 되돌리고 pid를 계산해(KMS는 트랜잭션 밖) 한 번 더 한다 */
class NeedPid extends Error {}

@Injectable()
export class ConfirmVerification {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider,
    @Inject(IDENTITY_HASHERS) private readonly hashers: IdentityHashers,
    @Inject(ACCOUNT_CLOSURE) private readonly closure: AccountClosure,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 본인확인 번호의 연락처 가명(없으면 쓰지 않는다: 시험, identity §9.1 '조사용 값의 첫 구현') */
    @Optional() @Inject(PHONE_REFS) private readonly phoneRefs?: PhoneRefs,
  ) {}

  async run(i: { accountId: string; verificationId: string; providerResult: Record<string, string> }): Promise<VerificationResultView> {
    const now = this.clock.now();
    const seen = isAttemptId(i.verificationId) ? await this.store.attempt(i.verificationId) : null;
    if (!seen || !acceptsResult(seen, i.accountId, now)) throw new VerificationError('NOT_FOUND', '없는 건이거나 만료됐거나 다른 계정의 건이다');
    if (seen.status !== 'PENDING') return this.#answer(seen);
    let done: Attempt;
    try {
      const checked = await this.#check(seen, i.providerResult, now);
      done = checked.outcome === 'VERIFIED' ? await this.#confirm(i.verificationId, checked, now) : await this.#settle(i.verificationId, checked.outcome, now);
    } catch (e) {
      if (!(e instanceof ProviderUnavailable || e instanceof KeyServiceUnavailable)) throw e;
      // 기관·연계정보·pid 키 장애(첫 저장의 pid 계산 포함): 그 건을 PROVIDER_DOWN으로 마친다(결과 조회가 같은 값을 주고, 다시 보내도 503이다)
      done = await this.#settle(i.verificationId, 'PROVIDER_DOWN', now);
    }
    return this.#answer(done);
  }

  /** 기관 값 확인 → 정리 중 확인 → 만 나이 → 연계정보 HMAC(모든 판)·pid. 모두 트랜잭션 밖이다 */
  async #check(a: Attempt, providerResult: Record<string, string>, now: number): Promise<Checked> {
    // 시작한 뒤 정리 중이 된 계정도 받지 않는다(새 맥락 리뷰 중간 2)
    if ((await this.closure.closureReasonOf(a.accountId)) === 'UNDER_14') return { outcome: 'UNDER_14' };
    // 탈퇴·탈퇴 유예·병합 계정은 본인확인을 남기지 않는다(남은 액세스 토큰으로 온 경우, 새 맥락 리뷰 M2)
    if (await this.closure.isClosing(a.accountId)) return { outcome: 'FAILED' };
    const outcome = await this.provider.confirm(a.id, providerResult);
    if (outcome.outcome !== 'VERIFIED') return outcome;
    const verified = await this.store.isVerified(a.accountId);
    // REVERIFY는 이미 본인확인한 계정만 받는다. 기록이 없는 계정의 REVERIFY가 첫 기록이 되거나 재통과로 세지지 않게 한다(새 맥락 리뷰 낮음 6)
    if (a.purpose === 'REVERIFY' && !verified) return { outcome: 'FAILED' };
    // 만 14세 재확인(FIRST·REVERIFY). 생년월일이 없거나 있을 수 없는 날이면 나이를 확인할 수 없어 통과시키지 않는다
    const age = ageOnKst(outcome.birthDate, now);
    if (age === null) return { outcome: 'FAILED' };
    // 이미 본인확인한 계정의 기록은 그때 만 14세 이상이었던 사람이다. 지금 미만이면 다른 사람이므로 정리하지 않고 FAILED다(새 맥락 리뷰 높음 1)
    if (age < MIN_AGE) return verified ? { outcome: 'FAILED' } : { outcome: 'UNDER_14' };
    const hmacs = await this.hashers.ciAll(outcome.ci);
    if (hmacs.length === 0) throw new Error('연계정보 HMAC 판이 없다');
    // pid는 트랜잭션이 새로 저장할 때만 계산한다(NeedPid로 한 번 더 돈다). 중복·다시 본인확인에는 pid 키를 부르지 않는다
    // (pid 키 장애가 중복 판정과 다시 본인확인을 막지 않게, 새 맥락 리뷰 낮음 7)
    // 번호는 가명 계산에만 쓰고 버린다(저장·로그 없음). 라벨 키가 없으면 비우고 다음 본인확인 때 쓴다
    const phoneRef = outcome.phone === undefined ? undefined : this.phoneRefs?.ref(outcome.phone);
    // 키 회전의 이음 기간이면 옛 판 값도 구해 둔다(회전 전 기록과 잇는다, BOT-046)
    const phoneRefPrev = phoneRef && outcome.phone !== undefined ? this.phoneRefs?.prevRef?.(outcome.phone) : undefined;
    return { outcome: 'VERIFIED', hmacs, pid: null, ...(phoneRef ? { phoneRef } : {}), ...(phoneRefPrev ? { phoneRefPrev } : {}) };
  }

  async #confirm(verificationId: string, checked: Extract<Checked, { outcome: 'VERIFIED' }>, now: number): Promise<Attempt> {
    let c = checked;
    for (let round = 0; ; round++) {
      try {
        return await this.#apply(verificationId, c, now);
      } catch (e) {
        if (round >= 2) {
          if (e instanceof CiAlreadyLinked) throw new VerificationError('DUPLICATE_ACCOUNT', '이미 다른 계정에서 본인확인한 분이다');
          throw e;
        }
        // 같은 계정의 건 둘이 동시에 처음 저장했다: 늦은 쪽은 앞 쪽이 저장한 기록으로 한 번 다시 판정한다.
        // 같은 사람이 다른 계정에서 동시에 확정했다: 늦은 쪽은 한 번 다시 판정해 DUPLICATE_ACCOUNT로 확정하고 시도 기록을 남긴다(새 맥락 리뷰 중간 4)
        if (e instanceof VerificationRaced || e instanceof CiAlreadyLinked) continue;
        if (e instanceof NeedPid) {
          c = { ...c, pid: await this.hashers.pid(c.hmacs[0]!.hmac) };
          continue;
        }
        throw e;
      }
    }
  }

  #apply(verificationId: string, checked: Extract<Checked, { outcome: 'VERIFIED' }>, now: number): Promise<Attempt> {
    return this.store.transaction(async (tx) => {
      const a = await tx.attemptForUpdate(verificationId);
      if (!a) throw new VerificationError('NOT_FOUND', '없는 건이다');
      if (a.status !== 'PENDING') return a;
      // 계정 행을 공유 잠금으로 읽어 탈퇴의 쓰기 잠금과 순서를 맞춘다: 탈퇴가 먼저면 DELETED를 보고 FAILED, 이 확정이 먼저면 탈퇴는 이 커밋을 기다린 뒤
      // 파기 트랜잭션이 이 기록까지 지운다(새 맥락 리뷰 M2). 메모리 저장소는 계정을 보지 못해 null이다
      const accountStatus = await tx.lockAccountForShare(a.accountId);
      if (accountStatus !== null && accountStatus !== 'ACTIVE') {
        await tx.completeAttempt(a.id, 'FAILED', now);
        return { ...a, status: 'FAILED' as const, completedAt: now };
      }
      const write = checked.hmacs[0]!;
      const owner = await tx.accountByCiHmac(checked.hmacs.map((h) => h.hmac), a.accountId);
      const mine = await tx.verificationOf(a.accountId);
      let status: Exclude<AttemptStatus, 'PENDING'>;
      if (owner && owner !== a.accountId) {
        status = 'DUPLICATE_ACCOUNT';
        // 부정 예매 후보 묶음의 연결 신호(identity §9.1). 연계정보와 HMAC은 싣지 않는다
        await tx.insertConflictAttempt({ id: uuidv7(this.clock), attemptedAccountId: a.accountId, existingAccountId: owner, attemptedAt: now });
      } else if (mine) {
        // 이 계정 기록의 판을 이 파드 설정이 갖지 않으면 같은 사람인지 가릴 수 없다. FAILED가 아니라 키 장애로 본다(판 설정이 어긋난 동안, 다시 보기 낮음 4)
        if (!checked.hmacs.some((h) => h.version === mine.ciHmacKeyVersion)) throw new KeyServiceUnavailable(`기록의 판 ${mine.ciHmacKeyVersion}이(가) 설정에 없다`);
        // 이미 본인확인한 계정의 다시 본인확인(REVERIFY 등)은 같은 사람이어야 하고, pid는 그대로 둔다. 옛 판 기록은 쓰기 판 값으로 바꾼다
        const same = checked.hmacs.some((h) => h.version === mine.ciHmacKeyVersion && h.hmac.equals(mine.ciHmac));
        status = same ? 'VERIFIED' : 'FAILED';
        // 다시 본인확인한 같은 사람이 이용 제한을 받은 연계정보면 이 계정에 잇는다(identity §8 '대조값 보관의 첫 구현')
        if (same) await tx.carryHolds(checked.hmacs.map((h) => h.hmac), a.accountId, now);
        if (same && mine.ciHmacKeyVersion < write.version) await tx.updateCiHmac(a.accountId, write.hmac, write.version);
      } else if (a.purpose === 'REVERIFY') {
        // 기록이 없는 계정의 REVERIFY는 첫 기록으로 삼지 않는다(새 맥락 리뷰 낮음 6)
        status = 'FAILED';
      } else {
        if (!checked.pid) throw new NeedPid();
        await tx.saveVerification({
          accountId: a.accountId,
          ciHmac: write.hmac,
          ciHmacKeyVersion: write.version,
          pid: checked.pid.pid,
          pidKeyVersion: checked.pid.version,
          verifiedAt: now,
          sourceRecord: JSON.stringify({ source: 'test-provider', purpose: a.purpose, at: new Date(now).toISOString() }),
        });
        // 같은 연계정보로 다시 가입한 계정: 끝나지 않은 대조값 보관 행에 이 계정을 적는다(보존 중인 모든 키 판으로, identity §8 '대조값 보관의 첫 구현')
        await tx.carryHolds(checked.hmacs.map((h) => h.hmac), a.accountId, now);
        status = 'VERIFIED';
      }
      // 본인확인이 이 계정의 것으로 끝났을 때만 번호의 연락처 가명을 쓴다(다른 사람·중복은 쓰지 않는다)
      if (status === 'VERIFIED' && checked.phoneRef) await tx.setPhoneRef({ accountId: a.accountId, ref: checked.phoneRef, refPrev: checked.phoneRefPrev ?? null, now });
      await tx.completeAttempt(a.id, status, now);
      return { ...a, status, completedAt: now };
    });
  }

  /** 처리 중인 건만 그 상태로 마친다(이미 마쳤으면 그 결과) */
  #settle(verificationId: string, status: Exclude<AttemptStatus, 'PENDING'>, now: number): Promise<Attempt> {
    return this.store.transaction(async (tx) => {
      const a = await tx.attemptForUpdate(verificationId);
      if (!a) throw new VerificationError('NOT_FOUND', '없는 건이다');
      if (a.status !== 'PENDING') return a;
      await tx.completeAttempt(a.id, status, now);
      return { ...a, status, completedAt: now };
    });
  }

  async #answer(a: Attempt): Promise<VerificationResultView> {
    if (a.status === 'DUPLICATE_ACCOUNT') throw new VerificationError('DUPLICATE_ACCOUNT', '이미 다른 계정에서 본인확인한 분이다');
    if (a.status === 'PROVIDER_DOWN') throw new VerificationError('PROVIDER_DOWN', '본인확인기관을 쓸 수 없다');
    if (a.status === 'UNDER_14') {
      // 계정 정리 시작은 멱등이다. 다시 보내면 다시 부르므로, 앞서 정리가 실패했어도 이어진다
      await this.closure.start(a.accountId, 'UNDER_14');
      throw new VerificationError('UNDER_14', '만 14세 미만이다');
    }
    return viewOf(a, await restrictedUntilFor(this.store, a, this.clock.now()));
  }
}
