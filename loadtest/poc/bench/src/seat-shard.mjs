// S-T27 좌석 샤드 하나의 처리량 상한(docs/features/seat-hold.md S-T27·§8 'S-T27 다시 재기', docs/architecture.md §9.4, BUILD_ORDER PRF-135).
// 회차 키를 한 샤드에 몰고(또는 나눠) 운영 홀드 Lua를 정해진 도착률로 넣으며, 같은 때 스냅샷 읽기·만료(두 단계)·릴레이 흉내 XTRIM·
// 틀린 좌석 요청의 재생 읽기를 돌린다. 샤드 Pub/Sub 델타는 운영 홀드·만료 Lua가 안에서 보낸다(예전 PoC는 앱이 따로 보냈다).
// 만료 반복은 운영 ExpirySweeper와 같은 규칙이다(sweep-rules.mjs): 1초 격자, 한 틱에 회차 4개까지 동시에, 20묶음 상한에 닿으면 기다림 없이 다음 틱.
// - Lua 원문: bench/lua/seat-hold.lua·seat-expire.lua·seat-open-sale.lua(loadtest/poc/seat-lua.mjs가 purchase-svc 원문에서 내보낸 사본).
// - KEYS·ARGV: seat-contract.mjs(운영 RedisSeatStore와 같은 규칙, loadtest/test/poc-seat.test.mjs가 견준다). 홀드 TTL만 짧게(큰 회차 5초·중형 3초).
// - 엔진 시간(INFO latencystats): 홀드·만료 Lua는 운영처럼 둘 다 EVALSHA(NOSCRIPT면 EVAL로 다시)라 한 분포에 섞인다. 그래서 끝에 만료 호출 수 nx를 알고
//   EVALSHA 분포의 백분위를 엔진에 물어 홀드 Lua p99를 낸다(engine.*.hold_lua: 판정 값과 아래·위 끝, holdLuaBounds).
//   --expire-call eval이면 만료만 EVAL로 보내 홀드 분포를 따로 본다(예전 방식). 스냅샷은 EVAL_RO, 만료 1단계 ZRANGE·HMGET, 재생 읽기 HMGET,
//   릴레이 XTRIM·XREVRANGE는 각 명령 이름이다(HMGET은 Lua 안의 것과 섞인다. 재생 읽기·만료의 지연은 클라이언트 쪽 칸으로 본다).
// - 오버셀: 좌석마다 토큰·µs 순서로 잡기·놓기를 맞추고(oversell.mjs), 끝에 한 번 좌석마다 비트맵·만료 인덱스와 기록을 견준다.
// 쓰는 법(컨테이너 안): node src/seat-shard.mjs --nodes valkey-1:6379,... --tls true --mode one|five --layout same|spread --duration 600 --warmup 60
//   [--expire on|off] [--expire-batch 100] [--expire-call evalsha|eval] [--replay-ratio 0.1] [--relay-trim-ms 1000] --out /out/x.json
import { createHash, randomUUID } from 'node:crypto';
import { RESP_TYPES } from 'redis';
import { connect, lua } from './clients.mjs';
import { Recorder, hostDelta, hostSample, mixedP99Percentiles, now, openLoop, parseArgs, procCpu, slotOf, writeResult } from './lib.mjs';
import { SeatLog, checkOversell, compareSeats } from './oversell.mjs';
import {
  EXPIRY_BATCH_SIZE,
  EXPIRY_CONCURRENCY,
  EXPIRY_TICK_MS,
  dueHoldCommand,
  dueRangeCommand,
  expireCall,
  holdCall,
  parseDueHold,
  parseDueRange,
  parseExpire,
  parseHold,
  relayTrimCommand,
  replayCommand,
  seatKeys,
  streamTailCommand,
} from './seat-contract.mjs';
import { batchOutcome, isResting, runLanes, runSweepLoop, sweepOrder } from './sweep-rules.mjs';

