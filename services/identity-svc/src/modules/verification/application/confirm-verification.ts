// 본인확인 결과 확정(openapi POST /v1/identity/verifications/{verificationId}/result, docs/features/identity.md §5, I-T6).
// 기관 값을 확인한 뒤(트랜잭션 밖) 건을 잠그고 결과를 정한다. 같은 연계정보가 다른 계정에 있으면 저장하지 않고 DUPLICATE_ACCOUNT다.
// pid는 계정의 첫 본인확인 때 한 번 계산하고 다시 본인확인해도 바꾸지 않는다(ADR-0050, 기술 검토 높음-18).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { IDENTITY_HASHERS, type IdentityHashers, VERIFICATION_PROVIDER, VERIFICATION_STORE, type VerificationProvider, type VerificationStore } from '../domain/ports.js';
import { acceptsResult, type Attempt, type AttemptStatus, CiAlreadyLinked, isAttemptId, ProviderUnavailable, VerificationRaced } from '../domain/verification.js';
import { VerificationError } from './verification-error.js';

export interface VerificationResultView {
  verificationId: string;
  purpose: Attempt['purpose'];
  status: AttemptStatus;
  next: string;
  /** 부정 예매 이용 제한이 이어진 사람의 제한 끝(openapi). 그 확인은 BUILD_ORDER BOT-030이 붙이고 그 전에는 늘 null */
  restrictedUntil: string | null;
}

export const viewOf = (a: Attempt): VerificationResultView => ({ verificationId: a.id, purpose: a.purpose, status: a.status, next: a.next, restrictedUntil: null });

@Injectable()
export class ConfirmVerification {
  constructor(
    @Inject(VERIFICATION_STORE) private readonly store: VerificationStore,
    @Inject(VERIFICATION_PROVIDER) private readonly provider: VerificationProvider,
    @Inject(IDENTITY_HASHERS) private readonly hashers: IdentityHashers,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: { accountId: string; verificationId: string; providerResult: Record<string, string> }): Promise<VerificationResultView> {
    const now = this.clock.now();
    const seen = isAttemptId(i.verificationId) ? await this.store.attempt(i.verificationId) : null;
    if (!seen || !acceptsResult(seen, i.accountId, now)) throw new VerificationError('NOT_FOUND', '없는 건이거나 만료됐거나 다른 계정의 건이다');
    if (seen.status !== 'PENDING') return this.#answer(seen);
    // 기관 확인은 트랜잭션 밖에서 한다(기관 호출 동안 행을 잡지 않게)
    let outcome: Awaited<ReturnType<VerificationProvider['confirm']>>;
    try {
      outcome = await this.provider.confirm(i.verificationId, i.providerResult);
    } catch (e) {
      if (!(e instanceof ProviderUnavailable)) throw e;
      // 기관 장애: 그 건을 PROVIDER_DOWN으로 마친다(결과 조회가 같은 값을 주고, 다시 보내도 503이다)
      return this.#answer(await this.#settle(i.verificationId, 'PROVIDER_DOWN', now));
    }
    const done = await this.#confirm(i.verificationId, outcome, now);
    return this.#answer(done);
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

  async #confirm(verificationId: string, outcome: Awaited<ReturnType<VerificationProvider['confirm']>>, now: number): Promise<Attempt> {
    try {
      try {
        return await this.#apply(verificationId, outcome, now);
      } catch (e) {
        // 같은 계정의 건 둘이 동시에 처음 저장했다: 늦은 쪽은 앞 쪽이 저장한 기록으로 한 번 다시 판정한다
        if (e instanceof VerificationRaced) return await this.#apply(verificationId, outcome, now);
        throw e;
      }
    } catch (e) {
      // 같은 사람이 다른 계정에서 동시에 확정했다: 건은 처리 중으로 남고, 다시 보내면 DUPLICATE_ACCOUNT로 확정된다
      if (e instanceof CiAlreadyLinked) throw new VerificationError('DUPLICATE_ACCOUNT', '이미 다른 계정에서 본인확인한 분이다');
      throw e;
    }
  }

  #apply(verificationId: string, outcome: Awaited<ReturnType<VerificationProvider['confirm']>>, now: number): Promise<Attempt> {
    return this.store.transaction(async (tx) => {
      const a = await tx.attemptForUpdate(verificationId);
      if (!a) throw new VerificationError('NOT_FOUND', '없는 건이다');
      if (a.status !== 'PENDING') return a;
      let status: Exclude<AttemptStatus, 'PENDING'>;
      if (outcome.outcome !== 'VERIFIED') status = outcome.outcome;
      else {
        const ci = this.hashers.ci(outcome.ci);
        const owner = await tx.accountByCiHmac(ci.hmac);
        const mine = await tx.verificationOf(a.accountId);
        if (owner && owner !== a.accountId) status = 'DUPLICATE_ACCOUNT';
        // 이미 본인확인한 계정의 다시 본인확인(REVERIFY 등)은 같은 사람이어야 하고, pid는 그대로 둔다
        else if (mine) status = mine.ciHmac.equals(ci.hmac) ? 'VERIFIED' : 'FAILED';
        else {
          const pid = this.hashers.pid(ci.hmac);
          await tx.saveVerification({
            accountId: a.accountId,
            ciHmac: ci.hmac,
            ciHmacKeyVersion: ci.version,
            pid: pid.pid,
            pidKeyVersion: pid.version,
            verifiedAt: now,
            sourceRecord: JSON.stringify({ source: 'test-provider', purpose: a.purpose, at: new Date(now).toISOString() }),
          });
          status = 'VERIFIED';
        }
      }
      await tx.completeAttempt(a.id, status, now);
      return { ...a, status, completedAt: now };
    });
  }

  #answer(a: Attempt): VerificationResultView {
    if (a.status === 'DUPLICATE_ACCOUNT') throw new VerificationError('DUPLICATE_ACCOUNT', '이미 다른 계정에서 본인확인한 분이다');
    if (a.status === 'PROVIDER_DOWN') throw new VerificationError('PROVIDER_DOWN', '본인확인기관을 쓸 수 없다');
    return viewOf(a);
  }
}
