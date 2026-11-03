// 변경분 받는 파드의 클라이언트(K4, S-T12의 v0 쪽, docs/verification.md §3.10). v0 앱 이미지 안에서 돈다: node /work/loadtest/runner/delta-client.mjs
// - 가상 사용자 CONNS_FROM ≤ i < CONNS_TO의 토큰(/work/users.json)으로 v0 변경분 WebSocket(GET /v0/events/{EVENT_ID}/seat-deltas)을 입구로 연다.
//   신원은 쿠키, IP는 X-Forwarded-For(측정용 대역), 출처는 ORIGIN이다. 인증서는 /work/ca.pem
// - 실행 도구가 /work/connect를 놓으면 연결을 맺기 시작하고(동시에 50개씩), /work/stop을 놓거나 DEADLINE_S가 지나면 닫고 끝난다
// - 1초마다 /work/out/delta-<CLIENT_INDEX>.ndjson에 { kind: 'delta_bucket', pod, sec, msgs, bytes, lat, opened, closed, errors, cpuUsec } 한 줄을 덧붙인다.
//   lat은 받은 시각 − 변경분의 atMs(같은 노드 커널 시계)의 칸 수(probes.mjs LAT_BOUNDS_MS). 연결을 다 맺으면 { kind: 'delta_conn', pod, connected, failed }
// - 끝나면 /work/out/delta-<CLIENT_INDEX>.done을 만든다. 토큰·쿠키는 출력하지 않는다
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { LAT_BOUNDS_MS, latencyBucket } from './probes.mjs';
import { ACCESS_COOKIE, userIp } from '../lib/users.mjs';

const require = createRequire('/app/package.json');
const WebSocket = require('ws');

const env = (k) => {
  const v = process.env[k];
  if (v === undefined || v === '') throw new Error(`환경 값 ${k}이 없다`);
  return v;
};
const POD = Number(env('CLIENT_INDEX'));
const FROM = Number(env('CONNS_FROM'));
const TO = Number(env('CONNS_TO'));
const GATEWAY = env('GATEWAY');
const EVENT_ID = env('EVENT_ID');
const ORIGIN = env('ORIGIN');
const DEADLINE_MS = Date.now() + Number(env('DEADLINE_S')) * 1000;
const OUT = `/work/out/delta-${POD}.ndjson`;
const CONCURRENCY = 50;

const tokens = JSON.parse(readFileSync('/work/users.json', 'utf8'));
const ca = readFileSync('/work/ca.pem');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cpuUsec() {
  try {
    const m = /^usage_usec (\d+)$/m.exec(readFileSync('/sys/fs/cgroup/cpu.stat', 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** 지금 초의 칸 */
let cur = null;
function bucket() {
  const sec = Math.floor(Date.now() / 1000);
  if (cur === null || cur.sec !== sec) {
    flush();
    cur = { kind: 'delta_bucket', pod: POD, sec, msgs: 0, bytes: 0, lat: new Array(LAT_BOUNDS_MS.length + 1).fill(0), opened: 0, closed: 0, errors: 0, cpuUsec: 0 };
  }
  return cur;
}
function flush() {
  if (cur === null) return;
  cur.cpuUsec = cpuUsec();
  appendFileSync(OUT, `${JSON.stringify(cur)}\n`);
  cur = null;
}

const sockets = new Set();
let connected = 0;
let failed = 0;

function open(i) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${GATEWAY}/v0/events/${EVENT_ID}/seat-deltas`, {
      ca,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
      headers: { cookie: `${ACCESS_COOKIE}=${tokens[i]}`, 'x-forwarded-for': userIp(i), origin: ORIGIN },
    });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (ok) connected++;
      else failed++;
      resolve();
    };
    ws.on('open', () => {
      sockets.add(ws);
      bucket().opened++;
      done(true);
    });
    ws.on('message', (data) => {
      const now = Date.now();
      const b = bucket();
      const text = typeof data === 'string' ? data : data.toString('utf8');
      b.msgs++;
      b.bytes += Buffer.byteLength(text);
      try {
        const at = JSON.parse(text)?.atMs;
        if (Number.isFinite(at)) b.lat[latencyBucket(now - at)]++;
      } catch {
        b.errors++;
      }
    });
    ws.on('close', () => {
      if (sockets.delete(ws)) bucket().closed++;
      done(false);
    });
    ws.on('error', () => {
      bucket().errors++;
      done(false);
    });
  });
}

async function main() {
  writeFileSync(OUT, '');
  while (!existsSync('/work/connect')) {
    if (Date.now() > DEADLINE_MS) throw new Error('연결 시작 표시가 오지 않았다');
    await sleep(100);
  }
  const ticker = setInterval(() => bucket(), 200);
  const ids = [];
  for (let i = FROM; i < TO; i++) ids.push(i);
  for (let k = 0; k < ids.length; k += CONCURRENCY) await Promise.all(ids.slice(k, k + CONCURRENCY).map(open));
  flush();
  appendFileSync(OUT, `${JSON.stringify({ kind: 'delta_conn', pod: POD, connected, failed })}\n`);
  while (!existsSync('/work/stop') && Date.now() < DEADLINE_MS) await sleep(200);
  clearInterval(ticker);
  for (const ws of sockets) ws.close(1000);
  await sleep(500);
  flush();
  writeFileSync(`/work/out/delta-${POD}.done`, '');
  process.exit(0);
}

main().catch((e) => {
  try {
    appendFileSync(`/work/out/delta-${POD}.error`, `${String(e?.message ?? e).slice(0, 300)}\n`);
  } catch {
    // 쓰지 못해도 끝낸다
  }
  process.exit(1);
});