const a = parseArgs();
const nodes = a.nodes.split(',');
const tls = a.tls === 'true';
const client = a.client ?? 'node-redis';
// 재생 읽기·만료 두 단계·릴레이를 node-redis 클러스터 명령(sendCommand)으로 보낸다. 운영 HotRedis도 node-redis다(packages/platform/src/redis.ts)
if (client !== 'node-redis') throw new Error(`seat-shard.mjs는 node-redis만 쓴다: ${client}`);
const durationS = Number(a.duration ?? 600);
const warmupS = Number(a.warmup ?? 60);
const mode = a.mode ?? 'one';
const layout = a.layout ?? 'same';
const expireOn = (a.expire ?? 'on') === 'on';
const expireBatch = Number(a['expire-batch'] ?? EXPIRY_BATCH_SIZE);
/** 만료 Lua를 부르는 법: evalsha(운영 HotRedis.evalScript와 같다, NOSCRIPT면 EVAL) 또는 eval(늘 EVAL) */
const expireCallMode = a['expire-call'] ?? 'evalsha';
if (expireCallMode !== 'evalsha' && expireCallMode !== 'eval') throw new Error(`--expire-call은 evalsha 또는 eval이다: ${expireCallMode}`);
/** 틀린 좌석 요청의 재생 읽기를 홀드 도착률의 이 비율로 섞는다(10% [가정], PRF-130 리뷰 낮음 2). 0이면 끈다 */
const replayRatio = Number(a['replay-ratio'] ?? 0.1);
/** 릴레이 흉내 XTRIM MINID 주기(1초 [가정]). 0이면 끈다(운영 Lua에는 XADD MAXLEN이 없어 끄면 Stream이 끝없이 쌓인다) */
const relayTrimMs = Number(a['relay-trim-ms'] ?? 1000);
/** 1인 한도(회차 설정의 최대 4매, seat-hold §3) */
const HOLD_LIMIT = 4;
const SECTIONS = 20;
const ACCOUNTS = 100_000;

// ---- Lua 원문(내보낸 사본) ----
const readLua = (name) => {
  try {
    return lua(name);
  } catch {
    throw new Error(`bench/lua/${name}.lua가 없다: node loadtest/poc/seat-lua.mjs로 내보낸 뒤 측정 이미지를 다시 만든다`);
  }
};
const LUA = { hold: readLua('seat-hold'), openSale: readLua('seat-open-sale'), expire: readLua('seat-expire'), snapshot: readLua('snapshot') };
if (!LUA.hold || !LUA.openSale) throw new Error('운영 홀드·판매 열기 Lua가 빈 글이다');
if (expireOn && !LUA.expire) throw new Error('운영 만료 Lua(seat-expire.lua)가 아직 빈 글이다. 만료 없이 홀드 경로만 보려면 --expire off');
const sha1 = (t) => createHash('sha1').update(t, 'utf8').digest('hex');
const SHA = { hold: sha1(LUA.hold), expire: LUA.expire ? sha1(LUA.expire) : null };
const scriptOf = (sha) => (sha === SHA.hold ? 'hold' : sha === SHA.expire ? 'expire' : null);
/** 문자열을 Buffer로 받는 명령 옵션(비트맵 GET, packages/platform/src/redis.ts와 같다) */
const BINARY = { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } };

const c = await connect(client, { nodes, tls, scripts: ['seat-hold'], timeoutMs: Number(a.timeout ?? 100) });
const admin = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
const cluster = admin.raw;

// ---- 주 노드와 슬롯 ----
const masters = cluster.masters.map((m) => ({ id: m.id, addr: `${m.host}:${m.port}` }));
const slotOwner = (slot) => {
  const s = cluster.slots[slot];
  return s.master.host + ':' + s.master.port;
};
/** 그 주 노드에 놓이는 회차 ID를 고른다(KEY_PART 모양). 큰 회차 배치 규칙(ADR-0176 결정 3)의 태그 고르기와 같은 효과다 */
const pickId = (prefix, wantOwner, used) => {
  for (let i = 0; i < 1_000_000; i += 1) {
    const id = `${prefix}${i}`;
    if (used.has(id)) continue;
    if (slotOwner(slotOf(seatKeys.bitmap(id))) === wantOwner) {
      used.add(id);
      return id;
    }
  }
  throw new Error('회차 ID를 고르지 못했다');
};

/** 좌석맵 판 흉내: 색인 → 좌석(구역 20개를 고르게, 좌석 ID는 0을 채워 색인 차례 = 좌석 ID 차례) */
function seatModel(seats) {
  const per = Math.ceil(seats / SECTIONS);
  const cache = new Array(seats);
  return (index) => {
    let s = cache[index];
    if (!s) {
      const sectionIndex = Math.floor(index / per);
      s = cache[index] = { seatId: `S${String(index).padStart(6, '0')}`, index, sectionId: `SEC${String(sectionIndex).padStart(2, '0')}`, sectionIndex, seatOffset: index - sectionIndex * per, tierId: `T${sectionIndex % 4}` };
    }
    return s;
  };
}

const used = new Set();
const A = masters[0].addr;
const B = masters[1 % masters.length].addr;
const C = masters[2 % masters.length].addr;
const plan =
  mode === 'one'
    ? [{ seats: 50_000, holds: 2_000, snaps: 1_000, owner: A, ttlMs: 5_000 }]
    : [
        { seats: 50_000, holds: 2_000, snaps: 1_000, owner: A, ttlMs: 5_000 },
        ...[0, 1, 2, 3].map((i) => ({ seats: 15_000, holds: 1_000, snaps: 500, owner: layout === 'same' ? A : i < 2 ? B : C, ttlMs: 3_000 })),
      ];
