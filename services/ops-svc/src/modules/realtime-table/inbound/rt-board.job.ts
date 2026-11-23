// 실시간 표 보드의 0.5초 주기를 앱 수명주기에 묶는다(듣기 전 켜고, 닫을 때 돌던 바퀴를 기다려 끈다).
import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { RtBoard } from '../application/rt-board.js';

export const RT_BOARD_AUTOSTART = Symbol.for('peaket.ops.rt-board-autostart');

@Injectable()
export class RtBoardJob implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    private readonly board: RtBoard,
    @Inject(RT_BOARD_AUTOSTART) private readonly autoStart: boolean,
  ) {}

  onApplicationBootstrap(): void {
    if (this.autoStart) this.board.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.board.stop();
  }
}
