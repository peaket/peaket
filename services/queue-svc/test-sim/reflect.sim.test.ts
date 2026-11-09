// 실측(PC): Q-T47 입장 임박 구간 반영 지연(docs/features/queue-admission.md §4·§11, docs/verification.md §3.4, ADR-0110). BUILD_ORDER PRF-085 ②.
// 운영 코드 그대로의 queue-svc(대기 상태 파일 원본) 앞에 로컬 nginx 캐시를 두고(원본의 Expires를 따르고 낡은 값 허용 없음, proxy_cache_lock만),
// serving을 200ms마다 올리며(초당 약 28번호, 리더가 쓰는 serving·serving_log·calls와 같은 모양) 합성 대기자 1,700명(차례 1분 안)이 0.5초 ±20%로 폴링한다.
// 대기자마다 '차례를 본 시각 − serving이 그 번호를 넘은 전진 시각(이 프로세스가 올린 시각)'을 재고 단계 넷(생성 대기·캐시 나이·폴링 대기·왕복)으로 나눈다.
// 원본 생성을 0.3초 늦추는 경우도 잰다. 끝나기 3초 전까지 넘은 번호만 세고, 입장 임박이 아닌 구간 파일로 본 대기자도 넣는다.
// 판정(ADR-0185): 제때 생성의 반영 지연 p99 ≤ 2.8초 [가정](목표 3초에서 CDN 계층 몫 0.2초를 남긴다). 두 경우 모두 캐시가 Expires 뒤에 옛 파일을 내는 시간(가장 늦은 것)이
// 캐시 시계 한 단위(nginx 1초)에 시계 흔들림 0.2초를 더한 1.2초 미만이다(낡은 값 허용을 켜 두면 옛 파일이 몇 초씩 남아 넘는다).
// 결과는 test-sim/record.ts로 성능 장부 갈 자리에 쓴다(실행마다 새 번호). 쓰는 법: pnpm --filter @peaket/queue-svc sim reflect
import 'reflect-metadata';
import { execFileSync, fork } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHotRedis, createService, type HotRedis } from '@peaket/platform';
import { expect, test } from 'vitest';
import { Es256AdmissionTokens } from '../src/modules/admission/adapters/es256-admission-tokens.js';
import { AppModule } from '../src/app.module.js';
import { keys } from '../src/modules/entry/adapters/redis-entry-store.js';
import { unavailableRisk } from '../src/modules/entry/adapters/unavailable-risk.js';
import { StateFiles } from '../src/modules/state/application/state-files.js';
import { tokens } from '../test/support.js';
import { startValkey } from '../test-int/valkey.js';
import { nextRunId, saveRun, SIM_DAY } from './record.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SIM = join(ROOT, '.cache', 'peaket-sim');
const NGINX_IMAGE = 'nginx:1.27-alpine';
const SECONDS = Number(process.env.SIM_SECONDS ?? 180);
const RATE = 28;
const IMMINENT = 1_700;
const POLL_MS = 500;
const WARMUP_S = 15;
/** 끝나기 전 이 시간 안에 넘은 번호는 세지 않는다(볼 기회가 모자라 잘리지 않게) */
const TAIL_S = 3;
const POLLER_PROCS = 4;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (xs: number[], p: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]! * 1000) / 1000;
};

/** 입장 임박 구간 경로는 낡은 값 허용이 없다: proxy_cache_lock만 두고 use_stale·background_update는 끈다(verification §3.4) */
const nginxConf = (port: number) => `proxy_cache_path /tmp/qcache levels=1:2 keys_zone=q:20m max_size=200m inactive=60s use_temp_path=off;
server {
  listen 8080;
  location /v1/queues/ {
    proxy_pass http://host.docker.internal:${port};
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_cache q;
    proxy_cache_lock on;
    proxy_cache_lock_timeout 2s;
    proxy_cache_use_stale off;
    proxy_cache_background_update off;
    add_header X-Cache $upstream_cache_status always;
  }
}
`;

