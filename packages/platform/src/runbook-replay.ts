// 런북 commandId 재생 관문(F-02-7, 계획 6.3·R9, ADR-0103 결정 5).
// 적용 전에 예약하고, 성공하면 확정, 실패하면 풀어 같은 commandId로 다시 보낼 수 있게 한다.
import { RUNBOOK_REPLAY_KEEP_MS } from './runbook-bundle.js';

export type RunbookReplayVerdict = 'reserved' | 'replayed' | 'conflict' | 'in-flight';

export interface RunbookReplayGuard {
  begin(commandId: string, digest: string, expiresAtMs: number, nowMs: number): RunbookReplayVerdict;
  commit(commandId: string): void;
  abort(commandId: string): void;
}

interface Seen {
  digest: string;
  state: 'in-flight' | 'applied';
  keepUntilMs: number;
}

/** 프로세스 메모리 재생 관문. 파드마다 따로 기억한다(비상 명령은 같은 파드에 두 번 닿지 않게 한다) */
export class MemoryRunbookReplayGuard implements RunbookReplayGuard {
  readonly #seen = new Map<string, Seen>();

  begin(commandId: string, digest: string, expiresAtMs: number, nowMs: number): RunbookReplayVerdict {
    for (const [id, s] of this.#seen) {
      if (nowMs > s.keepUntilMs) this.#seen.delete(id);
    }
    const s = this.#seen.get(commandId);
    if (!s) {
      this.#seen.set(commandId, { digest, state: 'in-flight', keepUntilMs: expiresAtMs + RUNBOOK_REPLAY_KEEP_MS });
      return 'reserved';
    }
    if (s.digest !== digest) return 'conflict';
    return s.state === 'applied' ? 'replayed' : 'in-flight';
  }

  commit(commandId: string): void {
    const s = this.#seen.get(commandId);
    if (s) s.state = 'applied';
  }

  abort(commandId: string): void {
    this.#seen.delete(commandId);
  }
}
