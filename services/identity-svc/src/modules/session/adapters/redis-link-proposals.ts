// 가입 때 연결 제안 저장소(세션·캐시 Redis id:link:{proposalId}, Hash, 10분, docs/data.md §3, identity §2.1 '가입 때 연결 제안의 첫 구현').
// 한 키만 다루므로 해시 태그를 두지 않는다. 실패 횟수 올리기와 3회째 지우기는 Lua 하나로 한다.
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import { type LinkProposals, LinkStoreUnavailable, type StoredLinkProposal } from '../domain/ports.js';
import { LINK_MAX_ATTEMPTS, type Provider } from '../domain/session.js';

export const linkKey = (id: string) => `id:link:${id}`;

const SAVE = redisScript(`
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 2))
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return 1
`);

const FAIL = redisScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if n >= tonumber(ARGV[1]) then redis.call('DEL', KEYS[1]) end
return n
`);

const PROVIDERS = new Set<Provider>(['kakao', 'naver', 'google']);
const str = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''));

/** 장애는 LinkStoreUnavailable로. 그 밖의 Redis 오류는 명령 인자(이메일·sub)가 로그에 실리지 않게 이름과 짧은 문구만 남긴 오류로 바꾼다(새 맥락 리뷰 낮음 9) */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new LinkStoreUnavailable(err);
    const e = err as { name?: unknown; message?: unknown };
    throw new Error(`연결 제안 저장소 오류(${typeof e?.name === 'string' ? e.name : 'Error'}): ${typeof e?.message === 'string' ? e.message.split('\n')[0]!.slice(0, 80) : ''}`);
  }
}

function fieldsOf(raw: unknown): Record<string, string> {
  const o: Record<string, string> = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) o[str(raw[i])] = str(raw[i + 1]);
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) o[k] = str(v);
  return o;
}

/** 칸이 빠졌거나 모양이 틀리면 null(없는 제안으로 본다) */
function parse(id: string, f: Record<string, string>, now: number): StoredLinkProposal | null {
  const num = (k: string) => (/^\d{1,16}$/.test(f[k] ?? '') ? Number(f[k]) : null);
  const createdAt = num('createdAt');
  const expiresAt = num('expiresAt');
  const attempts = num('attempts');
  const np = f.newProvider as Provider;
  const ep = f.existingProvider as Provider;
  if (createdAt === null || expiresAt === null || attempts === null || !PROVIDERS.has(np) || !PROVIDERS.has(ep)) return null;
  if (!f.bindingHash || !f.newProviderUserId || !f.email || !f.targetAccountId) return null;
  if (expiresAt <= now) return null;
  return { id, bindingHash: f.bindingHash, newProvider: np, newProviderUserId: f.newProviderUserId, email: f.email, targetAccountId: f.targetAccountId, existingProvider: ep, attempts, createdAt, expiresAt };
}

export class RedisLinkProposals implements LinkProposals {
  constructor(
    private readonly redis: HotRedis,
    private readonly now: () => number,
  ) {}

  async save(p: StoredLinkProposal): Promise<void> {
    const k = linkKey(p.id);
    const fields = [
      ['bindingHash', p.bindingHash],
      ['newProvider', p.newProvider],
      ['newProviderUserId', p.newProviderUserId],
      ['email', p.email],
      ['targetAccountId', p.targetAccountId],
      ['existingProvider', p.existingProvider],
      ['attempts', String(p.attempts)],
      ['createdAt', String(p.createdAt)],
      ['expiresAt', String(p.expiresAt)],
    ].flat();
    await guard(this.redis.evalScript(SAVE, [k], [String(p.expiresAt), ...fields]));
  }

  async get(id: string): Promise<StoredLinkProposal | null> {
    const k = linkKey(id);
    return parse(id, fieldsOf(await guard(this.redis.command(['HGETALL', k], { key: k }))), this.now());
  }

  async fail(id: string): Promise<number | null> {
    const n = Number(await guard(this.redis.evalScript(FAIL, [linkKey(id)], [String(LINK_MAX_ATTEMPTS)])));
    return n < 0 ? null : n;
  }

  async remove(id: string): Promise<void> {
    const k = linkKey(id);
    await guard(this.redis.command(['DEL', k], { key: k }));
  }
}
