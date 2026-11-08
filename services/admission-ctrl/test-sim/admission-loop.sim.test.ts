// 실측(PC): Q-T46 도착 지연을 넣은 입장 제어 루프(docs/features/queue-admission.md §11, ADR-0104 결정 7). BUILD_ORDER PRF-085 ⑤.
// 운영 코드 그대로(admission-ctrl AdmissionLeader·RedisLeaderStore, queue-svc ConfirmAdmission·RedisAdmissionStore)를 실제 Valkey에 10분 돌린다.
// 합성 대기자: 목표 5,000명, 안 오는 사람 20%, 차례를 본 뒤 도착까지 1~3초(고르게), 입장 뒤 머무는 시간 평균 180초(지수 분포), SOON 뒤 다시 시도 2~3초.
// 같은 조건을 '오는 중'을 빼지 않은 식(바꾸기 전: 오는 중 창 W = 0)으로도 돌린다(따로 띄운 Valkey에서 동시에). 저장소를 감싸 전진 입력의 W만 0으로 바꾼다.
// 두 식은 대기자마다 같은 난수(안 옴·도착 지연·머무는 시간·다시 시도)를 써서(공통 난수) 차이만 보이게 하고, 씨앗을 바꿔 SIM_REPS번(기본 3) 되풀이한다.
// 판정(ADR-0104): 곧 입장 응답 ≤ 입장 확정 요청의 1% [가정], 곧 입장으로 기다린 시간 p99 ≤ 5초 [가정], 바꾸기 전 식보다 입장 수 감소 2% [가정] 이내,
// 동시 입장 목표 초과 0, 처음 6초의 serving 증가 ≤ 초당 1,000번호. '시스템 원인 15분 만료 0'은 10분 실행에서 일어날 수 없어 판정에서 뺀다.
// 도착 지연은 넣은 값이 아니라 입장 확정 Lua가 잰 값(admission_arrival_delay_seconds의 원천), 오는 중은 리더가 주기마다 낸 추정을 남긴다.
// 결과는 queue-svc test-sim/record.ts로 성능 장부 갈 자리에 쓴다(실행마다 새 번호). 쓰는 법: pnpm --filter @peaket/admission-ctrl sim
import { generateKeyPairSync } from 'node:crypto';
import { createHotRedis, type HotRedis, systemClock } from '@peaket/platform';
import { afterAll, expect, test } from 'vitest';
import { Es256AdmissionTokens } from '../../queue-svc/src/modules/admission/adapters/es256-admission-tokens.js';
import { RedisAdmissionStore } from '../../queue-svc/src/modules/admission/adapters/redis-admission-store.js';
import { AdmissionError } from '../../queue-svc/src/modules/admission/application/admission-error.js';
import { ConfirmAdmission } from '../../queue-svc/src/modules/admission/application/confirm-admission.js';
import type { AdmissionSignals } from '../../queue-svc/src/modules/admission/domain/ports.js';
import { QueueStoreUnavailable } from '../../queue-svc/src/modules/entry/domain/queue.js';
import { HmacQueueTokens, QUEUE_TOKEN_KEY_ENV } from '../../queue-svc/src/modules/entry/adapters/hmac-tokens.js';
import { RedisEventSchedules } from '../../queue-svc/src/modules/entry/adapters/redis-event-schedules.js';
import { keys, RedisLeaderStore } from '../src/modules/leader/adapters/redis-leader-store.js';
import { AdmissionLeader } from '../src/modules/leader/application/admission-leader.js';
import { ALL_JOURNEYS, type EventInputs, type Reading } from '../src/modules/leader/domain/aimd.js';
import type { LeaderStore } from '../src/modules/leader/domain/ports.js';
import { nextRunId, saveRun, SIM_DAY } from '../../queue-svc/test-sim/record.js';
import { startValkey, type ValkeyContainer } from '../test-int/valkey.js';

const DURATION_S = Number(process.env.SIM_SECONDS ?? 600);
const REPS = Number(process.env.SIM_REPS ?? 3);
const TARGET = 5_000;
const NO_SHOW = 0.2;
const STAY_MEAN_S = 180;
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-000000000001';
const JNY = '0190f3a1-7c2e-7a00-8000-0000000000aa';

