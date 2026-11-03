// 대기열 Redis의 묶음 기록(docs/data.md §3: q:{event:E}:batch_done·batch_members:{n}·cfg, q:batch:{hash}, q:{event:E}:removed).
// 값의 모양은 queue-svc 진입 Lua와 같다: 닫힘 표시 {첫 번호}:{크기}:{세대}, 게시 표시 pub:{n} = 게시 시각·root:{n} = 머클 루트, 다시 쓰기 표시 repair:{n},
// 사람별 결과 {번호}:{세대}.
// 회차 ID는 부르는 쪽(리더)이 [A-Za-z0-9_-] 1~64자만 넘긴다(해시 태그를 깨지 않게).
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { BatchEntry, BatchStore, ClosedBatch, PublishedBatch } from '../domain/ports.js';

export const ADMISSION_REDIS = Symbol('admission.QueueRedis');
/** 게시 전 복제 확인의 최소 복제본 수(운영 1, 로컬·CI 0 [가정], PEAKET_QUEUE_REDIS_MIN_REPLICAS) */
export const MIN_REPLICAS = Symbol('admission.MinReplicas');
/** WAIT 전용 연결: WAIT는 그 연결을 막으므로, 노드마다 하나뿐인 공유 연결로 보내면 같은 노드의 다른 회차 명령이 기다린다(2026-11-03 새 맥락 리뷰) */
export const WAIT_REDIS = Symbol('admission.WaitRedis');

/** PEAKET_QUEUE_REDIS_MIN_REPLICAS: 0 이상의 정수. 없으면 클러스터 1, 단일 노드 0 [가정] */
export function minReplicasOf(raw: string | undefined, cluster: boolean): number {
  if (raw === undefined) return cluster ? 1 : 0;
  if (!/^\d{1,2}$/.test(raw)) throw new Error(`PEAKET_QUEUE_REDIS_MIN_REPLICAS는 0 이상의 정수다: ${raw}`);
  return Number(raw);
}
/** WAIT 시간 한도 [가정] */
const WAIT_MS = 200;

export const keys = {
  cfg: (e: string) => `q:{event:${e}}:cfg`,
  batchDone: (e: string) => `q:{event:${e}}:batch_done`,
  batchMembers: (e: string, n: number) => `q:{event:${e}}:batch_members:${n}`,
  removed: (e: string) => `q:{event:${e}}:removed`,
  batchResult: (tokenHash: string) => `q:batch:{${tokenHash}}`,
};

/** 결과 쓰기 한 번에 보내는 명령 수(같은 이벤트 루프 차례의 명령을 node-redis가 묶어 보낸다) */
const CHUNK = 1_000;
/** 참가자 읽기 한 번의 SSCAN COUNT. SMEMBERS 한 번에 100만 개를 받으면 회차 샤드가 그동안 다른 명령을 못 받는다 */
const SCAN_COUNT = 1_000;
/** 결과 쓰기 덩어리가 잠시 안 될 때 다시 보내는 횟수와 간격 [가정] */
const WRITE_ATTEMPTS = 3;
const WRITE_RETRY_MS = 200;

// 게시 전 복제 확인: 묶음 표시가 읽은 값과 같을 때만 확인 시각을 쓴다(장애 전환 중 표시가 없는 다른 노드를 '복제됨'으로 보지 않게)
const MARK_WAIT = redisScript(`
if redis.call('HGET', KEYS[1], ARGV[2]) ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'wait:' .. ARGV[2], ARGV[3])
return 1
`);
// 게시 표시는 비어 있을 때만 쓴다
const MARK_PUBLISHED = redisScript(`
redis.call('HSETNX', KEYS[1], 'pub:' .. ARGV[1], ARGV[2])
redis.call('HSETNX', KEYS[1], 'root:' .. ARGV[1], ARGV[3])
return 1
`);
// 본 값일 때만 지운다(그 사이 새로 청한 표시를 지우지 않게)
const CLEAR_REPAIR = redisScript(`
if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[1]) return 1 end
return 0
`);
const str = (v: unknown): string | null => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

@Injectable()
export class RedisBatchStore implements BatchStore {
  constructor(
    @Inject(ADMISSION_REDIS) private readonly redis: HotRedis,
    @Optional() @Inject(MIN_REPLICAS) private readonly minReplicas: number = 0,
    @Optional() @Inject(WAIT_REDIS) private readonly waitRedis?: HotRedis,
  ) {}

