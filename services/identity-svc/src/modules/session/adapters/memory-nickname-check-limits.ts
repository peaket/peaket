// 닉네임 확인의 세션별 요청 수(메모리, 로컬·시험. 운영은 RedisNicknameCheckLimits). ADR-0235 결정 5.
import type { Clock } from '@peaket/platform';
import type { NicknameCheckLimits } from '../domain/ports.js';
import { NICKNAME_CHECK_LIMIT, NICKNAME_CHECK_WINDOW_MS } from '../domain/signup.js';

export class MemoryNicknameCheckLimits implements NicknameCheckLimits {
  readonly #windows = new Map<string, { count: number; until: number }>();

  constructor(private readonly clock: Clock) {}

  async allow(sessionId: string) {
    const now = this.clock.now();
    let w = this.#windows.get(sessionId);
    if (!w || w.until <= now) {
      w = { count: 0, until: now + NICKNAME_CHECK_WINDOW_MS };
      this.#windows.set(sessionId, w);
    }
    w.count++;
    return w.count <= NICKNAME_CHECK_LIMIT ? ({ allowed: true } as const) : ({ allowed: false, retryAfterMs: Math.max(1, w.until - now) } as const);
  }
}
