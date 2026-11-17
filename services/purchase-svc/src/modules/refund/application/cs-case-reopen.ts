// CS 건 다시 열기의 한 틱 시간 예산·잇따른 무응답 멈춤(BAT-420 다시 보기 2 N1, transfer-refund §3.1 ⑥, guidelines §8.1 'ops-svc CS 처리함 내부 HTTP').
// 다시 열기 포트가 꽂힌 두 실행기(마감 뒤 환급·일괄 환불)는 그 틱의 환급 처리가 끝난 뒤 이 한 곳에서만 CS 건을 연다.
// - 예산: 한 틱에 하나를 만들어 그 실행기의 모든 종류가 함께 쓴다. 행마다 부르기 전에 남은 예산을 보고, 다 썼으면 남은 행은 다음 틱이다.
// - 잇따른 무응답: 시간 초과·연결 실패(CsCaseRejected가 아닌 던짐)가 두 번 [가정] 잇따르면 그 틱의 다시 열기를 멈춘다. 2xx 밖의 답(CsCaseRejected)은
//   ops-svc가 답한 것이라 잇따름을 끊는다.
// - 둘이 겹칠 때: 그 틱에 ops-svc가 아직 한 번도 답하지 않았으면(부른 것이 모두 무응답) 예산을 다 써도 잇따름 상한까지는 부른다. 시간 초과 하나가
//   예산(5초)을 다 쓰므로, 그렇지 않으면 무응답 멈춤이 시간 초과에는 쓰이지 않는다(guidelines §8.1 '그래서 ops-svc가 답하지 않아도 한 틱이 늘어나는 것은
//   약 10초까지다'). 한 번이라도 답했으면 예산이 정한다. 그래서 한 틱이 늘어나는 것은 어느 쪽이든 예산 + 호출 한도(5초) 또는 호출 한도 × 2, 약 10초까지다.
// - 멈추거나 예산을 넘기면 경고 cs-case-reopen-cut(이유 budget·unreachable)과 지표 purchase_cs_case_reopen_cut_total{reason}을 틱마다 하나씩 남긴다.
import { CS_CASE_REOPEN_BATCH, type CsCaseOpenSignals } from '../domain/event-refund-ports.js';

/** 한 틱의 다시 열기 시간 예산 5초 [가정] */
export const CS_CASE_REOPEN_BUDGET_MS = 5_000;
/** 시간 초과·연결 실패가 이만큼 잇따르면 그 틱의 다시 열기를 멈춘다(2번 [가정]) */
export const CS_CASE_REOPEN_MAX_UNREACHABLE = 2;

export type CsCaseReopenCut = 'budget' | 'unreachable';
export type CsCaseReopenOutcome = 'opened' | 'rejected' | 'unreachable';

export class CsCaseReopenBudget {
  readonly #nowMs: () => number;
  readonly #startMs: number;
  readonly #budgetMs: number;
  readonly #maxUnreachable: number;
  /** 잇따른 무응답 수('opened'·'rejected'가 끊는다) */
  #streak = 0;
  /** 이 틱에 ops-svc가 한 번이라도 답했는가('opened'·'rejected') */
  #answered = false;
  #cut: CsCaseReopenCut | undefined;

  /** 예산은 만든 때부터 센다 */
  constructor(o: { nowMs(): number; budgetMs?: number; maxUnreachable?: number }) {
    this.#nowMs = () => o.nowMs();
    this.#startMs = o.nowMs();
    this.#budgetMs = o.budgetMs ?? CS_CASE_REOPEN_BUDGET_MS;
    this.#maxUnreachable = o.maxUnreachable ?? CS_CASE_REOPEN_MAX_UNREACHABLE;
  }

