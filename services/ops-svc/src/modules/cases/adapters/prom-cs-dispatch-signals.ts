// 이의 처리 보낼 호출 지표(F-06-7 GAT-280, bot-defense §12 '지표'·§15 '이의 결과가 한 번씩 반영된다' 행). registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
// - ops_cs_case_dispatch_total{call,result}(카운터): 반영되면 applied, '반영 실패'로 바뀌는 때 한 번 failed, 그 밖의 실패(반영 실패 뒤 다시 보낸 실패 포함)는 retry.
import { Counter, type Registry } from '@peaket/platform';
import type { CsDispatchSignals, DispatchCall } from '../domain/verification-appeal.js';

export class PromCsDispatchSignals implements CsDispatchSignals {
  readonly #dispatch = new Counter({ name: 'ops_cs_case_dispatch_total', help: 'CS 처리함 보낼 호출의 결과 수(applied·retry·failed, F-06-7 ADR-0364 결정 9)', labelNames: ['call', 'result'], registers: [] });

  dispatch(call: DispatchCall, result: 'applied' | 'retry' | 'failed'): void {
    this.#dispatch.inc({ call, result });
  }

  register(registry: Registry): this {
    registry.registerMetric(this.#dispatch);
    return this;
  }
}
