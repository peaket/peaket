// 정비 signup-incomplete-purge(docs/features/identity.md §8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현', ADR-0235 결정 7, BUILD_ORDER BOT-047, I-T82):
// 하루 한 번. 만든 지 30일 [가정]이 지났고 살아 있는 세션이 없고 가입을 마치지 않았고 본인확인 기록이 없는 ACTIVE 계정을 탈퇴와 같은 길로 지운다.
// 본인확인을 마친 계정은 건너뛴다(이 길은 탈퇴 사건을 내지 않아 그 계정의 대기열 키를 지우지 못하고 pid를 잃는다). 본인확인 여부를 모르면 지우지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { INCOMPLETE_SIGNUP_PURGE_MS, signupCompleted } from '../domain/signup.js';
import { completeWithdrawal } from './withdraw-account.js';

/** 한 번에 다루는 계정 수 [가정] */
const BATCH = 200;

@Injectable()
export class PurgeIncompleteSignups {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 한 계정이 실패해도 나머지를 끝까지 다루고, 실패가 있으면 끝에 던진다(정비 실패 지표, FinishWithdrawals와 같다) */
  async run(signal?: AbortSignal): Promise<{ purged: number }> {
    const now = this.clock.now();
    const before = now - INCOMPLETE_SIGNUP_PURGE_MS;
    const skip = new Set<string>();
    let purged = 0;
    let failed = 0;
    for (;;) {
      if (signal?.aborted) break;
      const ids = (await this.store.transaction((tx) => tx.incompleteSignupsBefore(before, BATCH + skip.size))).filter((id) => !skip.has(id));
      if (ids.length === 0) break;
      for (const id of ids) {
        try {
          const done = await this.store.transaction(async (tx) => {
            await tx.lockAccount(id);
            const state = await tx.signupStateOf(id);
            if (!state || state.status !== 'ACTIVE' || signupCompleted(state.ageVerified, state.consentKinds)) return false;
            if ((await tx.verifiedOf(id)) !== false) return false;
            if ((await tx.activeSessions(id, now)).length > 0) return false;
            await completeWithdrawal(tx, id, now);
            return true;
          });
          if (done) purged++;
          else skip.add(id);
        } catch {
          failed++;
          skip.add(id);
        }
      }
      if (ids.length < BATCH) break;
    }
    if (failed > 0) throw new Error(`가입 전 계정 정리 실패 ${failed}건(지움 ${purged}). 다음 정비가 다시 한다`);
    return { purged };
  }
}
