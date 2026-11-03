// 만료 루프 시동(docs/features/seat-hold.md §14 동작 5): 복제본마다 정한 간격으로 만료 시각이 지난 홀드를 푼다.
// 같은 홀드를 두 복제본이 풀지 않는 판정은 저장소(FOR UPDATE SKIP LOCKED)가 한다. 실패는 기록하고 다음 간격에 다시 한다.
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { InventoryService } from '../application/inventory-service.js';

export const EXPIRY_INTERVAL_MS = Symbol.for('peaket.v0.inventory.expiryIntervalMs');

@Injectable()
export class ExpiryTicker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly inventory: InventoryService,
    @Inject(EXPIRY_INTERVAL_MS) private readonly intervalMs: number | false,
    @Inject(PLATFORM_LOGGER) private readonly logger: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs === false) return;
    this.timer = setInterval(() => void this.once(), this.intervalMs);
    this.timer.unref();
  }

  /** 타이머를 멈추고 돌던 한 번이 끝나기를 기다린다(그 뒤에 DB 연결을 닫아도 남은 호출이 없다) */
  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** 한 번 돈다. 앞의 것이 아직 돌면 그것을 기다린다 */
  once(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.inventory
      .expireDue()
      .then(
        () => undefined,
        (err: unknown) => {
          const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } };
          this.logger.error({ errName: String(e?.name ?? 'Error'), code: String(e?.code ?? e?.cause?.code ?? '') }, 'v0 홀드 만료 실패');
        },
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
