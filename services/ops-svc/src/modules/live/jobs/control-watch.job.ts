// 자동 제어 상태 감시의 수명주기(F-03-3, ADR-0371 결정 7). 대기열 Redis 주소가 있을 때만 1초 [가정]마다 돈다. 모듈이 내려가면 멈추고 연결을 닫는다(main.ts를 고치지 않는다).
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy, Optional } from '@nestjs/common';
import { ControlWatch } from '../application/control-watch.js';
import type { ControlReader } from '../domain/ports.js';
import { CONTROL_READER } from '../tokens.js';

@Injectable()
export class ControlWatchJob implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly watch: ControlWatch,
    @Optional() @Inject(CONTROL_READER) private readonly reader?: ControlReader,
  ) {}

  onApplicationBootstrap(): void {
    this.watch.start();
  }

  async onModuleDestroy(): Promise<void> {
    this.watch.stop();
    await this.reader?.close?.().catch(() => undefined);
  }
}