const tokens = HmacQueueTokens.fromEnv({ [QUEUE_TOKEN_KEY_ENV]: `k1:${Buffer.alloc(32, 3).toString('base64')}` });
const signer = new Es256AdmissionTokens({ jwk: { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'sim' }, issuer: 'https://queue.sim.invalid' });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** 번호·용도·씨앗으로 정하는 [0, 1) 난수(mulberry32). 두 식이 같은 대기자에게 같은 값을 쓴다 */
function rand(seed: number, seq: number, k: number): number {
  let a = (seed * 0x9e3779b1 + seq * 0x85ebca6b + k * 0xc2b2ae35) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const q = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 1000) / 1000;
};

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const f of cleanup.reverse()) await f();
});

interface Outcome {
  variant: string;
  requests: number;
  admitted: number;
  soon: number;
  soonRatio: number;
  soonWaitP99S: number | null;
  soonWaitMaxS: number | null;
  arrivalP50S: number | null;
  arrivalP95S: number | null;
  /** 시스템 원인 15분 만료(10분 실행에서는 일어날 수 없어 판정하지 않는다) */
  expired: number;
  /** 입장 확정 Lua가 잰 도착 지연(부른 때 → 처음 요청) */
  measuredArrivalP50S: number | null;
  measuredArrivalP95S: number | null;
  /** 리더가 주기마다 낸 오는 중 추정 */
  inFlightP50: number | null;
  inFlightMax: number | null;
  /** 대기열 Redis 일시 장애(503) 뒤 다시 보낸 수 */
  unavailable: number;
  errors: Record<string, number>;
  overTargetSamples: number;
  maxSlots: number;
  servingAt6s: number;
  servingEnd: number;
  called: number;
  noShows: number;
}

