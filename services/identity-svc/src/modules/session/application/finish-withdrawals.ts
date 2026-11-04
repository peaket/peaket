// 정비 withdrawal-finish(docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030): 하루 한 번 relay 프로세스의 정비 리더가 돈다.
// ① 만 14세 미만으로 정리를 시작하고 10분 [가정]이 지난 계정을 재인증 없이 탈퇴처럼 끝낸다(BOT-020이 넘긴 것)
// ② 지난 7일 [가정] 안에 탈퇴한 계정의 남은 본인확인 기록을 다시 지운다(탈퇴 때 파기가 실패한 경우, 늦어도 5일 안)
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { ACCOUNT_ERASER, type AccountEraser, SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { CLOSURE_GRACE_MS, WITHDRAWAL_SWEEP_MS } from '../domain/session.js';
import { completeWithdrawal } from './withdraw-account.js';

/** 한 번에 다루는 계정 수 [가정] */
const BATCH = 200;

@Injectable()
export class FinishWithdrawals {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(ACCOUNT_ERASER) private readonly eraser: AccountEraser,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** 한 계정이 실패해도 나머지를 끝까지 다루고, 실패가 있으면 끝에 던진다(정비 실패 지표, 새 맥락 리뷰 L3) */
  async run(signal?: AbortSignal): Promise<{ closed: number; erased: number }> {
    const now = this.clock.now();
    const failed: string[] = [];
    let closed = 0;
    const skip = new Set<string>();
    for (;;) {
      if (signal?.aborted) break;
      const ids = (await this.store.transaction((tx) => tx.closuresStartedBefore(now - CLOSURE_GRACE_MS, BATCH + skip.size))).filter((id) => !skip.has(id));
      if (ids.length === 0) break;
      for (const id of ids) {
        try {
          // 잠근 뒤 사유를 본다. 사이에 다른 길로 끝났으면(재인증 탈퇴) 그대로 둔다(L4)
          await this.store.transaction(async (tx) => {
            await tx.lockAccount(id);
            if ((await tx.closureReasonOf(id)) === 'UNDER_14') await completeWithdrawal(tx, id, now);
          });
          await this.eraser.erase(id, now);
          closed++;
        } catch {
          failed.push(id);
          skip.add(id);
        }
      }
      if (ids.length < BATCH) break;
    }
    let erased = 0;
    let after = '';
    for (;;) {
      if (signal?.aborted) break;
      const ids = await this.store.transaction((tx) => tx.deletedSince(now - WITHDRAWAL_SWEEP_MS, after, BATCH));
      for (const id of ids) {
        try {
          if (await this.eraser.erase(id, now)) erased++;
        } catch {
          failed.push(id);
        }
      }
      if (ids.length < BATCH) break;
      after = ids[ids.length - 1]!;
    }
    if (failed.length > 0) throw new Error(`탈퇴 뒤 정리 실패 ${failed.length}건(끝냄 ${closed}, 지움 ${erased}). 다음 정비가 다시 한다`);
    return { closed, erased };
  }
}
