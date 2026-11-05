// 패스키 챌린지의 메모리 구현(시험·local·ci만, BUILD_ORDER BOT-122). 파드가 여럿이면 챌린지가 나뉘므로 운영·데모는 Redis(redis-passkey-challenges.ts)다.
import type { PasskeyChallenge, PasskeyChallenges } from '../domain/ports.js';

export class MemoryPasskeyChallenges implements PasskeyChallenges {
  readonly #items = new Map<string, PasskeyChallenge>();

  async put(kind: PasskeyChallenge['kind'], handleHash: string, c: PasskeyChallenge): Promise<void> {
    this.#items.set(`${kind}:${handleHash}`, structuredClone(c));
  }

  async take(kind: PasskeyChallenge['kind'], handleHash: string, now: number): Promise<PasskeyChallenge | null> {
    const k = `${kind}:${handleHash}`;
    const c = this.#items.get(k);
    this.#items.delete(k);
    return c && c.kind === kind && c.expiresAt > now ? c : null;
  }
}
