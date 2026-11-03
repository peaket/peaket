// S-T27 좌석 샤드 하나의 처리량 상한(docs/features/seat-hold.md S-T27, docs/architecture.md §9.4).
// 회차 키를 한 샤드에 몰고(또는 나눠) 홀드 Lua를 정해진 도착률로 넣으며, 같은 때 스냅샷 읽기·1초 만료 작업·샤드 Pub/Sub 발행을 돌린다.
// 홀드 Lua 실행 시간은 엔진이 잰 명령별 지연(latency-tracking, INFO latencystats)으로 본다. 그래서 홀드만 EVALSHA(클라이언트의
// 스크립트 도구)로 보내고, 스냅샷은 EVAL_RO, 만료는 EVAL로 보내 명령 이름을 나눈다.
// 쓰는 법(컨테이너 안): node src/seat-shard.mjs --nodes valkey-1:6379,... --tls true --mode one|five --layout same|spread --duration 600 --warmup 60 --out /out/x.json
import { createHash, randomUUID } from 'node:crypto';
import { connect, lua } from './clients.mjs';
import { Recorder, hostDelta, hostSample, now, openLoop, parseArgs, procCpu, slotOf, writeResult } from './lib.mjs';

/**
 * 늘어나는 Int32 배열. 오버셀 검사 기록을 좌석마다 자바스크립트 배열로 쌓으면 수백만 개가 되어 GC가 길게 멈추고(2026-11-01 다섯 회차
 * 측정에서 모든 요청이 2초까지 늦었다) 그 멈춤이 측정값에 섞인다. 그래서 숫자만 이어 붙인다
 */
class GrowI32 {
  buf = new Int32Array(1 << 20);
  n = 0;
  push(...xs) {
    if (this.n + xs.length > this.buf.length) {
      const b = new Int32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    for (const x of xs) this.buf[this.n++] = x;
  }
}

const a = parseArgs();
const nodes = a.nodes.split(',');
const tls = a.tls === 'true';
const client = a.client ?? 'node-redis';
const durationS = Number(a.duration ?? 600);
const warmupS = Number(a.warmup ?? 60);
const mode = a.mode ?? 'one';
const layout = a.layout ?? 'same';
// 만료 작업이 Lua 한 번에 푸는 좌석 수 [가정](seat-hold §5의 LIMIT n). 500이면 한 번에 평균 2.3ms·가장 길게 10.9ms가 걸려 SLOWLOG에 남았다(2026-11-01)
const RELEASE_BATCH = String(Number(a['release-batch'] ?? 500));

const c = await connect(client, { nodes, tls, scripts: ['hold'], timeoutMs: Number(a.timeout ?? 100) });
const admin = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
const cluster = admin.raw;

// ---- 주 노드와 슬롯 ----
const masters = cluster.masters.map((m) => ({ id: m.id, addr: `${m.host}:${m.port}` }));
const slotOwner = (slot) => {
  const s = cluster.slots[slot];
  return s.master.host + ':' + s.master.port;
};
const pickTag = (prefix, wantOwner, used) => {
  for (let i = 0; i < 1_000_000; i += 1) {
    const tag = `${prefix}${i}`;
    if (used.has(tag)) continue;
    if (slotOwner(slotOf(`{event:${tag}}`)) === wantOwner) {
      used.add(tag);
      return tag;
    }
  }
  throw new Error('회차 ID를 고르지 못했다');
};
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
  const tag = pickTag(`st27e${i}x`, p.owner, used);
  const k = (s) => `s:{event:${tag}}:${s}`;
  return {
    ...p,
    tag,
    slot: slotOf(k('bitmap')),
    keys: { epoch: k('epoch'), ctl: k('ctl'), bitmap: k('bitmap'), expiry: k('expiry'), stream: k('stream'), fence: k('fence'), secver: k('secver') },
    holdKey: (seat) => k(`hold:${seat}`),
    quotaKey: (acct) => k(`quota:${acct}`),
    idemKey: (acct, key) => k(`idem:${acct}:${key}`),
    holdPrefix: k('hold:'),
    quotaPrefix: k('quota:'),
    // holds: (펜싱, 좌석) 짝, releases: (좌석, 순번, 놓은 홀드의 펜싱 또는 -1) 셋
    log: { holds: new GrowI32(), releases: new GrowI32() },
    rec: new Recorder(),
    snapRec: new Recorder(),
    outcomes: {},
  };
});

const nodeClient = (addr) => cluster.nodeClient(cluster.masters.find((m) => `${m.host}:${m.port}` === addr));
const onNode = async (addr, args) => (await nodeClient(addr)).sendCommand(args);

