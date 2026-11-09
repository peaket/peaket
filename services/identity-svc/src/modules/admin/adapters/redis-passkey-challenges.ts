// 패스키 챌린지 저장소(세션·캐시 Redis id:wa:reg:{해시}·id:wa:rea:{해시}, 문자열 JSON, 5분 [가정], docs/data.md §3 유실 등급 B, BUILD_ORDER BOT-122, ADR-0206 결정 4).
// 꺼낼 때 GETDEL로 지워 맞든 틀리든 한 번만 쓴다(ASVS 6.7.2). 키에는 등록 ID·재인증 단계 값의 SHA-256만 둔다.
// 판정은 저장한 끝 시각(expiresAt)과 부르는 쪽 시계로 하고, 키 수명(PX)은 정리용이다. 한 키만 다뤄 해시 태그를 두지 않는다.
import { type HotRedis, isRedisUnavailable } from '@peaket/platform';
import { type PasskeyChallenge, type PasskeyChallenges, PasskeyChallengesUnavailable } from '../domain/ports.js';

const PREFIX: Record<PasskeyChallenge['kind'], string> = { REG: 'id:wa:reg:', REAUTH: 'id:wa:rea:' };
export const passkeyChallengeKey = (kind: PasskeyChallenge['kind'], handleHash: string) => `${PREFIX[kind]}${handleHash}`;
const HEX64 = /^[0-9a-f]{64}$/;
const AUDS = new Set(['partner', 'ops']);

/** 장애는 PasskeyChallengesUnavailable로(값·키가 로그에 실리지 않게 이름만 남긴다) */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new PasskeyChallengesUnavailable(err instanceof Error ? err.name : undefined);
    throw new Error(`패스키 챌린지 저장소 오류(${err instanceof Error ? err.name : 'Error'})`);
  }
}

/** 모양이 틀리면 null(없는 챌린지로 본다) */
function parse(raw: unknown, kind: PasskeyChallenge['kind']): PasskeyChallenge | null {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : null;
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as Partial<PasskeyChallenge>;
    if (v.kind !== kind || typeof v.accountId !== 'string' || typeof v.sessionId !== 'string' || !AUDS.has(String(v.aud)) || typeof v.challenge !== 'string' || typeof v.expiresAt !== 'number') return null;
    return v as PasskeyChallenge;
  } catch {
    return null;
  }
}

export class RedisPasskeyChallenges implements PasskeyChallenges {
  constructor(private readonly redis: HotRedis) {}

  async put(kind: PasskeyChallenge['kind'], handleHash: string, c: PasskeyChallenge, ttlMs: number): Promise<void> {
    if (!HEX64.test(handleHash)) throw new Error('챌린지 핸들 해시는 SHA-256 16진수다');
    const key = passkeyChallengeKey(kind, handleHash);
    await guard(this.redis.command(['SET', key, JSON.stringify(c), 'PX', String(Math.max(1, Math.ceil(ttlMs)))], { key }));
  }

  async take(kind: PasskeyChallenge['kind'], handleHash: string, now: number): Promise<PasskeyChallenge | null> {
    if (!HEX64.test(handleHash)) return null;
    const key = passkeyChallengeKey(kind, handleHash);
    const c = parse(await guard(this.redis.command(['GETDEL', key], { key })), kind);
    return c && c.expiresAt > now ? c : null;
  }
}
