// 보상 지표(BAT-011, PRF-173, docs/features/payment.md §3 '보상 세 걸음의 첫 구현', docs/observability.md).
// PromTicketIssueSignals와 같은 꼴이다(registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다).
// - purchase_compensation_total{result}: started(큐에 새 행)·fenced(발권 막기 끝)·compensated(결제 취소·T20 끝)·retry(다시 보냄)·failed(영구 실패, SEV2)
// - order_compensation_jobs{state}: pending(STARTED·FENCED, 다시 보낼 행)과 failed(FAILED) 행 수(게이지, 10초 [가정]마다)
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { CompensationSignals } from '../domain/compensation.js';

const RESULTS = ['started', 'fenced', 'compensated', 'retry', 'failed'] as const;
type ResultName = (typeof RESULTS)[number];
const RESULT_SET: ReadonlySet<string> = new Set<string>(RESULTS);

export class PromCompensationSignals implements CompensationSignals {
  readonly #total = new Counter({
    name: 'purchase_compensation_total',
    help: '보상 세 걸음의 결과(result: started = 큐에 넣음, fenced = 발권 막기 끝, compensated = 결제 취소·COMPENSATED 끝, retry = 다시 보냄, failed = 영구 실패)',
    labelNames: ['result'] as const,
    registers: [],
  });

  readonly #jobs = new Gauge({
    name: 'order_compensation_jobs',
    help: 'order_compensation 행 수(state: pending = STARTED·FENCED로 다시 보낼 행, failed = FAILED로 사람을 기다리는 행)',
    labelNames: ['state'] as const,
    registers: [],
  });

  constructor() {
    // 이름표 값을 0으로 미리 보인다(처음 보상 전에도 경보식이 값을 본다)
    for (const r of RESULTS) this.#total.inc({ result: r }, 0);
    this.#jobs.set({ state: 'pending' }, 0);
    this.#jobs.set({ state: 'failed' }, 0);
  }

  /** 지표 둘을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#total);
    registry.registerMetric(this.#jobs);
    return this;
  }

  /** purchase_compensation_total{result}를 1 올린다(모르는 값은 이름표 수가 늘지 않게 버린다). 던지지 않는다 */
  result(result: ResultName): void {
    if (!RESULT_SET.has(result)) return;
    try {
      this.#total.inc({ result });
    } catch {
      // 지표는 실행기를 막지 않는다
    }
  }

  /** order_compensation_jobs{state}를 count로 둔다(0 이상 정수가 아니면 버린다). 던지지 않는다 */
  jobs(state: 'pending' | 'failed', count: number): void {
    if (!(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) return;
    try {
      this.#jobs.set({ state }, count);
    } catch {
      // 지표는 실행기를 막지 않는다
    }
  }
}