  async confirmReplicated(eventId: string, batchNo: number, marker: string): Promise<boolean> {
    const k = keys.batchDone(eventId);
    // 쓰기와 WAIT를 같은 연결로 보내야 그 쓰기까지의 복제를 센다. 복제는 순서대로라 이 쓰기가 복제됐으면 묶음 표시까지 복제됐다.
    // 같은 노드의 다른 회차 WAIT 뒤에 줄을 설 수 있어 쓰기에도 WAIT만큼의 마감을 준다
    const r = this.waitRedis ?? this.redis;
    const deadlineMs = WAIT_MS + 300;
    const ok = Number(await r.evalScript(MARK_WAIT, [k], [marker, String(batchNo), String(Date.now())], { deadlineMs })) === 1;
    if (!ok) return false;
    if (this.minReplicas <= 0) return true;
    const acked = Number(await r.command(['WAIT', String(this.minReplicas), String(WAIT_MS)], { key: k, deadlineMs }));
    return acked >= this.minReplicas;
  }

  async startsAtOf(eventId: string): Promise<number | null> {
    const k = keys.cfg(eventId);
    const v = str(await this.redis.command(['HGET', k, 'startsAtMs'], { key: k }));
    return v !== null && /^\d{1,16}$/.test(v) ? Number(v) : null;
  }

  async closed(eventId: string, batchNo: number): Promise<ClosedBatch | null> {
    const k = keys.batchDone(eventId);
    const v = str(await this.redis.command(['HGET', k, String(batchNo)], { key: k }));
    const m = v === null ? null : /^(\d+):(\d+):(\d+)$/.exec(v);
    return m ? { first: Number(m[1]), size: Number(m[2]), gen: Number(m[3]) } : null;
  }

  // SSCAN은 같은 원소를 두 번 줄 수 있어(읽는 사이 해시 표가 커질 때) 겹침을 뺀다
  async members(eventId: string, batchNo: number): Promise<string[]> {
    const k = keys.batchMembers(eventId, batchNo);
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const [next, items] = (await this.redis.command(['SSCAN', k, cursor, 'COUNT', String(SCAN_COUNT)], { key: k })) as [unknown, unknown[]];
      for (const x of items) seen.add(str(x)!);
      cursor = str(next)!;
    } while (cursor !== '0');
    return [...seen];
  }

  async published(eventId: string, batchNo: number): Promise<PublishedBatch | null> {
    const k = keys.batchDone(eventId);
    const [at, root, repair] = ((await this.redis.command(['HMGET', k, `pub:${batchNo}`, `root:${batchNo}`, `repair:${batchNo}`], { key: k })) as unknown[]).map(str);
    if (at === null || at === undefined) return null;
    return { atMs: Number(at), root: root ?? null, repairAtMs: repair === null || repair === undefined ? null : Number(repair) };
  }

  async writeResults(entries: readonly BatchEntry[], gen: number, expireAtMs: number): Promise<void> {
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      for (let attempt = 1; ; attempt++) {
        try {
          await Promise.all(
            chunk.map((e) => {
              const k = keys.batchResult(e.tokenHash);
              return this.redis.command(['SET', k, `${e.seq}:${gen}`, 'PXAT', String(expireAtMs)], { key: k });
            }),
          );
          break;
        } catch (err) {
          // 앞 덩어리는 이미 썼으니 이 덩어리만 다시 보낸다(같은 값이라 겹쳐 써도 된다). 그래도 안 되면 게시를 처음부터 다시 부른다
          if (!isRedisUnavailable(err) || attempt >= WRITE_ATTEMPTS) throw err;
          await sleep(WRITE_RETRY_MS * attempt);
        }
      }
    }
  }

  async markRemoved(eventId: string, seqs: readonly number[], expireAtMs: number): Promise<void> {
    const k = keys.removed(eventId);
    for (const s of seqs) await this.redis.command(['SETBIT', k, String(s), '1'], { key: k });
    // 수명은 더 늦은 쪽으로만 늘린다(queue-svc 진입 Lua와 같은 규칙)
    if (Number(await this.redis.command(['PEXPIRETIME', k], { key: k })) < expireAtMs) await this.redis.command(['PEXPIREAT', k, String(expireAtMs)], { key: k });
  }

  async markPublished(eventId: string, batchNo: number, atMs: number, root: string): Promise<void> {
    const k = keys.batchDone(eventId);
    await this.redis.evalScript(MARK_PUBLISHED, [k], [String(batchNo), String(atMs), root]);
  }

  async clearRepair(eventId: string, batchNo: number, repairAtMs: number): Promise<void> {
    await this.redis.evalScript(CLEAR_REPAIR, [keys.batchDone(eventId)], [`repair:${batchNo}`, String(repairAtMs)]);
  }
}
