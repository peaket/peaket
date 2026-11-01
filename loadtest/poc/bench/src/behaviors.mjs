// V-T33 ②~⑤ Redis 클라이언트 동작(docs/verification.md V-T33, docs/architecture.md §9.4).
// ② 실행 중 슬롯 옮기기·계획된 주 노드 바꾸기(CLUSTER FAILOVER)·주 노드 죽이기 ③ SCRIPT FLUSH 뒤 EVALSHA ④ 샤드 구독 중 슬롯 옮기기
// ⑤ 연결을 끊은 채 핫패스 명령 보내기(망에서 떼기 2초, 주 노드 죽이기)를 한 클라이언트로 차례로 본다.
// 컨테이너를 멈추고 망에서 떼는 일은 Docker 엔진 API(/var/run/docker.sock)로 한다. 클러스터는 이 시험마다 새로 만든다(stack.mjs).
// 쓰는 법(컨테이너 안): node src/behaviors.mjs --client ioredis --nodes valkey-1:6379,... --tls true --network peaket-poc --out /out/x.json
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from 'redis';
import { connect } from './clients.mjs';
import { now, openLoop, parseArgs, sleep, slotOf, writeResult } from './lib.mjs';

const a = parseArgs();
const nodes = a.nodes.split(',');
const tls = a.tls === 'true';
const client = a.client ?? 'node-redis';
const NET = a.network ?? 'peaket-poc';
const HOT_TIMEOUT = Number(a.timeout ?? 100);

