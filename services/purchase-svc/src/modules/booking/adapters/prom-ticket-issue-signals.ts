// 발권 실행기 지표(TicketIssueSignals, ADR-0106 결정 2, BUILD_ORDER PRF-170). PromOrderSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다. 이름은 docs/features/payment.md §2 '발권 호출과 재시도 큐의 첫 구현' 지표와
// docs/observability.md 서비스 템플릿의 발권 행 그대로다.
// 게이지는 실행기가 10초 [가정]마다 한 질의로 잰 값이라 파드마다 같은 값이다(경보는 최댓값으로 본다).
// main.ts가 발권 실행기를 켤 때(purchase DB가 있을 때) 서비스 레지스트리에 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { TicketIssueGauges, TicketIssueSignals } from '../domain/ports.js';
import { TICKET_ISSUE_ATTEMPT_RESULTS, TICKET_ISSUE_JOB_STATES, type TicketIssueAttemptResult } from '../domain/ticket-issue.js';

/**
 * - ticket_issue_jobs{state}(게이지, state: pending·stopped): 발권 큐 행 수. pending = next_attempt_at이 있는 행(처음·다시 보낼 행), stopped = 다시 보내지 않을 실패로 멈춘 행
 * - ticket_issue_oldest_seconds(게이지, 이름표 없음): 다시 보낼 큐 행 가운데 가장 오래된 행의 나이(초, 지금 − created_at. 멈춘 행은 빼고, 행이 없으면 0, 리뷰 고침 M3)
 * - ticket_issue_attempts_total{result}(카운터, result: issued·retry·stopped·stale): 발권 호출을 마친 큐 행 수
 * - ticket_issue_delayed_total(카운터, 이름표 없음): ISSUE_DELAYED를 낸 주문 수(SEV2)
 * - ticket_issue_overdue_total(카운터, 이름표 없음): 발권 기한을 넘긴 주문 수(SEV1)
 */
export class PromTicketIssueSignals implements TicketIssueSignals {
  readonly #jobs = new Gauge({
    name: 'ticket_issue_jobs',
    help: '발권 재시도 큐(ticket_issue_job) 행 수(state: pending = 처음·다시 보낼 행, stopped = 다시 보내지 않을 실패로 멈춘 행)',
    labelNames: ['state'] as const,
    registers: [],
  });

  readonly #oldest = new Gauge({
    name: 'ticket_issue_oldest_seconds',
    help: '발권 재시도 큐에서 다시 보낼 행 가운데 가장 오래된 행의 나이(초, 승인 반영 시각 created_at부터. 멈춘 행은 빼고, 행이 없으면 0)',
    registers: [],
  });

  readonly #attempts = new Counter({
    name: 'ticket_issue_attempts_total',
    help: '발권 호출을 마친 큐 행 수(result: issued = 발권 확정, retry = 다시 보냄, stopped = 멈춤, stale = 주문이 APPROVED가 아니라 큐 행만 지움)',
    labelNames: ['result'] as const,
    registers: [],
  });

  readonly #delayed = new Counter({
    name: 'ticket_issue_delayed_total',
    help: '승인 뒤 60초 [가정] 넘게 발권되지 않아 ISSUE_DELAYED를 낸 주문 수(SEV2)',
    registers: [],
  });

  readonly #overdue = new Counter({
    name: 'ticket_issue_overdue_total',
    help: '발권 기한(승인 + 30분 [가정])을 넘긴 주문 수(SEV1, CS TICKET_NOT_ISSUED)',
    registers: [],
  });

  constructor() {
    // 이름표 값을 0으로 미리 보인다(처음 발권 전에도 경보식이 값을 본다)
    for (const result of TICKET_ISSUE_ATTEMPT_RESULTS) this.#attempts.inc({ result }, 0);
    for (const state of TICKET_ISSUE_JOB_STATES) this.#jobs.set({ state }, 0);
  }

  /** 지표 다섯을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#jobs);
    registry.registerMetric(this.#oldest);
    registry.registerMetric(this.#attempts);
    registry.registerMetric(this.#delayed);
    registry.registerMetric(this.#overdue);
    return this;
  }

  /** ticket_issue_jobs{state}를 pending·stopped로, ticket_issue_oldest_seconds를 oldestAgeSeconds로 둔다. 던지지 않는다 */
  jobs(g: TicketIssueGauges): void {
    try {
      this.#jobs.set({ state: 'pending' }, g.pending);
      this.#jobs.set({ state: 'stopped' }, g.stopped);
      this.#oldest.set(g.oldestAgeSeconds);
    } catch {
      // 값이 수가 아니면(포트 약속 밖) 버린다. 지표는 실행기를 막지 않는다
    }
  }

  /** ticket_issue_attempts_total{result}를 1 올린다(모르는 값은 이름표 수가 늘지 않게 버린다). 던지지 않는다 */
  attempt(result: TicketIssueAttemptResult): void {
    if (!ATTEMPT_RESULTS.has(result)) return;
    this.#attempts.inc({ result });
  }

  /** ticket_issue_delayed_total을 count(0 이상 정수)만큼 올린다. 0이면 아무것도 하지 않는다. 던지지 않는다 */
  delayed(count: number): void {
    if (isPositiveCount(count)) this.#delayed.inc(count);
  }

  /** ticket_issue_overdue_total을 count(0 이상 정수)만큼 올린다. 0이면 아무것도 하지 않는다. 던지지 않는다 */
  overdue(count: number): void {
    if (isPositiveCount(count)) this.#overdue.inc(count);
  }
}

const ATTEMPT_RESULTS: ReadonlySet<string> = new Set<string>(TICKET_ISSUE_ATTEMPT_RESULTS);
/** 올릴 수(1 이상의 안전한 정수). 0·음수·소수·수가 아닌 값은 버린다 */
const isPositiveCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
