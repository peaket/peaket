// 게이트웨이 측정 k6 시나리오(loadtest/scenarios/gw.js)의 응답 분류 시험(V-T43 ②, SR-T13 ②, 묶음 BAT-056 검증의 놓친 결함 M35·M30).
// 고정한 k6 이미지로 gw.js를 실제로 돌려, 상태·Retry-After·Problem 본문·지연을 고른 작은 대역 HTTPS 서버(이 시험이 만든 Node 컨테이너)에 보낸다.
// 그 k6 요약을 실행 도구가 읽는 함수(loadtest/runner/gw.mjs streamMetrics)로 읽어 흐름마다 센 수를 단언한다(판정이 쓰는 원자료를 바깥 경계에서 본다).
// - 두 컨테이너는 이 시험이 만든 내부 전용 Docker 망(--internal, 바깥으로 나가지 않음)에만 붙는다. 이름은 lane1-b056t-gwk6-<실행>으로 시작하고 끝나면 지운다
// - 대역 서버의 TLS 인증서는 이 PC의 openssl로 새로 만들고(임시 폴더), k6는 인증서를 확인하지 않는다(K6_INSECURE_SKIP_TLS_VERIFY)
// - Docker 엔진이나 openssl이 없으면 모두 건너뛴다(scenarios.test.mjs와 같은 법)
// 정본 값: Retry-After는 숫자(초)여야 하고 없거나 빈 값이면 '없음', 숫자가 아니면 '숫자 아님'(docs/infra.md §4.1 '측정(V-T43)'·docs/api/guidelines.md §2),
// Problem 본문은 type about:blank·title·status 세 칸과 application/problem+json(docs/infra.md §4.1 '게이트웨이 오류의 Problem'), 빠른 실패 3ms(V-T43 ②).
// 3ms 경계 자체(3.0 통과·3.01 넘음)는 망을 거친 실행으로는 고를 수 없어 여기서는 '0ms 대역'과 '50ms 대역'의 두 쪽만 본다(계획 '놓친 결함 시험').
// 실행: node --test loadtest/test/gw-scenario.test.mjs
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { K6_IMAGE } from '../runner/manifests.mjs';
import { streamMetrics } from '../runner/gw.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hostPath = (p) => (process.platform === 'win32' ? p.replaceAll('\\', '/') : p);
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' };
/** 대역 서버 이미지(tools/local/gateway-objects.mjs GATEWAY_ECHO_IMAGE와 같은 판) */
const NODE_IMAGE = 'node:24.18.0-bookworm-slim';
const RUN = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const NET = `lane1-b056t-gwk6-${RUN}`;
const SRV = `lane1-b056t-gwk6-srv-${RUN}`;
const HOST = 'gw-fake.test';

// ---- 정본 값 ----
const FAST_FAIL_MS = 3;
const PROBLEM_503 = { type: 'about:blank', title: 'Service Unavailable', status: 503 };
const PROBLEM_429 = { type: 'about:blank', title: 'Too Many Requests', status: 429 };

function run(cmd, args, timeout) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: DOCKER_ENV, timeout, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}
const docker = (args, timeout = 120_000) => run('docker', args, timeout);
function skipReason() {
  try {
    docker(['version', '--format', '{{.Server.Version}}'], 60_000);
  } catch (e) {
    return `Docker가 없어 gw.js 실행 시험을 건너뛴다: ${e.code === 'ENOENT' ? 'docker 명령이 없다' : String(e.stderr ?? e.message).trim().slice(0, 200)}`;
  }
  try {
    run('openssl', ['version'], 30_000);
  } catch {
    return 'openssl이 없어 대역 서버 인증서를 만들 수 없어 건너뛴다';
  }
  return false;
}
const SKIP = skipReason();

/**
 * 대역 서버(Node, 컨테이너 안 443). 경로마다 상태·머리·본문이 정해져 있고, 요청 머리 x-e2e-delay-ms만큼 기다린 뒤 답한다(gateway-echo와 같은 머리).
 * 원문을 파일로 붙인다(바깥 이름을 쓰지 않는다)
 */
