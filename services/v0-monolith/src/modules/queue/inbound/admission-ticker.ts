// 입장 루프 시동(docs/features/queue-admission.md §13 동작 4): 복제본마다 정한 간격으로 연 회차마다 1초 칸을 부른다.
// 1초 칸을 한 복제본만 맡는 판정은 Lua가 한다. 그래서 간격을 1초보다 짧게 둔다: 1초 간격이면 타이머가 조금씩 밀려
// 칸 하나를 통째로 건너뛸 수 있다(새 맥락 리뷰). 실패는 기록하고 다음 간격에 다시 한다.
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { QueueService, QueueTickError } from '../application/queue-service.js';

export const TICK_INTERVAL_MS = Symbol.for('peaket.v0.queue.tickIntervalMs');

@Injectable()
export class AdmissionTicker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly queue: QueueService,
    @Inject(TICK_INTERVAL_MS) private readonly intervalMs: number | false,
    @Inject(PLATFORM_LOGGER) private readonly logger: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs === false) return;
    this.timer = setInterval(() => void this.once(), this.intervalMs);
    this.timer.unref();
  }

  /** 타이머를 멈추고 돌던 한 번이 끝나기를 기다린다(그 뒤에 Redis 연결을 닫아도 남은 호출이 없다) */
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** 한 번 돈다. 앞의 것이 아직 돌면 건너뛴다 */
  once(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.queue
      .tick()
      .then(
        () => undefined,
        (err: unknown) => {
          // 회차마다 따로 남긴다(묶은 오류의 안쪽은 로그 직렬화가 버린다)
          const each = err instanceof AggregateError ? err.errors : [err];
          for (const e of each) {
            if (e instanceof QueueTickError) this.logger.error({ err: e.cause, eventId: e.eventId }, 'v0 입장 루프 실패');
            else this.logger.error({ err: e }, 'v0 입장 루프 실패');
          }
        },
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
