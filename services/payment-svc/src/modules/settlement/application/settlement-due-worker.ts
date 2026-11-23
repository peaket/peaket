// 정산 일꾼(A2-06, F-07-5 ADR-0368 결정 12). Lease로 뽑힌 리더 파드 하나가 돈다.
// - 30분 [가정] tick마다: 기한이 지난 NOTIFIED 자동 확정, CS 처리함 건을 열지 못한 이의 다시 보내기, 오래된 PENDING 조정 닫기.
// - 평일 06시(KST) 정기 tick: 회차가 끝난 다음 영업일에 core-svc에서 끝난 회차를 읽어 결제가 있는 결제사·상점만 정산서를 만든다.
//   지급일은 계산일이 아니라 회차 종료일 +5영업일이다(정본 §4.1·§5.1, A1V-02).
// - 그날이 주의 첫 영업일(KST 공휴일 달력)이면 06시에 지난주 월~일 상품 정산서를 계산·통지한다(settlement §4.5). 같은 주는 두 번 만들지 않는다.
// - 토스 지급(F-07-6 ADR-0369 결정 10~13): 30분마다 보내지 못한 지급 쪽 CS 건 다시 보내기·대사 없는 최근 묶음의 BATCH 잔액 대사·지급일 다음 영업일 12시 미완료 점검,
//   은행 영업일 09:00 KST 뒤 첫 tick에 다음 은행 영업일 지급분 토스 묶음(PREPARED) 미리 만들기(실패하면 다음 tick에 다시),
//   매월 마지막 은행 영업일 22:00 KST 뒤 첫 tick에 두 상점 월 잔액 대사. 토스 지급대행 전송이 조립되지 않았으면 하지 않는다.
// - 포트원 지급·사후 대사(F-07-7 ADR-0370 결정 7·8): 08:00 KST 뒤 하루 한 번 파트너 계좌 대조, 09:00 KST 뒤 첫 tick에 그날 실행 건,
//   15:00 KST 뒤 첫 tick에 실행 기록 없음 점검, 30분마다 지급 내역 동기화·출금 대사·대사 멈춤 점검, 월말 22:00 뒤 포트원 월 잔액 대사.
//   감사·경보·CS 건 다시 보내기는 원인을 만든 일 뒤에 같은 tick에서 돈다. 포트원 플랫폼이 조립되지 않았으면 포트원 몫은 하지 않는다.
import { type Clock } from '@peaket/platform';
import type { Settlements } from './settlements.js';
import { nextBankBusinessDay } from '../domain/payout-failure.js';
import { dateOnly } from '../domain/settlement.js';

export interface SettlementDueLeadership {
  isLeader(): boolean;
}

export interface SettlementDueTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface SettlementDueLog {
  ticked?(o: { through: string; calculated: number }): void;
  failed?(e: unknown): void;
  /** 상품 정산서 주 계산을 건너뛰었다(원천 없음·실패) */
  productSkipped?(o: { periodStart: string; periodEnd: string; reason: string }): void;
}

export interface SettlementDueWorkerDeps {
  readonly settlements: Settlements;
  readonly leader: SettlementDueLeadership;
  readonly clock: Clock;
  readonly log?: SettlementDueLog;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly timer?: SettlementDueTimer;
}

const systemTimer: SettlementDueTimer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

