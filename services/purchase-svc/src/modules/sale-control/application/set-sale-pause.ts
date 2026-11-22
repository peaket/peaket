// 명령 3(판매 일시정지, 제어 gRPC SALE_PAUSE)을 원본 표에 쓰고 파드 메모리와 좌석 Redis 사본을 맞춘다(F-02-1 OPS-300, ADR-0365 결정 6·7).
// 원본(sale_control)은 판이 지금 paused_revision보다 클 때만 바뀐다. 같거나 작은 판이면 아무것도 바꾸지 않고 지금 판을 돌려준다(받는 쪽 판 비교, ADR-0103 결정 1).
// 사본 쓰기는 늘 원본 값으로 한다(앞선 시도가 Redis에 못 쓴 것을 같은 판의 다시 보내기가 고친다). 사본 Lua도 판이 칸보다 클 때만 쓴다.
// 전체 범위는 원본의 전체 행을 먼저 쓰고 그다음 회차 목록 s:ctl:events를 돌며 사본을 쓴다(data.md s:ctl:events: 새 회차와 함께 일어나도 어느 한쪽이 정지를 본다).
// 사본이 실패하면 던진다. ops-svc는 ack를 받지 못해 1초 [가정]마다 같은 판으로 다시 보낸다.
import type { SaleControlCopies, SaleControlStore } from '../domain/ports.js';
import type { SalePauseScope } from '../domain/sale-control.js';
import type { SaleControlMemory } from './sale-control-memory.js';

export interface SetSalePauseInput {
  readonly scope: SalePauseScope;
  readonly paused: boolean;
  readonly commandId: string;
  /** 제어 gRPC 판(1 이상 안전 정수. 받는 층이 먼저 본다) */
  readonly version: number;
  readonly nowMs: number;
}

export interface SetSalePauseResult {
  /** 쓰고 난 뒤(또는 쓰지 않았으면 지금)의 원본 판 */
  readonly appliedVersion: number;
  readonly paused: boolean;
  readonly changed: boolean;
}

export class SetSalePause {
  constructor(
    private readonly store: SaleControlStore,
    private readonly copies?: SaleControlCopies,
    private readonly memory?: SaleControlMemory,
  ) {}

  async run(input: SetSalePauseInput): Promise<SetSalePauseResult> {
    const applied = await this.store.applyPause({ scope: input.scope, paused: input.paused, commandId: input.commandId, version: input.version, nowMs: input.nowMs });
    const eventId = input.scope.kind === 'EVENT' ? input.scope.eventId : undefined;
    this.memory?.applyPause(eventId, { paused: applied.paused, revision: applied.appliedVersion, ...(applied.changedAtMs !== undefined ? { changedAtMs: applied.changedAtMs } : {}) });
    const copy = { paused: applied.paused, revision: applied.appliedVersion, ...(applied.commandId !== undefined ? { commandId: applied.commandId } : {}) };
    if (eventId !== undefined) await this.copies?.writePause?.({ eventId, ...copy });
    else await this.copies?.writePlatformPause?.(copy);
    return { appliedVersion: applied.appliedVersion, paused: applied.paused, changed: applied.changed };
  }
}
