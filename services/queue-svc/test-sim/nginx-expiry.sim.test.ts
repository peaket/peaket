// 실측(PC): 로컬 nginx 캐시가 원본의 Expires에 맞춰 만료하는지(Q-T47 실패의 원인 확인, ADR-0110 '측정', docs/review/open-items.md 104번). BUILD_ORDER PRF-085 ②.
// 원본은 요청마다 지금 초(gen)의 내용을 주고, Expires를 ① 다음 초 경계(gen + 1초, 지금 규칙) ② 생성한 그 초(gen)로 준다. nginx(Q-T47과 같은 설정)를 거쳐
// 100ms마다 10초 읽어 받은 내용의 나이(지금 − gen)와 원본 요청 수를 센다. Expires에 정확히 만료하면 ①의 나이는 1초 미만이다.
// ②는 nginx가 초 단위로 '그 초 끝까지' 살리는 버릇을 이용하는 것이라 다른 캐시(CloudFront)에서 같다는 보장이 없다(41번).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { nextRunId, saveRun, SIM_DAY } from './record.js';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const SIM = join(ROOT, '.cache', 'peaket-sim');
const NGINX_IMAGE = 'nginx:1.27-alpine';
const SECONDS = 10;
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function run(mode: 'next' | 'current') {
  let originHits = 0;
  const srv = createServer((_req, res) => {
    originHits += 1;
    const gen = Math.floor(Date.now() / 1000) * 1000;
    res.setHeader('content-type', 'application/json');
    res.setHeader('expires', new Date(mode === 'next' ? gen + 1000 : gen).toUTCString());
    res.setHeader('cache-control', 'public');
    res.end(JSON.stringify({ gen }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  mkdirSync(SIM, { recursive: true });
  const conf = join(SIM, `nginx-expiry-${mode}.conf`);
  writeFileSync(
    conf,
    `proxy_cache_path /tmp/c levels=1:2 keys_zone=q:1m max_size=10m inactive=60s use_temp_path=off;
server { listen 8080; location / { proxy_pass http://host.docker.internal:${port}; proxy_cache q; proxy_cache_lock on; proxy_cache_use_stale off; proxy_cache_background_update off; add_header X-Cache $upstream_cache_status always; } }
`,
  );
  const name = `peaket-nginx-expiry-${mode}`;
  try {
    docker('rm', '-f', '-v', name);
  } catch {
    // 없다
  }
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::8080', '-v', `${conf}:/etc/nginx/conf.d/default.conf:ro`, NGINX_IMAGE);
  const mapped = docker('port', name, '8080/tcp').split('\n')[0]!;
  const edge = `http://127.0.0.1:${mapped.slice(mapped.lastIndexOf(':') + 1)}`;
  await sleep(1_500);
  originHits = 0;
  const ages: number[] = [];
  const cache: Record<string, number> = {};
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    const r = await fetch(`${edge}/x`);
    const body = (await r.json()) as { gen: number };
    ages.push(Date.now() - body.gen);
    const c = r.headers.get('x-cache') ?? '-';
    cache[c] = (cache[c] ?? 0) + 1;
    await sleep(100);
  }
  docker('rm', '-f', '-v', name);
  srv.close();
  const xs = [...ages].sort((a, b) => a - b);
  return { mode, samples: xs.length, originHitsPerS: Math.round((originHits / SECONDS) * 10) / 10, ageP50Ms: xs[Math.floor(xs.length / 2)]!, ageMaxMs: xs[xs.length - 1]!, over1s: xs.filter((a) => a >= 1000).length, cache };
}

test('[실측] nginx는 Expires를 초 단위로 받아 그 초 끝까지 캐시를 살린다(Q-T47 실패의 원인)', async () => {
  const startedAt = new Date().toISOString();
  const next = await run('next');
  const current = await run('current');
  for (const r of [next, current]) {
    const id = nextRunId(`${SIM_DAY}-nginx-expiry-${r.mode}`);
    saveRun(id, { test: 'nginx-expiry', seconds: SECONDS, ...r, bench: { requests: r.samples, error_rate: 0, dropped: 0, p99_ms: r.ageMaxMs } }, {
      kpi: 'NFR-002',
      duration: SECONDS,
      scenario: 'services/queue-svc/test-sim/nginx-expiry.sim.test.ts',
      scenarioArgs: `원본 Expires = ${r.mode === 'next' ? '다음 초 경계(gen + 1초, 지금 규칙)' : '생성한 그 초(gen)'}, nginx 1.27 캐시(Q-T47과 같은 설정), 100ms마다 ${SECONDS}초`,
      notes: `nginx 만료 확인(Q-T47 원인): Expires = ${r.mode === 'next' ? 'gen + 1초' : 'gen'}이면 받은 내용의 나이 p50 ${r.ageP50Ms}ms·최대 ${r.ageMaxMs}ms, 1초 넘은 응답 ${r.over1s}/${r.samples}, 원본 요청 초당 ${r.originHitsPerS}, 캐시 ${JSON.stringify(r.cache)}. 원본은 이 PC의 작은 HTTP 서버(요청마다 지금 초의 내용)`,
    }, startedAt);
  }
  console.log(JSON.stringify({ next, current }));
  expect(next.samples).toBeGreaterThan(0);
}, 120_000);