const DEFAULT_INTERVAL_MS = 30 * 60 * 1_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export class SettlementDueWorker {
  #handle: unknown;
  #running = false;
  #tickPromise: Promise<void> | undefined;
  #lastRegularRunDay: string | undefined;
  #lastProductPeriod: string | undefined;
  /** 09시 토스 묶음을 모두 만든 KST 날짜 */
  #preparedDay: string | undefined;
  /** 월 잔액 대사를 마친 달('YYYY-MM') */
  #reconciledMonth: string | undefined;
  /** 포트원 09시 실행 건·15시 점검·월 잔액 대사를 마친 날·달 */
  #portoneExecutedDay: string | undefined;
  #portonePendingDay: string | undefined;
  #portoneReconciledMonth: string | undefined;

  constructor(private readonly deps: SettlementDueWorkerDeps) {}

  start(): void {
    if (this.#handle !== undefined) return;
    // 첫 실행은 리더가 된 뒤 onChange가 force로 부른다(A1V-07). 정기 tick은 30분마다이고, 회차·상품 계산은 06시(KST)에만 한다.
    this.#handle = (this.deps.timer ?? systemTimer).setInterval(() => this.#schedule(), this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.#handle === undefined) return;
    (this.deps.timer ?? systemTimer).clearInterval(this.#handle);
    this.#handle = undefined;
    await this.#tickPromise;
  }

  /**
   * 수동·리더 전환 시에는 force로 모든 일을 바로 하고, 정기 타이머는 30분마다 확정·CS 건·조정 닫기를 하며
   * 회차 계산은 평일 06시(KST)에, 상품 계산은 주의 첫 영업일 06시(KST)에만 한다.
   */
  async tick(force = true): Promise<void> {
    if (this.#running || !this.deps.leader.isLeader()) return;
    const now = new Date(this.deps.clock.now());
    const kst = new Date(now.getTime() + KST_OFFSET_MS);
    const today = dateOnly(kst);
    const hour = kst.getUTCHours();
    const weekday = kst.getUTCDay() >= 1 && kst.getUTCDay() <= 5;
    this.#running = true;
    try {
      // 회차 종료 다음 영업일 06시에 계산하므로, 오늘 이전(KST)에 끝난 회차까지가 대상이다.
      const through = dateOnly(new Date(kst.getTime() - DAY_MS));
      let calculated = 0;
      // 자동 확정·CS 건 다시 보내기·오래된 조정 닫기는 30분마다 돌고 core-svc 원천 장애와 독립이다(A1V-08, ADR-0368 결정 12)
      try {
        const confirmed = await this.deps.settlements.confirmDueStatements(this.deps.limit ?? 100);
        calculated += confirmed.confirmed;
      } catch (e) {
        this.deps.log?.failed?.(e);
      }
      try {
        await this.deps.settlements.retryDisputeCases();
      } catch (e) {
        this.deps.log?.failed?.(e);
      }
      try {
        await this.deps.settlements.voidStaleAdjustments();
      } catch (e) {
        this.deps.log?.failed?.(e);
      }
      await this.#portone(today, hour, weekday);
      // 토스 지급 쪽 30분 일(ADR-0369 결정 10·11·12)과 ops로 보낼 행 다시 보내기(F-07-7). 하나의 실패가 나머지를 멈추지 않는다
      for (const job of [
        () => this.deps.settlements.retryPayoutCases(),
        () => this.deps.settlements.retrySettlementAlerts(),
        () => this.deps.settlements.retryPayoutAccountAudits(),
        // 계좌 변경 뒤 취소가 실패·무응답이었던 보류 기간 안 토스 예약지급을 다시 취소한다(F-07-7 C-10)
        () => this.deps.settlements.retryAccountChangeCancellations(),
        () => this.deps.settlements.reconcileRecentBatches(),
        () => this.deps.settlements.checkOverduePayouts(),
      ]) {
        try {
          await job();
        } catch (e) {
          this.deps.log?.failed?.(e);
        }
      }
      await this.#prepareTossBatches(today, hour, weekday);
      await this.#monthlyReconciliation(today, hour, weekday);
      const regularDue = hour === 6 && weekday && this.#lastRegularRunDay !== today;
      if (force || regularDue) {
        try {
          const out = await this.deps.settlements.calculateDueEvents(through, this.deps.limit ?? 100);
          calculated += out.calculated;
          // 정기 06시 tick이 성공했을 때만 그날 실행을 소비한다. force tick은 정기 실행을 막지 않는다(A1V-07).
          if (!force) this.#lastRegularRunDay = today;
        } catch (e) {
          this.deps.log?.failed?.(e);
        }
      }
      calculated += await this.#weeklyProducts(now, hour, force);
      this.deps.log?.ticked?.({ through, calculated });
    } finally {
      this.#running = false;
    }
  }

  /** 주의 첫 영업일 06시(KST, force면 06시 이후 언제든) 지난주 월~일 상품 정산서. 성공한 주는 다시 부르지 않는다(저장소도 같은 주를 두 번 넣지 않는다) */
  async #weeklyProducts(now: Date, hour: number, force: boolean): Promise<number> {
    if (force ? hour < 6 : hour !== 6) return 0;
    let period: { periodStart: string; periodEnd: string } | undefined;
    try {
      period = this.deps.settlements.productPeriodFor(now);
      if (!period || this.#lastProductPeriod === period.periodStart) return 0;
      const out = await this.deps.settlements.calculateProduct(period);
      this.#lastProductPeriod = period.periodStart;
      return out.created;
    } catch (e) {
      // 상품 원천이 없거나 답하지 않으면 건너뛰고 로그만 남긴다. 다음 tick이 다시 본다
      this.deps.log?.productSkipped?.({ periodStart: period?.periodStart ?? '', periodEnd: period?.periodEnd ?? '', reason: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
      return 0;
    }
  }

  /** 은행 영업일 09:00 KST 뒤 첫 tick에 다음 은행 영업일 지급분 토스 묶음(ADR-0369 결정 13). 한 상점이라도 실패하면 다음 tick에 다시 한다 */
  async #prepareTossBatches(today: string, hour: number, weekday: boolean): Promise<void> {
    if (!this.deps.settlements.tossPayoutEnabled() || !weekday || hour < 9 || this.#preparedDay === today) return;
    try {
      const out = await this.deps.settlements.runTossBatchPreparation(nextBankBusinessDay(today));
      if (out.failedStores.length === 0) this.#preparedDay = today;
    } catch (e) {
      this.deps.log?.failed?.(e);
    }
  }

  /** 매월 마지막 은행 영업일 22:00 KST 뒤 첫 tick에 두 상점 월 잔액 대사(ADR-0369 결정 11). 같은 달은 저장소 유일 인덱스도 막는다 */
  async #monthlyReconciliation(today: string, hour: number, weekday: boolean): Promise<void> {
    const month = today.slice(0, 7);
    if (!this.deps.settlements.tossReconciliationEnabled() || !weekday || hour < 22 || this.#reconciledMonth === month) return;
    if (nextBankBusinessDay(today).slice(0, 7) === month) return;
    let ok = true;
    for (const pgStore of ['STANDARD', 'ESCROW'] as const) {
      try {
        await this.deps.settlements.reconcileTossBalance({ pgStore, kind: 'MONTHLY', periodMonth: `${month}-01` });
      } catch (e) {
        ok = false;
        this.deps.log?.failed?.(e);
      }
    }
    if (ok) this.#reconciledMonth = month;
  }

  /** 포트원 지급·사후 대사(F-07-7). 시각 몫(08·09·15·월말 22시)을 먼저, 30분 몫을 뒤에 한다. 하나의 실패가 나머지를 멈추지 않는다 */
  async #portone(today: string, hour: number, weekday: boolean): Promise<void> {
    const s = this.deps.settlements;
    if (!s.portonePayoutEnabled()) return;
    const run = async (job: () => Promise<unknown>): Promise<boolean> => {
      try {
        await job();
        return true;
      } catch (e) {
        this.deps.log?.failed?.(e);
        return false;
      }
    };
    // 08:00 KST 뒤 하루 한 번(그날 이미 성공했으면 스스로 건너뛴다)
    await run(() => s.runDailyPortonePartnerCheck());
    if (hour >= 9 && this.#portoneExecutedDay !== today && (await run(() => s.preparePortoneExecution(today)))) this.#portoneExecutedDay = today;
    if (hour >= 15 && this.#portonePendingDay !== today && (await run(() => s.checkPortoneExecutionPending(today)))) this.#portonePendingDay = today;
    const month = today.slice(0, 7);
    if (weekday && hour >= 22 && this.#portoneReconciledMonth !== month && nextBankBusinessDay(today).slice(0, 7) !== month) {
      if (await run(() => s.reconcilePortoneBalance({ kind: 'MONTHLY', periodMonth: `${month}-01` }))) this.#portoneReconciledMonth = month;
    }
    await run(() => s.syncPortonePayouts());
    await run(() => s.reconcilePortoneTransfers());
    await run(() => s.checkPortoneLedgerStale());
  }

  #schedule(): void {
    if (this.#tickPromise) return;
    this.#tickPromise = this.tick(false).finally(() => {
      this.#tickPromise = undefined;
    });
  }
}
