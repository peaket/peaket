// 관제 실시간 표 모듈 조립(OPS-160, F-04-1). 보드(RtBoard)는 시작 조립(rt-wiring.ts)이 원천·기대 파티션·지표로 만들어 넘긴다.
// 보드를 내보내 관제 위젯 원천(F-03-1 WidgetSource)이 같은 보드를 쓴다. 소속 확인(core 판매 설정)이 없으면 파트너 판매 현황은 503 authz-unavailable이다.
import { type DynamicModule, Module } from '@nestjs/common';
import { GetPartnerLiveSnapshot } from './application/get-partner-live-snapshot.js';
import { RtBoard } from './application/rt-board.js';
import type { EventOwners } from './domain/ports.js';
import { PartnerLiveSnapshotController } from './inbound/partner-live-snapshot.controller.js';
import { RT_BOARD_AUTOSTART, RtBoardJob } from './inbound/rt-board.job.js';

export interface RealtimeTableModuleDeps {
  readonly board: RtBoard;
  /** 회차 판매자(core 판매 설정). 없으면 파트너 판매 현황이 503 authz-unavailable */
  readonly owners?: EventOwners;
  /** 앱이 뜰 때 0.5초 주기를 켤지(기본 켬). 시험은 끄고 tick을 직접 부른다 */
  readonly autoStart?: boolean;
}

@Module({})
export class RealtimeTableModule {
  static register(deps: RealtimeTableModuleDeps): DynamicModule {
    return {
      module: RealtimeTableModule,
      controllers: [PartnerLiveSnapshotController],
      providers: [
        { provide: RtBoard, useValue: deps.board },
        { provide: RT_BOARD_AUTOSTART, useValue: deps.autoStart ?? true },
        { provide: GetPartnerLiveSnapshot, useFactory: () => new GetPartnerLiveSnapshot(deps.board, deps.owners) },
        RtBoardJob,
      ],
      exports: [RtBoard],
    };
  }
}
