// 탈퇴 미룸 다시 하기 고리 withdrawal-pending-retry의 한 바퀴(docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '다시 하기 고리',
// docs/data.md §5.1 '탈퇴 미룸 다시 하기 고리', ADR-0284 결정 4, BUILD_ORDER PRF-169, I-T84 ④).
// API 파드마다 60초 [가정]마다 main.ts가 부른다(앞 바퀴가 도는 중이면 건너뛴다). 한 트랜잭션에서 다음 확인 시각이 된 미룬 계정을 20개 [가정]까지
// FOR UPDATE SKIP LOCKED로 잡고 다음 확인 시각을 지금 + 60초로 미뤄 커밋한다. 그다음 계정마다 참여자를 부르고(데드라인 10초 [가정]) 모두 DONE이면
// 요청 경로와 같은 끝내기를 한다. 한 계정의 실패는 경고 로그만 남기고 나머지를 이어 간다. 바퀴 끝에 가장 오래 미룬 계정의 나이를 지표로 낸다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { ACCOUNT_ERASER, type AccountEraser, SESSION_STORE, type SessionStore } from '../domain/ports.js';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentStore } from '../domain/staff.js';
import {
  WITHDRAWAL_NEXT_CHECK_MS,
  WITHDRAWAL_PARTICIPANTS,
  WITHDRAWAL_RETRY_BATCH,
  WITHDRAWAL_RETRY_DEADLINE_MS,
  WITHDRAWAL_SIGNALS,
  type WithdrawalParticipant,
  type WithdrawalSignals,
} from '../domain/withdrawal.js';
import { askParticipants, finishPendingWithdrawal, type WithdrawalFinishDeps } from './withdraw-account.js';

/** 한 바퀴의 결과: 잡은 수, 끝낸 수(이미 다른 길이 끝낸 것 포함), 참여자가 PENDING이라 둔 수, 참여자 실패·끝내기 실패 수 */
export interface RetryPendingWithdrawalsReport {
  claimed: number;
  withdrawn: number;
  deferred: number;
  failed: number;
}

@Injectable()
export class RetryPendingWithdrawals {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(ACCOUNT_ERASER) private readonly eraser: AccountEraser,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(WITHDRAWAL_PARTICIPANTS) private readonly participants?: readonly WithdrawalParticipant[],
    @Optional() @Inject(STAFF_ASSIGNMENT_STORE) private readonly staff?: StaffAssignmentStore,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    @Optional() @Inject(WITHDRAWAL_SIGNALS) private readonly signals?: WithdrawalSignals,
  ) {}

  /** 잡기가 실패하면 던진다(고리가 경고 로그를 남기고 다음 바퀴에서 다시 한다). 잡은 뒤의 실패는 계정마다 세고 던지지 않는다 */
  async run(signal?: AbortSignal): Promise<RetryPendingWithdrawalsReport> {
    const now = this.clock.now();
    const ids = await this.store.transaction((tx) => tx.claimPendingWithdrawals(now, now + WITHDRAWAL_NEXT_CHECK_MS, WITHDRAWAL_RETRY_BATCH));
    const report: RetryPendingWithdrawalsReport = { claimed: ids.length, withdrawn: 0, deferred: 0, failed: 0 };
    const participants = this.participants ?? [];
    const deps: WithdrawalFinishDeps = { store: this.store, eraser: this.eraser, ...(this.staff ? { staff: this.staff } : {}), ...(this.logger ? { logger: this.logger } : {}) };
    for (const accountId of ids) {
      // 멈추면 남은 계정은 부르지 않는다(다음 확인 시각이 지나면 다른 파드가 다시 잡는다)
      if (signal?.aborted) break;
      try {
        const verdict = await askParticipants(participants, accountId, { path: 'retry', deadlineMs: WITHDRAWAL_RETRY_DEADLINE_MS, ...(this.signals ? { signals: this.signals } : {}), ...(this.logger ? { logger: this.logger } : {}) });
        if (verdict === 'FAILED') {
          report.failed++;
          continue;
        }
        if (verdict === 'PENDING') {
          report.deferred++;
          continue;
        }
        const r = await finishPendingWithdrawal(deps, accountId, this.clock.now());
        if (r === 'NOT_PENDING') report.deferred++;
        else report.withdrawn++;
      } catch (err) {
        // 한 계정의 실패가 다른 계정의 끝내기를 막지 않는다(I-T84 ④)
        report.failed++;
        this.logger?.warn({ err, accountId }, '미룬 탈퇴를 끝내지 못했다(다음 확인 시각에 다시 한다)');
      }
    }
    await this.#reportOldest();
    return report;
  }

  /** 가장 오래 미룬 WITHDRAWAL 계정의 나이(초, 없으면 0). 읽지 못하면 경고만 남기고 지표를 바꾸지 않는다 */
  async #reportOldest(): Promise<void> {
    if (!this.signals) return;
    try {
      const oldest = await this.store.transaction((tx) => tx.oldestPendingWithdrawalSince());
      this.signals.pendingOldest(oldest === null ? 0 : Math.max(0, (this.clock.now() - oldest) / 1000));
    } catch (err) {
      this.logger?.warn({ err }, '가장 오래 미룬 탈퇴의 나이를 읽지 못했다');
    }
  }
}
