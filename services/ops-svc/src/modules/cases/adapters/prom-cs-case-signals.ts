// CS 처리함 건 지표(transfer-refund §13 'CS 처리함 건' 행, F-06-2 GAT-280). registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
// - ops_cs_case_requests_total{kind,result}(카운터): 건 요청 결과(opened·existing·duplicate·ignored). 받는 종류의 ignored가 1건 이상이면 SEV3다.
// - ops_cs_case_open{kind,due_state}(게이지): 알림 작업 한 바퀴가 센 열린 건 수(ON_TRACK·DUE_SOON·OVERDUE·NONE).
// - ops_cs_case_due_tick_seconds(게이지): 알림 작업 한 바퀴가 끝난 시각(유닉스 초). 5분 [가정] 넘게 오르지 않으면 SEV3다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { CsCaseSignals } from '../domain/cs-case.js';

export class PromCsCaseSignals implements CsCaseSignals {
  readonly #requests = new Counter({ name: 'ops_cs_case_requests_total', help: 'CS 처리함 건 요청 결과 수(opened·existing·duplicate·ignored, ADR-0364 결정 4)', labelNames: ['kind', 'result'], registers: [] });
  readonly #open = new Gauge({ name: 'ops_cs_case_open', help: '알림 작업 한 바퀴가 센 열린 CS 건 수(종류·기한 상태별, ADR-0364 결정 3)', labelNames: ['kind', 'due_state'], registers: [] });
  readonly #tick = new Gauge({ name: 'ops_cs_case_due_tick_seconds', help: 'CS 처리함 기한 알림 작업 한 바퀴가 끝난 시각(유닉스 초)', registers: [] });

  request(kind: string, result: 'opened' | 'existing' | 'duplicate' | 'ignored'): void {
    this.#requests.inc({ kind, result });
  }

  openCounts(counts: ReadonlyMap<string, number>): void {
    this.#open.reset();
    for (const [key, n] of counts) {
      const [kind = '', dueState = ''] = key.split('|');
      this.#open.set({ kind, due_state: dueState }, n);
    }
  }

  tickFinished(nowMs: number): void {
    this.#tick.set(Math.floor(nowMs / 1000));
  }

  register(registry: Registry): this {
    registry.registerMetric(this.#requests);
    registry.registerMetric(this.#open);
    registry.registerMetric(this.#tick);
    return this;
  }
}