const events = plan.map((p, i) => {
  const tag = pickId(`st27e${i}x`, p.owner, used);
  return {
    ...p,
    tag,
    slot: slotOf(seatKeys.bitmap(tag)),
    seatAt: seatModel(p.seats),
    log: new SeatLog(),
    outcomes: {},
    // 위 칸들은 예전부터 있던 뜻 그대로다. 아래 넷(immediate_ticks·cap_ticks·max_concurrent·backoff_skips)은 운영 반복 규칙을 따르게 하며 더했다(sweep-rules.mjs):
    // immediate_ticks 앞 틱의 상한 때문에 기다림 없이 이어 돈 틱 가운데 이 회차를 돈 수, cap_ticks 이 회차가 20묶음 상한에 닿은 틱 수(tick_cap과 같은 수),
    // max_concurrent 이 회차를 도는 동안 함께 돈 회차 수의 최댓값(자기 포함), backoff_skips 오류 뒤 5초 쉬느라 건너뛴 틱 수
    expire: { ticks: 0, calls: 0, released: 0, skipped: 0, orphans: 0, not_ready: 0, full_batches: 0, no_progress: 0, tick_cap: 0, errors: 0, error_kinds: {}, evalsha_measured: 0, evalsha_measured_small: 0, noscript: 0, immediate_ticks: 0, cap_ticks: 0, max_concurrent: 0, backoff_skips: 0 },
    failedAtMs: undefined,
    expireRec: new Recorder(),
    relay: { trims: 0, trimmed: 0, errors: 0, lastId: null },
  };
});

const nodeClient = (addr) => cluster.nodeClient(cluster.masters.find((m) => `${m.host}:${m.port}` === addr));
const onNode = async (addr, args) => (await nodeClient(addr)).sendCommand(args);
const send = (key, readonly, args) => cluster.sendCommand(key, readonly, args);

// ---- 준비: 키 지우기, 운영 판매 열기 Lua로 비트맵·세대 키, 정지 사본 ----
// keepUntil = 판매 종료 + 1일 대신 측정 시작 + 1일(홀드·만료 Lua ARGV의 키 만료 시각)
const keepUntilMs = Date.now() + 24 * 3600_000;
for (const m of masters) await onNode(m.addr, ['FLUSHALL']);
for (const e of events) {
  await send(seatKeys.ctlEvents(), false, ['SADD', seatKeys.ctlEvents(), e.tag]);
  const r = await send(seatKeys.bitmap(e.tag), false, ['EVAL', LUA.openSale, '2', seatKeys.bitmap(e.tag), seatKeys.epoch(e.tag), String(e.seats), String(keepUntilMs)]);
  e.seatEpoch = String(r[1]);
  await send(seatKeys.ctl(e.tag), false, ['HSET', seatKeys.ctl(e.tag), 'paused', '0', 'allPaused', '0', 'suspended', '0']);
}

// ---- 부하 ----
/** 홀드 지문(domain/hold.ts holdFingerprint): 좌석 ID 오름차순을 LF로 이은 SHA-256 hex. 좌석은 이미 좌석 ID 차례다 */
const fingerprintOf = (seats) => createHash('sha256').update(seats.map((s) => s.seatId).join('\n'), 'utf8').digest('hex');
const holdOp = (e) => async () => {
  const n = 1 + Math.floor(Math.random() * 4);
  const hot = Math.random() < 0.5;
  const range = hot ? Math.floor(e.seats * 0.1) : e.seats;
  const start = Math.min(e.seats - n, Math.floor(Math.random() * range));
  const seats = Array.from({ length: n }, (_, k) => e.seatAt(start + k));
  const acct = Math.floor(Math.random() * ACCOUNTS);
  const call = holdCall({
    eventId: e.tag,
    accountId: `a${acct}`,
    purchaseSessionId: `ps${acct}`,
    holdId: randomUUID(),
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf(seats),
    seats,
    limit: HOLD_LIMIT,
    keepUntilMs,
    ttlMs: e.ttlMs,
  });
  const r = parseHold(await c.run('seat-hold', call.keys, call.args));
  e.outcomes[r.kind] = (e.outcomes[r.kind] ?? 0) + 1;
  if (r.kind === 'OK') for (const s of seats) e.log.hold(r.fencingToken, s.index);
};
// 틀린 좌석 요청(422 invalid-seat 앞)의 재생 읽기: 새 멱등 키라 기록이 없다(RedisSeatStore.replay, seat-hold §3 '재생이 앱 쪽 거절보다 먼저다')
const replayOp = (e) => () => {
  const q = replayCommand(e.tag, `a${Math.floor(Math.random() * ACCOUNTS)}`, randomUUID());
  return c.raw.sendCommand(q.key, true, q.args);
};
const snapOp = (e) => () => send(seatKeys.bitmap(e.tag), true, ['EVAL_RO', LUA.snapshot, '3', seatKeys.epoch(e.tag), seatKeys.bitmap(e.tag), seatKeys.secver(e.tag)]);