// ---- 준비: 키 지우기, 세대·정지 사본·비트맵 만들기 ----
for (const m of masters) await onNode(m.addr, ['FLUSHALL']);
for (const e of events) {
  await cluster.set(e.keys.epoch, '1:poc');
  await cluster.hSet(e.keys.ctl, { paused: '0', suspended: '0' });
  await cluster.setBit(e.keys.bitmap, e.seats - 1, 0);
}

// ---- 부하 ----
const SECTIONS = 20;
const ACCOUNTS = 100_000;
const holdOp = (e) => async () => {
  const n = 1 + Math.floor(Math.random() * 4);
  const hot = Math.random() < 0.5;
  const range = hot ? Math.floor(e.seats * 0.1) : e.seats;
  const start = Math.min(e.seats - n, Math.floor(Math.random() * range));
  const seats = Array.from({ length: n }, (_, i) => start + i);
  const acct = `a${Math.floor(Math.random() * ACCOUNTS)}`;
  const idem = randomUUID();
  const holdId = randomUUID();
  const section = Math.floor((start / e.seats) * SECTIONS);
  const fp = createHash('sha256').update(idem).digest('base64url');
  const keys = [e.keys.epoch, e.keys.ctl, e.keys.bitmap, e.keys.expiry, e.quotaKey(acct), e.idemKey(acct, idem), e.keys.stream, e.keys.fence, e.keys.secver, ...seats.map(e.holdKey)];
  const r = await c.run('hold', keys, [4, e.ttlMs, holdId, fp, acct, section, ...seats]);
  const tag = String(r[0]);
  e.outcomes[tag] = (e.outcomes[tag] ?? 0) + 1;
  if (tag === 'OK') {
    const fence = Number(r[1]);
    for (const seat of seats) e.log.holds.push(fence, seat);
    // 델타 발행(구역 채널, seat-hold §7). 발행은 홀드 지연에 넣지 않는다
    c.spublish(`s:{event:${e.tag}}:sec:${section}`, `${section}:${seats.join(',')}:${r[1]}`).catch(() => {
      e.outcomes.publish_error = (e.outcomes.publish_error ?? 0) + 1;
    });
  }
};
const SNAP = lua('snapshot');
const RELEASE = lua('release');
const snapOp = (e) => () => cluster.sendCommand(e.keys.bitmap, true, ['EVAL_RO', SNAP, '3', e.keys.epoch, e.keys.bitmap, e.keys.secver]);

// 구독: 회차마다 한 연결이 구역 채널 전부를 듣는다(realtime-gw 하나의 몫)
const received = { count: 0 };
const subs = [];
for (const e of events) {
  const chans = Array.from({ length: SECTIONS }, (_, i) => `s:{event:${e.tag}}:sec:${i}`);
  const sub = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
  for (const ch of chans) await sub.ssubscribe(ch, () => (received.count += 1));
  subs.push(sub);
}

// 만료 작업: 1초마다 회차별로 지난 홀드를 500개씩 푼다(seat-hold §5)
let expiryRunning = true;
let releaseCalls = 0;
const expiry = (async () => {
  while (expiryRunning) {
    const t = now();
    for (const e of events) {
      for (;;) {
        const r = await cluster.sendCommand(e.keys.bitmap, false, ['EVAL', RELEASE, '5', e.keys.bitmap, e.keys.expiry, e.keys.stream, e.keys.fence, e.keys.secver, RELEASE_BATCH, e.holdPrefix, e.quotaPrefix]);
        releaseCalls += 1;
        for (let i = 0; i < r.length; i += 3) e.log.releases.push(Number(r[i]), Number(r[i + 1]), r[i + 2] === '' ? -1 : Number(r[i + 2]));
        if (r.length / 3 < Number(RELEASE_BATCH)) break;
      }
    }
    const left = 1000 - (now() - t) / 1e6;
    if (left > 0) await new Promise((res) => setTimeout(res, left));
  }
})();

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
  for (const m of masters) {
    await onNode(m.addr, ['CONFIG', 'RESETSTAT']);
    await onNode(m.addr, ['SLOWLOG', 'RESET']);
  }
  cpu0 = Object.fromEntries(await Promise.all(targets.map(async (t) => [t, await cpuOf(t)])));
  tReset = now();
  host0 = hostSample();
}, warmupS * 1000);

