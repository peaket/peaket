// 대기열·입장 제어 모델 기반 시험의 대상(wbs 2.3.4, docs/verification.md §2.4, specs/queue.qnt).
// 운영 코드(queue-svc 진입·입장 확정 저장소와 ConfirmAdmission, admission-ctrl 리더 저장소와 PublishBatchResults)를 실제 Valkey(노드 하나짜리
// 클러스터 모드: CLUSTER MYID와 설정 세대가 있다) 위에 그대로 돌린다. 명세가 다루는 복제와 장애 전환은 키 사본으로 흉내 낸다.
// - 회차 슬롯(`{event:E}`) 키를 걸음마다 Lua 하나로 읽어 둔다. 명세의 쓰기 하나가 사본 하나이고, 복제되지 않은 사본을 LAG개까지 둔다.
//   장애 전환은 복제본 사본을 되살리고, 세대 키의 표지를 '다른 노드, 설정 세대 j만큼 낮음'으로 바꿔 새 주 노드를 흉내 낸다(이 노드는 늘 설정 세대 E).
// - 사람 슬롯(q:dup·q:adm)은 사람마다 쓰기 하나 늦은 사본을 둔다.
// - 리더의 묶음 게시 전 복제 확인(WAIT)은 복제본 사본에 같은 표시가 있는지로 본다. 게시 시각은 분산 창(첫 전진 문)이 지난 것으로 둔다(명세가 시간을 줄인 것).
// - 이탈(leave)은 아직 구현이 없어(BUILD_ORDER HOT-060) 명세의 뜻(빠진 번호 켜기, 이 요청의 기록 지우기)을 저장소 호출로 흉내 낸다.
// - 경합 시험(SystemOptions.scheduler)은 운영 코드의 Redis 호출을 fast-check 스케줄러로 감싸고, 걸음마다 스케줄러를 직접 돌려 끝나는 순서를 섞는다.
// 메서드 이름은 명세의 동작 이름이다. 결과로 탭 상태(명세 Tab)를 바꾸고, 불변식 ①~⑤와 입장 키 유지를 관측으로 센다(violations).
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { type CallOptions, type Clock, type HotRedis, type RedisScript, redisScript, systemClock } from '@peaket/platform';
import { combinedKey, drandRoundAfter, merkleRoot, shuffle, sortHashes } from '@peaket/shuffle';
import type { Scheduler } from 'fast-check';
import { Es256AdmissionTokens } from '../../../queue-svc/src/modules/admission/adapters/es256-admission-tokens.js';
import { RedisAdmissionStore } from '../../../queue-svc/src/modules/admission/adapters/redis-admission-store.js';
import { AdmissionError } from '../../../queue-svc/src/modules/admission/application/admission-error.js';
import { ConfirmAdmission } from '../../../queue-svc/src/modules/admission/application/confirm-admission.js';
import type { AdmissionSignals } from '../../../queue-svc/src/modules/admission/domain/ports.js';
import { HmacQueueTokens, QUEUE_TOKEN_KEY_ENV } from '../../../queue-svc/src/modules/entry/adapters/hmac-tokens.js';
import { keys as entryKeys, RedisEntryStore } from '../../../queue-svc/src/modules/entry/adapters/redis-entry-store.js';
import { RedisEventSchedules } from '../../../queue-svc/src/modules/entry/adapters/redis-event-schedules.js';
import { RedisBatchStore } from '../../src/modules/batch/adapters/redis-batch-store.js';
import { PublishBatchResults } from '../../src/modules/batch/application/publish-batch-results.js';
import type { BatchStore, SeedSource } from '../../src/modules/batch/domain/ports.js';
import { keys, RedisLeaderStore } from '../../src/modules/leader/adapters/redis-leader-store.js';

export type Phase = 'IDLE' | 'PREEMPTED' | 'NUMBERED' | 'SADDED' | 'BATCHED' | 'HELD' | 'CHECKED' | 'CLAIMED' | 'SLOTTED' | 'RELEASING' | 'ADMITTED' | 'DONE';
/** 명세 Tab과 같은 칸 + 구현이 쓰는 값(요청 ID, 대기표, 해시, 요청 표지) */
export interface TabState {
  phase: Phase;
  seq: number;
  gen: number;
  own: boolean;
  after: Phase | '';
  ticket?: string;
  hash?: string;
  nonce?: string;
  turnAtMs?: number;
  skipped?: boolean;
}
/** 명세 검사 모듈의 범위(상수) */
export interface Scope {
  tickets: ReadonlyArray<readonly [number, number]>;
  ctrls: readonly number[];
  lag: number;
  openBatch: boolean;
  admitSteps: boolean;
  maxFailovers: number;
  personFailovers: boolean;
  maxLeaderChanges: number;
  epochJumps: readonly number[];
}
/** 명세 Tab을 고르는 (사람, 탭) */
export type K = readonly [number, number];
export const HOLDING: ReadonlySet<Phase> = new Set(['BATCHED', 'HELD', 'CHECKED', 'CLAIMED', 'SLOTTED', 'RELEASING', 'ADMITTED']);

/** 이 노드의 설정 세대. 흉내 낸 옛 주 노드는 이보다 낮다 */
export const NODE_EPOCH = 100;
const OTHER_NODE = 'f'.repeat(40);
const DAY = 86_400_000;
const BIG_TARGET = 1_000_000;
const JNY = '0190f3a1-7c2e-7a00-8000-0000000000aa';
const accountOf = (p: number) => `0190f3a1-7c2e-7a00-8000-${String(p).padStart(12, '0')}`;
const keyOf = (k: K) => `${k[0]},${k[1]}`;

