// 회차 취소 요청 지표(BAT-420 웨이브 끝 리뷰 K4). 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다(purchase-svc 지표와 같은 꼴).
// - ops_event_cancellation_core_apply_failures_total(카운터, 이름표 없음): core 회차 상태 반영이 실패한 수(BAT-420-rest GAT-110, transfer-refund §5).
// - ops_event_cancellation_revert_failures_total(카운터, 이름표 없음): 확정 실패 뒤 PENDING_APPROVAL로 되돌리는 저장이 던진 수.
//   1 이상이면 그 요청이 RUNNING에 남았을 수 있다(approve의 다시 확정이 이어 간다, transfer-refund §5 '판정·미리보기·확정의 차례')
import { Counter, type Registry } from '@peaket/platform';

export class PromEventCancellationSignals {
  readonly #revertFailures = new Counter({
    name: 'ops_event_cancellation_revert_failures_total',
    help: '회차 취소 확정 실패 뒤 PENDING_APPROVAL 되돌리기 저장이 실패한 수(그 요청은 RUNNING에 남는다, 웨이브 끝 리뷰 K4)',
    registers: [],
  });

  readonly #coreApplyFailures = new Counter({
    name: 'ops_event_cancellation_core_apply_failures_total',
    help: 'core 회차 상태 반영(확정 직후·다시 하기)이 실패한 수(확정은 그대로, 1분 다시 하기가 잇는다, BAT-420-rest GAT-110)',
    registers: [],
  });

  /** EventCancellationExtra.revertFailures에 넘기는 몫 */
  readonly revertFailures = { inc: (): void => this.#revertFailures.inc() };

  /** EventCancellationExtra.coreApplyFailures에 넘기는 몫 */
  readonly coreApplyFailures = { inc: (): void => this.#coreApplyFailures.inc() };

  constructor() {
    // 처음 실패 전에도 경보식이 값을 보게 0을 미리 보인다
    this.#revertFailures.inc(0);
    this.#coreApplyFailures.inc(0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#revertFailures);
    registry.registerMetric(this.#coreApplyFailures);
    return this;
  }
}
