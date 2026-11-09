// 로비 참가 지표(docs/observability.md §5 로비 참가 퍼뜨리기 신호·셔플 비콘 신호, ADR-0231)
import { Counter, type Registry } from '@peaket/platform';
import type { LobbySignals } from '../domain/ports.js';

export class PromLobbySignals implements LobbySignals {
  readonly #early = new Counter({ name: 'lobby_join_before_open_total', help: '그 기기의 로비 입장 버튼이 열리는 시각보다 먼저 온 로비 참가 수', labelNames: ['event_id'] as const, registers: [] });
  readonly #late = new Counter({ name: 'queue_shuffle_commit_late_total', help: '공시 때가 지나서 그 자리에서 만든 셔플 커밋 수', registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#early);
    registry.registerMetric(this.#late);
  }

  joinedBeforeUnlock(eventId: string): void {
    this.#early.inc({ event_id: eventId });
  }

  commitLate(): void {
    this.#late.inc();
  }
}