  /** 부르기 전에 본다. 남은 예산이 있고(남은 1ms면 부르고 0ms면 부르지 않는다) 잇따른 무응답 멈춤이 아니면 참. 한 번 거짓이면 그 틱에는 계속 거짓이다 */
  canCall(): boolean {
    if (this.#cut !== undefined) return false;
    if (this.#streak >= this.#maxUnreachable) {
      this.#cut = 'unreachable';
      return false;
    }
    if (this.#nowMs() - this.#startMs < this.#budgetMs) return true;
    // 예산을 다 썼어도 아직 한 번도 답을 받지 못한 무응답 잇따름이면 상한까지는 잇따름 셈이 정한다(위 머리말 '둘이 겹칠 때')
    if (!this.#answered && this.#streak > 0) return true;
    this.#cut = 'budget';
    return false;
  }

  /** 부른 결과: 'opened' 2xx, 'rejected' CsCaseRejected(2xx 밖 답), 'unreachable' 그 밖에 던진 것(시간 초과·연결 실패) */
  record(outcome: CsCaseReopenOutcome): void {
    if (outcome === 'unreachable') {
      this.#streak++;
      return;
    }
    this.#streak = 0;
    this.#answered = true;
  }

  /** 멈춘 까닭(예산 넘김·잇따른 무응답). canCall이 거짓을 준 뒤에 정해진다. 멈추지 않았으면 undefined */
  get cut(): CsCaseReopenCut | undefined {
    return this.#cut;
  }
}

/**
 * 열기가 던진 것을 예산 결과로 나눈다: CsCaseRejected(adapters/cs-case-response.ts, 2xx 밖 답)는 ops-svc가 답한 것, 그 밖(시간 초과·연결 실패·마감 넘김)은 무응답.
 * 쓰임새 층이 어댑터를 가져오지 않게 오류 이름으로 가른다
 */
export function reopenOutcomeOf(err: unknown): Exclude<CsCaseReopenOutcome, 'opened'> {
  return err instanceof Error && err.name === 'CsCaseRejected' ? 'rejected' : 'unreachable';
}

/** 다시 열 CS 건 한 종류(목록·열기·연 시각 쓰기와, 실패했을 때 남길 경고·지표) */
export interface CsCaseReopenKind<Row> {
  /** 지표 purchase_cs_case_open_failures_total{kind}의 값 */
  readonly kind: Parameters<CsCaseOpenSignals['inc']>[0];
  /** 실패한 행마다 남길 경고 이름(예: event-refund-failure-notice-failed) */
  readonly failedEvent: string;
  /** 열지 않은 행(표시 시각 순, limit까지) */
  list(limit: number): Promise<readonly Row[]>;
  open(row: Row, nowMs: number): Promise<void>;
  /** ops-svc가 2xx로 받은 뒤에만 부른다 */
  markOpened(row: Row, nowMs: number): Promise<void>;
  /** 경고에 실을 식별자(ID만, 개인정보 없음) */
  ids(row: Row): Record<string, string>;
}

/**
 * 한 틱의 다시 열기. 종류를 차례로 넘기면(reopen) 같은 예산으로 연다. 목록을 읽지 못하거나 한 행이 실패해도 던지지 않는다(경고·지표 뒤 다음 틱).
 * 예산을 넘기거나 무응답으로 멈추면 그 틱에 한 번 경고 cs-case-reopen-cut·지표 cut(reason)을 남기고, 뒤 종류는 목록도 읽지 않는다
 */
export class CsCaseReopenTick {
  readonly #budget: CsCaseReopenBudget;

  constructor(
    private readonly o: {
      readonly nowMs: () => number;
      /** 경고에 실을 실행기 이름(event-refund·cancellation-refund) */
      readonly runner: string;
      readonly signals?: CsCaseOpenSignals | undefined;
      readonly log?: { warn(o: object, msg: string): void } | undefined;
      readonly budgetMs?: number;
      readonly maxUnreachable?: number;
    },
  ) {
    this.#budget = new CsCaseReopenBudget({
      nowMs: () => o.nowMs(),
      ...(o.budgetMs !== undefined ? { budgetMs: o.budgetMs } : {}),
      ...(o.maxUnreachable !== undefined ? { maxUnreachable: o.maxUnreachable } : {}),
    });
  }

  async reopen<Row>(k: CsCaseReopenKind<Row>): Promise<void> {
    if (this.#budget.cut !== undefined) return;
    let rows: readonly Row[];
    try {
      rows = await k.list(CS_CASE_REOPEN_BATCH);
    } catch (err) {
      this.o.log?.warn({ event: k.failedEvent, err: err instanceof Error ? err.name : 'unknown' }, `${k.failedEvent}: 열지 않은 CS 건 목록을 읽지 못했다(다음 틱에 다시 본다)`);
      return;
    }
    for (const row of rows) {
      if (!this.#budget.canCall()) {
        this.#reportCut(k.kind);
        return;
      }
      const nowMs = this.o.nowMs();
      try {
        await k.open(row, nowMs);
      } catch (err) {
        this.#budget.record(reopenOutcomeOf(err));
        this.#failed(k, row, err);
        continue;
      }
      this.#budget.record('opened');
      try {
        await k.markOpened(row, nowMs);
      } catch (err) {
        // 건은 열렸지만 연 시각을 쓰지 못했다. 다음 틱에 다시 보내고 ops-svc가 같은 eventKey라 한 건으로 받는다
        this.#failed(k, row, err);
      }
    }
  }

  #failed<Row>(k: CsCaseReopenKind<Row>, row: Row, err: unknown): void {
    this.o.log?.warn({ event: k.failedEvent, ...k.ids(row), err: err instanceof Error ? err.name : 'unknown' }, `${k.failedEvent}: CS 건을 열지 못했다(다음 틱에 다시 연다)`);
    this.o.signals?.inc(k.kind);
  }

  #reportCut(kind: string): void {
    const reason = this.#budget.cut;
    if (reason === undefined) return;
    this.o.log?.warn(
      { event: 'cs-case-reopen-cut', runner: this.o.runner, reason, kind },
      `cs-case-reopen-cut: 이번 틱의 CS 건 다시 열기를 멈췄다(이유 ${reason}, 남은 건은 다음 틱)`,
    );
    this.o.signals?.cut?.(reason);
  }
}