const gen = procCpu();
const runs = await Promise.all(
  events.flatMap((e) => [
    openLoop({ rate: e.holds, durationS: warmupS + durationS, warmupS, maxInflight: 5_000, op: holdOp(e) }).then((r) => ({ e, kind: 'hold', r })),
    openLoop({ rate: e.snaps, durationS: warmupS + durationS, warmupS, maxInflight: 5_000, op: snapOp(e) }).then((r) => ({ e, kind: 'snapshot', r })),
  ]),
);
const tEnd = now();
const host1 = hostSample();
expiryRunning = false;
await expiry;
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
  const slowlogLen = Number(await onNode(t, ['SLOWLOG', 'LEN']));
  const slow = slowlogLen > 0 ? await onNode(t, ['SLOWLOG', 'GET', '10']) : [];
  engine[t] = {
    events: events.filter((e) => e.owner === t).map((e) => e.tag),
    evalsha_hold: { ...pick('evalsha'), ...calls('evalsha') },
    eval_release: { ...pick('eval'), ...calls('eval') },
    eval_ro_snapshot: { ...pick('eval_ro'), ...calls('eval_ro') },
    spublish: { ...pick('spublish'), ...calls('spublish') },
    main_thread_cpu_pct: Math.round(((cpu1.main - cpu0[t].main) / wall) * 1000) / 10,
    process_cpu_pct: Math.round(((cpu1.all - cpu0[t].all) / wall) * 1000) / 10,
    slowlog_len: slowlogLen,
    slowlog_sample: slow.slice(0, 5).map((x) => ({ id: x[0], usec: x[2], cmd: String(x[3]?.[0] ?? '') })),
  };
}

// ---- 오버셀 확인: 펜싱·연산 순번(회차마다 Lua가 늘리는 한 값)으로 좌석마다 잡기·놓기가 번갈아 오는지 본다 ----
const invariants = [];
for (const e of events) {
  // 순번(펜싱·연산 순번은 회차마다 Lua가 늘리는 한 값)으로 정렬해 좌석마다 잡기·놓기가 번갈아 오는지 본다.
  // 값 하나에 (순번, 종류, 좌석)을 담는다: 순번 × 2^17 + 종류 × 2^16 + 좌석(좌석 < 65,536, 순번 < 2^35)
  const H = e.log.holds;
  const L = e.log.releases;
  const nh = H.n / 2;
  const nr = L.n / 3;
  const keys = new Float64Array(nh + nr);
  let maxFence = 0;
  for (let i = 0; i < nh; i += 1) {
    keys[i] = H.buf[2 * i] * 131072 + H.buf[2 * i + 1];
    if (H.buf[2 * i] > maxFence) maxFence = H.buf[2 * i];
  }
  for (let i = 0; i < nr; i += 1) {
    keys[nh + i] = L.buf[3 * i + 1] * 131072 + 65536 + L.buf[3 * i];
    if (L.buf[3 * i + 1] > maxFence) maxFence = L.buf[3 * i + 1];
  }
  // 놓기 순번 → 그 놓기가 푼 홀드의 펜싱
  const relHf = new Int32Array(maxFence + 1).fill(-2);
  for (let i = 0; i < nr; i += 1) relHf[L.buf[3 * i + 1]] = L.buf[3 * i + 2];
  keys.sort();
  const state = new Int32Array(e.seats).fill(-1);
  let oversell = 0;
  let unknownRelease = 0;
  for (const k of keys) {
    const fence = Math.floor(k / 131072);
    const rest = k - fence * 131072;
    const kind = rest >= 65536 ? 1 : 0;
    const seat = rest - kind * 65536;
    if (kind === 0) {
      if (state[seat] !== -1) oversell += 1;
      state[seat] = fence;
    } else {
      if (state[seat] === -1 || state[seat] !== relHf[fence]) unknownRelease += 1;
      state[seat] = -1;
    }
  }
  const bits = Number(await cluster.bitCount(e.keys.bitmap));
  const zcard = Number(await cluster.zCard(e.keys.expiry));
  // 홀드가 오류(시간 초과 등)로 끝나면 서버에서는 실행됐을 수 있어 기록에 빠진다. 그때 오버셀 검사는 판정할 수 없다
  // 예열 동안의 오류도 센다(error_kinds는 예열을 포함한다, 코드 리뷰 2026-11-01)
  const holdErrors = runs.filter((x) => x.e === e && x.kind === 'hold').reduce((n, x) => n + Object.values(x.r.error_kinds).reduce((a, b) => a + b, 0), 0);
  invariants.push({ event: e.tag, oversell, unknown_release: unknownRelease, bitcount: bits, expiry_zcard: zcard, bit_equals_index: bits === zcard, hold_errors: holdErrors, verifiable: holdErrors === 0 });
}

const result = {
  test: 'S-T27',
  client,
  tls,
  mode,
  layout,
  release_batch: Number(RELEASE_BATCH),
  duration_s: durationS,
  warmup_s: warmupS,
  events: events.map((e) => ({ tag: e.tag, slot: e.slot, owner: e.owner, seats: e.seats, hold_rate: e.holds, snapshot_rate: e.snaps, ttl_ms: e.ttlMs, outcomes: e.outcomes })),
  load: runs.map(({ e, kind, r }) => ({ event: e.tag, kind, ...r })),
  engine,
  pubsub_received: received.count,
  release_calls: releaseCalls,
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
writeResult(a.out, result);
for (const s of subs) await s.close();
await c.close();
await admin.close();
process.exit(0);
