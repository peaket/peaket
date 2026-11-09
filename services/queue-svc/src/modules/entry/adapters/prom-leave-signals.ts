// 대기 취소 지표(docs/observability.md §5 대기 취소 신호, ADR-0233)
import { Counter, type Registry } from '@peaket/platform';
import type { LeaveRoute, LeaveSignals } from '../domain/ports.js';

export class PromLeaveSignals implements LeaveSignals {
  readonly #left = new Counter({ name: 'queue_leave_total', help: '대기 취소·로비 참가 취소로 기록을 실제로 취소한 요청 수(route는 URL 템플릿)', labelNames: ['route'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#left);
  }

  left(route: LeaveRoute): void {
    this.#left.inc({ route });
  }
}
