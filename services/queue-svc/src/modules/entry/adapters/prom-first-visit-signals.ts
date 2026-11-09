// 최초 방문 쿠키 읽기 지표(docs/features/bot-defense.md §15, ADR-0249 결정 2).
import { Counter, type Registry } from '@peaket/platform';
import type { FirstVisitResult, FirstVisitSignals } from '../domain/ports.js';

export class PromFirstVisitSignals implements FirstVisitSignals {
  readonly #cookie = new Counter({ name: 'trust_first_visit_cookie_total', help: '최초 방문 쿠키 읽기 결과(ok: 신호로 씀, absent: 쿠키 없음, invalid: 서명·모양이 틀림, stale: 시각이 범위 밖, disabled: 키가 없어 기능을 껐다)', labelNames: ['result'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#cookie);
  }

  cookie(result: FirstVisitResult): void {
    this.#cookie.inc({ result });
  }
}