async function runVariant(variant: 'new' | 'old', seed: number): Promise<Outcome> {
  const valkey: ValkeyContainer = await startValkey();
  const redis: HotRedis = await createHotRedis({ url: valkey.url });
  cleanup.push(() => valkey.stop(), () => redis.close().catch(() => undefined));
  const cmd = (key: string, args: string[]) => redis.command(args, { key });
  const eventId = `sim46-${variant}-${seed}`;
  const now0 = Date.now();
  const startsAt = now0 + 2 * 86_400_000;
  const keepUntil = startsAt;
  // 일정 사본(로비·묶음 켬), 표시와 게시를 이미 지난 회차(첫 전진 문이 열려 있다), 진행 중 목록, 발급된 번호
  await cmd(keys.cfg(eventId), ['HSET', keys.cfg(eventId), 'opensAtMs', String(now0 - 120_000), 'startsAtMs', String(startsAt), 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1']);
  await cmd(keys.batchDone(eventId), ['HSET', keys.batchDone(eventId), 'lobby', '1:0:1', 'pub:lobby', String(now0 - 60_000), '1', '1:0:1', 'pub:1', String(now0 - 60_000)]);
  await cmd(keys.events(), ['ZADD', keys.events(), String(keepUntil), eventId]);
  await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), '400000']);
  await cmd(keys.ctl(eventId), ['HSET', keys.ctl(eventId), 'target', String(TARGET), 'targetUntil', String(startsAt)]);

  const base = new RedisLeaderStore(redis);
  // 바꾸기 전 식: 전진 입력의 오는 중 창만 0으로(오는 중을 빼지 않는다)
  const store: LeaderStore = variant === 'old' ? new Proxy(base, { get: (t, k) => (k === 'tick' ? (i: Parameters<LeaderStore['tick']>[0]) => t.tick({ ...i, windowMs: 0 }) : (Reflect.get(t, k) as unknown as (...a: unknown[]) => unknown)?.bind?.(t) ?? Reflect.get(t, k)) }) : base;
  const inFlight: number[] = [];
  const leaderMetrics = { event: (_e: string, r: { inFlight: number }) => void inFlight.push(r.inFlight), control: () => undefined, openGaps: () => undefined, loop: () => undefined, leader: () => undefined, fenced: () => undefined, publish: () => undefined, forget: () => undefined };
  const leader = new AdmissionLeader(store, { run: async () => ({ status: 'NO_SCHEDULE' }) }, { generation: () => 1 }, systemClock, undefined, leaderMetrics as never);
  const admStore = new RedisAdmissionStore(redis);
  const measuredArrivals: number[] = [];
  const signals: AdmissionSignals = { admittedBeforeTurn: () => undefined, turnEntryFailed: () => undefined, arrivalDelay: (sec) => void measuredArrivals.push(sec), soonWait: () => undefined, etaError: () => undefined };
  const app = new ConfirmAdmission(admStore, new RedisEventSchedules(redis, systemClock), tokens, signer, signals, systemClock);

  const o: Outcome = { variant, requests: 0, admitted: 0, soon: 0, soonRatio: 0, soonWaitP99S: null, soonWaitMaxS: null, arrivalP50S: null, arrivalP95S: null, measuredArrivalP50S: null, measuredArrivalP95S: null, inFlightP50: null, inFlightMax: null, expired: 0, unavailable: 0, errors: {}, overTargetSamples: 0, maxSlots: 0, servingAt6s: 0, servingEnd: 0, called: 0, noShows: 0 };
  const soonWaits: number[] = [];
  const arrivals: number[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, f: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      f();
    }, ms);
    timers.add(t);
  };
  let stopping = false;
  const t0 = Date.now();

  const attempt = (seq: number, calledAt: number, firstSoonAt?: number, retry = false, tries = 0) => {
    if (stopping) return;
    const ticket = tokens.ticket({ e: eventId, a: ACCOUNT, d: '', s: seq, g: 1, seg: Math.floor((seq - 1) / 1000), rq: `rq-${seq}`, jny: JNY });
    o.requests += 1;
    if (firstSoonAt === undefined && !retry) arrivals.push((Date.now() - calledAt) / 1000);
    app
      .run({ accountId: ACCOUNT, pid: `p${seq}`, sessionId: 's', eventId, body: { queueTicket: ticket } })
      .then(async (r) => {
        if (r.status === 'ADMITTED') {
          o.admitted += 1;
          if (firstSoonAt !== undefined) soonWaits.push((Date.now() - firstSoonAt) / 1000);
          const jti = JSON.parse(Buffer.from(r.admissionToken.split('.')[1]!, 'base64url').toString()).jti as string;
          // 구매 세션 시작(곧바로)과 종료(머무는 시간, 지수 분포)
          later(500, () => void admStore.sessionStarted({ eventId, jti, maxStayUntilMs: Date.now() + 45 * 60_000 }).catch(() => undefined));
          later(-Math.log(1 - rand(seed, seq, 3)) * STAY_MEAN_S * 1000, () => void admStore.sessionEnded({ eventId, jti }).catch(() => undefined));
        } else if (r.status === 'SOON') {
          o.soon += 1;
          const first = firstSoonAt ?? Date.now();
          later(2_000 + rand(seed, seq, 10 + tries) * 1_000, () => attempt(seq, calledAt, first, false, tries + 1));
        } else {
          o.errors[r.status] = (o.errors[r.status] ?? 0) + 1;
        }
      })
      .catch((e: unknown) => {
        // 대기열 Redis 일시 장애(503)는 브라우저처럼 Retry-After 1초 뒤 같은 대기표로 다시 보낸다
        if (e instanceof QueueStoreUnavailable) {
          o.unavailable += 1;
          later(1_000, () => attempt(seq, calledAt, firstSoonAt, true, tries + 1));
          return;
        }
        if (e instanceof AdmissionError && e.code === 'EXPIRED') o.expired += 1;
        const k = e instanceof AdmissionError ? e.code : String((e as Error)?.name);
        o.errors[k] = (o.errors[k] ?? 0) + 1;
      });
  };

  leader.start();
  let seen = 0;
  const watcher = setInterval(() => {
    void (async () => {
      const s = Number((await cmd(keys.serving(eventId), ['GET', keys.serving(eventId)])) ?? 0);
      const calledAt = Date.now();
      for (let n = seen + 1; n <= s; n += 1) {
        o.called += 1;
        if (rand(seed, n, 1) < NO_SHOW) {
          o.noShows += 1;
          continue;
        }
        later(1_000 + rand(seed, n, 2) * 2_000, () => attempt(n, calledAt));
      }
      if (s > seen) seen = s;
      if (Date.now() - t0 <= 6_000) o.servingAt6s = s;
      const slots = Number(await cmd(keys.slots(eventId), ['ZCOUNT', keys.slots(eventId), `(${Date.now()}`, '+inf']));
      o.maxSlots = Math.max(o.maxSlots, slots);
      if (slots > TARGET) o.overTargetSamples += 1;
    })().catch(() => undefined);
  }, 100);

  await sleep(DURATION_S * 1000);
  stopping = true;
  clearInterval(watcher);
  await leader.stop();
  for (const t of timers) clearTimeout(t);
  await sleep(500);
  o.servingEnd = seen;
  o.soonRatio = o.requests ? o.soon / o.requests : 0;
  o.soonWaitP99S = q(soonWaits, 0.99);
  o.soonWaitMaxS = q(soonWaits, 1);
  o.arrivalP50S = q(arrivals, 0.5);
  o.arrivalP95S = q(arrivals, 0.95);
  o.measuredArrivalP50S = q(measuredArrivals, 0.5);
  o.measuredArrivalP95S = q(measuredArrivals, 0.95);
  o.inFlightP50 = q(inFlight, 0.5);
  o.inFlightMax = q(inFlight, 1);
  // 되풀이마다 컨테이너를 닫는다(정리 목록은 실패했을 때를 위해 남긴다)
  await redis.close().catch(() => undefined);
  valkey.stop();
  return o;
}