// 구독: 회차마다 한 연결이 구역 채널 전부를 듣는다(realtime-gw 하나의 몫)
const received = { count: 0 };
const subs = [];
for (const e of events) {
  const sub = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
  for (let i = 0; i < SECTIONS; i += 1) await sub.ssubscribe(seatKeys.section(e.tag, String(i)), () => (received.count += 1));
  subs.push(sub);
}

/** 예열이 끝나 엔진 통계를 비우기 직전부터 참(만료 EVALSHA 수를 엔진 통계와 같은 창으로 센다. 경계에서 몇 번 더 세면 위 끝이 조금 커질 뿐이다) */
let measuring = false;
/** 좌석이 이만큼 이하인 만료 호출은 홀드 Lua p99보다 빠를 수 있다고 본다(holdLuaBounds의 판정 값, 20석 [가정]) */
const SMALL_EXPIRE_SEATS = 20;
/** 만료 Lua 한 번(좌석 seatCount석): 운영(HotRedis.evalScript)처럼 EVALSHA, 서버에 없으면(NOSCRIPT) EVAL로 다시 보낸다. --expire-call eval이면 늘 EVAL */
async function evalExpire(e, keys, args, seatCount) {
  const t = now();
  const head = [String(keys.length), ...keys, ...args];
  let r;
  if (expireCallMode === 'eval') r = await send(keys[0], false, ['EVAL', LUA.expire, ...head]);
  else {
    if (measuring) {
      e.expire.evalsha_measured += 1;
      if (seatCount <= SMALL_EXPIRE_SEATS) e.expire.evalsha_measured_small += 1;
    }
    try {
      r = await send(keys[0], false, ['EVALSHA', SHA.expire, ...head]);
    } catch (err) {
      if (!String(err?.message ?? err).includes('NOSCRIPT')) throw err;
      e.expire.noscript += 1;
      r = await send(keys[0], false, ['EVAL', LUA.expire, ...head]);
    }
  }
  if (measuring) e.expireRec.add(now() - t);
  return r;
}
const errKind = (err) => (err && (err.name + ': ' + String(err.message).slice(0, 80))) || String(err);
let running = true;
const repeatEvery = (ms, work) =>
  (async () => {
    while (running) {
      const t = now();
      await work();
      const left = ms - (now() - t) / 1e6;
      if (left > 0 && running) await new Promise((res) => setTimeout(res, left));
    }
  })();

// 만료 반복: 운영 application/expiry-sweeper.ts ExpirySweeper와 같은 규칙이다(규칙은 sweep-rules.mjs, 값은 seat-contract.mjs).
// - 반복 한 번은 틱의 이어짐이다. 한 틱은 회차를 문자 코드 순으로 EXPIRY_CONCURRENCY(4)개까지 동시에 돌고, 회차 하나는 20묶음까지 돈다.
//   한 묶음은 ① ZRANGE … LIMIT 0 100 ② 좌석마다 HMGET ③ 좌석맵 판(seatAt) ④ 만료 Lua다(seat-hold §5 '두 단계로 나눈다').
// - 어떤 회차든 20묶음 상한(BATCH_LIMIT)에 닿으면 기다리지 않고 다음 틱을 바로 연다. 다 풀렸거나(DRAINED) 푼 것·고아가 0이면(NO_PROGRESS)
//   다음 1초 격자까지 기다린다. 오류가 난 회차는 5초 쉰다(BACKOFF).
// - 운영과 달리 회차 목록 읽기(SMEMBERS s:ctl:events)와 회차별 임대는 부르지 않는다(이 측정은 파드 하나이고 회차가 정해져 있다).
const sweepIds = sweepOrder(events.map((e) => e.tag));
const eventOf = new Map(events.map((e) => [e.tag, e]));
const sweeping = new Set();
const sweepPeak = { max_concurrent: 0 };

/** 회차 하나의 한 틱(운영 #sweepEvent, 던지지 않는다). 결과는 운영 SweepOutcome 글이다 */
async function sweepEvent(e, immediate) {
  const x = e.expire;
  if (isResting(e.failedAtMs, Date.now())) {
    x.backoff_skips += 1;
    return 'BACKOFF';
  }
  x.ticks += 1;
  if (immediate) x.immediate_ticks += 1;
  sweeping.add(e);
  sweepPeak.max_concurrent = Math.max(sweepPeak.max_concurrent, sweeping.size);
  for (const s of sweeping) s.expire.max_concurrent = Math.max(s.expire.max_concurrent, sweeping.size);
  try {
    const outcome = await expireTick(e);
    e.failedAtMs = undefined;
    if (outcome === 'BATCH_LIMIT') {
      x.tick_cap += 1;
      x.cap_ticks += 1;
    }
    return outcome;
  } catch (err) {
    x.errors += 1;
    const k = errKind(err);
    x.error_kinds[k] = (x.error_kinds[k] ?? 0) + 1;
    e.failedAtMs = Date.now();
    return 'ERROR';
  } finally {
    sweeping.delete(e);
  }
}

