// 알림 표 행을 운영자마다의 화면 사건으로 바꾼다(ADR-0100 결정 4, ADR-0360 결정 1·3).
// 트리거가 쓴 본문은 참조값과 상태뿐이라, 명령 사건은 명령 저장소로 다시 읽어 명령 목록 한 줄 모양(baseViewOf)으로 만든다.
// 거르기: 행의 받을 역할에 내 역할이 없으면 보내지 않는다. 승인 대기(approval)는 그 명령을 내가 승인할 수 있을 때만 보낸다(요청자 ≠ 승인자, control-tower §4).
// 생성자 인자 모양({ commands, checkpoints, limit? })은 AppModule이 부르는 모양 그대로다. checkpoints는 감사 탭이 REST로 다시 읽어 흐름에서는 쓰지 않는다.
import type { Principal } from '@peaket/platform';
import type { AuditCheckpoint } from '../../audit/index.js';
import { baseViewOf, canApproveOf, type Command } from '../../commands/index.js';
import type { OpsLiveEvent, PushEventRow } from '../domain/live.js';

export interface OpsLiveCommandSource {
  list(q: { limit: number; updatedAfterMs?: number }): Promise<{ items: readonly Command[] }>;
  find(commandId: string): Promise<Command | undefined>;
}

export interface OpsLiveCheckpointSource {
  list(limit: number): Promise<readonly AuditCheckpoint[]>;
}

export interface OpsLiveFeedDeps {
  readonly commands: OpsLiveCommandSource;
  readonly checkpoints: OpsLiveCheckpointSource;
  /** 메모리 조립이 한 번에 훑는 명령 수(openapi limit 상한과 같다) */
  readonly limit?: number;
}

/** 파드가 한 번 읽어 모든 연결에 나눠 주는 행(명령 사건은 명령을 붙인다) */
export interface PushDelivery {
  readonly row: PushEventRow;
  readonly command?: Command;
}

export class OpsLiveFeed {
  constructor(readonly deps: OpsLiveFeedDeps) {}

  /** 행 묶음에 명령을 붙인다(같은 명령은 한 번만 읽는다). 읽기 실패한 명령은 본문만으로 보낸다 */
  async resolve(rows: readonly PushEventRow[]): Promise<PushDelivery[]> {
    const ids = [...new Set(rows.filter((r) => r.kind === 'command' || r.kind === 'approval').map((r) => r.body.commandId).filter((v): v is string => typeof v === 'string'))];
    const found = new Map<string, Command>();
    await Promise.all(
      ids.map(async (id) => {
        try {
          const c = await this.deps.commands.find(id);
          if (c) found.set(id, c);
        } catch {
          // 본문만으로 보낸다
        }
      }),
    );
    return rows.map((row) => {
      const id = row.body.commandId;
      const command = typeof id === 'string' ? found.get(id) : undefined;
      return command ? { row, command } : { row };
    });
  }

  /**
   * 한 운영자에게 보낼 사건. 보내지 않으면 undefined
   * @param d 붙인 행
   * @param me 흐름을 연 운영자
   */
  eventFor(d: PushDelivery, me: Principal | undefined): OpsLiveEvent | undefined {
    const { row } = d;
    if (!me?.role || !row.roles.includes(me.role)) return undefined;
    switch (row.kind) {
      case 'command': {
        // 행이 쓰인 때의 상태를 싣는다(같은 명령의 두 변경이 따로 온다). 나머지 칸은 지금 명령 목록 한 줄과 같다
        const data = d.command ? { ...baseViewOf(d.command, me), state: row.body.state ?? d.command.state } : row.body;
        return { id: row.seq, event: 'command', data };
      }
      case 'approval': {
        if (!d.command || !canApproveOf(d.command, me)) return undefined;
        return { id: row.seq, event: 'approval', data: approvalOf(row.body) };
      }
      case 'alert':
        return { id: row.seq, event: 'alert', data: row.body };
      case 'autoAction':
        return { id: row.seq, event: 'autoAction', data: row.body };
      default:
        return undefined;
    }
  }
}

/** asyncapi OpsApproval 본문(ADR-0360 결정 3): 명령 ID·종류·상태·회차·승인 기한 */
export function approvalOf(body: Record<string, unknown>): Record<string, unknown> {
  const pick = (k: string) => (body[k] !== undefined && body[k] !== null ? { [k]: body[k] } : {});
  return { ...pick('commandId'), ...pick('type'), ...pick('state'), ...pick('eventId'), ...pick('approvalExpiresAt') };
}
