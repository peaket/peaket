// CS 건 열기 실패·다시 열기 멈춤 지표(BAT-420 웨이브 끝 리뷰 C2·S1, 다시 보기 2 N1·N2, guidelines §8.1 'ops-svc CS 처리함 내부 HTTP'). PromOrderExpirySignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다. API 파드(Start의 옛 조립)와 릴레이 프로세스(실행기 틱)가 각자 붙인다.
// - purchase_cs_case_open_failures_total{kind}(카운터, kind: DEDUCTION_GAP·FLAGGED·REFUND_FAILED·EVENT_REFUND_FAILED): ops-svc가 2xx로 받지 않아 열지 못한 CS 건 수(행은 다음 틱에 다시 연다)
// - purchase_cs_case_reopen_cut_total{reason}(카운터, reason: budget·unreachable): 한 틱의 다시 열기를 시간 예산 넘김·잇따른 무응답으로 멈춘 수(transfer-refund §3.1 ⑥)
import { Counter, type Registry } from '@peaket/platform';

const KINDS = ['DEDUCTION_GAP', 'FLAGGED', 'REFUND_FAILED', 'EVENT_REFUND_FAILED'] as const;
type CsCaseKind = (typeof KINDS)[number];
const CUT_REASONS = ['budget', 'unreachable'] as const;
type CutReason = (typeof CUT_REASONS)[number];

export class PromCsCaseSignals {
  readonly #failures = new Counter({
    name: 'purchase_cs_case_open_failures_total',
    help: 'ops-svc CS 처리함이 2xx로 받지 않아 열지 못한 건 수(kind: DEDUCTION_GAP 공제 차액·FLAGGED 이상 표시·REFUND_FAILED 환급 실패·EVENT_REFUND_FAILED 일괄 환불 실패, 다음 틱에 다시 연다)',
    labelNames: ['kind'] as const,
    registers: [],
  });

  readonly #cuts = new Counter({
    name: 'purchase_cs_case_reopen_cut_total',
    help: '한 틱의 CS 건 다시 열기를 멈춘 수(reason: budget 시간 예산 5초 넘김·unreachable 시간 초과·연결 실패 두 번 잇따름, 남은 건은 다음 틱)',
    labelNames: ['reason'] as const,
    registers: [],
  });

  constructor() {
    // 처음 실패 전에도 경보식이 값을 보게 이름표 값을 0으로 미리 보인다
    for (const kind of KINDS) this.#failures.inc({ kind }, 0);
    for (const reason of CUT_REASONS) this.#cuts.inc({ reason }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#failures);
    registry.registerMetric(this.#cuts);
    return this;
  }

  /** purchase_cs_case_open_failures_total{kind}를 1 올린다(모르는 값은 버린다). 던지지 않는다 */
  inc(kind: CsCaseKind): void {
    if ((KINDS as readonly string[]).includes(kind)) this.#failures.inc({ kind });
  }

  /** purchase_cs_case_reopen_cut_total{reason}을 1 올린다(모르는 값은 버린다). 던지지 않는다 */
  cut(reason: CutReason): void {
    if ((CUT_REASONS as readonly string[]).includes(reason)) this.#cuts.inc({ reason });
  }
}
