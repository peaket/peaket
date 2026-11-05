// 시험용 회차 슬롯 값(Valkey 어댑터 redis-state-snapshots.ts가 Lua로 읽는 것과 같은 모양).
import type { StateSnapshots } from '../domain/ports.js';
import type { PlatformNotice, StateSnapshot } from '../domain/state.js';

const EMPTY: StateSnapshot = { seq: 0, serving: 0, removed: new Uint8Array(0), skipped: [], servingLog: [], calls: [] };

export class MemoryStateSnapshots implements StateSnapshots {
  readonly #m = new Map<string, StateSnapshot>();
  reads = 0;
  /** 다음 읽기를 실패시킨다(대기열 Redis 일시 장애 흉내) */
  failNext: unknown = null;
  #platform: PlatformNotice = {};
  platformReads = 0;
  /** 다음 전체 범위 공지 읽기를 실패시킨다 */
  failPlatformNext: unknown = null;

  async readPlatform(): Promise<PlatformNotice> {
    this.platformReads++;
    if (this.failPlatformNext) {
      const err = this.failPlatformNext;
      this.failPlatformNext = null;
      throw err;
    }
    return { ...this.#platform };
  }

  setPlatform(n: PlatformNotice): void {
    this.#platform = { ...n };
  }

  async read(eventId: string): Promise<StateSnapshot> {
    this.reads++;
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const s = this.#m.get(eventId) ?? EMPTY;
    return { ...s, removed: s.removed.slice(), skipped: [...s.skipped], servingLog: [...s.servingLog], calls: [...s.calls] };
  }

  // 시험 도구
  set(eventId: string, s: Partial<StateSnapshot>): void {
    this.#m.set(eventId, { ...(this.#m.get(eventId) ?? EMPTY), ...s });
  }

  /** 번호들을 빠진 번호 비트맵에 켠다(Redis SETBIT과 같은 비트 순서) */
  markRemoved(eventId: string, numbers: number[]): void {
    const cur = this.#m.get(eventId) ?? EMPTY;
    const max = Math.max(cur.seq, ...numbers);
    const bits = new Uint8Array((max >> 3) + 1);
    bits.set(cur.removed.subarray(0, bits.length));
    for (const n of numbers) bits[n >> 3]! |= 0x80 >> (n & 7);
    this.set(eventId, { removed: bits });
  }
}
