// 도착 시각 쿠키와 칸 번호 지표(docs/observability.md §5, ADR-0223, Q-T16의 장부).
import { Counter, type Registry } from '@peaket/platform';
import type { ArrivalSignals } from '../domain/ports.js';

export class PromArrivalSignals implements ArrivalSignals {
  readonly #cookies = new Counter({ name: 'queue_arrival_cookies_total', help: '도착 시각 쿠키를 번호를 받기 직전에 본 결과(ok 받음, invalid 어긋남, reused 이미 쓴 요청 ID, absent 엣지가 서명 없이 보냄, unavailable 요청 ID를 잡지 못해 503)', labelNames: ['result'] as const, registers: [] });
  readonly #numbers = new Counter({ name: 'queue_arrival_numbers_total', help: '쿠키를 받은 요청의 번호 길(slot 칸 안, late 칸이 닫혔거나 없음, overflow 구간이 참)', labelNames: ['path'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#cookies);
    registry.registerMetric(this.#numbers);
  }

  cookie(result: 'ok' | 'invalid' | 'reused' | 'absent' | 'unavailable'): void {
    this.#cookies.inc({ result });
  }

  number(path: 'slot' | 'late' | 'overflow'): void {
    this.#numbers.inc({ path });
  }
}
