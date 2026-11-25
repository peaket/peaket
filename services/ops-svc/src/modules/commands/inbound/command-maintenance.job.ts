// 명령 정비 작업의 타이머(30초 [가정], ADR-0340 결정 3·4·5). 모듈 수명주기로 켜고 끈다(main.ts를 고치지 않는다).
// 파드마다 돌아도 FOR UPDATE SKIP LOCKED라 한 명령은 한쪽만 고친다. 한 바퀴가 실패해도 다음 바퀴에 다시 한다.
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { CLOCK, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { MaintainCommands } from '../application/maintain-commands.js';
import { CheckSettingsApply } from '../application/check-settings-apply.js';
import { PublishOnsaleLogSampling } from '../domain/log-sampling.js';
import { APPLY_CHECK_ROUND_MS } from '../domain/apply-check.js';
import { COMMAND_MAINTENANCE_EXTRAS, COMMAND_MAINTENANCE_OPTIONS } from '../tokens.js';

export interface CommandMaintenanceOptions {
  /** 꺼 두면 타이머를 켜지 않는다(메모리 조립·시험) */
  readonly enabled: boolean;
  readonly intervalMs: number;
  /** 적용 확인 바퀴 간격(기본 5,000ms). 시작 직후에는 돌지 않고 이 간격 뒤에 처음 돈다 */
  readonly applyCheckRoundMs?: number;
}

@Injectable()
export class CommandMaintenanceJob implements OnApplicationBootstrap, OnModuleDestroy {
  #timer: NodeJS.Timeout | undefined;
  #applyTimer: NodeJS.Timeout | undefined;
  #running = false;
  #applyRunning = false;

  constructor(
    private readonly maintain: MaintainCommands,
    @Inject(CLOCK) private readonly clock: { now(): number },
    @Inject(COMMAND_MAINTENANCE_OPTIONS) private readonly options: CommandMaintenanceOptions,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    @Optional() @Inject(COMMAND_MAINTENANCE_EXTRAS) private readonly extras: { readonly settingsApply?: CheckSettingsApply; readonly logSampling?: PublishOnsaleLogSampling } = {},
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled || this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.#timer.unref();
    // 적용 확인은 정비(30초)와 따로 5초마다 본다. 첫 tick은 이 간격이 지난 뒤다(즉시 돌지 않는다)
    if (this.extras.settingsApply) {
      this.#applyTimer = setInterval(() => void this.tickApplyCheck(), this.options.applyCheckRoundMs ?? APPLY_CHECK_ROUND_MS);
      this.#applyTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#applyTimer) clearInterval(this.#applyTimer);
    this.#timer = undefined;
    this.#applyTimer = undefined;
  }

  /** 한 바퀴(겹치지 않게 한 번에 하나). 정비 + 온세일 표본 생산 */
  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      await this.maintain.runOnce(this.clock.now());
      await this.extras.logSampling?.runOnce().catch(() => undefined);
    } catch (err) {
      this.logger?.warn({ event: 'ops-command-maintenance-failed', err: err instanceof Error ? err.name : 'unknown' }, '명령 정비 한 바퀴가 실패했다(다음 바퀴에 다시)');
    } finally {
      this.#running = false;
    }
  }

  /** 적용 확인 한 바퀴(겹치지 않게 한 번에 하나). 시험은 이 메서드를 부른다 */
  async tickApplyCheck(): Promise<import('../application/check-settings-apply.js').ApplyCheckRound> {
    if (this.#applyRunning || !this.extras.settingsApply) return { checked: 0, opened: 0, resolved: 0 };
    this.#applyRunning = true;
    try {
      return await this.extras.settingsApply.runOnce();
    } catch (err) {
      this.logger?.warn({ event: 'ops-settings-apply-check-failed', err: err instanceof Error ? err.name : 'unknown' }, '적용 확인 한 바퀴가 실패했다(다음 바퀴에 다시)');
      return { checked: 0, opened: 0, resolved: 0 };
    } finally {
      this.#applyRunning = false;
    }
  }
}
