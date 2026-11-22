// DB 없는 조립(memory: true·단위 시험)의 알림 표 대역(ADR-0360 결정 2). 트리거 대신, 읽을 때마다 명령 저장소를 훑어
// 명령의 (상태, 고친 시각)이 바뀌었으면 command 행(승인 대기면 approval 행도)을 순번을 매겨 쌓는다. 본문 모양은 0028 트리거와 같다.
// 경보는 메모리 경보 저장소를 이 모듈이 받지 못해 싣지 않는다(DB 조립은 트리거가 싣는다). 시험이 행을 직접 넣을 수 있게 append를 연다.
import type { PushEventRow, PushKind } from '../domain/live.js';
import type { PresenceEntry, PresenceStore, PushEventSource } from '../domain/ports.js';

/** 훑을 명령 저장소의 읽기 면(명령 모듈 저장소가 그대로 맞는다) */
export interface MemoryCommandScan {
  list(q: { limit: number }): Promise<{ items: readonly { commandId: string; type: string; state: string; eventId?: string; approvalExpiresAtMs?: number; updatedAtMs: number }[] }>;
}

const COMMAND_ROLES = ['viewer', 'operator', 'commander'];
const APPROVAL_ROLES = ['operator', 'commander'];
const PENDING = new Set(['PENDING_APPROVAL', 'REVERT_PENDING']);

export class MemoryPushEvents implements PushEventSource {
  readonly #rows: PushEventRow[] = [];
  readonly #seen = new Map<string, string>();
  #seq = 0;
  #scanning: Promise<void> | undefined;

  constructor(
    private readonly commands?: MemoryCommandScan,
    private readonly now: () => number = Date.now,
    private readonly scanLimit = 100,
  ) {}

  /** 행 하나를 쌓는다(트리거 대역). 매긴 순번 */
  append(row: { kind: PushKind; eventId: string | null; roles: readonly string[]; body: Record<string, unknown>; createdAtMs?: number }): number {
    this.#seq += 1;
    this.#rows.push({ seq: this.#seq, kind: row.kind, eventId: row.eventId, roles: [...row.roles], body: row.body, createdAtMs: row.createdAtMs ?? this.now() });
    return this.#seq;
  }

  private scan(): Promise<void> {
    if (!this.commands) return Promise.resolve();
    this.#scanning ??= (async () => {
      try {
        const page = await this.commands!.list({ limit: this.scanLimit });
        const changed = [...page.items].filter((c) => this.#seen.get(c.commandId) !== `${c.state}|${c.updatedAtMs}`).sort((a, b) => a.updatedAtMs - b.updatedAtMs);
        for (const c of changed) {
          const prev = this.#seen.get(c.commandId);
          this.#seen.set(c.commandId, `${c.state}|${c.updatedAtMs}`);
          if (prev !== undefined && prev.split('|')[0] === c.state) continue;
          const body: Record<string, unknown> = {
            commandId: c.commandId,
            type: c.type,
            state: c.state,
            ...(c.eventId !== undefined ? { eventId: c.eventId } : {}),
            ...(c.approvalExpiresAtMs !== undefined ? { approvalExpiresAt: new Date(c.approvalExpiresAtMs).toISOString() } : {}),
          };
          this.append({ kind: 'command', eventId: c.eventId ?? null, roles: COMMAND_ROLES, body, createdAtMs: c.updatedAtMs });
          if (PENDING.has(c.state)) this.append({ kind: 'approval', eventId: c.eventId ?? null, roles: APPROVAL_ROLES, body, createdAtMs: c.updatedAtMs });
        }
      } finally {
        this.#scanning = undefined;
      }
    })();
    return this.#scanning;
  }

  async after(seq: number, limit: number): Promise<readonly PushEventRow[]> {
    await this.scan();
    return this.#rows.filter((r) => r.seq > seq).slice(0, limit);
  }

  async afterOrAt(seq: number, seqs: readonly number[], limit: number): Promise<readonly PushEventRow[]> {
    await this.scan();
    const at = new Set(seqs);
    return this.#rows.filter((r) => r.seq > seq || at.has(r.seq)).slice(0, limit);
  }

  async latest(): Promise<number> {
    await this.scan();
    return this.#seq;
  }

  async oldestWithin(windowMs: number): Promise<number | undefined> {
    const since = this.now() - windowMs;
    return this.#rows.find((r) => r.createdAtMs >= since)?.seq;
  }

  async deleteOlderThan(windowMs: number): Promise<number> {
    const since = this.now() - windowMs;
    const before = this.#rows.length;
    for (let i = this.#rows.length - 1; i >= 0; i -= 1) if (this.#rows[i]!.createdAtMs < since) this.#rows.splice(i, 1);
    return before - this.#rows.length;
  }
}

/** 메모리 접속자 표 */
export class MemoryPresence implements PresenceStore {
  readonly #rows = new Map<string, PresenceEntry & { eventId: string; lastSeenMs: number }>();

  async touch(e: PresenceEntry & { eventId: string; nowMs: number }): Promise<void> {
    const key = `${e.accountRef}|${e.eventId}`;
    const prev = this.#rows.get(key);
    this.#rows.set(key, { accountRef: e.accountRef, role: e.role, screen: e.screen, eventId: e.eventId, lastSeenMs: Math.max(prev?.lastSeenMs ?? 0, e.nowMs) });
  }

  async activeByEvent(eventIds: readonly string[], windowMs: number, nowMs: number): Promise<ReadonlyMap<string, readonly PresenceEntry[]>> {
    const out = new Map<string, PresenceEntry[]>();
    const rows = [...this.#rows.values()].filter((r) => eventIds.includes(r.eventId) && r.lastSeenMs > nowMs - windowMs).sort((a, b) => (a.accountRef < b.accountRef ? -1 : a.accountRef > b.accountRef ? 1 : 0));
    for (const r of rows) {
      const arr = out.get(r.eventId) ?? [];
      arr.push({ accountRef: r.accountRef, role: r.role, screen: r.screen });
      out.set(r.eventId, arr);
    }
    return out;
  }

  async deleteOlderThan(windowMs: number, nowMs: number): Promise<number> {
    let n = 0;
    for (const [k, r] of this.#rows) {
      if (r.lastSeenMs <= nowMs - windowMs) {
        this.#rows.delete(k);
        n += 1;
      }
    }
    return n;
  }
}