const tokens = HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${Buffer.alloc(32, 7).toString('base64')}` });
const signer = new Es256AdmissionTokens({ jwk: { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'mbt' }, issuer: 'https://queue.mbt.invalid' });

// ---- 키 사본 ----
interface KeyCopy {
  t: string;
  /** PEXPIRETIME(-1이면 수명 없음) */
  x: number;
  /** 문자열은 16진, 나머지는 원소 목록 */
  v: string | string[];
}
export type Copy = Map<string, KeyCopy>;
const DUMP = redisScript(`
local out = {}
for _, k in ipairs(KEYS) do
  local t = redis.call('TYPE', k)['ok']
  local v = {}
  if t == 'string' then v = {redis.call('GET', k)}
  elseif t == 'hash' then v = redis.call('HGETALL', k)
  elseif t == 'set' then v = redis.call('SMEMBERS', k)
  elseif t == 'list' then v = redis.call('LRANGE', k, 0, -1)
  elseif t == 'zset' then v = redis.call('ZRANGE', k, 0, -1, 'WITHSCORES') end
  out[#out + 1] = {t, redis.call('PEXPIRETIME', k), v}
end
return out
`);
const RESTORE = redisScript(`
local function unhex(h) return (string.gsub(h, '..', function(c) return string.char(tonumber(c, 16)) end)) end
for i = 1, #KEYS do redis.call('DEL', KEYS[i]) end
for _, e in ipairs(cjson.decode(ARGV[1])) do
  local k = KEYS[e.i]
  if e.t == 'string' then redis.call('SET', k, unhex(e.v))
  elseif e.t == 'hash' then for j = 1, #e.v, 2 do redis.call('HSET', k, e.v[j], e.v[j + 1]) end
  elseif e.t == 'set' then for _, m in ipairs(e.v) do redis.call('SADD', k, m) end
  elseif e.t == 'list' then for _, m in ipairs(e.v) do redis.call('RPUSH', k, m) end
  elseif e.t == 'zset' then for j = 1, #e.v, 2 do redis.call('ZADD', k, e.v[j + 1], e.v[j]) end end
  if e.x > 0 then redis.call('PEXPIREAT', k, e.x) end
end
return 1
`);
// 이탈 흉내(HOT-060 전): 이 요청의 번호 기록이나 묶음 기록일 때만 q:dup을 지운다
const LEAVE_DUP = redisScript(`
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local rq = string.match(v, '^%d+:%d+:([^:]+):') or string.match(v, '^BATCH:1:[0-9a-f]+:([^:]+):')
if rq == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`);
const EXPIRE_PENDING = redisScript(`
local v = redis.call('GET', KEYS[1])
if v and string.sub(v, 1, 8) == 'PENDING:' then redis.call('DEL', KEYS[1]) return 1 end
return 0
`);

// 시험을 고칠 때만: MBT_DEBUG=<파일>이면 걸음마다 한 줄 남긴다(시험이 멈춰도 남는다)
export const debug = (line: string) => {
  if (process.env.MBT_DEBUG) appendFileSync(process.env.MBT_DEBUG, `${line}
`);
};
const text = (b: unknown) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b));
const PATIENT_MS = 5_000;
/** 호출마다 마감을 적어도 ms로 늘린 HotRedis(기다림 한도가 더 긴 호출, 예: WAIT는 그대로) */
function patient(r: HotRedis, ms: number): HotRedis {
  return Object.assign(Object.create(r) as HotRedis, {
    command: (args: string[], o: CallOptions = {}) => r.command(args, { ...o, deadlineMs: Math.max(o.deadlineMs ?? 0, ms) }),
    evalScript: (sc: RedisScript, ks: string[], as: string[], o: Omit<CallOptions, 'key'> = {}) => r.evalScript(sc, ks, as, { ...o, deadlineMs: Math.max(o.deadlineMs ?? 0, ms) }),
  });
}
/** 걸음 사이에 바뀌어도 명세의 쓰기가 아닌 칸: 세대 키를 견준 초와 RB-05 확인 전 WAIT 표시, 게시 전 WAIT 표시, 시험이 넣는 지금 목표 */
const volatile = (key: string, field: string) =>
  (key.endsWith(':epoch') && (field === 'chk' || field === 'wait')) || (key.endsWith(':batch_done') && field.startsWith('wait:')) || (key.endsWith(':ctl') && field === 'targetNow');
/** 수명과 걸음 사이의 값은 빼고 견준다 */
function canon(c: Copy): string {
  const out: string[] = [];
  for (const k of [...c.keys()].sort()) {
    const e = c.get(k)!;
    let v = e.v;
    if (e.t === 'hash') {
      const xs = v as string[];
      const pairs: string[] = [];
      for (let i = 0; i < xs.length; i += 2) if (!volatile(k, xs[i]!)) pairs.push(`${xs[i]}=${xs[i + 1]}`);
      v = pairs.sort();
      if (pairs.length === 0) continue;
    } else if (e.t === 'set') v = [...(v as string[])].sort();
    out.push(`${k}|${e.t}|${JSON.stringify(v)}`);
  }
  return out.join('\n');
}

export interface Ghost {
  issued: Map<string, string>;
  admittedBy: Map<number, Set<string>>;
  early: boolean;
  staleApplied: number;
  maxGenSeen: number;
  admLost: Set<number>;
  dupLost: Set<number>;
}

export interface SystemOptions {
  /**
   * 경합 시험: 운영 코드의 Redis 호출이 끝나는 순서를 fast-check 스케줄러가 정한다. 걸음마다 스케줄러를 직접 돌린다(대기 중인 호출이 있으면
   * 하나씩 무작위로 풀고, 없으면 입출력을 기다린다). fc.scheduledModelRun은 명령이 스케줄 밖 입출력(이 하네스의 키 사본 읽기)을 기다린 뒤에 생긴
   * 호출을 풀지 않아 멈추므로(2026-11-03 확인) 쓰지 않는다
   */
  scheduler?: Scheduler;
  /** 재생: 묶음 결과 순서를 명세(사람·탭 순)와 같게 하는 시드를 고른다 */
  specRanks?: boolean;
}

export class QueueSystem {
  readonly tabs = new Map<string, TabState>();
  readonly ctl = { holder: 0, transitions: 0, acquisitions: 0, c: new Map<number, { gen: number; op: string }>() };
  readonly env = { windowOpen: false, primary: 1, evFailovers: 0, psFailovers: 0 };
  readonly ghost: Ghost = { issued: new Map(), admittedBy: new Map(), early: false, staleApplied: 0, maxGenSeen: 0, admLost: new Set(), dupLost: new Set() };
  readonly violations: string[] = [];
  /** 회차 슬롯: 지금 주 노드, 복제본, 복제되지 않은 쓰기 */
  current: Copy = new Map();
  replica: Copy = new Map();
  pending: Copy[] = [];
  readonly personRep = new Map<number, Copy>();
  readonly eventId: string;
  readonly log: string[] = [];

  readonly #redis: HotRedis;
  readonly #raw: HotRedis;
  readonly #entry: RedisEntryStore;
  readonly #adm: RedisAdmissionStore;
  readonly #leader: RedisLeaderStore;
  readonly #app: ConfirmAdmission;
  readonly #publisher: PublishBatchResults;
  readonly #opensAt: number;
  readonly #startsAt: number;
  readonly #scheduler: Scheduler | undefined;
  #onAdmitCall: (() => void) | undefined;
  #myMarker = '';
  #earlySignal = false;

  constructor(
    raw: HotRedis,
    readonly scope: Scope,
    run: string,
    o: SystemOptions = {},
  ) {
    // 시험 PC나 CI 러너가 바쁠 때(여러 시험 파일이 함께 돌 때) 운영 기본 마감(100ms)에 걸려 걸음이 실패하지 않게 모든 호출의 마감을 늘린다.
    // 마감 처리는 이 시험이 보는 것이 아니다(플랫폼 시험이 본다)
    this.#raw = patient(raw, PATIENT_MS);
    this.#scheduler = o.scheduler;
    const sch = o.scheduler;
    const base = this.#raw;
    this.#redis = sch
      ? Object.assign(Object.create(base) as HotRedis, { command: sch.scheduleFunction(base.command.bind(base)), evalScript: sch.scheduleFunction(base.evalScript.bind(base)) })
      : base;
    this.eventId = `mbt${run}`;
    const now = Date.now();
    this.#opensAt = now - 60_000;
    this.#startsAt = now + 2 * DAY;
    for (const k of scope.tickets) this.tabs.set(keyOf(k), { phase: 'IDLE', seq: 0, gen: 0, own: false, after: '' });
    for (const p of this.persons()) this.ghost.admittedBy.set(p, new Set());
    for (const c of scope.ctrls) this.ctl.c.set(c, { gen: 0, op: 'NONE' });
    this.env.windowOpen = scope.openBatch;
    this.#entry = new RedisEntryStore(this.#redis);
    this.#adm = new RedisAdmissionStore(this.#redis);
    this.#leader = new RedisLeaderStore(this.#redis);
    const signals: AdmissionSignals = {
      admittedBeforeTurn: () => {
        this.#earlySignal = true;
      },
      turnEntryFailed: () => undefined,
      arrivalDelay: () => undefined,
      soonWait: () => undefined,
      etaError: () => undefined,
    };
    // 입장 확정이 회차 슬롯 입장 Lua를 부르는 때를 안다(경합 시험이 그 바로 뒤에 지금 목표를 올린다)
    const adm = this.#adm;
    const watched = Object.assign(Object.create(adm) as RedisAdmissionStore, {
      admit: (i: Parameters<RedisAdmissionStore['admit']>[0]) => {
        const p = adm.admit(i);
        this.#onAdmitCall?.();
        return p;
      },
    });
    this.#app = new ConfirmAdmission(watched, new RedisEventSchedules(this.#redis, systemClock), tokens, signer, signals, systemClock);
    const real = new RedisBatchStore(this.#redis);
    // 게시 전 복제 확인: 구현의 표시 확인(WAIT 앞 Lua) + 복제본 사본에 같은 표시가 있는가(WAIT 흉내)
    const batches: BatchStore = Object.assign(Object.create(real) as BatchStore, {
      confirmReplicated: async (e: string, n: number | 'lobby', marker: string) => (await real.confirmReplicated(e, n, marker)) && this.replicaMarker() === marker,
    });
    const secret = createHash('sha256').update(`mbt-randomness-${run}`).digest();
    const beacon = async () => createHash('sha256').update(`beacon\0${secret.toString('hex')}`).digest();
    const seeds: SeedSource = o.specRanks
      ? { seed: async (e, n) => this.#seedForSpecOrder(real, e, n as number, await beacon()) }
      : { seed: async (e, n) => createHash('sha256').update(`seed\0${secret.toString('hex')}\0${e}\0${n}`).digest() };
    // 게시 시각을 분산 창(8초)과 늦은 게시 창보다 앞으로 둔다: 명세는 '게시 뒤 첫 전진 문이 열림'을 한 걸음으로 줄였다
    const pastClock: Clock = { now: () => Date.now() - 600_000, monotonicMs: () => systemClock.monotonicMs() };
    // 공시 기록은 모델 밖이다: 언제나 있고 멈추지 않는다(명세는 공정성 공시를 뺀다)
    const records = {
      read: async (e: string, g: number | 'lobby') => {
        const s = await real.scheduleOf(e);
        const fixAt = g === 'lobby' ? s!.opensAtMs : s!.opensAtMs + (s!.batchWindowMs ?? 2_000);
        return { commit: '00'.repeat(32), round: drandRoundAfter(fixAt), sealed: 'x', atMs: 0 };
      },
      stop: async () => true,
    };
    this.#publisher = new PublishBatchResults(batches, records, seeds, { value: beacon }, { write: async () => undefined }, pastClock);
  }

  persons(): number[] {
    return [...new Set(this.scope.tickets.map((k) => k[0]))];
  }
  tab(k: K): TabState {
    return this.tabs.get(keyOf(k))!;
  }
  get #closeAt(): number {
    return this.env.windowOpen ? this.#opensAt + 2 * 3_600_000 : this.#opensAt + 1;
  }
  get #saleEnd(): number {
    return this.#startsAt - DAY;
  }
  get #keepUntil(): number {
    return this.#startsAt;
  }
  #requestId(k: K): string {
    return `rq${k[0]}x${k[1]}`;
  }
  #tokenHash(k: K): string {
    return createHash('sha256').update(`pv-${this.eventId}-${k[0]}-${k[1]}`).digest('hex');
  }

  // ---- 준비 ----
  async init(): Promise<void> {
    const e = this.eventId;
    const cmd = (key: string, args: string[]) => this.#raw.command(args, { key });
    this.#myMarker = `${text(await this.#raw.command(['CLUSTER', 'MYID']))}:${NODE_EPOCH}`;
    // 묶음 없는 범위는 로비 셔플을 켠 회차로 둔다(둘 다 끈 회차는 없다, ADR-0118). 로비는 명세가 뺀 것이라 Lua는 늘 로비를 끈 값으로 부른다
    await cmd(keys.cfg(e), ['HSET', keys.cfg(e), 'opensAtMs', String(this.#opensAt), 'startsAtMs', String(this.#startsAt), 'lobbyShuffle', this.scope.openBatch ? '0' : '1',
      'openBatch', this.scope.openBatch ? '1' : '0', 'rev', '1']);
    // 세대 키는 회차 일정 사본을 읽는 Lua가 쓴다(오픈 전에 서는 것과 같다)
    await new RedisEventSchedules(this.#raw, systemClock).get(e);
    this.current = await this.#dumpEvent();
    this.replica = this.current;
    for (const p of this.persons()) this.personRep.set(p, await this.#dumpPerson(p));
  }

  // ---- 사본 ----
  async #scanEvent(): Promise<string[]> {
    const pat = `q:{event:${this.eventId}}:*`;
    const found = new Set<string>();
    let cursor = '0';
    do {
      const [next, items] = (await this.#raw.command(['SCAN', cursor, 'MATCH', pat, 'COUNT', '1000'], { key: keys.seq(this.eventId) })) as [unknown, unknown[]];
      for (const x of items) found.add(text(x));
      cursor = text(next);
    } while (cursor !== '0');
    return [...found].filter((k) => !k.endsWith(':cfg')).sort();
  }
  async #dump(ks: string[]): Promise<Copy> {
    const out: Copy = new Map();
    if (ks.length === 0) return out;
    const r = (await this.#raw.evalScript(DUMP, ks, [], { binary: true, deadlineMs: 2_000 })) as unknown[][];
    ks.forEach((k, i) => {
      const [t, x, v] = r[i] as [unknown, unknown, unknown[]];
      const type = text(t);
      if (type === 'none') return;
      out.set(k, { t: type, x: Number(x), v: type === 'string' ? (v[0] as Buffer).toString('hex') : v.map(text) });
    });
    return out;
  }
  async #dumpEvent(): Promise<Copy> {
    return this.#dump(await this.#scanEvent());
  }
  #personKeys(p: number): string[] {
    return [entryKeys.dup(`p${p}`, this.eventId), entryKeys.adm(`p${p}`, this.eventId)];
  }
  async #dumpPerson(p: number): Promise<Copy> {
    return this.#dump(this.#personKeys(p));
  }
  async #restore(c: Copy, extra: string[]): Promise<void> {
    const ks = [...new Set([...extra, ...c.keys()])];
    const spec = [...c.entries()].map(([k, e]) => ({ i: ks.indexOf(k) + 1, t: e.t, x: e.x, v: e.v }));
    await this.#raw.evalScript(RESTORE, ks, [JSON.stringify(spec)], { deadlineMs: 2_000 });
  }
  replicaMarker(): string | null {
    const h = this.replica.get(keys.batchDone(this.eventId));
    if (!h) return null;
    const xs = h.v as string[];
    const i = xs.findIndex((x, j) => j % 2 === 0 && x === '1');
    return i < 0 ? null : xs[i + 1]!;
  }
  #field(c: Copy, key: string, field: string): string | null {
    const h = c.get(key);
    if (!h || h.t !== 'hash') return null;
    const xs = h.v as string[];
    for (let i = 0; i < xs.length; i += 2) if (xs[i] === field) return xs[i + 1]!;
    return null;
  }
  /** 세대 키가 이 노드(지금 주 노드)의 표지인가(명세 ev.node == env.primary) */
  markerMine(): boolean {
    return this.#field(this.current, keys.epoch(this.eventId), 'node') === this.#myMarker;
  }
  /** RB-05가 건너뛰었고 복제 확인 전인가(명세 ev.pend, ADR-0186) */
  rb05Pending(): boolean {
    return this.#field(this.current, keys.epoch(this.eventId), 'pend') !== null;
  }
  /** 진입 ②가 번호를 낼 수 있는가(명세 markerOk: 세대 키가 지금 노드이고 확인 전이 아님) */
  markerOk(): boolean {
    return this.markerMine() && !this.rb05Pending();
  }
  closed(): boolean {
    return this.#field(this.current, keys.batchDone(this.eventId), '1') !== null;
  }
  published(): boolean {
    return this.#field(this.current, keys.batchDone(this.eventId), 'pub:1') !== null;
  }
  /** 리더가 게시할 수 있는가(명세 markerReplicated, 아직 게시 전) */
  publishable(): boolean {
    const m = this.#field(this.current, keys.batchDone(this.eventId), '1');
    return this.scope.openBatch && m !== null && m === this.replicaMarker() && !this.published();
  }
  async eventValues(): Promise<{ seq: number; serving: number; gen: number; leader: number }> {
    const e = this.eventId;
    const n = async (k: string) => Number(text((await this.#raw.command(['GET', k], { key: k })) ?? '0'));
    const gen = Number(await this.#raw.command(['LLEN', keys.skipped(e)], { key: keys.skipped(e) })) + 1;
    return { seq: await n(keys.seq(e)), serving: await n(keys.serving(e)), gen, leader: await n(keys.leader(e)) };
  }

  /**
   * 걸음 하나를 돌리고 복제 사본을 맞춘 뒤 불변식을 센다. evWrite: 명세가 이 걸음을 회차 슬롯 쓰기로 보는지(재생은 동작 기록이 정한다).
   * 주지 않으면 회차 슬롯 키가 바뀌었는지로 정한다
   */
  async step(name: string, f: () => Promise<void>, evWrite?: boolean): Promise<void> {
    debug(`${this.eventId} ${name}`);
    const before = new Map<number, Copy>();
    for (const p of this.persons()) before.set(p, await this.#dumpPerson(p));
    await this.#drive(f());
    const now = await this.#dumpEvent();
    const wrote = evWrite ?? canon(now) !== canon(this.current);
    if (wrote) {
      if (this.pending.length >= this.scope.lag) this.replica = this.pending.shift()!;
      this.pending.push(now);
    }
    this.current = now;
    for (const p of this.persons()) {
      const after = await this.#dumpPerson(p);
      if (canon(after) !== canon(before.get(p)!)) this.personRep.set(p, before.get(p)!);
    }
    this.log.push(name);
    this.#checkInvariants(name);
    await this.checkAdmissionKeys();
  }

  async #drive(p: Promise<void>): Promise<void> {
    const sch = this.#scheduler;
    if (!sch) return p;
    let done = false;
    const watched = p.finally(() => {
      done = true;
    });
    watched.catch(() => undefined);
    while (!done) {
      if (sch.count() > 0) await sch.waitNext(1);
      else await new Promise((r) => setTimeout(r, 1));
    }
    return watched;
  }

  /** 쓰기가 아닌 걸음(Lease·계획·복제·장애 전환·시간)을 남기고 불변식을 센다. 사람 슬롯 사본은 그 걸음이 직접 맞춘다 */
  note(name: string): void {
    debug(`${this.eventId} note ${name}`);
    this.log.push(name);
    this.#checkInvariants(name);
  }
  /** 묶음 참가자 목록(회차 슬롯 사본)에 이 탭의 사전 검증 토큰 해시가 있는가 */
  isMember(k: K): boolean {
    const m = this.current.get(keys.batchMembers(this.eventId));
    return m !== undefined && (m.v as string[]).includes(this.#tokenHash(k));
  }
  /** 사람 슬롯의 지금 값이 복제본과 다른가(명세 pssRep != pss) */
  async personDiffers(p: number): Promise<boolean> {
    return canon(await this.#dumpPerson(p)) !== canon(this.personRep.get(p)!);
  }
  /** 재생이 견주는 회차 슬롯 관측(사본): 묶음 표시 '{첫 번호}:{크기}:{세대}', 게시 표시, 빠진 번호, 세대 키가 지금 노드인가 */
  observed(): { marker: string | null; pub: boolean; removed: number[]; markerMine: boolean; pend: boolean } {
    const bits = this.current.get(keys.removed(this.eventId));
    const removed: number[] = [];
    if (bits) {
      const b = Buffer.from(bits.v as string, 'hex');
      for (let i = 0; i < b.length * 8; i++) if ((b[i >> 3]! >> (7 - (i & 7))) & 1) removed.push(i);
    }
    return { marker: this.#field(this.current, keys.batchDone(this.eventId), '1'), pub: this.published(), removed, markerMine: this.markerMine(), pend: this.rb05Pending() };
  }
  /** 사람 슬롯 값의 종류(명세 Slot.kind): q:dup은 NONE·PENDING·REC·BATCH, q:adm은 NONE·ADM */
  async personKinds(p: number): Promise<{ dup: string; adm: string }> {
    const [dupK, admK] = this.#personKeys(p);
    const v = text((await this.#raw.command(['GET', dupK!], { key: dupK! })) ?? '');
    const dup = v === '' ? 'NONE' : v.startsWith('PENDING:') ? 'PENDING' : v.startsWith('BATCH:1:') ? 'BATCH' : /^\d+:\d+:/.test(v) ? 'REC' : `?${v}`;
    const adm = Number(await this.#raw.command(['EXISTS', admK!], { key: admK! })) === 1 ? 'ADM' : 'NONE';
    return { dup, adm };
  }

  /** 지금 serving·카운터(회차 슬롯 사본) */
  counters(): { seq: number; serving: number } {
    const num = (k: string) => {
      const e = this.current.get(k);
      return e ? Number(Buffer.from(e.v as string, 'hex').toString('utf8')) : 0;
    };
    return { seq: num(keys.seq(this.eventId)), serving: num(keys.serving(this.eventId)) };
  }

  // ---- 진입 ----
  async enterPreempt(k: K): Promise<void> {
    const r = await this.#entry.preempt({ pid: `p${k[0]}`, eventId: this.eventId, requestId: this.#requestId(k), pendingTtlMs: 600_000 });
    this.tab(k).phase = r.kind === 'PROCEED' ? 'PREEMPTED' : 'DONE';
  }
  async pendingExpires(p: number): Promise<void> {
    const key = entryKeys.dup(`p${p}`, this.eventId);
    await this.#raw.evalScript(EXPIRE_PENDING, [key], []);
  }
  #numberInput() {
    return { eventId: this.eventId, expireAtMs: this.#keepUntil, opensAtMs: this.#opensAt, closeAtMs: this.#closeAt, lobbyShuffle: false, openBatch: this.scope.openBatch, batchExpireAtMs: this.#saleEnd };
  }
  async enterNumber(k: K): Promise<void> {
    // 명세 enterNumber는 markerOk일 때만 할 수 있다: 세대 키가 다르거나 RB-05 확인 전이면 번호도 묶음도 없어야 한다(ADR-0181·0186)
    const ok = this.markerOk();
    const r = await this.#entry.number({ ...this.#numberInput(), eligible: true, tokenHash: this.#tokenHash(k) });
    if (!ok && r.kind !== 'RECOVERING') this.#violate(`enterNumber ${keyOf(k)}: 세대 키가 다르거나 RB-05 확인 전인데 결과가 ${r.kind}`);
    const t = this.tab(k);
    if (r.kind === 'NUMBERED') Object.assign(t, { phase: 'NUMBERED', seq: r.seq, gen: r.gen });
    else if (r.kind === 'BATCHING') t.phase = 'SADDED';
    else if (r.kind === 'RECOVERING') {
      // 503 queue-recovering: 진입은 선점을 풀고 화면은 같은 요청 ID로 다시 보낸다(ADR-0181 결정 2). 다시 선점해 PREEMPTED로 남는다
      await this.#entry.release({ pid: `p${k[0]}`, eventId: this.eventId, requestId: this.#requestId(k) });
      const again = await this.#entry.preempt({ pid: `p${k[0]}`, eventId: this.eventId, requestId: this.#requestId(k), pendingTtlMs: 600_000 });
      if (again.kind !== 'PROCEED') t.phase = 'DONE';
    } else throw new Error(`enterNumber: 뜻밖의 결과 ${r.kind}`);
  }
  async enterRecord(k: K): Promise<void> {
    const t = this.tab(k);
    const r = await this.#entry.record({ pid: `p${k[0]}`, eventId: this.eventId, requestId: this.#requestId(k), seq: t.seq, gen: t.gen, jny: JNY, expireAtMs: this.#saleEnd });
    if (r.kind === 'RECORDED') this.#hold(k, t.seq, t.gen);
    else if (r.kind === 'ADMITTED' || r.kind === 'TAKEN') {
      await this.#entry.markRemoved({ eventId: this.eventId, seq: t.seq, expireAtMs: this.#keepUntil });
      t.phase = 'DONE';
    } else throw new Error(`enterRecord: 뜻밖의 결과 ${r.kind}`);
  }
  async enterBatchRecord(k: K): Promise<void> {
    const r = await this.#entry.batchRecord({ pid: `p${k[0]}`, eventId: this.eventId, requestId: this.#requestId(k), tokenHash: this.#tokenHash(k), jny: JNY, expireAtMs: this.#saleEnd });
    if (r.kind === 'BATCHED') this.tab(k).phase = 'BATCHED';
    else if (r.kind === 'ADMITTED' || r.kind === 'TAKEN') this.tab(k).phase = 'DONE';
    else throw new Error(`enterBatchRecord: 뜻밖의 결과 ${r.kind}`);
  }
  /**
   * 묶음 결과 읽기(EnterQueue의 묶음 기록 갈래): 결과면 묶음 기록을 번호 기록으로 바꿔 HELD(바뀌었으면 409 → DONE), 참가자 목록에 없으면(batchMissing)
   * 묶음 기록을 지우고 같은 요청으로 다시 진입하므로 IDLE(다음 걸음이 선점부터). 게시 전이면 그대로
   */
  async #batchOutcome(k: K): Promise<'RESULT' | 'GONE' | 'MISSING' | 'PENDING'> {
    const h = this.#tokenHash(k);
    const r = await this.#entry.batchResult({ eventId: this.eventId, tokenHash: h });
    const pid = `p${k[0]}`;
    if (r.kind === 'RESULT') {
      const c = await this.#entry.convertBatch({ pid, eventId: this.eventId, requestId: this.#requestId(k), tokenHash: h, seq: r.seq, gen: r.gen, expireAtMs: this.#saleEnd });
      if (c.kind === 'RECORDED') {
        this.#hold(k, c.seq, c.gen);
        return 'RESULT';
      }
      this.tab(k).phase = 'DONE';
      return 'GONE';
    }
    if (r.kind === 'MISSING') {
      await this.#entry.dropBatch({ pid, eventId: this.eventId, requestId: this.#requestId(k), tokenHash: h });
      this.tab(k).phase = 'IDLE';
      return 'MISSING';
    }
    return 'PENDING';
  }
  async takeBatchResult(k: K): Promise<void> {
    const o = await this.#batchOutcome(k);
    // 묶음 기록이 바뀌는 것은 사람 슬롯 장애 전환으로 잃었을 때뿐이다
    if (o === 'GONE' && !this.ghost.dupLost.has(k[0])) this.#violate(`takeBatchResult ${keyOf(k)}: 묶음 기록이 장애 전환 없이 바뀌었다(409)`);
    if (o === 'MISSING' || o === 'PENDING') this.#violate(`takeBatchResult ${keyOf(k)}: 게시된 참가인데 결과가 ${o}`);
  }
  async batchMissing(k: K): Promise<void> {
    const o = await this.#batchOutcome(k);
    if (o !== 'MISSING') this.#violate(`batchMissing ${keyOf(k)}: 참가자 목록에 없는데 결과가 ${o}`);
  }
  async leave(k: K): Promise<void> {
    const t = this.tab(k);
    await this.#entry.markRemoved({ eventId: this.eventId, seq: t.seq, expireAtMs: this.#keepUntil });
    await this.#raw.evalScript(LEAVE_DUP, [entryKeys.dup(`p${k[0]}`, this.eventId)], [this.#requestId(k)]);
    t.phase = 'DONE';
  }
  async windowEnds(): Promise<void> {
    this.env.windowOpen = false;
  }
  async publishBatch(): Promise<string> {
    const can = this.publishable();
    const st = (await this.#publisher.run({ eventId: this.eventId })).status;
    if (can && st !== 'PUBLISHED') this.#violate(`publishBatch: 표시가 복제됐는데 게시 결과가 ${st}`);
    return st;
  }
  #hold(k: K, seq: number, gen: number): void {
    const t = this.tab(k);
    Object.assign(t, { phase: 'HELD', seq, gen });
    t.ticket = tokens.ticket({ e: this.eventId, a: accountOf(k[0]), d: '', s: seq, g: gen, seg: 0, rq: this.#requestId(k), jny: JNY });
    t.hash = tokens.hash(t.ticket);
    const id = `${seq}:${gen}`;
    const was = this.ghost.issued.get(id);
    if (was !== undefined && was !== keyOf(k)) this.#violate(`② 같은 세대 안 번호 중복: ${id}를 ${was}와 ${keyOf(k)}가 받았다`);
    this.ghost.issued.set(id, keyOf(k));
  }

  // ---- 리더 ----
  acquire(c: number): void {
    this.ctl.holder = c;
    this.ctl.transitions += 1;
    this.ctl.acquisitions += 1;
    this.ctl.c.set(c, { gen: this.ctl.transitions, op: 'BUMP' });
  }
  plan(c: number, op: 'ADVANCE' | 'CLOSE'): void {
    this.ctl.c.get(c)!.op = op;
  }
  async applyWrite(c: number): Promise<string> {
    const w = this.ctl.c.get(c)!;
    const e = this.eventId;
    let out: string;
    if (w.op === 'BUMP') out = await this.#leader.bump(e, w.gen, this.#keepUntil);
    else if (w.op === 'ADVANCE') {
      const r = await this.#leader.tick({ eventId: e, gen: w.gen, target: BIG_TARGET, ratioFloor: 0.2, saleStateFallback: 'ON_SALE', windowMs: 0, maxAdvance: 1,
        keepUntilMs: this.#keepUntil, saleEndMs: this.#saleEnd, lobbyShuffle: false, openBatch: this.scope.openBatch, closeAtMs: this.#closeAt });
      out = r.kind;
    } else {
      out = await this.#leader.close({ eventId: e, gen: w.gen, keepUntilMs: this.#keepUntil, opensAtMs: this.#opensAt, closeAtMs: this.#closeAt, lobbyShuffle: false, openBatch: this.scope.openBatch });
    }
    this.ctl.c.set(c, { gen: w.gen, op: 'NONE' });
    if (out !== 'FENCED') {
      if (w.gen < this.ghost.maxGenSeen) this.ghost.staleApplied += 1;
      this.ghost.maxGenSeen = Math.max(this.ghost.maxGenSeen, w.gen);
    }
    return out;
  }

  // ---- 복제와 장애 전환 ----
  replicateEv(): void {
    this.replica = this.pending.shift()!;
  }
  async replicatePerson(p: number): Promise<void> {
    this.personRep.set(p, await this.#dumpPerson(p));
  }
  /** 복제본을 주 노드로 올린다. 새 주 노드는 설정 세대가 j만큼 오른 다른 노드다: 되살린 세대 키 표지의 설정 세대를 j만큼 내린 다른 노드 표지로 둔다 */
  async failoverEv(j: number): Promise<void> {
    const restored: Copy = new Map(this.replica);
    const ek = keys.epoch(this.eventId);
    const held = restored.get(ek);
    if (held) {
      const xs = [...(held.v as string[])];
      const i = xs.findIndex((x, n) => n % 2 === 0 && x === 'node');
      if (i >= 0) {
        const was = xs[i + 1]!;
        const epoch = was === this.#myMarker ? NODE_EPOCH : Number(/:(\d+)$/.exec(was)?.[1] ?? NODE_EPOCH);
        xs[i + 1] = `${OTHER_NODE}:${epoch - j}`;
      }
      restored.set(ek, { ...held, v: xs });
    }
    await this.#restore(restored, await this.#scanEvent());
    this.current = await this.#dumpEvent();
    this.replica = this.current;
    this.pending = [];
    this.env.evFailovers += 1;
    this.env.primary += j;
  }
  async failoverPerson(p: number): Promise<void> {
    const now = await this.#dumpPerson(p);
    const rep = this.personRep.get(p)!;
    const [dupK, admK] = this.#personKeys(p);
    const same = (k: string) => JSON.stringify(now.get(k)?.v ?? null) === JSON.stringify(rep.get(k)?.v ?? null);
    if (now.has(admK!) && !same(admK!)) this.ghost.admLost.add(p);
    if (!same(dupK!)) this.ghost.dupLost.add(p);
    await this.#restore(rep, this.#personKeys(p));
    this.env.psFailovers += 1;
  }
  async rb05(): Promise<string> {
    const want = !this.markerMine() ? 'SKIPPED' : this.rb05Pending() ? 'PENDING' : 'DONE';
    const r = await this.#entry.rb05({ eventId: this.eventId, expireAtMs: this.#keepUntil, skippedExpireAtMs: this.#saleEnd, skipBase: this.scope.lag,
      opensAtMs: this.#opensAt, closeAtMs: this.#closeAt, lobbyShuffle: false, openBatch: this.scope.openBatch });
    if (r.kind !== want) this.#violate(`rb05: ${want}이어야 하는데 결과가 ${r.kind}`);
    return r.kind;
  }
  /**
   * RB-05 복제 확인(명세 rb05Confirm, ADR-0186): 운영 코드의 확인(표시 → 붙은 복제본 수만큼 WAIT → 지우기)을 부른다. 이 노드에는 복제본이 없어
   * WAIT를 건너뛰므로, 'WAIT가 됨'은 하네스의 복제본 사본이 지금까지의 쓰기를 다 받았는지(복제되지 않은 쓰기 없음)로 흉내 낸다. 받지 못했으면 부르지 않는다
   */
  async rb05Confirm(): Promise<string> {
    if (!(this.markerMine() && this.rb05Pending())) {
      this.#violate('rb05Confirm: 확인할 것이 없는데 불렀다');
      return 'NONE';
    }
    if (this.pending.length > 0) {
      this.#violate('rb05Confirm: 복제되지 않은 쓰기가 남았는데 확인했다(WAIT 흉내)');
      return 'WAITING';
    }
    const r = await this.#entry.confirmRb05({ eventId: this.eventId });
    if (r !== 'CONFIRMED') this.#violate(`rb05Confirm: 붙은 복제본이 없는데 결과가 ${r}`);
    return r;
  }

  // ---- 입장 확정 ----
  async #setTarget(n: number): Promise<void> {
    const k = keys.ctl(this.eventId);
    await this.#raw.command(['HSET', k, 'targetNow', String(n)], { key: k });
  }
  /**
   * 네 호출을 한 번에(ConfirmAdmission). copies가 2면 같은 대기표의 요청 둘을 함께 보낸다(응답을 잃은 재시도·두 파드, ADR-0183 결정 2).
   * raiseAfter를 주면 지금 목표를 0(곧 입장)에서 시작해, 스케줄러가 빈 작업을 그만큼 푼 뒤 올린다(리더 전진과 엇갈림. 경합 시험은 Redis 호출이 끝나는
   * 순서를 스케줄러가 섞으므로 올리는 때가 요청들의 호출 사이 아무 데나 온다). 'afterFirstAdmit'이면 첫 요청이 입장 Lua를 부른 바로 뒤에 올린다
   * (그 요청은 곧 입장, 뒤 요청은 자리를 받는다. 그 뒤 순서는 스케줄러가 섞는다)
   */
  async admit(k: K, o: { copies?: number; raiseAfter?: number | 'afterFirstAdmit' } = {}): Promise<string[]> {
    const t = this.tab(k);
    await this.#setTarget(o.raiseAfter === undefined ? BIG_TARGET : 0);
    this.#earlySignal = false;
    const ctlKey = keys.ctl(this.eventId);
    const raise = (async () => {
      if (o.raiseAfter === undefined) return;
      if (o.raiseAfter === 'afterFirstAdmit') {
        // 같은 연결로 보내므로 HSET은 그 입장 Lua 뒤에 돈다
        await new Promise<void>((r) => {
          this.#onAdmitCall = () => {
            this.#onAdmitCall = undefined;
            void this.#raw.command(['HSET', ctlKey, 'targetNow', String(BIG_TARGET)], { key: ctlKey }).then(() => r());
          };
        });
        return;
      }
      for (let i = 0; i < o.raiseAfter; i++) await (this.#scheduler ? this.#scheduler.schedule(Promise.resolve()) : Promise.resolve());
      await this.#redis.command(['HSET', ctlKey, 'targetNow', String(BIG_TARGET)], { key: ctlKey });
    })();
    const one = async () => {
      try {
        const r = await this.#app.run({ accountId: accountOf(k[0]), pid: `p${k[0]}`, sessionId: 's', eventId: this.eventId, body: { queueTicket: t.ticket! } });
        return r.status;
      } catch (e) {
        if (e instanceof AdmissionError) return e.code;
        throw e;
      }
    };
    const [outs] = await Promise.all([Promise.all(Array.from({ length: o.copies ?? 1 }, one)), raise]);
    debug(`${this.eventId} admit ${keyOf(k)} → ${outs.join(',')}`);
    if (this.#earlySignal) this.ghost.early = true;
    if (outs.includes('ADMITTED')) this.#admitted(k);
    else if (outs.some((x) => x === 'REMOVED' || x === 'DUPLICATE_ADMISSION')) t.phase = 'DONE';
    return outs;
  }
  async admitCheck(k: K): Promise<string> {
    const t = this.tab(k);
    const r = await this.#adm.precheck({ eventId: this.eventId, seq: t.seq, gen: t.gen, ticketHash: t.hash! });
    if (r.kind === 'OK') Object.assign(t, { phase: 'CHECKED', turnAtMs: r.turnAtMs, skipped: r.skipped });
    else if (r.kind === 'REMOVED') t.phase = 'DONE';
    return r.kind;
  }
  async admitClaim(k: K): Promise<string> {
    const t = this.tab(k);
    t.nonce = randomUUID();
    const r = await this.#adm.claim({ pid: `p${k[0]}`, eventId: this.eventId, ticketHash: t.hash!, nonce: t.nonce, expireAtMs: this.#saleEnd });
    if (r.kind === 'DUP') {
      await this.#adm.markRemoved({ eventId: this.eventId, seq: t.seq, expireAtMs: this.#keepUntil });
      t.phase = 'DONE';
    } else Object.assign(t, { phase: 'CLAIMED', own: r.kind === 'NEW' });
    return r.kind;
  }
  async admitSlot(k: K, ok: boolean): Promise<string> {
    const t = this.tab(k);
    await this.#setTarget(ok ? BIG_TARGET : 0);
    const r = await this.#adm.admit({ eventId: this.eventId, seq: t.seq, ticketHash: t.hash!, freshJti: t.nonce!, ...(t.turnAtMs !== undefined ? { turnAtMs: t.turnAtMs } : {}),
      skipped: t.skipped ?? false, keepUntilMs: this.#keepUntil, soonExpireAtMs: this.#saleEnd });
    if (r.kind === 'ADMITTED') {
      if (t.seq > r.serving) this.ghost.early = true;
      t.phase = 'SLOTTED';
    } else {
      const after: Phase = r.kind === 'REMOVED' ? 'DONE' : 'HELD';
      if (t.own) Object.assign(t, { phase: 'RELEASING', after });
      else t.phase = after;
    }
    return r.kind;
  }
  async admitSettle(k: K): Promise<void> {
    const t = this.tab(k);
    await this.#adm.settle({ pid: `p${k[0]}`, eventId: this.eventId, ticketHash: t.hash!, outcome: 'ADMITTED', nonce: t.nonce!, expireAtMs: this.#saleEnd });
    this.#admitted(k);
  }
  async admitRelease(k: K): Promise<void> {
    const t = this.tab(k);
    await this.#adm.settle({ pid: `p${k[0]}`, eventId: this.eventId, ticketHash: t.hash!, outcome: 'RELEASE', nonce: t.nonce!, expireAtMs: this.#saleEnd });
    Object.assign(t, { phase: t.after || 'HELD', own: false, after: '' });
  }
  #admitted(k: K): void {
    const t = this.tab(k);
    t.phase = 'ADMITTED';
    this.ghost.admittedBy.get(k[0])!.add(`${k[1]}:${t.seq}:${t.gen}`);
  }

  // ---- 불변식(명세 ①~⑤) + 입장한 대기표의 입장 키(ADR-0183 결정 2·3) ----
  #violate(msg: string): void {
    this.violations.push(`${msg} [걸음 ${this.log.length}: ${this.log.slice(-12).join(' → ')}]`);
  }
  #checkInvariants(name: string): void {
    const g = this.ghost;
    if (g.early) this.#violate(`① 차례 전 입장(${name})`);
    if ((this.env.evFailovers === 0 && g.staleApplied > 0) || g.staleApplied > this.env.evFailovers) this.#violate(`③ 옛 리더 쓰기 ${g.staleApplied}회(장애 전환 ${this.env.evFailovers}회)`);
    for (const p of this.persons()) {
      if (!g.admLost.has(p) && g.admittedBy.get(p)!.size > 1) this.#violate(`④ 사람 ${p}가 대기표 ${g.admittedBy.get(p)!.size}장으로 입장`);
      const held = this.scope.tickets.filter((k) => k[0] === p && HOLDING.has(this.tab(k).phase)).length;
      if (!(g.dupLost.has(p) || g.admLost.has(p)) && held > 1) this.#violate(`⑤ 사람 ${p}가 자리 ${held}개`);
    }
  }
  /** 입장한 탭의 사람에게 입장 키(q:adm, 그 대기표 해시)가 남아 있는가. 사람 슬롯 장애 전환으로 입장 키가 바뀐 사람은 뺀다. 쓰기 걸음마다 본다 */
  async checkAdmissionKeys(): Promise<void> {
    for (const [key, t] of this.tabs) {
      if (t.phase !== 'ADMITTED') continue;
      const p = Number(key.split(',')[0]);
      if (this.ghost.admLost.has(p)) continue;
      const k = entryKeys.adm(`p${p}`, this.eventId);
      const v = text((await this.#raw.command(['GET', k], { key: k })) ?? '');
      if (!v.startsWith(`${t.hash}:`) && v !== t.hash) this.#violate(`입장한 탭 ${key}의 입장 키가 없다(q:adm=${v || '없음'})`);
    }
  }

  /** 재생: 명세 Tab 순서대로 묶음 참가자의 순위가 나오게 하는 시드(구현의 셔플 함수로 찾는다) */
  async #seedForSpecOrder(store: BatchStore, eventId: string, n: number, beacon: Buffer): Promise<Buffer> {
    const members = sortHashes(await store.members(eventId, n));
    const want = [...this.scope.tickets].sort((a, b) => a[0] * 100 + a[1] - (b[0] * 100 + b[1])).map((k) => this.#tokenHash(k)).filter((h) => members.includes(h));
    const root = merkleRoot(members.map((h) => Buffer.from(h, 'hex')));
    for (let i = 0; i < 100_000; i++) {
      const seed = createHash('sha256').update(`spec-order\0${i}`).digest();
      const got = shuffle(members, combinedKey(seed, beacon, root, eventId));
      if (got.length === want.length && got.every((h, j) => h === want[j])) return seed;
    }
    throw new Error('명세 순서와 같은 셔플 시드를 찾지 못했다');
  }
}