/** 회차 하나의 묶음 되풀이(최대 20묶음). 돌려주는 글: DRAINED·NO_PROGRESS·BATCH_LIMIT·NOT_READY */
async function expireTick(e) {
  let batches = 0;
  for (;;) {
    const rq = dueRangeCommand(e.tag, Date.now(), expireBatch);
    const due = parseDueRange(await send(rq.key, true, rq.args));
    if (due.length === 0) return batchOutcome({ dueCount: 0, batches });
    const hashes = await Promise.all(due.map((d) => {
      const q = dueHoldCommand(e.tag, d.index);
      return send(q.key, true, q.args);
    }));
    const seats = due.map((d, k) => ({ index: d.index, expected: parseDueHold(hashes[k], d.index), seat: e.seatAt(d.index) }));
    const x = expireCall({ eventId: e.tag, keepUntilMs, seats });
    const r = parseExpire(await evalExpire(e, x.keys, x.args, seats.length));
    batches += 1;
    e.expire.calls += 1;
    if (r.kind === 'NOT_READY') {
      e.expire.not_ready += 1;
      return 'NOT_READY';
    }
    const asked = new Set(due.map((d) => d.index));
    for (const h of r.expired) {
      if (!asked.has(h.index)) throw new Error(`만료 Lua가 넘기지 않은 좌석 색인을 돌려줬다: ${h.index}`);
      e.log.release(r.nowUs, h.index, h.fencingToken);
    }
    e.expire.released += r.released;
    e.expire.skipped += r.skipped;
    e.expire.orphans += r.orphans;
    // 예전 칸의 뜻 그대로: 꽉 찬 묶음 수, 그 가운데 푼 것·고아가 0이었던 수
    if (due.length >= expireBatch) {
      e.expire.full_batches += 1;
      if (r.released + r.orphans === 0) e.expire.no_progress += 1;
    }
    const step = batchOutcome({ dueCount: due.length, released: r.released, orphans: r.orphans, batches, batchSize: expireBatch });
    if (step !== 'CONTINUE') return step;
  }
}

const sweepStats = { ticks: 0, capTicks: 0, immediateTicks: 0 };
const sweepOrigin = now();
const expiry = expireOn
  ? runSweepLoop({
      tick: (immediate) => runLanes(sweepIds, EXPIRY_CONCURRENCY, (id) => sweepEvent(eventOf.get(id), immediate)),
      elapsedMs: () => (now() - sweepOrigin) / 1e6,
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      running: () => running,
      tickMs: EXPIRY_TICK_MS,
    }).then((s) => Object.assign(sweepStats, s))
  : Promise.resolve();

// 릴레이 흉내(docs/data.md §3 stream): 앞 틱에 본 마지막 항목까지 Kafka로 보냈다고 보고 그보다 앞을 XTRIM MINID로 지운다. Stream 읽기(XREAD) 부하는 넣지 않는다(PRF-140)
const relay = relayTrimMs > 0
  ? repeatEvery(relayTrimMs, async () => {
      for (const e of events) {
        try {
          if (e.relay.lastId) {
            const q = relayTrimCommand(e.tag, e.relay.lastId);
            e.relay.trimmed += Number(await send(q.key, false, q.args));
            e.relay.trims += 1;
          }
          const t = streamTailCommand(e.tag);
          const tail = await send(t.key, true, t.args);
          if (Array.isArray(tail) && tail.length > 0) e.relay.lastId = String(tail[0][0]);
        } catch {
          e.relay.errors += 1;
        }
      }
    })
  : Promise.resolve();

// 예열이 끝나면 엔진 통계를 비운다(명령별 지연·SLOWLOG). CPU는 차이로 잰다
const targets = [...new Set(events.map((e) => e.owner))];
const cpuOf = async (addr) => {
  const info = String(await onNode(addr, ['INFO', 'cpu']));
  const g = (n) => Number(new RegExp(`${n}:([0-9.]+)`).exec(info)?.[1] ?? NaN);
  return { main: g('used_cpu_user_main_thread') + g('used_cpu_sys_main_thread'), all: g('used_cpu_user') + g('used_cpu_sys') };
};
let cpu0;
let tReset;
let host0;
setTimeout(async () => {
  measuring = true;
  for (const m of masters) {
    await onNode(m.addr, ['CONFIG', 'RESETSTAT']);
    await onNode(m.addr, ['SLOWLOG', 'RESET']);
  }
  cpu0 = Object.fromEntries(await Promise.all(targets.map(async (t) => [t, await cpuOf(t)])));
  tReset = now();
  host0 = hostSample();
}, warmupS * 1000);

