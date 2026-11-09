// 새 결제 일시 정지 행과 시험 재개 행 읽기(docs/data.md §2, ADR-0105, docs/features/payment.md §2 '새 결제 일시 정지 읽기의 첫 구현', BUILD_ORDER PRF-201). 핫패스 풀이고 쓰기 인스턴스를 본다. 쓰지 않는다(쓰기는 판정자 PRF-202).
import type { Database } from '@peaket/platform';
import { and, eq, gte } from 'drizzle-orm';
import type { EntryPauseReason, EntryPauses, EntryPauseRow, EntryPauseStage } from '../../domain/entry-pause.js';
import type { PgName } from '../../domain/payment-gateway.js';
import type { CallBudget, EntryPauseReader, EntryTrialReader } from '../../domain/ports.js';
import { armStatementLimit } from './drizzle-payment-store.js';
import { paymentEntryPause, paymentEntryTrial } from './schema.js';

/** 정지 행 읽기 문장 시간 한도 상한 150ms [가정](선택 읽기와 같다, docs/data.md §5.1) */
export const ENTRY_PAUSE_STATEMENT_TIMEOUT_MS = 150;

export class DrizzleEntryPause implements EntryPauseReader, EntryTrialReader {
  constructor(private readonly o: { readonly database: Database }) {}

  /** channel = 'ALL' 행을 모두 읽는다(결제사 셋이라 행이 많지 않다). 채널별 정지를 쓰는 단계가 조건을 푼다 */
  async read(budget?: CallBudget): Promise<EntryPauses> {
    const startedAt = performance.now();
    const rows = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_STATEMENT_TIMEOUT_MS, budget, startedAt);
      return tx
        .select({ pg: paymentEntryPause.pg, stage: paymentEntryPause.stage, reason: paymentEntryPause.reason, since: paymentEntryPause.since, version: paymentEntryPause.version })
        .from(paymentEntryPause)
        .where(eq(paymentEntryPause.channel, 'ALL'));
    });
    const pauses = new Map<PgName, EntryPauseRow>();
    for (const row of rows) {
      const pg = row.pg as PgName;
      pauses.set(pg, { pg, stage: row.stage as EntryPauseStage, reason: row.reason as EntryPauseReason, sinceMs: row.since.getTime(), version: row.version });
    }
    return pauses;
  }

  /** 이번 시험 재개로 받은 주문만 참이다: admitted_at >= 정지 행의 trial_started_at(앞 시험의 행은 지워지기 전까지 남는다. 시작 시각이 비면 조건이 NULL이라 거짓이다, BUILD_ORDER PRF-201 코드 리뷰) */
  async isAdmitted(orderId: string, pg: PgName, budget?: CallBudget): Promise<boolean> {
    const startedAt = performance.now();
    const rows = await this.o.database.transaction(async (tx) => {
      await armStatementLimit(tx, ENTRY_PAUSE_STATEMENT_TIMEOUT_MS, budget, startedAt);
      return tx
        .select({ orderId: paymentEntryTrial.orderId })
        .from(paymentEntryTrial)
        .innerJoin(paymentEntryPause, and(eq(paymentEntryPause.pg, paymentEntryTrial.pg), eq(paymentEntryPause.channel, 'ALL')))
        .where(and(eq(paymentEntryTrial.orderId, orderId), eq(paymentEntryTrial.pg, pg), gte(paymentEntryTrial.admittedAt, paymentEntryPause.trialStartedAt)))
        .limit(1);
    });
    return rows.length > 0;
  }
}
