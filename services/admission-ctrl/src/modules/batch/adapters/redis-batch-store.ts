// 대기열 Redis의 묶음 기록(docs/data.md §3: q:{event:E}:batch_done·batch_members:{n}·cfg, q:batch:{hash}, q:{event:E}:removed).
// 값의 모양은 queue-svc 진입 Lua와 같다: 닫힘 표시 {첫 번호}:{크기}:{세대}, 게시 표시 pub:{n} = 게시 시각·root:{n} = 머클 루트, 다시 쓰기 표시 repair:{n},
// 사람별 결과 {번호}:{세대}.
// 회차 ID는 부르는 쪽(리더)이 [A-Za-z0-9_-] 1~64자만 넘긴다(해시 태그를 깨지 않게).
import { setTimeout as sleep } from 'node:timers/promises';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { BatchEntry, BatchSchedule, BatchStore, BeaconStopReason, ClosedBatch, EarlyRoot, PublishedBatch, ShuffleGroup, ShuffleRecord, ShuffleRecords } from '../domain/ports.js';

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
  lobbyMembers: (e: string) => `q:{event:${e}}:lobby_members`,
  removed: (e: string) => `q:{event:${e}}:removed`,
  verify: (e: string) => `q:{event:${e}}:verify`,
  shuffle: (e: string) => `q:{event:${e}}:shuffle`,
  batchResult: (tokenHash: string) => `q:batch:{${tokenHash}}`,
  lobbyResult: (tokenHash: string) => `q:lobby:{${tokenHash}}`,
};

