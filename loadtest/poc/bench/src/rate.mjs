// 한 키 INCR 20만/s(docs/architecture.md §9.4 'Redis INCR 단일 키', NFR-001)와 Redis 클라이언트 셋 처리량(V-T33 ①).
// 진입 서버 여럿을 프로세스 여럿(--procs)으로 흉내 내고, 프로세스마다 정해진 도착률(--rate ÷ procs)로 보낸다.
// --op incr: 요청마다 INCR 하나. --op batch: 프로세스마다 --batch-ms 동안 모은 요청을 INCRBY 하나로 보내고 받은 범위를 나눠 준다
// (파드별 INCRBY 마이크로 배치). --op hold: 좌석 홀드 Lua(클라이언트 셋 비교용, 큰 비트맵 하나).
// --model closed --conc N: 최대 처리량(닫힌 모델, 지연은 참고값).
// 쓰는 법(컨테이너 안): node src/rate.mjs --nodes valkey-1:6379,... --tls true --client node-redis --op incr --rate 200000 --procs 4 --duration 60 --warmup 15 --out /out/x.json
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect } from './clients.mjs';
import { closedLoop, hostDelta, hostSample, mergeHistograms, now, openLoop, parseArgs, procCpu, slotOf, writeResult } from './lib.mjs';

const a = parseArgs();
const nodes = a.nodes.split(',');
const tls = a.tls === 'true';
const client = a.client ?? 'node-redis';
const op = a.op ?? 'incr';
const durationS = Number(a.duration ?? 60);
const warmupS = Number(a.warmup ?? 15);
const KEY = 'q:{event:poc-entry}:seq';
const EVENT = 'poc-hold';
const hk = (s) => `s:{event:${EVENT}}:${s}`;
// 진입 ② 묶음 Lua의 회차 키(KEY와 같은 슬롯). 공통 인자: 회차 키 수명, 오픈(1분 전), 묶음 구간 끝(지남), 로비 셔플 켬, 묶음 켬, 참가자 목록 수명. 그 뒤 요청 수와 요청마다(묶음 대상 아님, 토큰 해시 없음)
const ek = (s) => `q:{event:poc-entry}:${s}`;
const NUMBER_KEYS = [KEY, ek('skipped'), ek('batch_done'), ek('batch_members:1'), ek('lobby_members'), ek('epoch')];
const HOLD_SEATS = 10_000_000;

