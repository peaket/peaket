// 접속 중 운영자(ADR-0100 결정 4). 흐름을 든 파드가 연결마다 15초 [가정]마다 ops_presence를 고쳐 쓰고,
// 5초 [가정]마다 이 파드의 연결이 고른 회차별로 45초 [가정] 안의 행을 모아 presence 사건으로 보낸다.
// 연결이 닫혀도 행을 지우지 않는다: 다른 탭이 같은 (계정, 회차)를 쓸 수 있고, 나간 사람은 45초 안에 빠진다(ADR-0100 '남는 한계').
// 같은 회차의 모은 값이 지난번과 같으면 다시 보내지 않고, 새로 붙은 연결에는 바로 한 번 보낸다.
import { OPS_PRESENCE_GATHER_MS, OPS_PRESENCE_WINDOW_MS, OPS_PRESENCE_WRITE_MS } from '../domain/live.js';
import type { PresenceEntry, PresenceStore } from '../domain/ports.js';

export interface PresenceSnapshot {
  readonly eventId: string;
  readonly operators: readonly PresenceEntry[];
}

export interface PresenceOptions {
  readonly writeMs?: number;
  readonly gatherMs?: number;
  readonly windowMs?: number;
  readonly now?: () => number;
}

interface Watcher {
  readonly eventId: string;
  readonly entry: PresenceEntry;
  readonly send: (s: PresenceSnapshot) => void;
  writer: NodeJS.Timeout;
}

export class PresenceHub {
  readonly #watchers = new Set<Watcher>();
  readonly #last = new Map<string, string>();
  #gather: NodeJS.Timeout | undefined;
  #gathering = false;

  constructor(
    private readonly store: PresenceStore,
    private readonly options: PresenceOptions = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** 한 연결이 회차를 본다. 돌려준 함수로 끊는다 */
  watch(eventId: string, entry: PresenceEntry, send: (s: PresenceSnapshot) => void): () => void {
    const touch = (): void => void this.store.touch({ ...entry, eventId, nowMs: this.now() }).catch(() => undefined);
    const w: Watcher = { eventId, entry, send, writer: setInterval(touch, this.options.writeMs ?? OPS_PRESENCE_WRITE_MS) };
    w.writer.unref();
    this.#watchers.add(w);
    if (!this.#gather) {
      this.#gather = setInterval(() => void this.gather(), this.options.gatherMs ?? OPS_PRESENCE_GATHER_MS);
      this.#gather.unref();
    }
    // 처음 쓰고 바로 모아 이 연결에 보낸다
    void this.store
      .touch({ ...entry, eventId, nowMs: this.now() })
      .catch(() => undefined)
      .then(() => this.gather(w));
    return () => {
      clearInterval(w.writer);
      this.#watchers.delete(w);
      if (![...this.#watchers].some((x) => x.eventId === eventId)) this.#last.delete(eventId);
      if (this.#watchers.size === 0 && this.#gather) {
        clearInterval(this.#gather);
        this.#gather = undefined;
      }
    };
  }

  /**
   * 회차별로 모아 보낸다. only를 주면 그 연결에만 지난번과 같아도 보낸다(새로 붙은 연결)
   */
  async gather(only?: Watcher): Promise<void> {
    if (this.#gathering && !only) return;
    if (!only) this.#gathering = true;
    try {
      const targets = only ? [only] : [...this.#watchers];
      const events = [...new Set(targets.map((w) => w.eventId))];
      if (events.length === 0) return;
      const active = await this.store.activeByEvent(events, this.options.windowMs ?? OPS_PRESENCE_WINDOW_MS, this.now());
      for (const eventId of events) {
        const operators = active.get(eventId) ?? [];
        const key = JSON.stringify(operators);
        if (!only && this.#last.get(eventId) === key) continue;
        if (!only) this.#last.set(eventId, key);
        for (const w of targets) if (w.eventId === eventId && this.#watchers.has(w)) w.send({ eventId, operators });
      }
    } catch {
      // 다음 주기에 다시 모은다
    } finally {
      if (!only) this.#gathering = false;
    }
  }
}
