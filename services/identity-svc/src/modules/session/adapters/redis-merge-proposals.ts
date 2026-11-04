// 병합 제안 저장소(세션·캐시 Redis id:merge:{proposalId}, Hash 한 칸에 JSON, 10분, docs/data.md §3, identity §2.1 '계정 병합의 첫 구현').
// 쓰는 쪽은 identity뿐이라 칸을 나누지 않고 값 하나(body)에 두고, 수명은 PEXPIREAT로 건다.
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { StoredMergeProposal } from '../domain/merge.js';
import { LinkStoreUnavailable, type MergeProposals } from '../domain/ports.js';

export const mergeKey = (id: string) => `id:merge:${id}`;
const SAVE = redisScript(`
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'body', ARGV[2])
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
return 1
`);

async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new LinkStoreUnavailable(err);
    const e = err as { name?: unknown };
    throw new Error(`병합 제안 저장소 오류(${typeof e?.name === 'string' ? e.name : 'Error'})`);
  }
}

export class RedisMergeProposals implements MergeProposals {
  constructor(
    private readonly redis: HotRedis,
    private readonly now: () => number,
  ) {}

  async save(p: StoredMergeProposal): Promise<void> {
    await guard(this.redis.evalScript(SAVE, [mergeKey(p.id)], [String(p.expiresAt), JSON.stringify(p)]));
  }

  async get(id: string): Promise<StoredMergeProposal | null> {
    const k = mergeKey(id);
    const raw = await guard(this.redis.command(['HGET', k, 'body'], { key: k }));
    if (raw === null || raw === undefined) return null;
    try {
      const p = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as StoredMergeProposal;
      return p.id === id && p.expiresAt > this.now() ? p : null;
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    const k = mergeKey(id);
    await guard(this.redis.command(['DEL', k], { key: k }));
  }
}