const gen = procCpu();
const total = warmupS + durationS;
const runs = await Promise.all(
  events.flatMap((e) => [
    openLoop({ rate: e.holds, durationS: total, warmupS, maxInflight: 5_000, op: holdOp(e) }).then((r) => ({ e, kind: 'hold', r })),
    openLoop({ rate: e.snaps, durationS: total, warmupS, maxInflight: 5_000, op: snapOp(e) }).then((r) => ({ e, kind: 'snapshot', r })),
    ...(replayRatio > 0 ? [openLoop({ rate: e.holds * replayRatio, durationS: total, warmupS, maxInflight: 5_000, op: replayOp(e) }).then((r) => ({ e, kind: 'replay', r }))] : []),
  ]),
);
const tEnd = now();
const host1 = hostSample();
running = false;
await expiry;
await relay;
const genCpu = gen();

// ---- 엔진 통계 ----
const engine = {};
for (const t of targets) {
  const lat = String(await onNode(t, ['INFO', 'latencystats']));
  const cmd = String(await onNode(t, ['INFO', 'commandstats']));
  const cpu1 = await cpuOf(t);
  const wall = (tEnd - tReset) / 1e9;
  const pick = (name) => {
    const m = new RegExp(`latency_percentiles_usec_${name}:p50=([0-9.]+),p99=([0-9.]+),p99\\.9=([0-9.]+)`).exec(lat);
    return m ? { p50_us: Number(m[1]), p99_us: Number(m[2]), p999_us: Number(m[3]) } : null;
  };
  const calls = (name) => {
    const m = new RegExp(`cmdstat_${name}:calls=(\\d+),usec=(\\d+),usec_per_call=([0-9.]+)`).exec(cmd);
    return m ? { calls: Number(m[1]), usec_per_call: Number(m[3]) } : null;
  };
  const stat = (name) => ({ ...pick(name), ...calls(name) });
  const evalsha = stat('evalsha');
  const mine = events.filter((e) => e.owner === t);
  const holdLua = await holdLuaBounds(t, evalsha.calls ?? 0, mine.reduce((s, e) => s + e.expire.evalsha_measured, 0), mine.reduce((s, e) => s + e.expire.evalsha_measured_small, 0));
  // SLOWLOG 0 확인(기록 기준 10ms, stack.mjs): 예열 뒤 비운 SLOWLOG가 끝에 비었는지. 어느 Lua인지는 EVALSHA의 sha로 가린다
  const slowlogLen = Number(await onNode(t, ['SLOWLOG', 'LEN']));
  const slow = slowlogLen > 0 ? await onNode(t, ['SLOWLOG', 'GET', '10']) : [];
  engine[t] = {
    events: events.filter((e) => e.owner === t).map((e) => e.tag),
    // evalsha: 홀드 Lua와(--expire-call evalsha면) 만료 Lua가 섞인 분포. 홀드만의 p99는 hold_lua
    evalsha,
    hold_lua: holdLua,
    eval: stat('eval'),
    eval_ro_snapshot: stat('eval_ro'),
    // 아래는 Lua 안에서 부른 것도 함께 센다(hmget: 홀드 Lua 안·만료 1단계·재생 읽기, spublish: 홀드·만료 Lua 안)
    hmget: stat('hmget'),
    zrange_due: stat('zrange'),
    xtrim_relay: stat('xtrim'),
    xrevrange_relay: stat('xrevrange'),
    spublish: stat('spublish'),
    main_thread_cpu_pct: Math.round(((cpu1.main - cpu0[t].main) / wall) * 1000) / 10,
    process_cpu_pct: Math.round(((cpu1.all - cpu0[t].all) / wall) * 1000) / 10,
    slowlog_len: slowlogLen,
    slowlog_sample: slow.slice(0, 5).map((x) => ({ id: x[0], usec: x[2], cmd: String(x[3]?.[0] ?? ''), script: scriptOf(String(x[3]?.[1] ?? '')), args: (x[3] ?? []).slice(1, 3).map((v) => String(v).slice(0, 40)) })),
  };
}

/**
 * 홀드 Lua만의 엔진 p99 v를 EVALSHA 분포(홀드 nh번 + 만료 nx번 = nAll번)에서 낸다. 섞인 분포에서 v 이하의 몫은
 * (0.99·nh + f·nx)/nAll이다(f = 만료 호출 가운데 v보다 빠른 몫). 그래서 f를 가정해 그 백분위를 엔진에 묻는다.
 * - p99_us_lo: f = 0(만료가 모두 v보다 느리다). 아래 끝
 * - p99_us: 좌석 SMALL_EXPIRE_SEATS석 이하의 만료 호출(nxSmall번)만 v보다 빠를 수 있다고 본다(그보다 많은 좌석을 푸는 만료 Lua는 홀드 Lua p99보다 느리다 [가정]). 판정에 쓴다
 * - p99_us_hi: f = 1(만료가 모두 v보다 빠르다). 가정 없는 위 끝
 * latency-tracking-info-percentiles로 그 백분위들을 엔진에 묻고 기본값(50 99 99.9)으로 되돌린다. nx = 0이면 셋 다 p99다
 */
