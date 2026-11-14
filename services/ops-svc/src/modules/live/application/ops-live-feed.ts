// 관제 SSE가 내보낼 갱신을 명령 원장과 감사 체크포인트에서 모은다(BAT-465 R-584).
// 콘솔은 더 이상 5초마다 목록을 폴링하지 않고 이 흐름을 받는다. 서버 쪽에서 1초마다 바뀐 것만 읽는다.
// 정본의 'ops DB 알림 표 순번'을 id로 쓰는 설계는 후속이다(지금은 마지막 변경 시각을 id로 쓴다: 재시작에도 Last-Event-ID가 통한다).
import type { Command } from '../../commands/index.js';
import type { AuditCheckpoint } from '../../audit/index.js';
import type { OpsLiveEvent } from '../domain/live.js';

export interface OpsLiveCommandSource {
  list(q: { limit: number; updatedAfterMs?: number }): Promise<{ items: readonly Command[] }>;
}

export interface OpsLiveCheckpointSource {
  list(limit: number): Promise<readonly AuditCheckpoint[]>;
}

export interface OpsLiveFeedDeps {
  readonly commands: OpsLiveCommandSource;
  readonly checkpoints: OpsLiveCheckpointSource;
  /** 한 번에 읽는 수(openapi limit 상한과 같다) */
  readonly limit?: number;
}

export class OpsLiveFeed {
  constructor(private readonly deps: OpsLiveFeedDeps) {}

  /**
   * sinceMs 뒤(같은 시각 포함)에 바뀐 명령·감사 체크포인트를 시각 차례로 돌려준다.
   * 같은 시각을 포함하는 것은 커서가 밀리초라 같은 밀리초의 두 변경을 놓치지 않게 하기 위해서다(화면이 ID로 겹침을 지운다).
   * 명령 원장의 updatedAfter는 그 시각보다 큰 것만 주므로 1ms 앞을 넘겨 같은 밀리초를 포함시킨다.
   */
  async scan(sinceMs: number): Promise<OpsLiveEvent[]> {
    const limit = this.deps.limit ?? 100;
    const after = Math.max(-1, sinceMs - 1);
    const [page, checkpoints] = await Promise.all([this.deps.commands.list({ limit, updatedAfterMs: after }), this.deps.checkpoints.list(limit)]);
    const events: OpsLiveEvent[] = [
      ...page.items.map((c): OpsLiveEvent => ({ id: c.updatedAtMs, event: 'command', data: c })),
      ...checkpoints.filter((c) => c.createdAtMs >= sinceMs).map((c): OpsLiveEvent => ({ id: c.createdAtMs, event: 'audit', data: c })),
    ];
    return events.sort((a, b) => a.id - b.id);
  }
}
