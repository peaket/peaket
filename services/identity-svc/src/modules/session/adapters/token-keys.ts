// 토큰 서명 키 셋 셋(팬·관리·현장 스태프, ADR-0050 결정 9)과 무중단 교체(docs/features/identity.md §3 '토큰 수명주기 구현', I-T20).
// 키 셋마다 지금 키(ES256 개인 JWK, 서명) 하나와 옛 키(공개 JWK, 검증만) 하나까지 둔다. 옛 키는 정한 시각까지만 공개키 묶음에 싣는다.
// 교체는 두 단계다: ① 다음 키(공개 JWK)를 먼저 묶음에 실어 배포하고 받는 쪽 캐시(5분)가 새 kid를 알게 한 뒤 ② 그 키를 지금 키로, 지금 키를 옛 키로 옮긴다.
// 그래야 파드를 차례로 바꾸는 동안 새 kid로 서명한 토큰을 받는 쪽이 모르는 일이 없다.
// 운영은 Secrets Manager의 값을 시작 때 메모리로 읽는다(설정 값으로 넣는다, OPEN[10] 추천 적용 R-226).
import { importJWK, type JWK } from 'jose';
import type { PublicKeys } from '../domain/ports.js';

export const KEY_SETS = ['fan', 'admin', 'staff'] as const;
export type KeySetName = (typeof KEY_SETS)[number];

/** 운영 쪽 환경은 세 키 셋이 모두 있어야 시작한다. local·ci는 팬 키 셋만 있어도 된다 */
const RELAXED_ENVS = ['local', 'ci'];
const ENV_NAME: Record<KeySetName, string> = { fan: 'PEAKET_FAN_TOKEN_KEY', admin: 'PEAKET_ADMIN_TOKEN_KEY', staff: 'PEAKET_STAFF_TOKEN_KEY' };

interface KeySet {
  kid: string;
  key: Awaited<ReturnType<typeof importJWK>>;
  publicJwk: JWK;
  previous?: { publicJwk: JWK; until: number };
  /** 다음 키(공개 JWK). 서명하지 않고 묶음에만 싣는다 */
  next?: JWK;
}

const publicPart = (j: JWK): JWK => ({ kty: j.kty, crv: j.crv, x: j.x, y: j.y, kid: j.kid, alg: 'ES256', use: 'sig' });

function parse(name: string, raw: string): JWK {
  let j: JWK;
  try {
    j = JSON.parse(raw) as JWK;
  } catch {
    throw new Error(`${name}는 JWK JSON이어야 한다`);
  }
  if (j.kty !== 'EC' || j.crv !== 'P-256' || typeof j.x !== 'string' || typeof j.y !== 'string') throw new Error(`${name}는 P-256 JWK여야 한다(ES256)`);
  if (!j.kid) throw new Error(`${name}에 kid가 없다(받는 쪽이 kid로 키를 고른다)`);
  return j;
}

/** 옛 키·다음 키는 공개 JWK만 받는다(개인키가 비밀 저장소에 남지 않게) */
function publicOnly(name: string, raw: string): JWK {
  const j = parse(name, raw);
  if ('d' in j) throw new Error(`${name}는 공개 JWK여야 한다(d를 빼고 넣는다)`);
  return j;
}

export class TokenKeyRing implements PublicKeys {
  readonly #sets = new Map<KeySetName, KeySet>();

  private constructor() {}

  static async fromEnv(env: Record<string, string | undefined>): Promise<TokenKeyRing> {
    const ring = new TokenKeyRing();
    const strict = !RELAXED_ENVS.includes(env.PEAKET_ENV ?? 'prod');
    const kids = new Set<string>();
    for (const set of KEY_SETS) {
      const name = ENV_NAME[set];
      const raw = env[name];
      if (!raw) {
        if (strict || set === 'fan') throw new Error(`${name}가 없다(${set} 토큰 서명 개인 JWK, 비밀 관리에서 넣는다)`);
        continue;
      }
      const current = parse(name, raw);
      if (typeof current.d !== 'string') throw new Error(`${name}는 개인 JWK여야 한다(서명에 쓴다)`);
      const entry: KeySet = { kid: current.kid!, key: await importJWK({ ...current, alg: 'ES256' }, 'ES256'), publicJwk: publicPart(current) };
      const prevRaw = env[`${name}_PREVIOUS`];
      if (prevRaw) {
        const prev = publicOnly(`${name}_PREVIOUS`, prevRaw);
        const untilRaw = env[`${name}_PREVIOUS_UNTIL`];
        const until = untilRaw ? Date.parse(untilRaw) : Number.NaN;
        if (!Number.isFinite(until)) throw new Error(`${name}_PREVIOUS_UNTIL이 없거나 틀렸다(옛 공개키 검증 허용 끝 시각, docs/security/secrets-and-keys.md)`);
        entry.previous = { publicJwk: publicPart(prev), until };
      }
      const nextRaw = env[`${name}_NEXT`];
      if (nextRaw) entry.next = publicPart(publicOnly(`${name}_NEXT`, nextRaw));
      for (const kid of [entry.kid, entry.previous?.publicJwk.kid, entry.next?.kid].filter((k): k is string => Boolean(k))) {
        if (kids.has(kid)) throw new Error(`토큰 서명 키 kid가 겹친다: ${kid}(키 셋마다, 지금·옛 키마다 달라야 한다)`);
        kids.add(kid);
      }
      ring.#sets.set(set, entry);
    }
    return ring;
  }

  has(set: KeySetName): boolean {
    return this.#sets.has(set);
  }

  /** 서명할 지금 키 */
  signingKey(set: KeySetName): { kid: string; key: KeySet['key'] } {
    const s = this.#sets.get(set);
    if (!s) throw new Error(`${set} 토큰 서명 키가 없다`);
    return { kid: s.kid, key: s.key };
  }

  /** 지금 키의 공개 JWK(교체할 때 옛 키 값으로 옮긴다) */
  publicJwk(set: KeySetName): JWK {
    const s = this.#sets.get(set);
    if (!s) throw new Error(`${set} 토큰 서명 키가 없다`);
    return { ...s.publicJwk };
  }

  /** 공개키 묶음(JWKS): 지금 키와, 기한 안이면 옛 키 */
  jwks(set: KeySetName, now: number): { keys: JWK[] } {
    const s = this.#sets.get(set);
    if (!s) return { keys: [] };
    return {
      keys: [{ ...s.publicJwk }, ...(s.next ? [{ ...s.next }] : []), ...(s.previous && now <= s.previous.until ? [{ ...s.previous.publicJwk }] : [])],
    };
  }
}