const docker = (method, path, body) =>
  new Promise((resolve, reject) => {
    const req = request({ socketPath: '/var/run/docker.sock', path: `/v1.47${path}`, method, headers: { 'content-type': 'application/json' } }, (res) => {
      let t = '';
      res.on('data', (d) => (t += d));
      res.on('end', () => (res.statusCode < 300 ? resolve(t) : reject(new Error(`docker ${method} ${path}: ${res.statusCode} ${t}`))));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

const admin = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
const cl = admin.raw;
// 노드마다 따로 붙는 관리 연결(시험 대상 클라이언트와 상관없음)
const direct = new Map();
const cmdOn = async (addr, args) => {
  let d = direct.get(addr);
  if (!d) {
    d = createClient({ url: `${tls ? 'rediss' : 'redis'}://${addr}`, socket: tls ? { tls: true, ca: readFileSync('/tls/ca.crt', 'utf8'), reconnectStrategy: false } : { reconnectStrategy: false } });
    d.on('error', () => {});
    await d.connect();
    direct.set(addr, d);
  }
  return d.sendCommand(args);
};
const dropDirect = async (addr) => {
  const d = direct.get(addr);
  direct.delete(addr);
  await d?.destroy?.();
};
const ownerOf = (slot) => `${cl.slots[slot].master.host}:${cl.slots[slot].master.port}`;
const masters = () => cl.masters.map((m) => `${m.host}:${m.port}`);
const idOf = async (addr) => String(await cmdOn(addr, ['CLUSTER', 'MYID']));
const refresh = async () => {
  // admin 연결의 토폴로지를 새로 읽는다(시험 대상 클라이언트와 상관없음)
  try {
    await cl.sendCommand(undefined, true, ['PING']);
  } catch {
    // 다음 명령에서 다시
  }
  await cl.close().catch(() => {});
  await cl.connect();
};

/** 슬롯 하나를 옮긴다(MIGRATING/IMPORTING → 키 옮기기 → NODE). 키 옮기는 동안 ASK 다시 보내기가 생긴다 */
async function migrateSlot(slot, toAddr, { pauseBetweenMs = 0 } = {}) {
  const from = ownerOf(slot);
  const fromId = await idOf(from);
  const toId = await idOf(toAddr);
  const [th, tp] = toAddr.split(':');
  await cmdOn(toAddr, ['CLUSTER', 'SETSLOT', String(slot), 'IMPORTING', fromId]);
  await cmdOn(from, ['CLUSTER', 'SETSLOT', String(slot), 'MIGRATING', toId]);
  for (;;) {
    const keys = await cmdOn(from, ['CLUSTER', 'GETKEYSINSLOT', String(slot), '50']);
    if (!keys.length) break;
    await cmdOn(from, ['MIGRATE', th, tp, '', '0', '5000', 'KEYS', ...keys]);
    if (pauseBetweenMs) await sleep(pauseBetweenMs);
  }
  for (const m of masters()) await cmdOn(m, ['CLUSTER', 'SETSLOT', String(slot), 'NODE', toId]).catch(() => {});
  await refresh();
  return { slot, from, to: toAddr };
}

/** 같은 슬롯에 놓인 키 여럿(옮기는 동안 ASK가 나게) */
const keysInTag = (tag, n) => Array.from({ length: n }, (_, i) => `{${tag}}:k${i}`);

/** 일정 비율로 INCR을 보내며 fn을 한다. 실패·지연을 센다 */
async function underLoad(keys, rate, seconds, fn) {
  let fnResult;
  const run = openLoop({ rate, durationS: seconds, op: (i) => c.incr(keys[i % keys.length]) });
  await sleep(1_000);
  fnResult = await fn();
  const r = await run;
  return { action: fnResult, issued: r.issued, errors: r.errors, error_kinds: r.error_kinds, latency: r.latency };
}

const c = await connect(client, { nodes, tls, scripts: ['hold'], timeoutMs: HOT_TIMEOUT });
const out = { test: 'V-T33-behaviors', client, tls, timeout_ms: HOT_TIMEOUT, steps: {} };

// ---- ② 실행 중 슬롯 옮기기 ----
{
  const keys = keysInTag('mig', 200);
  for (const k of keys) await cl.set(k, '0');
  const slot = slotOf(keys[0]);
  const target = masters().find((m) => m !== ownerOf(slot));
  out.steps.migrate = await underLoad(keys, 5_000, 8, () => migrateSlot(slot, target, { pauseBetweenMs: 20 }));
}

// ---- ② 계획된 주 노드 바꾸기(복제가 CLUSTER FAILOVER) ----
{
  const keys = keysInTag('fo', 50);
  const slot = slotOf(keys[0]);
  const master = ownerOf(slot);
  const masterId = await idOf(master);
  const repLine = [].concat(await cmdOn(master, ['CLUSTER', 'REPLICAS', masterId])).map(String)[0];
  const repAddr = `${/,([^ ]+)/.exec(repLine)[1]}:6379`;
  out.steps.failover = await underLoad(keys, 5_000, 10, async () => {
    const t = now();
    await cmdOn(repAddr, ['CLUSTER', 'FAILOVER']);
    for (let i = 0; i < 100; i += 1) {
      const role = String(await cmdOn(repAddr, ['ROLE'])).split(',')[0];
      if (role === 'master') break;
      await sleep(50);
    }
    await refresh();
    return { from: master, to: repAddr, promoted_ms: Math.round((now() - t) / 1e6) };
  });
}

// ---- ③ SCRIPT FLUSH 뒤 EVALSHA ----
{
  const ev = 'scr';
  const k = (s) => `s:{event:${ev}}:${s}`;
  await cl.set(k('epoch'), '1:poc');
  await cl.hSet(k('ctl'), { paused: '0', suspended: '0' });
  const hold = (seat) => {
    const idem = randomUUID();
    return c.run('hold', [k('epoch'), k('ctl'), k('bitmap'), k('expiry'), k('quota:a1'), k(`idem:a1:${idem}`), k('stream'), k('fence'), k('secver'), k(`hold:${seat}`)], [1_000_000, 60_000, randomUUID(), idem, 'a1', 0, seat]);
  };
  const first = String((await hold(1))[0]);
  for (const m of masters()) await cmdOn(m, ['SCRIPT', 'FLUSH']);
  let after;
  let error = null;
  try {
    after = String((await hold(2))[0]);
  } catch (err) {
    error = String(err.message ?? err);
  }
  out.steps.script_flush = { before: first, after_flush: after ?? null, error, pass: after === 'OK' && error === null };
}

// ---- ④ 샤드 구독 중 슬롯 옮기기 ----
{
  const ch = `s:{event:sub}:sec:0`;
  const slot = slotOf(ch);
  const got = [];
  let sub;
  if (client === 'node-redis') {
    sub = await connect('node-redis', { nodes, tls, timeoutMs: 5_000 });
    await sub.ssubscribe(ch, (_c, m) => got.push(Number(m)));
  } else {
    sub = await connect(client, { nodes, tls, timeoutMs: 5_000, shardChannels: [ch], onShard: (_c, m) => got.push(Number(m)) });
  }
  await sleep(500);
  let seq = 0;
  let pubErrors = 0;
  const pub = setInterval(() => {
    seq += 1;
    cl.sPublish(ch, String(seq)).catch(() => (pubErrors += 1));
  }, 10);
  await sleep(1_000);
  const beforeMove = seq;
  const target = masters().find((m) => m !== ownerOf(slot));
  const moved = await migrateSlot(slot, target);
  const afterMove = seq;
  await sleep(5_000);
  clearInterval(pub);
  await sleep(300);
  const last = seq;
  const receivedAfter = got.filter((x) => x > afterMove + 20).length; // 옮긴 뒤 0.2초 지난 것부터
  const sentAfter = last - (afterMove + 20);
  out.steps.sharded_pubsub = { moved, sent_total: last, received_total: got.length, sent_before_move: beforeMove, sent_after_move_settled: sentAfter, received_after_move_settled: receivedAfter, publish_errors: pubErrors, pass: sentAfter > 0 && receivedAfter >= sentAfter * 0.99 };
  await sub.close();
}

// ---- ⑤ 연결을 끊은 채 핫패스 명령(망에서 2초 떼기: 패킷이 사라진다) ----
async function cutCase(kind) {
  const key = kind === 'blackhole' ? '{cut1}:n' : '{cut2}:n';
  await cl.set(key, '0');
  const slot = slotOf(key);
  const addr = ownerOf(slot);
  const host = addr.split(':')[0];
  const inspect = JSON.parse(await docker('GET', `/containers/${host}/json`));
  const ip = inspect.NetworkSettings.Networks[NET].IPAddress;
  let ok = 0;
  const fails = [];
  const stop = { v: false };
  const loop = (async () => {
    while (!stop.v) {
      const t = now();
      try {
        await c.incr(key);
        ok += 1;
      } catch {
        fails.push((now() - t) / 1e6);
      }
      await sleep(5);
    }
  })();
  await sleep(500);
  const t0 = now();
  if (kind === 'blackhole') {
    await docker('POST', `/networks/${NET}/disconnect`, { Container: host, Force: true });
    await sleep(2_000);
    await docker('POST', `/networks/${NET}/connect`, { Container: host, EndpointConfig: { IPAMConfig: { IPv4Address: ip }, Aliases: [host] } });
  } else {
    await docker('POST', `/containers/${host}/kill`);
    // 복제가 이어받을 때까지(cluster-node-timeout 5초 + 선출)
    await sleep(9_000);
  }
  await sleep(3_000);
  stop.v = true;
  await loop;
  const downMs = (now() - t0) / 1e6;
  await dropDirect(addr);
  if (kind === 'kill') {
    await docker('POST', `/containers/${host}/start`);
    await sleep(2_000);
  }
  await refresh();
  // 쌓였다가 나중에 들어간 명령이 있으면 카운터가 성공 수보다 크다
  await sleep(1_000);
  const counter = Number(await cl.get(key));
  fails.sort((x, y) => x - y);
  const p = (q) => (fails.length ? Math.round(fails[Math.min(fails.length - 1, Math.ceil(q * fails.length) - 1)] * 10) / 10 : null);
  return {
    kind,
    node: addr,
    window_ms: Math.round(downMs),
    succeeded: ok,
    failed: fails.length,
    fail_ms: { p50: p(0.5), p99: p(0.99), max: fails.length ? Math.round(fails[fails.length - 1] * 10) / 10 : null },
    counter_after: counter,
    queued_then_applied: counter - ok,
    pass: fails.length > 0 && (p(0.99) ?? 0) <= HOT_TIMEOUT * 1.5 && counter - ok <= (kind === 'blackhole' ? fails.length : 0),
  };
}
out.steps.offline_blackhole = await cutCase('blackhole');
out.steps.offline_kill = await cutCase('kill');

writeResult(a.out, out);
await c.close().catch(() => {});
await admin.close().catch(() => {});
process.exit(0);
