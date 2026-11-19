// BAT-425 GAT-120·GAT-130 지표(transfer-refund §5 '스스로 멈춤', §6 '배상 지급', ADR-0316 결정 7, docs/observability.md).
// PromCsCaseSignals와 같은 꼴이다: registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
// - purchase_refund_account_total{result}(accepted·refunded·pending·rejected·invalid): 지연 환급 계좌 다시 받기
// - purchase_compensation_total{result}(account_pending·requested·paid·failed·unavailable): 배상 계좌 입력·송금
// - event_refund_circuit_pause_total{pg}: 결제사 서킷이 열려 그 몫을 멈춘 수
// 계좌·카드·결제 키는 이름표에 싣지 않는다(ASVS 16.2.5).
import { Counter, type Registry } from '@peaket/platform';

const REFUND_ACCOUNT_RESULTS = ['accepted', 'refunded', 'pending', 'rejected', 'invalid'] as const;
type RefundAccountResult = (typeof REFUND_ACCOUNT_RESULTS)[number];
const COMPENSATION_RESULTS = ['account_pending', 'requested', 'paid', 'failed', 'unavailable'] as const;
type CompensationResult = (typeof COMPENSATION_RESULTS)[number];
const PGS = ['TOSS', 'PORTONE', 'SIMULATOR'] as const;
type CircuitPg = (typeof PGS)[number];

export class PromRefundAccountSignals {
  readonly #refundAccounts = new Counter({
    name: 'purchase_refund_account_total',
    help: '지연 환급 계좌 다시 받기 결과(result: accepted 접수·refunded 환급 끝·pending 결과 모름·rejected 계좌 거절 또는 시도 소진·invalid 본문 오류)',
    labelNames: ['result'] as const,
    registers: [],
  });

  readonly #compensations = new Counter({
    name: 'purchase_compensation_total',
    help: '배상 계좌 입력·송금 결과(result: account_pending 계좌 입력 대기·requested 송금 요청됨·paid 송금 완료·failed 송금 실패·unavailable 지급대행 없음)',
    labelNames: ['result'] as const,
    registers: [],
  });

  readonly #circuitPauses = new Counter({
    name: 'event_refund_circuit_pause_total',
    help: '결제사 서킷이 열려 그 결제사 몫을 멈춘 수(pg: TOSS·PORTONE·SIMULATOR)',
    labelNames: ['pg'] as const,
    registers: [],
  });

  constructor() {
    for (const r of REFUND_ACCOUNT_RESULTS) this.#refundAccounts.inc({ result: r }, 0);
    for (const r of COMPENSATION_RESULTS) this.#compensations.inc({ result: r }, 0);
    for (const pg of PGS) this.#circuitPauses.inc({ pg }, 0);
  }

  register(registry: Registry): this {
    registry.registerMetric(this.#refundAccounts);
    registry.registerMetric(this.#compensations);
    registry.registerMetric(this.#circuitPauses);
    return this;
  }

  refundAccount(result: RefundAccountResult): void {
    if ((REFUND_ACCOUNT_RESULTS as readonly string[]).includes(result)) this.#refundAccounts.inc({ result });
  }

  compensation(result: CompensationResult): void {
    if ((COMPENSATION_RESULTS as readonly string[]).includes(result)) this.#compensations.inc({ result });
  }

  circuitPause(pg: CircuitPg): void {
    if ((PGS as readonly string[]).includes(pg)) this.#circuitPauses.inc({ pg });
  }
}