// AIMD를 켠 짧은 시나리오(ADR-0226): 칸이 실제 Valkey를 왕복해도 증액이 일어나고, 합산 나누기가 자기 목표로 굳지 않는지 본다. 판정이 아니라 회귀 확인이라 장부에 쓰지 않는다
test('[Q-T42] [Q-T67] AIMD를켠짧은시나리오_나눈값이자기목표로굳지않고_증액이실제Valkey를왕복한다', async () => {
  const valkey: ValkeyContainer = await startValkey();
  const redis: HotRedis = await createHotRedis({ url: valkey.url });
  cleanup.push(() => valkey.stop(), () => redis.close().catch(() => undefined));
  const cmd = (key: string, args: string[]) => redis.command(args, { key });
  const now0 = Date.now();
  const startsAt = now0 + 2 * 86_400_000;
  const [a, b] = ['simaimd-a', 'simaimd-b'];
  for (const e of [a, b]) {
    await cmd(keys.cfg(e), ['HSET', keys.cfg(e), 'opensAtMs', String(now0 - 120_000), 'startsAtMs', String(startsAt), 'lobbyShuffle', '1', 'openBatch', '0', 'rev', '1']);
    await cmd(keys.batchDone(e), ['HSET', keys.batchDone(e), 'lobby', '1:0:1', 'pub:lobby', String(now0 - 60_000)]);
    await cmd(keys.events(), ['ZADD', keys.events(), String(startsAt), e]);
    await cmd(keys.seq(e), ['SET', keys.seq(e), '400000']);
  }
  const healthy = (): EventInputs => {
    const at = Math.floor(Date.now() / 5_000) * 5_000;
    const budget = new Map<string, Reading>();
    for (const j of ALL_JOURNEYS) for (const k of ['alert', 'burn50']) budget.set(`${j}:${k}`, { ok: true, value: 0, atMs: at });
    return { latency: { ok: true, value: 0.02, atMs: at }, errors: { ok: true, value: 0, atMs: at }, seatStore: { ok: true, value: 0, atMs: at }, budget, pgCause: false };
  };
  const leader = new AdmissionLeader(new RedisLeaderStore(redis), { run: async () => ({ status: 'NO_SCHEDULE' }) }, { generation: () => 1 }, systemClock, undefined, undefined, { read: async () => ({ forEvent: healthy }) });
  const ctlOf = async (e: string, f: string) => String((await cmd(keys.ctl(e), ['HGET', keys.ctl(e), f])) ?? '');
  leader.start();
  await sleep(4_000);
  const shared = await ctlOf(a, 'targetNow');
  const own = await ctlOf(a, 'aimdTarget');
  await cmd(keys.events(), ['ZREM', keys.events(), b]);
  await sleep(4_000);
  const alone = await ctlOf(a, 'targetNow');
  await sleep(31_000);
  const raised = await ctlOf(a, 'aimdTarget');
  await leader.stop();
  await redis.close().catch(() => undefined);
  valkey.stop();
  console.log(JSON.stringify({ shared, own, alone, raised }));
  expect(shared).toBe('2500');
  expect(own).toBe('5000');
  expect(alone).toBe('5000');
  expect(Number(raised)).toBeGreaterThanOrEqual(5_100);
}, 120_000);