if (a.worker === 'true') {
  // ---- 진입 서버 하나 ----
  const c = await connect(client, { nodes, tls, scripts: op === 'hold' ? ['hold'] : op.startsWith('number') ? ['entry-number-batch'] : [], timeoutMs: Number(a.timeout ?? 100) });
  const t0 = Date.now();
  const NUMBER_COMMON = [t0 + 2 * 86_400_000, t0 - 60_000, t0 - 58_000, '1', '1', t0 + 86_400_000];
  const numberArgv = (n) => [...NUMBER_COMMON, n, ...Array.from({ length: n }, () => ['0', '']).flat()];
  const batchMs = Number(a['batch-ms'] ?? 2);
  let batches = 0;
  // 파드별 묶음: --batch-ms 동안, 또는 --batch-max건이 찰 때까지 모은 요청을 묶음 Lua 한 번으로 보내고 받은 번호를 순서대로 나눠 준다(queue-svc NumberBatcher와 같은 방식)
  const batchMax = Number(a['batch-max'] ?? 500);
  let nPending = [];
  let nTimer;
  const nFlush = async () => {
    clearTimeout(nTimer);
    nTimer = undefined;
    const take = nPending;
    nPending = [];
    batches += 1;
    try {
      const r = await c.run('entry-number-batch', NUMBER_KEYS, numberArgv(take.length));
      take.forEach((w, i) => w.resolve(r[3 + 2 * i]));
    } catch (err) {
      for (const w of take) w.reject(err);
    }
  };
  let pending = [];
  let timer;
  const flush = async () => {
    timer = undefined;
    const take = pending;
    pending = [];
    batches += 1;
    try {
      const last = Number(await c.incrBy(KEY, take.length));
      take.forEach((w, i) => w.resolve(last - take.length + 1 + i));
    } catch (err) {
      for (const w of take) w.reject(err);
    }
  };
  const ops = {
    incr: () => c.incr(KEY),
    // queue-svc 진입 ② 묶음 Lua를 요청마다 1건으로(원문은 run.mjs가 lua/entry-number-batch.lua로 옮긴다)
    number: () => c.run('entry-number-batch', NUMBER_KEYS, numberArgv(1)),
    'number-batch': () =>
      new Promise((resolve, reject) => {
        nPending.push({ resolve, reject });
        if (nPending.length >= batchMax) void nFlush();
        else if (!nTimer) nTimer = setTimeout(nFlush, batchMs);
      }),
    batch: () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
        if (!timer) timer = setTimeout(flush, batchMs);
      }),
    hold: () => {
      const n = 1 + Math.floor(Math.random() * 4);
      const start = Math.floor(Math.random() * (HOLD_SEATS - n));
      const seats = Array.from({ length: n }, (_, i) => start + i);
      const acct = `a${Math.floor(Math.random() * 1_000_000)}`;
      const idem = randomUUID();
      return c.run('hold', [hk('epoch'), hk('ctl'), hk('bitmap'), hk('expiry'), hk(`quota:${acct}`), hk(`idem:${acct}:${idem}`), hk('stream'), hk('fence'), hk('secver'), ...seats.map((s) => hk(`hold:${s}`))], [1_000_000, 420_000, randomUUID(), idem, acct, 0, ...seats]);
    },
  };
  const fn = ops[op];
  // 모든 작업 프로세스가 연결을 마친 뒤 같은 시각에 시작한다(부모가 그 시각 + 예열에 엔진 통계를 비운다)
  process.send({ ready: true });
  const startAt = await new Promise((res) => process.once('message', (m) => res(m.startAt)));
  await new Promise((res) => setTimeout(res, Math.max(0, startAt - Date.now())));
  const cpu = procCpu();
  let r;
  if (a.model === 'closed') r = await closedLoop({ conc: Number(a.conc ?? 256), durationS, warmupS, op: fn });
  else r = await openLoop({ rate: Number(a.rate) / Number(a.procs ?? 1), durationS: warmupS + durationS, warmupS, maxInflight: Number(a['max-inflight'] ?? 20_000), op: fn, withHistogram: true });
  r.cpu_pct = cpu();
  r.batches = batches;
  process.send(r);
  await c.close();
  process.exit(0);
}