const SERVER = `
const https = require('node:https');
const fs = require('node:fs');
const p503 = ${JSON.stringify(JSON.stringify(PROBLEM_503))};
const p429 = ${JSON.stringify(JSON.stringify(PROBLEM_429))};
const PJ = 'application/problem+json';
const routes = {
  '/ra-none': { status: 503, type: PJ, body: p503, headers: {} },
  '/ra-empty': { status: 503, type: PJ, body: p503, headers: { 'Retry-After': '' } },
  '/ra-2': { status: 503, type: PJ, body: p503, headers: { 'Retry-After': '2' } },
  '/ra-abc': { status: 503, type: PJ, body: p503, headers: { 'Retry-After': 'abc' } },
  '/ra-2s': { status: 503, type: PJ, body: p503, headers: { 'Retry-After': '2s' } },
  '/problem-extra': { status: 503, type: PJ, body: JSON.stringify({ ...JSON.parse(p503), detail: 'x' }), headers: { 'Retry-After': '2' } },
  '/problem-json': { status: 503, type: 'application/json', body: p503, headers: { 'Retry-After': '2' } },
  '/r429-abc': { status: 429, type: PJ, body: p429, headers: { 'Retry-After': 'abc' } },
  '/r429-1': { status: 429, type: PJ, body: p429, headers: { 'Retry-After': '1' } },
  '/ok': { status: 200, type: 'application/json', body: '{"ok":true}', headers: {} },
};
https
  .createServer({ key: fs.readFileSync('/srv/key.pem'), cert: fs.readFileSync('/srv/cert.pem') }, (req, res) => {
    const r = routes[req.url.split('?')[0]] || { status: 404, type: 'text/plain', body: 'no', headers: {} };
    const ms = Number(req.headers['x-e2e-delay-ms']) || 0;
    req.resume();
    req.on('end', () =>
      setTimeout(() => {
        res.statusCode = r.status;
        res.setHeader('Content-Type', r.type);
        for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
        res.end(r.body);
      }, ms),
    );
  })
  .listen(443, () => console.log('ready'));
`;

/** 흐름 하나(scenarioInput의 흐름 꼴): 경로마다 초당 rate건, 지연 ms */
const stream = (name, path, expect, ms = 0) => ({
  name,
  host: HOST,
  method: 'GET',
  path,
  token: false,
  rate: 8,
  delay: { kind: 'fixed', ms },
  ip: { kind: 'single', addr: '203.0.113.9' },
  preVUs: 4,
  maxVUs: 20,
  expect: expect === 429 ? { status: 429, title: PROBLEM_429.title } : { status: 503, title: PROBLEM_503.title },
});
const STREAMS = [
  stream('none', '/ra-none', 503),
  stream('empty', '/ra-empty', 503),
  stream('two', '/ra-2', 503),
  stream('abc', '/ra-abc', 503),
  stream('twos', '/ra-2s', 503),
  stream('slow', '/ra-2', 503, 50),
  stream('pextra', '/problem-extra', 503),
  stream('pjson', '/problem-json', 503),
  stream('t429abc', '/r429-abc', 429),
  stream('t429one', '/r429-1', 429),
  stream('ok', '/ok', 503),
];