interface Seen {
  n: number;
  /** servingSteps에서 찾은 전진 시각(브라우저의 방법, 입장 임박 구간이 아니면 없음). 판정은 이 프로세스가 기록한 시각을 쓴다 */
  adv: number | null;
  imminent: boolean;
  req: number;
  recv: number;
  gen: number;
  cache: string;
}

async function runVariant(delayMs: number) {
  const valkey = await startValkey();
  const redis: HotRedis = await createHotRedis({ url: valkey.url });
  const signer = new Es256AdmissionTokens({ jwk: { ...generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }), kid: 'sim' }, issuer: 'https://queue.sim.invalid' });
  const svc = await createService({
    name: 'queue-svc',
    module: AppModule.register({ redis, tokens, risk: unavailableRisk, state: { autoTick: false }, admission: { signer } }),
    env: { PEAKET_ENV: 'ci', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' },
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const { port } = await svc.listen('127.0.0.1');
  mkdirSync(SIM, { recursive: true });
  const conf = join(SIM, `nginx-${delayMs}.conf`);
  writeFileSync(conf, nginxConf(port));
  const name = `peaket-sim-nginx-${delayMs}`;
  try {
    docker('rm', '-f', '-v', name);
  } catch {
    // 없다
  }
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-v', `${conf}:/etc/nginx/conf.d/default.conf:ro`, NGINX_IMAGE);
  const mapped = docker('port', name, '8080/tcp').split('\n')[0]!;
  const edge = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  const cmd = (key: string, args: string[]) => redis.command(args, { key });
  const eventId = `sim47d${delayMs}`;
  const now0 = Date.now();
  const total = RATE * SECONDS + IMMINENT;
  await cmd(keys.cfg(eventId), ['HSET', keys.cfg(eventId), 'opensAtMs', String(now0 - 120_000), 'startsAtMs', String(now0 + 2 * 86_400_000), 'lobbyShuffle', '1', 'openBatch', '1', 'rev', '1']);
  await cmd(keys.seq(eventId), ['SET', keys.seq(eventId), String(total + 10_000)]);
  const states = svc.app.get(StateFiles, { strict: false });

  let advErrors = 0;
  const advAt = new Float64Array(RATE * SECONDS * 2 + IMMINENT + 10);
  const genStart = new Map<number, number>();
  const genDone = new Map<number, number>();
  let serving = 0;
  let stop = false;
  // 매초 경계 + 늦춤에 파일을 만든다(늦춰도 파일의 생성 시각은 그 경계다)
  const genLoop = (async () => {
    while (!stop) {
      const b = Math.floor(Date.now() / 1000) * 1000 + 1000;
      await sleep(b + delayMs - Date.now());
      genStart.set(b, Date.now());
      await states.tick(b).catch(() => undefined);
      genDone.set(b, Date.now());
    }
  })();
  // serving을 200ms마다 올린다(리더 ADVANCE가 쓰는 세 키와 같은 모양)
  let carry = 0;
  const advT0 = Date.now();
  let beat = 0;
  const advLoop = (async () => {
    while (!stop && serving < total) {
      beat += 1;
      await sleep(advT0 + beat * 200 - Date.now());
      carry += RATE / 5;
      const k = Math.floor(carry);
      carry -= k;
      if (k === 0) continue;
      const at = Date.now();
      const s = Math.min(total, serving + k);
      try {
        await cmd(keys.calls(eventId), ['ZADD', keys.calls(eventId), String(s), `${at}:${k}`]);
        await cmd(keys.servingLog(eventId), ['ZADD', keys.servingLog(eventId), String(s), String(Math.floor(at / 1000))]);
        await cmd(keys.serving(eventId), ['SET', keys.serving(eventId), String(s)]);
        const done = Date.now();
        for (let n = serving + 1; n <= s; n += 1) advAt[n] = done;
        serving = s;
      } catch {
        advErrors += 1;
        carry += k;
      }
    }
  })();

  // 대기자는 프로세스 넷에 나눠 띄운다(원본 서버와 이벤트 루프를 나눠 쓰지 않게)
  const seen: Seen[] = [];
  const stats = { requests: 0, errors: 0, staleHits: 0, staleMaxMs: 0, noStep: 0, cache: {} as Record<string, number> };
  const kids = Array.from({ length: POLLER_PROCS }, () => fork(fileURLToPath(new URL('./pollers.mjs', import.meta.url)), [edge, eventId, String(POLL_MS)], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  await Promise.all(kids.map((k) => new Promise<void>((res) => k.once('message', () => res()))));
  const done = kids.map(
    (k) =>
      new Promise<void>((res) =>
        k.on('message', (m: { seen?: Omit<Seen, 'genDone'>; stats?: typeof stats }) => {
          if (m.seen) seen.push(m.seen);
          if (m.stats) {
            stats.requests += m.stats.requests;
            stats.errors += m.stats.errors;
            stats.staleHits += m.stats.staleHits;
            stats.staleMaxMs = Math.max(stats.staleMaxMs, m.stats.staleMaxMs);
            stats.noStep += m.stats.noStep;
            for (const [c, n] of Object.entries(m.stats.cache)) stats.cache[c] = (stats.cache[c] ?? 0) + n;
            res();
          }
        }),
      ),
  );
  const t0 = Date.now();
  // 차례가 1분(1,700명) 안으로 들어온 번호부터 폴링을 시작한다
  let started = 0;
  while (Date.now() - t0 < SECONDS * 1000) {
    while (started < total && started + 1 <= serving + IMMINENT) {
      started += 1;
      kids[started % POLLER_PROCS]!.send({ start: started });
    }
    await sleep(50);
  }
  for (const k of kids) k.send({ stop: true });
  await Promise.race([Promise.all(done), sleep(15_000)]);
  stop = true;
  await Promise.allSettled([genLoop, advLoop]);
  docker('rm', '-f', '-v', name);
  await svc.close();
  await redis.close();
  valkey.stop();
  // 예열 뒤·끝 TAIL_S초 전까지 넘은 번호만 센다(그 번호를 다 봤는지도 센다)
  const tEnd = t0 + SECONDS * 1000;
  const inWindow = (n: number) => advAt[n]! > 0 && advAt[n]! - t0 >= WARMUP_S * 1000 && advAt[n]! <= tEnd - TAIL_S * 1000;
  const measured = seen.filter((x) => inWindow(x.n));
  let passedInWindow = 0;
  for (let n = 1; n < advAt.length; n += 1) if (inWindow(n)) passedInWindow += 1;
  // 그 번호가 든 첫 생성(전진 뒤 시작한 첫 생성, 본 파일이 더 이르면 그것)
  const bounds = [...genStart.keys()].sort((a, b) => a - b);
  const firstGenAfter = (t: number) => bounds.find((b) => genStart.get(b)! >= t);
  const delay: number[] = [];
  const genWait: number[] = [];
  const cacheAge: number[] = [];
  const pollWait: number[] = [];
  const rtt: number[] = [];
  for (const x of measured) {
    const adv = advAt[x.n]!;
    delay.push((x.recv - adv) / 1000);
    rtt.push((x.recv - x.req) / 1000);
    const g1 = firstGenAfter(adv);
    const gFirst = g1 === undefined || x.gen < g1 ? x.gen : g1;
    const firstDone = genDone.get(gFirst);
    const seenDone = genDone.get(x.gen);
    if (firstDone === undefined || seenDone === undefined) continue;
    genWait.push(Math.max(0, firstDone - adv) / 1000);
    cacheAge.push(Math.max(0, seenDone - firstDone) / 1000);
    pollWait.push(Math.max(0, x.req - Math.max(seenDone, adv)) / 1000);
  }
  const stat = (xs: number[]) => ({ p50_s: q(xs, 0.5), p95_s: q(xs, 0.95), p99_s: q(xs, 0.99), max_s: q(xs, 1) });
  const servedSeconds = (Math.max(...[...advAt].filter((t) => t > 0)) - advT0) / 1000;
  return {
    delayMs,
    waiters: seen.length,
    measured: measured.length,
    passedInWindow,
    unseenInWindow: passedInWindow - measured.length,
    actualRatePerS: Math.round((serving / servedSeconds) * 10) / 10,
    notImminent: measured.filter((x) => !x.imminent).length,
    noStep: stats.noStep,
    requests: stats.requests,
    errors: stats.errors,
    advErrors,
    cache: stats.cache,
    staleHits: stats.staleHits,
    staleMaxMs: stats.staleMaxMs,
    delay: stat(delay),
    stages: { genWait: stat(genWait), cacheAge: stat(cacheAge), pollWait: stat(pollWait), roundTrip: stat(rtt) },
    requestsPerSecond: Math.round(stats.requests / SECONDS),
  };
}

test('[실측] Q-T47 입장 임박 구간 반영 지연(제때 생성·0.3초 늦은 생성)', async () => {
  const startedAt = new Date().toISOString();
  const d0 = await runVariant(0);
  const d300 = await runVariant(300);
  // nginx가 Expires를 초 단위로 다뤄 옛 파일이 최대 1초 가까이 남는다(측정 999ms·998ms). 시계 흔들림 0.2초를 더해 한도로 둔다(ADR-0185)
  const STALE_LIMIT_MS = 1_200;
  const pass = (d0.delay.p99_s ?? 99) <= 2.8 && d0.staleMaxMs < STALE_LIMIT_MS && d300.staleMaxMs < STALE_LIMIT_MS && d0.unseenInWindow === 0 && d300.unseenInWindow === 0;
  for (const r of [d0, d300]) {
    const id = nextRunId(`${SIM_DAY}-qt47-d${r.delayMs}`);
    const out = { test: 'Q-T47', seconds: SECONDS, rate_per_s: RATE, imminent: IMMINENT, poll_ms: POLL_MS, warmup_s: WARMUP_S, tail_s: TAIL_S, ...r, ...(r.delayMs === 0 ? { pass } : {}), bench: { requests: r.requests, error_rate: r.requests ? r.errors / r.requests : 0, dropped: 0, p99_ms: r.delay.p99_s === null ? null : r.delay.p99_s * 1000 } };
    saveRun(
      id,
      out,
      {
        kpi: 'NFR-002',
        duration: SECONDS,
        warmup: WARMUP_S,
        scenario: 'services/queue-svc/test-sim/reflect.sim.test.ts',
        scenarioArgs: `serving 초당 ${RATE}번호(200ms마다, 실제 ${r.actualRatePerS}), 대기자 ${IMMINENT}명(차례 1분 안) 0.5초 ±20% 폴링(프로세스 ${POLLER_PROCS}개), 원본 생성 ${r.delayMs ? `${r.delayMs}ms 늦춤` : '제때'}`,
        notes: `Q-T47 ${r.delayMs === 0 ? `판정 ${pass ? '통과' : '실패'}` : '0.3초 늦은 생성'}: 반영 지연 p50 ${r.delay.p50_s}초·p99 ${r.delay.p99_s}초·최대 ${r.delay.max_s}초(센 번호 ${r.measured}/${r.passedInWindow}), 단계 p99 생성 대기 ${r.stages.genWait.p99_s}·캐시 나이 ${r.stages.cacheAge.p99_s}·폴링 대기 ${r.stages.pollWait.p99_s}·왕복 ${r.stages.roundTrip.p99_s}초, 캐시 ${JSON.stringify(r.cache)}, Expires보다 50ms 넘게 늦은 요청에 낸 HIT ${r.staleHits}(가장 늦은 것 ${r.staleMaxMs}ms). queue-svc(운영 코드, 대기 상태 파일 원본) + nginx 1.27 캐시(낡은 값 허용 없음, proxy_cache_lock) + Valkey 8.1 단일 노드, 대기자는 이 PC의 측정 프로세스 ${POLLER_PROCS}개(같은 시계)`,
      },
      startedAt,
    );
  }
  console.log(JSON.stringify({ pass, d0, d300 }));
  expect(d0.measured).toBeGreaterThan(0);
}, (SECONDS * 2 + 300) * 1000);