test('[실측] Q-T46 도착 지연을 넣은 입장 제어 루프(10분, 오는 중을 빼는 식과 빼지 않는 식, 공통 난수로 되풀이)', async () => {
  const results: Array<{ seed: number; pass: boolean }> = [];
  for (let rep = 1; rep <= REPS; rep += 1) {
    const startedAt = new Date().toISOString();
    const seed = 46_000 + rep;
    const [n, old] = await Promise.all([runVariant('new', seed), runVariant('old', seed)]);
    const drop = old.admitted ? (old.admitted - n.admitted) / old.admitted : 0;
    const checks = {
      soonRatioUnder1pct: n.soonRatio <= 0.01,
      soonWaitP99Under5s: n.soonWaitP99S === null || n.soonWaitP99S <= 5,
      admittedDropWithin2pct: drop <= 0.02,
      noOverTarget: n.overTargetSamples === 0,
      first6sWithinCap: n.servingAt6s <= 6_000,
    };
    const pass = Object.values(checks).every(Boolean);
    results.push({ seed, pass });
    for (const r of [n, old]) {
      const id = nextRunId(`${SIM_DAY}-qt46-${r.variant}`);
      const errorCount = Object.values(r.errors).reduce((x, y) => x + y, 0);
      const out = { test: 'Q-T46', seed, duration_s: DURATION_S, target: TARGET, no_show: NO_SHOW, stay_mean_s: STAY_MEAN_S, outcome: r, ...(r.variant === 'new' ? { compare: { old_admitted: old.admitted, admitted_drop: drop }, checks, pass } : {}), bench: { requests: r.requests, error_rate: r.requests ? errorCount / r.requests : 0, dropped: 0, p99_ms: r.soonWaitP99S === null ? null : r.soonWaitP99S * 1000 } };
      saveRun(
        id,
        out,
        {
          kpi: 'FR-037',
          duration: DURATION_S,
          scenario: 'services/admission-ctrl/test-sim/admission-loop.sim.test.ts',
          scenarioArgs: `목표 ${TARGET}, 안 오는 사람 ${NO_SHOW * 100}%, 도착 1~3초, 머무는 시간 평균 ${STAY_MEAN_S}초(지수), SOON 뒤 2~3초, 공통 난수 씨앗 ${seed}, ${r.variant === 'new' ? '오는 중 창 W 5초(지금 식)' : 'W 0(오는 중을 빼지 않는 바꾸기 전 식)'}`,
          notes: `Q-T46 ${r.variant === 'new' ? `판정 ${pass ? '통과' : '실패'}(${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ') || '모두 통과'}, 입장 수 감소 ${Math.round(drop * 10000) / 100}%)` : '비교 기준(바꾸기 전 식)'}: 입장 ${r.admitted}, 입장 확정 요청 ${r.requests}, 곧 입장 ${r.soon}(${Math.round(r.soonRatio * 10000) / 100}%), 곧 입장 대기 p99 ${r.soonWaitP99S ?? '-'}초, 목표 초과 표본 ${r.overTargetSamples}(최대 자리 ${r.maxSlots}), 처음 6초 serving ${r.servingAt6s}, Lua가 잰 도착 지연 p50 ${r.measuredArrivalP50S}초·p95 ${r.measuredArrivalP95S}초, 오는 중 추정 p50 ${r.inFlightP50}·최대 ${r.inFlightMax}, 503 뒤 다시 보냄 ${r.unavailable}. 운영 코드(AdmissionLeader·RedisLeaderStore·ConfirmAdmission·RedisAdmissionStore), Valkey 8.1 단일 노드(변형마다 하나), 발생기는 이 PC의 측정 프로세스 하나(두 변형을 동시에). 15분 만료는 10분 실행이라 판정하지 않는다`,
        },
        startedAt,
      );
    }
    console.log(JSON.stringify({ seed, pass, checks, drop, new: n, old }));
  }
  console.log(JSON.stringify({ results }));
  expect(results.length).toBe(REPS);
}, (DURATION_S * REPS + 600) * 1000);
