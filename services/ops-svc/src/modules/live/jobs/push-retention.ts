// 관제 SSE 정비 반복(ADR-0100 결정 4, ADR-0360 결정 1): 1분 [가정]마다 1시간 [가정] 지난 알림 행과 45초 [가정] 지난 접속자 행을 지운다.
// 파드마다 돌아도 같은 조건의 지우기라 겹쳐도 맞다. 모듈 수명주기로 켜고 끈다(main.ts를 고치지 않는다). DB 조립에서만 켠다.
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { OPS_LIVE_REPLAY_WINDOW_MS, OPS_LIVE_RETENTION_MS, OPS_PRESENCE_WINDOW_MS } from '../domain/live.js';
import type { PresenceStore, PushEventSource } from '../domain/ports.js';
import { LIVE_RETENTION_ENABLED, PRESENCE_STORE, PUSH_EVENT_SOURCE } from '../tokens.js';

@Injectable()
export class PushRetentionJob implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    @Inject(PUSH_EVENT_SOURCE) private readonly events: PushEventSource,
    @Inject(PRESENCE_STORE) private readonly presence: PresenceStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LIVE_RETENTION_ENABLED) private readonly enabled: boolean,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled || this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), OPS_LIVE_RETENTION_MS);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 한 바퀴(겹치지 않게). 지운 수 */
  async tick(): Promise<{ events: number; presence: number }> {
    if (this.#running) return { events: 0, presence: 0 };
    this.#running = true;
    try {
      const [events, presence] = await Promise.all([this.events.deleteOlderThan(OPS_LIVE_REPLAY_WINDOW_MS), this.presence.deleteOlderThan(OPS_PRESENCE_WINDOW_MS, this.clock.now())]);
      return { events, presence };
    } catch (err) {
      this.logger?.warn({ event: 'ops-live-retention-failed', err: err instanceof Error ? err.name : 'unknown' }, '관제 알림 표 정비가 실패했다(다음 바퀴에 다시)');
      return { events: 0, presence: 0 };
    } finally {
      this.#running = false;
    }
  }
}
