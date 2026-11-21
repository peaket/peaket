// 명령 정비 작업의 타이머(30초 [가정], ADR-0340 결정 3·4·5). 모듈 수명주기로 켜고 끈다(main.ts를 고치지 않는다).
// 파드마다 돌아도 FOR UPDATE SKIP LOCKED라 한 명령은 한쪽만 고친다. 한 바퀴가 실패해도 다음 바퀴에 다시 한다.
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { MaintainCommands } from '../application/maintain-commands.js';
import { COMMAND_MAINTENANCE_OPTIONS } from '../tokens.js';

export interface CommandMaintenanceOptions {
  /** 꺼 두면 타이머를 켜지 않는다(메모리 조립·시험) */
  readonly enabled: boolean;
  readonly intervalMs: number;
}

@Injectable()
export class CommandMaintenanceJob implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly maintain: MaintainCommands,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(COMMAND_MAINTENANCE_OPTIONS) private readonly options: CommandMaintenanceOptions,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** 한 바퀴(겹치지 않게 한 번에 하나) */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.maintain.runOnce(this.clock.now());
    } catch (err) {
      this.logger?.warn({ event: 'ops-command-maintenance-failed', err: err instanceof Error ? err.name : 'unknown' }, '명령 정비 한 바퀴가 실패했다(다음 바퀴에 다시)');
    } finally {
      this.#running = false;
    }
  }
}