describe('V-T43 ②·SR-T13 ② k6 시나리오 gw.js의 응답 분류(대역 HTTPS 서버에 실제로 돌림)', { skip: SKIP, concurrency: false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-k6-'));
  const m = {};
  after(() => {
    for (const args of [
      ['rm', '-f', '-v', SRV],
      ['network', 'rm', NET],
    ])
      try {
        docker(args, 60_000);
      } catch {
        // 이미 없다
      }
    rmSync(dir, { recursive: true, force: true });
  });
  before(
    () => {
      for (const img of [K6_IMAGE, NODE_IMAGE])
        try {
          docker(['image', 'inspect', '--format', '{{.Id}}', img], 60_000);
        } catch {
          docker(['pull', '--quiet', img], 600_000);
        }
      run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', `/CN=${HOST}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], 60_000);
      writeFileSync(join(dir, 'server.cjs'), SERVER);
      docker(['network', 'create', '--internal', NET]);
      docker(['run', '-d', '--name', SRV, '--network', NET, '--mount', `type=bind,source=${hostPath(dir)},target=/srv,readonly`, NODE_IMAGE, 'node', '/srv/server.cjs']);
      const until = Date.now() + 60_000;
      while (!docker(['logs', SRV]).includes('ready')) {
        if (Date.now() > until) throw new Error(`대역 서버가 60초 안에 뜨지 않았다: ${docker(['logs', SRV])}`);
        execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
      }
      const ip = docker(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', SRV]).trim();
      assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/, `대역 서버 주소: ${ip}`);
      // scenarioInput(loadtest/runner/gw.mjs)과 같은 꼴의 입력
      writeFileSync(join(dir, 'gw.json'), JSON.stringify({ origin: 'https://www.peaket.example', originVerify: 'v', hosts: { [HOST]: ip }, fastFailMs: FAST_FAIL_MS, normalDelay: [{ ms: 5, weight: 1 }], streams: STREAMS }));
      const env = { GW_FILE: '/srv/gw.json', WARM_S: '1', MAIN_S: '4', USERS_FILE: '/repo/loadtest/test/fixtures/users.json', OUT_DIR: '/out', RUN_TAG: RUN, K6_INSECURE_SKIP_TLS_VERIFY: 'true' };
      const out = mkdtempSync(join(tmpdir(), 'gw-k6-out-'));
      try {
        docker(
          [
            'run',
            '--rm',
            '--name',
            `lane1-b056t-gwk6-k6-${RUN}`,
            '--network',
            NET,
            '--mount',
            `type=bind,source=${hostPath(REPO)},target=/repo,readonly`,
            '--mount',
            `type=bind,source=${hostPath(dir)},target=/srv,readonly`,
            '--mount',
            `type=bind,source=${hostPath(out)},target=/out`,
            '-u',
            '0',
            ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
            K6_IMAGE,
            'run',
            '--quiet',
            '/repo/loadtest/scenarios/gw.js',
          ],
          300_000,
        );
        const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
        for (const s of STREAMS) m[s.name] = streamMetrics(summary, s.name);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    },
    { timeout: 900_000 },
  );

  /** 그 흐름이 기대한 상태로 시험 바탕이 될 만큼(본구간 5건 이상) 받았는가 */
  const base = (name, cls) => {
    const x = m[name];
    assert.ok(x, `${name}: 요약에 흐름이 없다`);
    const n = x.status[cls];
    assert.ok(n >= 5, `${name}: 시험 바탕 모자람(${cls} ${n}건, ${JSON.stringify(x.status)})`);
    assert.equal(n, x.sent, `${name}: 대역이 고른 상태 밖 응답이 있다 ${JSON.stringify(x.status)}`);
    return n;
  };

  test('V-T43 ② M35 Retry-After가 없거나 빈 값인 503은 없음(missing)이고 숫자(num)로 세지 않는다', () => {
    for (const name of ['none', 'empty']) {
      const n = base(name, '503');
      assert.deepEqual(m[name].retryAfter['503'], { num: 0, missing: n, nonnum: 0 }, `${name}: ${JSON.stringify(m[name].retryAfter['503'])}`);
    }
  });

  test('V-T43 ② M35 Retry-After "2"는 숫자, "abc"·"2s"는 숫자 아님이다', () => {
    const two = base('two', '503');
    assert.deepEqual(m.two.retryAfter['503'], { num: two, missing: 0, nonnum: 0 });
    for (const name of ['abc', 'twos']) {
      const n = base(name, '503');
      assert.deepEqual(m[name].retryAfter['503'], { num: 0, missing: 0, nonnum: n }, `${name}: ${JSON.stringify(m[name].retryAfter['503'])}`);
    }
  });

  test('SR-T13 ② M35 429의 Retry-After도 같은 규칙으로 센다("abc"는 숫자 아님, "1"은 숫자)', () => {
    const a = base('t429abc', '429');
    assert.deepEqual(m.t429abc.retryAfter['429'], { num: 0, missing: 0, nonnum: a });
    const o = base('t429one', '429');
    assert.deepEqual(m.t429one.retryAfter['429'], { num: o, missing: 0, nonnum: 0 });
  });

  test('V-T43 ② Problem 본문은 세 칸과 application/problem+json일 때만 맞음이다', () => {
    const two = base('two', '503');
    assert.deepEqual(m.two.problem['503'], { ok: two, bad: 0 });
    for (const name of ['pextra', 'pjson']) {
      const n = base(name, '503');
      assert.deepEqual(m[name].problem['503'], { ok: 0, bad: n }, `${name}: ${JSON.stringify(m[name].problem['503'])}`);
    }
  });

  test('V-T43 ② M30 3ms를 넘은 503을 센다(50ms 대역은 모두, 0ms 대역은 절반 이하)', () => {
    const slow = base('slow', '503');
    assert.equal(m.slow.overFast, slow, `50ms 대역: ${FAST_FAIL_MS}ms를 넘은 수 ${m.slow.overFast} / ${slow}`);
    assert.ok(m.slow.latency['503'].p99 > FAST_FAIL_MS, `50ms 대역 503 p99 ${m.slow.latency['503'].p99}`);
    const fast = base('two', '503');
    assert.ok(m.two.overFast <= fast / 2, `0ms 대역: ${FAST_FAIL_MS}ms를 넘은 수 ${m.two.overFast} / ${fast}(시험 바탕: 망 지연이 크다)`);
  });

  test('V-T43 ② 기대 상태가 아닌 응답(200)은 Retry-After·Problem·3ms 셈에 넣지 않는다', () => {
    const n = base('ok', '2xx');
    assert.deepEqual(m.ok.retryAfter['503'], { num: 0, missing: 0, nonnum: 0 });
    assert.deepEqual(m.ok.problem['503'], { ok: 0, bad: 0 });
    assert.equal(m.ok.overFast, 0);
    assert.ok(n >= 5);
  });
});