// ---- 부모: 프로세스를 띄우고 엔진 통계를 모은다 ----
const admin = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
const cluster = admin.raw;
const keySlot = slotOf(op === 'hold' ? hk('bitmap') : KEY);
const s = cluster.slots[keySlot];
const owner = cluster.masters.find((m) => m.host === s.master.host && m.port === s.master.port);
const onOwner = async (args) => (await cluster.nodeClient(owner)).sendCommand(args);
await onOwner(['FLUSHALL']);
if (op.startsWith('number')) {
  // 로비·묶음 표시가 이미 선 회차(오픈 뒤 평시): Lua는 표시를 보기만 하고 INCR한다
  await cluster.hSet(ek('batch_done'), { lobby: '1:0:1', 1: '1:0:1' });
}
if (op === 'hold') {
  await cluster.set(hk('epoch'), '1:poc');
  await cluster.hSet(hk('ctl'), { paused: '0', suspended: '0' });
  await cluster.setBit(hk('bitmap'), HOLD_SEATS - 1, 0);
}
const cpuOf = async () => {
  const info = String(await onOwner(['INFO', 'cpu']));
  const g = (n) => Number(new RegExp(`${n}:([0-9.]+)`).exec(info)?.[1] ?? NaN);
  return g('used_cpu_user_main_thread') + g('used_cpu_sys_main_thread');
};
const procs = Number(a.procs ?? 1);
const argv = process.argv.slice(2);
const children = Array.from({ length: procs }, () => fork(new URL(import.meta.url).pathname, [...argv, '--worker', 'true'], { stdio: 'inherit' }));
const waitMsg = (ch, pred) => new Promise((res, rej) => {
  const on = (m) => {
    if (pred(m)) {
      ch.off('message', on);
      res(m);
    }
  };
  ch.on('message', on);
  ch.once('exit', (code) => (code ? rej(new Error(`작업 프로세스 종료 코드 ${code}`)) : undefined));
});
await Promise.all(children.map((ch) => waitMsg(ch, (m) => m.ready)));
const startAt = Date.now() + 300;
const resultsP = Promise.all(children.map((ch) => waitMsg(ch, (m) => !m.ready)));
for (const ch of children) ch.send({ startAt });
let cpu0;
let t0;
let host0;
setTimeout(async () => {
  await onOwner(['CONFIG', 'RESETSTAT']);
  await onOwner(['SLOWLOG', 'RESET']);
  cpu0 = await cpuOf();
  t0 = now();
  host0 = hostSample();
}, startAt - Date.now() + warmupS * 1000 + 50);
const results = await resultsP;
const t1 = now();
const host1 = hostSample();
const cpu1 = await cpuOf();
const lat = String(await onOwner(['INFO', 'latencystats']));
const pick = (name) => {
  const m = new RegExp(`latency_percentiles_usec_${name}:p50=([0-9.]+),p99=([0-9.]+),p99\\.9=([0-9.]+)`).exec(lat);
  return m ? { p50_us: Number(m[1]), p99_us: Number(m[2]), p999_us: Number(m[3]) } : null;
};
const finalValue = op === 'hold' ? null : Number(await cluster.get(KEY));
const closed = a.model === 'closed';
const merged = closed ? null : mergeHistograms(results.map((r) => r.hist));
const issued = results.reduce((x, r) => x + (r.issued ?? r.completed), 0);
// 예열 뒤 요청 수(닫힌 모델은 예열 뒤 끝난 수와 오류 수)
const measured = results.reduce((x, r) => x + (r.measured ?? r.completed + r.errors), 0);
const errors = results.reduce((x, r) => x + r.errors, 0);
const dropped = results.reduce((x, r) => x + (r.dropped ?? 0), 0);
const out = {
  test: op === 'hold' ? 'V-T33-hold' : 'INCR-single-key',
  client,
  tls,
  op,
  model: closed ? 'closed' : 'open',
  procs,
  offered_rate: closed ? null : Number(a.rate),
  batch_ms: op === 'batch' ? Number(a['batch-ms'] ?? 2) : null,
  duration_s: durationS,
  warmup_s: warmupS,
  key_owner: `${owner.host}:${owner.port}`,
  latency: merged,
  throughput_per_s: closed ? results.reduce((x, r) => x + r.throughput_per_s, 0) : null,
  issued,
  errors,
  dropped,
  error_kinds: results.reduce((acc, r) => {
    for (const [k, n] of Object.entries(r.error_kinds ?? {})) acc[k] = (acc[k] ?? 0) + n;
    return acc;
  }, {}),
  measured,
  per_proc: results.map((r) => ({ cpu_pct: r.cpu_pct, issued: r.issued, measured: r.measured, errors: r.errors, dropped: r.dropped, max_inflight: r.max_inflight, batches: r.batches, throughput_per_s: r.throughput_per_s, latency: r.latency, latency_from_send: r.latency_from_send })),
  engine: {
    incr: pick('incr'),
    incrby: pick('incrby'),
    evalsha: pick('evalsha'),
    main_thread_cpu_pct: Math.round(((cpu1 - cpu0) / ((t1 - t0) / 1e9)) * 1000) / 10,
  },
  final_counter: finalValue,
  host: hostDelta(host0, host1),
};
out.bench = { p99_ms: merged ? merged.p99_ms : null, error_rate: measured ? errors / measured : 0, requests: measured, dropped, throughput_per_s: out.throughput_per_s };
writeResult(a.out, out);
await admin.close();
process.exit(0);