/** 구간별 참가자 목록·결과 키(로비 q:lobby:{hash}, 묶음 q:batch:{hash}) */
const membersKey = (e: string, g: ShuffleGroup): string => (g === 'lobby' ? keys.lobbyMembers(e) : keys.batchMembers(e, g));
const resultKey = (g: ShuffleGroup, h: string): string => (g === 'lobby' ? keys.lobbyResult(h) : keys.batchResult(h));

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
// 멈춤 표시: 비어 있을 때만 쓰고(HSETNX 결과를 돌려준다) 수명을 회차 키와 같게 늦은 쪽으로만 늘린다(공시 기록 없이 멈춤만 써도 키가 영원히 남지 않게)
const STOP_SHUFFLE = redisScript(`
local wrote = redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
if redis.call('PEXPIRETIME', KEYS[1]) < tonumber(ARGV[3]) then redis.call('PEXPIREAT', KEYS[1], ARGV[3]) end
return wrote
`);
// 게시 표시는 비어 있을 때만 쓴다
const MARK_PUBLISHED = redisScript(`
redis.call('HSETNX', KEYS[1], 'pub:' .. ARGV[1], ARGV[2])
redis.call('HSETNX', KEYS[1], 'root:' .. ARGV[1], ARGV[3])
return 1
`);
// 머클 루트 공시: 비어 있을 때만 쓰고 공시 시각은 저장소 시각이다. 파드 시계가 어긋나도 라운드 시각과 견줄 수 있게 한다(ADR-0232 결정 5). 남아 있는 값을 돌려준다
const MARK_ROOT = redisScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then redis.call('HSET', KEYS[1], ARGV[3], tostring(now)) end
if redis.call('PEXPIRETIME', KEYS[1]) < tonumber(ARGV[4]) then redis.call('PEXPIREAT', KEYS[1], ARGV[4]) end
return redis.call('HMGET', KEYS[1], ARGV[1], ARGV[3])
`);
// 공시 칸 두 개를 비어 있을 때만 쓴다(비콘·시드, ADR-0232). 첫 칸이 이미 있으면 둘 다 그대로 둔다. 수명은 늦은 쪽으로만 늘린다
const WRITE_ONCE_PAIR = redisScript(`
if redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2]) == 1 then redis.call('HSET', KEYS[1], ARGV[3], ARGV[4]) end
if redis.call('PEXPIRETIME', KEYS[1]) < tonumber(ARGV[5]) then redis.call('PEXPIREAT', KEYS[1], ARGV[5]) end
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

  async confirmReplicated(eventId: string, batchNo: ShuffleGroup, marker: string): Promise<boolean> {
    const k = keys.batchDone(eventId);
    // 쓰기와 WAIT를 같은 연결로 보내야 그 쓰기까지의 복제를 센다. 복제는 순서대로라 이 쓰기가 복제됐으면 묶음 표시까지 복제됐다.
    // 같은 노드의 다른 회차 WAIT 뒤에 줄을 설 수 있어 쓰기에도 WAIT만큼의 마감을 준다
    const r = this.waitRedis ?? this.redis;
    const deadlineMs = WAIT_MS + 300;
    const ok = Number(await r.evalScript(MARK_WAIT, [k], [marker, String(batchNo), String(Date.now())], { deadlineMs })) === 1;
    if (!ok) return false;
    if (this.minReplicas <= 0) return true;
    // pin: WAIT는 pin이 없으면 클러스터 클라이언트가 모든 샤드로 보내 최솟값을 돌려준다(다른 샤드의 복제본이 모자라도 게시가 미뤄진다, ADR-0186 클러스터 실측)
    const acked = Number(await r.command(['WAIT', String(this.minReplicas), String(WAIT_MS)], { key: k, deadlineMs, pin: true }));
    return acked >= this.minReplicas;
  }

  async scheduleOf(eventId: string): Promise<BatchSchedule | null> {
    const k = keys.cfg(eventId);
    const [startsAt, opensAt, window] = ((await this.redis.command(['HMGET', k, 'startsAtMs', 'opensAtMs', 'batchWindowMs'], { key: k })) as unknown[]).map(str);
    const int = (v: string | null | undefined): number | null => (v !== null && v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);
    const startsAtMs = int(startsAt);
    const opensAtMs = int(opensAt);
    if (startsAtMs === null || opensAtMs === null) return null;
    const batchWindowMs = int(window);
    return { startsAtMs, opensAtMs, ...(batchWindowMs !== null ? { batchWindowMs } : {}) };
  }

  async closed(eventId: string, batchNo: ShuffleGroup): Promise<ClosedBatch | null> {
    const k = keys.batchDone(eventId);
    const v = str(await this.redis.command(['HGET', k, String(batchNo)], { key: k }));
    const m = v === null ? null : /^(\d+):(\d+):(\d+)$/.exec(v);
    return m ? { first: Number(m[1]), size: Number(m[2]), gen: Number(m[3]) } : null;
  }

  // SSCAN은 같은 원소를 두 번 줄 수 있어(읽는 사이 해시 표가 커질 때) 겹침을 뺀다
  async members(eventId: string, batchNo: ShuffleGroup): Promise<string[]> {
    const k = membersKey(eventId, batchNo);
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const [next, items] = (await this.redis.command(['SSCAN', k, cursor, 'COUNT', String(SCAN_COUNT)], { key: k })) as [unknown, unknown[]];
      for (const x of items) seen.add(str(x)!);
      cursor = str(next)!;
    } while (cursor !== '0');
    return [...seen];
  }

  async published(eventId: string, batchNo: ShuffleGroup): Promise<PublishedBatch | null> {
    const k = keys.batchDone(eventId);
    const [at, root, repair] = ((await this.redis.command(['HMGET', k, `pub:${batchNo}`, `root:${batchNo}`, `repair:${batchNo}`], { key: k })) as unknown[]).map(str);
    if (at === null || at === undefined) return null;
    return { atMs: Number(at), root: root ?? null, repairAtMs: repair === null || repair === undefined ? null : Number(repair) };
  }

  async writeResults(group: ShuffleGroup, entries: readonly BatchEntry[], gen: number, expireAtMs: number): Promise<void> {
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      for (let attempt = 1; ; attempt++) {
        try {
          await Promise.all(
            chunk.map((e) => {
              const k = resultKey(group, e.tokenHash);
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

  async markPublished(eventId: string, batchNo: ShuffleGroup, atMs: number, root: string): Promise<void> {
    const k = keys.batchDone(eventId);
    await this.redis.evalScript(MARK_PUBLISHED, [k], [String(batchNo), String(atMs), root]);
  }

  async markRoot(eventId: string, batchNo: ShuffleGroup, root: string, expireAtMs: number): Promise<EarlyRoot> {
    const r = (await this.redis.evalScript(MARK_ROOT, [keys.batchDone(eventId)], [`root:${batchNo}`, root, `rootAt:${batchNo}`, String(expireAtMs)])) as unknown[];
    return { root: str(r[0])!, atMs: Number(str(r[1])) };
  }

  async earlyRootOf(eventId: string, batchNo: ShuffleGroup): Promise<EarlyRoot | null> {
    const k = keys.batchDone(eventId);
    const [root, at] = ((await this.redis.command(['HMGET', k, `root:${batchNo}`, `rootAt:${batchNo}`], { key: k })) as unknown[]).map(str);
    return root && at ? { root, atMs: Number(at) } : null;
  }

  async clearRepair(eventId: string, batchNo: ShuffleGroup, repairAtMs: number): Promise<void> {
    await this.redis.evalScript(CLEAR_REPAIR, [keys.batchDone(eventId)], [`repair:${batchNo}`, String(repairAtMs)]);
  }

  async toRemoveAmong(eventId: string, hashes: readonly string[]): Promise<string[]> {
    const k = keys.verify(eventId);
    const out: string[] = [];
    for (let i = 0; i < hashes.length; i += CHUNK) {
      const chunk = hashes.slice(i, i + CHUNK);
      const vals = (await this.redis.command(['HMGET', k, ...chunk], { key: k })) as unknown[];
      chunk.forEach((h, j) => {
        if (/^(VERIFYING|ORPHAN):/.test(str(vals[j]) ?? '')) out.push(h);
      });
    }
    return out;
  }
}

/** 셔플 공시 기록 읽기와 멈춤 표시(q:{event:E}:shuffle, ADR-0231 결정 6·12) */
@Injectable()
export class RedisShuffleRecords implements ShuffleRecords {
  constructor(@Inject(ADMISSION_REDIS) private readonly redis: HotRedis) {}

  async read(eventId: string, group: ShuffleGroup): Promise<ShuffleRecord | null> {
    const k = keys.shuffle(eventId);
    const [commit, round, sealed, at, stop, beacon, signature, seed, seedAt] = ((await this.redis.command(['HMGET', k, `commit:${group}`, `round:${group}`, `sealed:${group}`, `at:${group}`, `stop:${group}`, `beacon:${group}`, `sig:${group}`, `seed:${group}`, `seedAt:${group}`], { key: k })) as unknown[]).map(str);
    if (!commit || !round || !sealed || !at) return null;
    const rec: ShuffleRecord = { commit, round: Number(round), sealed, atMs: Number(at), ...(beacon && signature ? { beacon, signature } : {}), ...(seed && seedAt ? { seed, seedAtMs: Number(seedAt) } : {}) };
    if (!stop) return rec;
    // 값이 있으면 모양이 틀려도 멈춘 것으로 본다(모르는 값을 '멈춤 아님'으로 읽으면 RB-35 없이 게시가 다시 돈다)
    const m = /^(\d+):(beacon|stale_round|late_commit|no_commit|late_root|members_changed)$/.exec(stop);
    return { ...rec, stopped: m ? { atMs: Number(m[1]), reason: m[2] as BeaconStopReason } : { atMs: 0, reason: 'unknown' } };
  }

  async recordBeacon(eventId: string, group: ShuffleGroup, value: string, signature: string, expireAtMs: number): Promise<void> {
    await this.redis.evalScript(WRITE_ONCE_PAIR, [keys.shuffle(eventId)], [`beacon:${group}`, value, `sig:${group}`, signature, String(expireAtMs)]);
  }

  async reveal(eventId: string, group: ShuffleGroup, seed: string, atMs: number, expireAtMs: number): Promise<void> {
    await this.redis.evalScript(WRITE_ONCE_PAIR, [keys.shuffle(eventId)], [`seed:${group}`, seed, `seedAt:${group}`, String(atMs), String(expireAtMs)]);
  }

  async stop(eventId: string, group: ShuffleGroup, atMs: number, reason: BeaconStopReason, expireAtMs: number): Promise<boolean> {
    return Number(await this.redis.evalScript(STOP_SHUFFLE, [keys.shuffle(eventId)], [`stop:${group}`, `${atMs}:${reason}`, String(expireAtMs)])) === 1;
  }
}