async function holdLuaBounds(addr, nAll, nx, nxSmall) {
  if (nAll <= 0) return null;
  // 경계에서 엔진과 도구가 센 수가 조금 어긋날 수 있어 범위 안으로 자른다
  const x = Math.min(nx, nAll);
  const nh = nAll - x;
  const { lo, est, hi } = mixedP99Percentiles(nAll, x, Math.min(nxSmall, x));
  await onNode(addr, ['CONFIG', 'SET', 'latency-tracking-info-percentiles', [...new Set([lo, est, hi])].join(' ')]);
  const info = String(await onNode(addr, ['INFO', 'latencystats']));
  await onNode(addr, ['CONFIG', 'SET', 'latency-tracking-info-percentiles', '50 99 99.9']);
  const line = /latency_percentiles_usec_evalsha:([^\r\n]*)/.exec(info)?.[1] ?? '';
  const vals = line.split(',').map((kv) => /^p([0-9.]+)=([0-9.]+)$/.exec(kv)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
  const at = (p) => vals.find(([x]) => Math.abs(x - p) < 1e-6)?.[1] ?? null;
  return { evalsha_calls: nAll, expire_calls: nx, expire_calls_small: nxSmall, hold_calls: nh, q_lo: lo, q: est, q_hi: hi, p99_us_lo: at(lo), p99_us: at(est), p99_us_hi: at(hi) };
}

// ---- 오버셀 확인: 좌석마다 토큰·µs 순서로 잡기·놓기가 번갈아 오는지(oversell.mjs), 그리고 끝에 한 번 좌석마다 비트맵·만료 인덱스와 기록 ----
const invariants = [];
for (const e of events) {
  const held = new Float64Array(e.seats);
  const o = checkOversell(e.log, e.seats, held);
  const bitmap = await cluster.sendCommand(seatKeys.bitmap(e.tag), true, ['GET', seatKeys.bitmap(e.tag)], BINARY);
  const members = (await send(seatKeys.expiry(e.tag), true, ['ZRANGE', seatKeys.expiry(e.tag), '0', '-1'])).map((m) => Number(String(m)));
  const seatsCmp = compareSeats(held, bitmap ?? Buffer.alloc(0), members);
  const bits = Number(await cluster.bitCount(seatKeys.bitmap(e.tag)));
  const zcard = members.length;
  e.streamLen = Number(await send(seatKeys.stream(e.tag), true, ['XLEN', seatKeys.stream(e.tag)]));
  // 홀드·만료가 오류(시간 초과 등)로 끝나면 서버에서는 실행됐을 수 있어 기록에 빠진다. 그때 오버셀 검사는 판정할 수 없다(예열 동안의 오류도 센다)
  const holdErrors = runs.filter((x) => x.e === e && x.kind === 'hold').reduce((n, x) => n + Object.values(x.r.error_kinds).reduce((s, v) => s + v, 0), 0);
  const expireErrors = e.expire.errors;
  invariants.push({
    event: e.tag,
    ...o,
    bitcount: bits,
    expiry_zcard: zcard,
    bit_equals_index: bits === zcard,
    log_equals_bits: o.held_at_end === bits,
    // 좌석마다(총수가 같아도 서로 다른 좌석이 어긋나면 잡는다): 놓기 기록 없이 꺼진 비트(log_without_bit) 등
    seats: seatsCmp,
    seats_match: seatsCmp.bit_without_log + seatsCmp.log_without_bit + seatsCmp.index_without_log + seatsCmp.log_without_index === 0,
    hold_errors: holdErrors,
    expire_errors: expireErrors,
    verifiable: holdErrors === 0 && expireErrors === 0,
  });
}

const result = {
  test: 'S-T27',
  lua: {
    source: 'services/purchase-svc/src/modules/inventory/adapters/hold-lua.ts·expire-lua.ts(loadtest/poc/seat-lua.mjs가 내보냄)',
    hold_sha1: sha1(LUA.hold),
    open_sale_sha1: sha1(LUA.openSale),
    expire_sha1: LUA.expire ? sha1(LUA.expire) : null,
  },
  client,
  tls,
  mode,
  layout,
  expire: expireOn,
  expire_batch: expireBatch,
  expire_call: expireCallMode,
  replay_ratio: replayRatio,
  relay_trim_ms: relayTrimMs,
  // 만료 반복 요약(운영 ExpirySweeper와 같은 규칙, 위 '만료 반복' 주석). 모두 예열을 포함한 전체 시간의 수다. 만료를 끄면 null
  // ticks 돈 틱 수(틱 하나 = 회차 전체를 한 번 도는 것), cap_ticks 어떤 회차든 20묶음 상한에 닿은 틱 수, immediate_ticks 그 상한 때문에 기다림 없이 이어 돈 틱 수,
  // max_concurrent 동시에 돈 회차 수의 최댓값(회차별 값은 events[].expire.max_concurrent), event_ticks 회차별 틱의 합, released 푼 좌석 수, expire_calls 만료 Lua 호출 수
  sweep: expireOn
    ? {
        concurrency: EXPIRY_CONCURRENCY,
        tick_ms: EXPIRY_TICK_MS,
        ticks: sweepStats.ticks,
        cap_ticks: sweepStats.capTicks,
        immediate_ticks: sweepStats.immediateTicks,
        max_concurrent: sweepPeak.max_concurrent,
        event_ticks: events.reduce((s, e) => s + e.expire.ticks, 0),
        released: events.reduce((s, e) => s + e.expire.released, 0),
        expire_calls: events.reduce((s, e) => s + e.expire.calls, 0),
      }
    : null,
  duration_s: durationS,
  warmup_s: warmupS,
  events: events.map((e) => ({ tag: e.tag, slot: e.slot, owner: e.owner, seats: e.seats, hold_rate: e.holds, snapshot_rate: e.snaps, replay_rate: e.holds * replayRatio, ttl_ms: e.ttlMs, seat_epoch: e.seatEpoch, outcomes: e.outcomes, expire: { ...e.expire, latency_client: e.expireRec.summary() }, relay: { trims: e.relay.trims, trimmed: e.relay.trimmed, errors: e.relay.errors }, stream_len_end: e.streamLen })),
  load: runs.map(({ e, kind, r }) => ({ event: e.tag, kind, ...r })),
  engine,
  pubsub_received: received.count,
  invariants,
  generator_cpu_pct: genCpu,
  host: hostDelta(host0, host1),
};
// 장부 요약 칸: 홀드 p99(클라이언트가 잰 왕복, 보내기로 한 시각부터)·오류율·요청 수
const holds = runs.filter((x) => x.kind === 'hold');
result.bench = {
  p99_ms: Math.max(...holds.map((x) => x.r.latency.p99_ms ?? 0)),
  error_rate: holds.reduce((s, x) => s + x.r.errors, 0) / Math.max(1, holds.reduce((s, x) => s + x.r.measured, 0)),
  requests: holds.reduce((s, x) => s + x.r.measured, 0),
  dropped: runs.reduce((s, x) => s + x.r.dropped, 0),
};
// 판정 칸(seat-hold §12 S-T27 기준): 홀드 Lua p99 0.1ms 이하 [가정], SLOWLOG 0, 샤드 엔진 CPU 50% 이하 [가정], 홀드 p99 50ms 이하, 오버셀 0(판정 가능할 때)
const engines = Object.values(engine);
const judge = {
  // 홀드 Lua p99: EVALSHA 분포에서 낸 판정 값(작은 만료 호출만 빠를 수 있다고 봄)과 아래·위 끝(holdLuaBounds)
  hold_lua_p99_us: Math.max(...engines.map((x) => x.hold_lua?.p99_us ?? Infinity)),
  hold_lua_p99_us_lo: Math.max(...engines.map((x) => x.hold_lua?.p99_us_lo ?? Infinity)),
  hold_lua_p99_us_hi: Math.max(...engines.map((x) => x.hold_lua?.p99_us_hi ?? Infinity)),
  slowlog_total: engines.reduce((s, x) => s + x.slowlog_len, 0),
  shard_cpu_max_pct: Math.max(...engines.map((x) => x.main_thread_cpu_pct)),
  hold_p99_ms: result.bench.p99_ms,
  oversell: invariants.reduce((s, i) => s + i.oversell, 0),
  unknown_release: invariants.reduce((s, i) => s + i.unknown_release, 0),
  verifiable: invariants.every((i) => i.verifiable),
  dropped: result.bench.dropped,
};
judge.pass = {
  hold_lua_p99: judge.hold_lua_p99_us <= 100,
  slowlog_zero: judge.slowlog_total === 0,
  shard_cpu: judge.shard_cpu_max_pct <= 50,
  hold_p99: judge.hold_p99_ms <= 50,
  oversell_zero: judge.verifiable && judge.oversell === 0 && judge.unknown_release === 0 && invariants.every((i) => i.bit_equals_index && i.log_equals_bits && i.seats_match),
  no_dropped: judge.dropped === 0,
};
result.judge = judge;
writeResult(a.out, result);
for (const s of subs) await s.close();
await c.close();
await admin.close();
process.exit(0);
