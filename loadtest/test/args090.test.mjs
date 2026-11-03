// BSL-090 Before 측정에서 실행 도구 인자에 더한 것의 시험(docs/verification.md §3.10, loadtest/runner/args.mjs parseArgs JSDoc의
// 'BSL-090(docs/verification.md §3.10)에서 더한 것'). JSDoc을 명세로 보고 계약만 시험한다. BSL-060까지의 규칙은 runner.test.mjs가 본다.
// 클러스터·Docker는 건드리지 않는다.
// 실행: node --test loadtest/test/args090.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GATEWAY_RATE_PER_IP, SCENARIOS, UsageError, parseArgs } from '../runner/args.mjs';

const README = join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md');

// ---------------------------------------------------------------------------------------------
// 공통 도우미(runner.test.mjs와 같은 꼴)
// ---------------------------------------------------------------------------------------------

/** 값이 undefined인 칸을 뺀다. JSDoc의 `promUrl?`·`runId?`·`out?`은 없거나 undefined면 같은 뜻으로 본다 */
const norm = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** 인자 목록을 만든다. 값이 true면 값 없는 인자, undefined·false면 뺀다 */
function argvOf(head, flags) {
  const out = [...head];
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined || v === false) continue;
    out.push(`--${k}`);
    if (v !== true) out.push(String(v));
  }
  return out;
}
const QUEUE = { users: 1000, 'entry-rate': 500, 'admit-per-second': 28 };
const SEAT = { users: 2000, rate: 200 };
const PAY = { users: 9002, rate: 100 }; // 결제 시작 수의 상한 100 × (30 + 60) + 2 = 9,002 = users
const DELTAS = { users: 1000, rate: 300, connections: 5000 }; // IP 몫 300 × 20 = 6,000 ≤ 6 × 10 × 1,000, K4의 연결 5,000개
const GATE = { scanners: 10, rate: 20 }; // IP 몫 20 × 10 ≤ 6 × 10 × 10, 티켓 20 × (30 + 180) + 2 = 4,202
const q = (o = {}) => argvOf(['v0', 'queue'], { ...QUEUE, ...o });
const sh = (o = {}) => argvOf(['v0', 'seat-hold'], { ...SEAT, ...o });
const pay = (o = {}) => argvOf(['v0', 'payment'], { ...PAY, ...o });
const sd = (o = {}) => argvOf(['v0', 'seat-deltas'], { ...DELTAS, ...o });
const gate = (o = {}) => argvOf(['v0', 'gate'], { ...GATE, ...o });
const cal = (o = {}) => argvOf(['calibrate'], o);
const MAKERS = { queue: q, 'seat-hold': sh, payment: pay, 'seat-deltas': sd, gate };
const ALL_V0 = Object.keys(MAKERS);
/** --record에 꼭 있어야 하는 실행 ID까지 */
const REC = { record: true, 'run-id': '2026-11-03-bsl090' };

/** UsageError(한국어 메시지)로 거부하는지. re를 주면 메시지가 그것과 맞는지도 본다 */
function expectUsage(argv, re) {
  assert.throws(
    () => parseArgs(argv),
    (e) => {
      assert.ok(e instanceof UsageError, `UsageError가 아니다(${e?.name}: ${e?.message}) argv=${JSON.stringify(argv)}`);
      assert.equal(e.name, 'UsageError');
      assert.match(e.message, /[가-힣]/, '메시지는 한국어');
      if (re) assert.match(e.message, re);
      return true;
    },
    `거부해야 한다: ${JSON.stringify(argv)}`,
  );
}

/**
 * 돌려주는 꼴 전체를 견준다. 줬을 때만 있는 칸(generators·killAppAtS, --record일 때만 있는 profile)은 expected에 없으면
 * undefined 값의 칸도 없어야 한다(JSDoc '줬을 때만', '--record일 때만 칸이 있으며')
 */
const ONLY_WHEN_GIVEN = ['generators', 'killAppAtS', 'profile'];
function assertShape(argv, expected) {
  const r = parseArgs(argv);
  assert.deepStrictEqual(norm(r), expected);
  for (const k of ONLY_WHEN_GIVEN) {
    assert.equal(Object.hasOwn(r, k), Object.hasOwn(expected, k), `${k} 칸(${r[k]}) argv=${JSON.stringify(argv)}`);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------
// 시나리오 목록과 모든 v0 시나리오의 공통 인자
// ---------------------------------------------------------------------------------------------

test('BSL090_K4_K10_SCENARIOS는seat-deltas·gate를더한다섯이고_parseArgs가모두받는다', () => {
  assert.deepStrictEqual({ ...SCENARIOS }, {
    queue: 'v0-queue.js',
    'seat-hold': 'v0-seat-hold.js',
    payment: 'v0-payment.js',
    'seat-deltas': 'v0-seat-hold.js', // 홀드는 seat-hold 스크립트가 보내고 변경분 연결은 전용 클라이언트가 받는다
    gate: 'v0-gate.js',
  });
  assert.ok(Object.isFrozen(SCENARIOS));
  assert.deepStrictEqual([...ALL_V0].sort(), Object.keys(SCENARIOS).sort());
  for (const [name, mk] of Object.entries(MAKERS)) {
    const r = parseArgs(mk());
    assert.equal(r.command, 'v0', name);
    assert.equal(r.scenario, name);
  }
});

test('BSL090_K1_D-T40_K9_공통인자기본값_namespace는v0·settle·hpaTimeline은false·generators와promUrl칸은없다', () => {
  assertShape(q(), {
    command: 'v0',
    scenario: 'queue',
    users: 1000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    entryRate: 500,
    admitPerSecond: 28,
  });
  for (const [name, mk] of Object.entries(MAKERS)) {
    const r = parseArgs(mk());
    assert.equal(r.namespace, 'v0', name);
    assert.equal(r.settle, false, name);
    assert.equal(r.hpaTimeline, false, name);
    // 주지 않으면 실행 도구가 최고 도착률로 정한다. 돌려주는 꼴에는 줬을 때만 generators
    assert.equal(Object.hasOwn(r, 'generators'), false, `${name}: generators 칸이 있다(${r.generators})`);
    assert.equal(r.promUrl, undefined, name);
  }
});

test('BSL090_K1_D-T40_K9_공통인자를모두주면그값을돌려주고_모든v0시나리오가받는다', () => {
  const a = q({ generators: 8, namespace: 'v0-base', settle: true, 'hpa-timeline': true, ...REC, 'prom-url': 'http://127.0.0.1:9090',
    invariants: true, out: '.cache/x y' });
  assertShape(a, {
    command: 'v0',
    scenario: 'queue',
    users: 1000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: true,
    runId: '2026-11-03-bsl090',
    profile: 'local-1k',
    invariants: true,
    out: '.cache/x y',
    generators: 8,
    namespace: 'v0-base',
    settle: true,
    hpaTimeline: true,
    promUrl: 'http://127.0.0.1:9090',
    entryRate: 500,
    admitPerSecond: 28,
  });
  for (const [name, mk] of Object.entries(MAKERS)) {
    const r = parseArgs(mk({ generators: 64, namespace: 'v0-base', settle: true, 'hpa-timeline': true, ...REC, 'prom-url': 'http://localhost:19090' }));
    assert.deepStrictEqual([r.generators, r.namespace, r.settle, r.hpaTimeline, r.promUrl], [64, 'v0-base', true, true, 'http://localhost:19090'], name);
  }
  // 인자 순서가 달라도 같다(값 없는 인자를 앞에 둬도 다음 인자를 값으로 먹지 않는다)
  const b = ['v0', 'gate', '--settle', '--scanners', '10', '--hpa-timeline', '--namespace', 'v0-base', '--rate', '20', '--generators', '3'];
  assert.deepStrictEqual(norm(parseArgs(b)), norm(parseArgs(gate({ generators: 3, namespace: 'v0-base', settle: true, 'hpa-timeline': true }))));
});

test('BSL090_K1_발생기수_--generators는1~64만받고_줬을때만generators칸이있다 [ASVS v5.0.0-2.2.1]', () => {
  for (const n of [1, 2, 63, 64]) assert.equal(parseArgs(q({ generators: n })).generators, n, `--generators ${n}`);
  // 정수 인자는 10진수로 읽는다(앞의 0은 받는다. 8진수로 읽으면 틀린 값)
  assert.equal(parseArgs(q({ generators: '010' })).generators, 10);
  for (const bad of [0, 65, 100, '-1', '+2', '1.5', '2e1', ' 2', '2 ', '', 'two', '0x10', '٣', '99999999999999999999']) {
    expectUsage(q({ generators: bad }));
  }
  expectUsage(q({ generators: 65 }), /generators/);
  expectUsage(q({ generators: 0 }), /generators/);
  for (const [name, mk] of Object.entries(MAKERS)) {
    assert.equal(parseArgs(mk({ generators: 1 })).generators, 1, name);
    assert.equal(parseArgs(mk({ generators: 64 })).generators, 64, name);
    expectUsage(mk({ generators: 0 }));
    expectUsage(mk({ generators: 65 }));
    assert.equal(Object.hasOwn(parseArgs(mk()), 'generators'), false, name);
  }
});

test('BSL090_D-T40_기준판자리_--namespace는v0·v0-base만받고_기본은v0다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(parseArgs(q()).namespace, 'v0');
  assert.equal(parseArgs(q({ namespace: 'v0' })).namespace, 'v0');
  for (const [name, mk] of Object.entries(MAKERS)) {
    assert.equal(parseArgs(mk({ namespace: 'v0-base' })).namespace, 'v0-base', name);
    assert.equal(parseArgs(mk({ namespace: 'v0' })).namespace, 'v0', name);
  }
  for (const bad of ['V0', 'v0-Base', 'V0-BASE', 'v0_base', 'v0base', 'v0-base-2', 'v1', 'v0 ', ' v0', 'v0-base ', '', 'default', 'loadtest',
    'peaket-local', 'kube-system', 'v0/..', '../v0', 'v0\n', '__proto__', 'constructor', 'toString']) {
    expectUsage(q({ namespace: bad }));
  }
  expectUsage(q({ namespace: 'v1' }), /namespace/);
  expectUsage(gate({ namespace: 'loadtest' }), /namespace/);
});

test('BSL090_K9_--settle·--hpa-timeline은값없는인자이고_주면true다 [ASVS v5.0.0-2.2.1]', () => {
  const both = parseArgs(q({ settle: true, 'hpa-timeline': true }));
  assert.deepStrictEqual([both.settle, both.hpaTimeline], [true, true]);
  const s = parseArgs(sh({ settle: true }));
  assert.deepStrictEqual([s.settle, s.hpaTimeline], [true, false]);
  const h = parseArgs(pay({ 'hpa-timeline': true }));
  assert.deepStrictEqual([h.settle, h.hpaTimeline], [false, true]);
  for (const [name, mk] of Object.entries(MAKERS)) {
    const r = parseArgs(mk({ settle: true, 'hpa-timeline': true }));
    assert.deepStrictEqual([r.settle, r.hpaTimeline], [true, true], name);
  }
  // 값 없는 인자라 뒤의 글을 값으로 먹지 않는다(남는 위치 인자로 거부). --이름=값 꼴과 두 번 준 것도 거부
  expectUsage([...q(), '--settle', 'true']);
  expectUsage([...q(), '--hpa-timeline', 'yes']);
  expectUsage([...q(), '--settle=true']);
  expectUsage([...q(), '--hpa-timeline=1']);
  expectUsage([...q({ settle: true }), '--settle']);
  expectUsage([...q({ 'hpa-timeline': true }), '--hpa-timeline']);
});

test('BSL090_NFR-013_프롬주소_--prom-url은--record와함께만_127.0.0.1·localhost와포트1~65535꼴만받는다 [ASVS v5.0.0-2.2.1]', () => {
  const prom = (url, mk = q) => mk({ ...REC, 'prom-url': url });
  for (const url of ['http://127.0.0.1:9090', 'http://localhost:9090', 'http://127.0.0.1:1', 'http://localhost:1', 'http://127.0.0.1:65535',
    'http://localhost:65535', 'http://127.0.0.1:19090']) {
    assert.equal(parseArgs(prom(url)).promUrl, url, url);
  }
  // 모든 v0 시나리오가 받는다
  for (const [name, mk] of Object.entries(MAKERS)) assert.equal(parseArgs(prom('http://localhost:9090', mk)).promUrl, 'http://localhost:9090', name);
  // --record 없이는 받지 않는다(어느 시나리오든, 메시지는 무엇이 틀렸는지 적는다)
  for (const mk of Object.values(MAKERS)) expectUsage(mk({ 'prom-url': 'http://127.0.0.1:9090' }), /prom-url|record/);
  // 그 꼴이 아니면 거부: https, 다른 주소(같은 루프백의 다른 표기 포함), 사용자 정보, 포트 없음·범위 밖, 뒤에 붙은 경로·질의·조각, 공백
  const bad = [
    'https://127.0.0.1:9090',
    'https://localhost:9090',
    'http://127.0.0.2:9090',
    'http://0.0.0.0:9090',
    'http://10.0.0.5:9090',
    'http://198.18.0.1:9090',
    'http://prometheus.observability.svc:9090',
    'http://prometheus.observability.svc.cluster.local:9090',
    'http://localhost.peaket.example:9090',
    'http://127.0.0.1.nip.io:9090',
    'http://[::1]:9090',
    'http://127.1:9090',
    'http://2130706433:9090',
    'http://0x7f000001:9090',
    'http://user@127.0.0.1:9090',
    'http://user:pw@localhost:9090',
    'http://localhost:9090@evil.example:80',
    'http://127.0.0.1',
    'http://localhost',
    'http://127.0.0.1:',
    'http://127.0.0.1:0',
    'http://localhost:0',
    'http://127.0.0.1:65536',
    'http://localhost:99999',
    'http://127.0.0.1:-1',
    'http://127.0.0.1:+9090',
    'http://127.0.0.1:9a90',
    'http://127.0.0.1:9090/',
    'http://127.0.0.1:9090/api/v1',
    'http://localhost:9090/metrics',
    'http://127.0.0.1:9090?x=1',
    'http://127.0.0.1:9090#x',
    'http://127.0.0.1:9090 ',
    ' http://127.0.0.1:9090',
    'http://127.0.0.1:9090\n',
    'http://127.0.0.1 :9090',
    '127.0.0.1:9090',
    'localhost:9090',
    '//127.0.0.1:9090',
    'ftp://127.0.0.1:9090',
    'http:/127.0.0.1:9090',
    'http:127.0.0.1:9090',
    '',
    // 주소 해석기가 같은 주소로 맞춰 주는 다른 표기도 그 꼴이 아니다(대문자 스킴·이름, 끝 점, 전각 숫자 포트, 포트 둘)
    'HTTP://127.0.0.1:9090',
    'http://LOCALHOST:9090',
    'http://Localhost:9090',
    'http://localhost.:9090',
    'http://127.0.0.1:９０９０',
    'http://127.0.0.1:9090:9091',
  ];
  for (const url of bad) expectUsage(prom(url));
  expectUsage(prom('https://127.0.0.1:9090'), /prom-url/);
  expectUsage(prom('http://127.0.0.1:65536'), /prom-url/);
});

// ---------------------------------------------------------------------------------------------
// seat-hold: --keep, --db-stats
// ---------------------------------------------------------------------------------------------

test('BSL090_S-T1_seat-hold돌려주는꼴_keep·dbStats는기본false다', () => {
  const expected = {
    command: 'v0',
    scenario: 'seat-hold',
    users: 2000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    rate: 200,
    mode: 'spread',
    holdSize: 2,
    hotCount: 1,
    pairs: 1,
    releaseMs: 0,
    keep: false,
    dbStats: false,
  };
  assertShape(sh(), expected);
  // --keep이면 release-ms는 주지 않은 기본값 그대로다
  assertShape(sh({ keep: true, 'db-stats': true }), { ...expected, keep: true, dbStats: true });
  // 인기 좌석에 몰려 홀드를 놓지 않는 실행(S-T1: 한 명만 성공하고 나머지는 409)
  const hot = parseArgs(sh({ mode: 'hot', keep: true }));
  assert.deepStrictEqual([hot.mode, hot.keep, hot.releaseMs], ['hot', true, 0]);
});

test('BSL090_S-T1_seat-hold_--keep이면IP몫규칙이rate×10≤6×한도×users다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(GATEWAY_RATE_PER_IP, 10, '아래 경계는 입구의 IP당 한도 초당 10으로 셈했다');
  // users 100: --keep 없으면 rate × 20 ≤ 6,000(rate 300까지), --keep이면 rate × 10 ≤ 6,000(rate 600까지)
  assert.equal(parseArgs(sh({ users: 100, rate: 300 })).rate, 300);
  expectUsage(sh({ users: 100, rate: 301 }));
  assert.equal(parseArgs(sh({ users: 100, rate: 301, keep: true })).rate, 301);
  assert.equal(parseArgs(sh({ users: 100, rate: 600, keep: true })).rate, 600);
  expectUsage(sh({ users: 100, rate: 601, keep: true }));
  // 가장 작은 경계: users 1이면 --keep 6까지, 없으면 3까지
  assert.equal(parseArgs(sh({ users: 1, rate: 6, keep: true })).rate, 6);
  expectUsage(sh({ users: 1, rate: 7, keep: true }));
  assert.equal(parseArgs(sh({ users: 1, rate: 3 })).rate, 3);
  expectUsage(sh({ users: 1, rate: 4 }));
  // 도착률 최댓값: 100,000 × 10 = 1,000,000 ≤ 60 × 16,667 = 1,000,020, 16,666명이면 999,960이라 거부
  assert.equal(parseArgs(sh({ users: 16667, rate: 100000, keep: true })).users, 16667);
  expectUsage(sh({ users: 16666, rate: 100000, keep: true }));
  expectUsage(sh({ users: 16667, rate: 100000 })); // --keep이 없으면 × 20이라 거부
});

test('BSL090_S-T1_seat-hold_--keep은--release-ms와함께줄수없다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(parseArgs(sh({ keep: true })).keep, true);
  assert.equal(parseArgs(sh()).keep, false);
  assert.equal(parseArgs(sh({ 'release-ms': 1500 })).releaseMs, 1500); // --keep이 없으면 그대로 받는다
  // 값이 기본값(0)과 같아도 함께 주면 거부
  for (const ms of [0, 1, 1500, 600000]) expectUsage(sh({ keep: true, 'release-ms': ms }));
  expectUsage(sh({ keep: true, 'release-ms': 1500 }), /keep|release-ms/);
  expectUsage(['v0', 'seat-hold', '--release-ms', '0', '--users', '2000', '--keep', '--rate', '200']);
  // 값 없는 인자다
  expectUsage([...sh(), '--keep', 'true']);
  expectUsage([...sh(), '--keep=true']);
  expectUsage([...sh({ keep: true }), '--keep']);
});

test('BSL090_S-T10_--db-stats는seat-hold·payment에서만받는다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(parseArgs(sh({ 'db-stats': true })).dbStats, true);
  assert.equal(parseArgs(pay({ 'db-stats': true })).dbStats, true);
  assert.equal(parseArgs(sh()).dbStats, false);
  assert.equal(parseArgs(pay()).dbStats, false);
  for (const a of [q({ 'db-stats': true }), sd({ 'db-stats': true }), gate({ 'db-stats': true }), cal({ 'db-stats': true })]) expectUsage(a, /db-stats/);
  expectUsage([...pay(), '--db-stats', 'yes']);
  expectUsage([...pay(), '--db-stats=true']);
  expectUsage([...sh({ 'db-stats': true }), '--db-stats']);
});

// ---------------------------------------------------------------------------------------------
// payment: 장애 주입(P-T1)
// ---------------------------------------------------------------------------------------------

test('BSL090_P-T1_payment돌려주는꼴_faultDropPct·faultDelayPct·killAppAtS·dbStats', () => {
  const expected = {
    command: 'v0',
    scenario: 'payment',
    users: 9002,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    rate: 100,
    seatsPerOrder: 2,
    faultDropPct: 0,
    faultDelayPct: 0,
    dbStats: false,
  };
  const d = assertShape(pay(), expected);
  assert.equal(Object.hasOwn(d, 'killAppAtS'), false, `주지 않았는데 killAppAtS 칸이 있다(${d.killAppAtS})`);
  assertShape(pay({ 'fault-drop-pct': 10, 'fault-delay-pct': 20, 'kill-app-at': 30, 'db-stats': true }), {
    ...expected,
    faultDropPct: 10,
    faultDelayPct: 20,
    killAppAtS: 30,
    dbStats: true,
  });
});

test('BSL090_P-T1_결제장애비율_--fault-drop-pct·--fault-delay-pct는각0~100·합100이하·기본0이다 [ASVS v5.0.0-2.2.1]', () => {
  const pct = (r) => [r.faultDropPct, r.faultDelayPct];
  assert.deepStrictEqual(pct(parseArgs(pay())), [0, 0]);
  // 하나만 주면 다른 하나는 기본 0
  assert.deepStrictEqual(pct(parseArgs(pay({ 'fault-drop-pct': 100 }))), [100, 0]);
  assert.deepStrictEqual(pct(parseArgs(pay({ 'fault-delay-pct': 100 }))), [0, 100]);
  assert.deepStrictEqual(pct(parseArgs(pay({ 'fault-drop-pct': 7 }))), [7, 0]);
  for (const [drop, delay] of [[0, 0], [100, 0], [0, 100], [60, 40], [40, 60], [50, 50], [1, 99], [99, 1], [0, 1], [1, 0]]) {
    assert.deepStrictEqual(pct(parseArgs(pay({ 'fault-drop-pct': drop, 'fault-delay-pct': delay }))), [drop, delay], `${drop}+${delay}`);
  }
  // 각 0~100, 합 100 이하(하나 넘으면 거부)
  for (const [drop, delay] of [[101, undefined], [undefined, 101], [101, 0], [0, 101], [60, 41], [41, 60], [100, 1], [1, 100], [51, 50],
    [100, 100]]) {
    expectUsage(pay({ 'fault-drop-pct': drop, 'fault-delay-pct': delay }));
  }
  for (const v of ['-1', '+5', 'abc', '', '50%', '1e1', '0x10', ' 5']) {
    expectUsage(pay({ 'fault-drop-pct': v }));
    expectUsage(pay({ 'fault-delay-pct': v }));
  }
  expectUsage(pay({ 'fault-drop-pct': 101 }), /fault-drop-pct/);
  expectUsage(pay({ 'fault-delay-pct': 101 }), /fault-delay-pct/);
});

test('BSL090_P-T1_앱멈추기_--kill-app-at은1~main정수이고_줬을때만killAppAtS칸이있다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(Object.hasOwn(parseArgs(pay()), 'killAppAtS'), false);
  assert.equal(parseArgs(pay({ 'kill-app-at': 1 })).killAppAtS, 1);
  assert.equal(parseArgs(pay({ 'kill-app-at': 30 })).killAppAtS, 30);
  assert.equal(parseArgs(pay({ 'kill-app-at': 60 })).killAppAtS, 60); // 본구간(기본 60초)과 같으면 받는다
  expectUsage(pay({ 'kill-app-at': 61 }));
  expectUsage(pay({ 'kill-app-at': 0 }));
  // main을 바꾸면 그 main까지(결제 시작 수의 상한 100 × (30 + 120) + 2 = 15,002 ≤ users)
  const long = { users: 15002, main: 120 };
  assert.equal(parseArgs(pay({ ...long, 'kill-app-at': 120 })).killAppAtS, 120);
  expectUsage(pay({ ...long, 'kill-app-at': 121 }));
  // 가장 짧은 본구간 5초
  const short = { users: 8, rate: 1, warm: 1, main: 5 };
  assert.equal(parseArgs(pay({ ...short, 'kill-app-at': 5 })).killAppAtS, 5);
  expectUsage(pay({ ...short, 'kill-app-at': 6 }));
  // 가장 긴 본구간 7,200초도 main까지 받는다(정한 상한이 따로 없다. 결제 시작 수의 상한 1 × (1 + 7,200) + 2 = 7,203 ≤ users)
  const longest = { users: 7203, rate: 1, warm: 1, main: 7200 };
  assert.equal(parseArgs(pay({ ...longest, 'kill-app-at': 7200 })).killAppAtS, 7200);
  expectUsage(pay({ ...longest, 'kill-app-at': 7201 }));
  // 정수만(10진수 숫자)
  for (const v of ['-1', '1.5', '+1', 'abc', '', '1e1', ' 1', '0x1']) expectUsage(pay({ 'kill-app-at': v }));
  expectUsage(pay({ 'kill-app-at': 0 }), /kill-app-at/);
  expectUsage(pay({ 'kill-app-at': 61 }), /kill-app-at/);
});

// ---------------------------------------------------------------------------------------------
// seat-deltas(K4, S-T12)
// ---------------------------------------------------------------------------------------------

test('BSL090_K4_S-T12_seat-deltas_users·rate·connections가꼭있어야하고_돌려주는꼴', () => {
  assertShape(sd(), {
    command: 'v0',
    scenario: 'seat-deltas',
    users: 1000,
    warmS: 30,
    mainS: 60,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    rate: 300,
    connections: 5000,
    listenerPods: 10, // ⌈5,000 ÷ 500⌉
    holdSize: 2,
  });
  // 모두 바꾸면 그 값(IP 몫 1,500 × 20 = 30,000 = 6 × 10 × 500은 같아서 받는다)
  const all = sd({ users: 500, rate: 1500, connections: 64, 'listener-pods': 64, 'hold-size': 4, warm: 10, main: 120, cpus: 8, 'memory-mi': 8192,
    generators: 2, namespace: 'v0-base', settle: true, 'hpa-timeline': true, record: true, 'run-id': '2026-11-03-k4-v0-local-1k',
    'prom-url': 'http://127.0.0.1:9090', invariants: true, out: 'o' });
  assertShape(all, {
    command: 'v0',
    scenario: 'seat-deltas',
    users: 500,
    warmS: 10,
    mainS: 120,
    cpus: 8,
    memoryMi: 8192,
    record: true,
    runId: '2026-11-03-k4-v0-local-1k',
    profile: 'local-1k',
    invariants: true,
    out: 'o',
    generators: 2,
    namespace: 'v0-base',
    settle: true,
    hpaTimeline: true,
    promUrl: 'http://127.0.0.1:9090',
    rate: 1500,
    connections: 64,
    listenerPods: 64,
    holdSize: 4,
  });
  for (const missing of ['users', 'rate', 'connections']) expectUsage(sd({ [missing]: undefined }), new RegExp(missing));
  expectUsage(['v0', 'seat-deltas']);
});

test('BSL090_K4_S-T12_seat-deltas_connections는1~20000·listener-pods는1~64·기본⌈connections÷500⌉·connections이하 [ASVS v5.0.0-2.2.1]', () => {
  for (const [c, p] of [[1, 1], [2, 1], [499, 1], [500, 1], [501, 2], [1000, 2], [1001, 3], [5000, 10], [5001, 11], [19999, 40], [20000, 40]]) {
    const r = parseArgs(sd({ connections: c }));
    assert.equal(r.connections, c);
    assert.equal(r.listenerPods, p, `connections=${c}`);
  }
  expectUsage(sd({ connections: 0 }));
  expectUsage(sd({ connections: 20001 }));
  expectUsage(sd({ connections: 20001 }), /connections/);
  // listener-pods 1~64
  assert.equal(parseArgs(sd({ 'listener-pods': 1 })).listenerPods, 1);
  assert.equal(parseArgs(sd({ 'listener-pods': 64 })).listenerPods, 64);
  expectUsage(sd({ 'listener-pods': 0 }));
  expectUsage(sd({ 'listener-pods': 65 }));
  expectUsage(sd({ 'listener-pods': 65 }), /listener-pods/);
  // listener-pods ≤ connections(받는 파드보다 연결이 적으면 빈 파드가 생긴다)
  assert.equal(parseArgs(sd({ connections: 10, 'listener-pods': 10 })).listenerPods, 10);
  expectUsage(sd({ connections: 10, 'listener-pods': 11 }));
  assert.equal(parseArgs(sd({ connections: 1, 'listener-pods': 1 })).listenerPods, 1);
  expectUsage(sd({ connections: 1, 'listener-pods': 2 }));
  assert.equal(parseArgs(sd({ connections: 64, 'listener-pods': 64 })).listenerPods, 64);
  expectUsage(sd({ connections: 63, 'listener-pods': 64 }));
  // hold-size 1~4, 기본 2
  assert.equal(parseArgs(sd()).holdSize, 2);
  assert.equal(parseArgs(sd({ 'hold-size': 1 })).holdSize, 1);
  assert.equal(parseArgs(sd({ 'hold-size': 4 })).holdSize, 4);
  expectUsage(sd({ 'hold-size': 0 }));
  expectUsage(sd({ 'hold-size': 5 }));
  // 정수만(10진수 숫자)
  for (const v of ['-1', '1.5', '+1', 'abc', '', '1e3', ' 1']) {
    expectUsage(sd({ connections: v }));
    expectUsage(sd({ 'listener-pods': v }));
  }
});

test('BSL090_K4_S-T12_seat-deltas_users+connections≤131072이고_IP몫은seat-hold와같다 [ASVS v5.0.0-2.2.1]', () => {
  // 가상 사용자와 변경분 연결을 합쳐 131,072까지
  assert.equal(parseArgs(sd({ users: 111072, rate: 1, connections: 20000 })).users, 111072);
  expectUsage(sd({ users: 111073, rate: 1, connections: 20000 }));
  assert.equal(parseArgs(sd({ users: 131071, rate: 1, connections: 1 })).users, 131071);
  expectUsage(sd({ users: 131072, rate: 1, connections: 1 }));
  // IP 몫: 홀드를 잡자마자 놓으므로 rate × 20 ≤ 6 × 한도 × users(한도 10)
  assert.equal(GATEWAY_RATE_PER_IP, 10, '아래 경계는 입구의 IP당 한도 초당 10으로 셈했다');
  assert.equal(parseArgs(sd({ users: 100, rate: 300, connections: 100 })).rate, 300);
  expectUsage(sd({ users: 100, rate: 301, connections: 100 }));
  assert.equal(parseArgs(sd({ users: 1, rate: 3, connections: 1 })).rate, 3);
  expectUsage(sd({ users: 1, rate: 4, connections: 1 }));
  assert.equal(parseArgs(sd({ users: 33334, rate: 100000, connections: 1 })).rate, 100000); // 2,000,000 ≤ 2,000,040(받는 가장 작은 users)
  expectUsage(sd({ users: 33333, rate: 100000, connections: 1 })); // 2,000,000 > 1,999,980
});

test('BSL090_K4_S-T12_seat-deltas_토큰수명의준비시간은users+connections로센다 [ASVS v5.0.0-2.2.1]', () => {
  // 준비 2 × ⌈20,200 ÷ min(20,200, 200)⌉ + 3 = 205초. 205 + warm + 7,200 + 60 + 600 ≤ 10,800 → warm ≤ 2,735
  const big = { users: 200, rate: 1, connections: 20000, main: 7200 };
  assert.equal(parseArgs(sd({ ...big, warm: 2735 })).warmS, 2735);
  expectUsage(sd({ ...big, warm: 2736 })); // 가상 사용자만 셌다면(준비 5초) 받았을 값
  // 연결이 적으면 준비가 짧다: 2 × ⌈201 ÷ 200⌉ + 3 = 7초 → warm ≤ 2,933
  const small = { users: 200, rate: 1, connections: 1, main: 7200 };
  assert.equal(parseArgs(sd({ ...small, warm: 2933 })).warmS, 2933);
  expectUsage(sd({ ...small, warm: 2934 }));
  // 나누는 수도 합으로 센다: min(10 + 20,000, 200) = 200 → 2 × ⌈20,010 ÷ 200⌉ + 3 = 205초 → warm ≤ 2,735
  // (min(users, 200) = 10으로 나누면 준비 4,005초라 받을 수 없다)
  const few = { users: 10, rate: 1, connections: 20000, main: 7200 };
  assert.equal(parseArgs(sd({ ...few, warm: 2735 })).warmS, 2735);
  expectUsage(sd({ ...few, warm: 2736 }));
});

test('BSL090_K4_S-T12_seat-deltas_--record의프로파일기본은users로정한다(연결수는세지않는다)', () => {
  // 프로파일 기본 규칙(사용자 수: 1,000 이하 local-1k, 10,000 이하 local-10k, 그 밖 local-100k)을 바꾼 것은 gate(scanners)뿐이다
  assert.equal(parseArgs(sd({ ...REC })).profile, 'local-1k'); // users 1,000(연결과 합치면 6,000)
  assert.equal(parseArgs(sd({ users: 1001, ...REC })).profile, 'local-10k');
  assert.equal(parseArgs(sd({ users: 10000, connections: 20000, ...REC })).profile, 'local-10k'); // 합치면 30,000
  assert.equal(parseArgs(sd({ users: 10001, ...REC })).profile, 'local-100k');
  assert.equal(parseArgs(sd({ ...REC, profile: 'local-k4' })).profile, 'local-k4');
  assert.equal(Object.hasOwn(parseArgs(sd()), 'profile'), false);
});

// ---------------------------------------------------------------------------------------------
// gate(K10)
// ---------------------------------------------------------------------------------------------

test('BSL090_K10_gate_scanners·rate가꼭있어야하고_users는받지않으며_돌려주는꼴의users는scanners다', () => {
  assertShape(gate(), {
    command: 'v0',
    scenario: 'gate',
    users: 10,
    warmS: 30,
    mainS: 180,
    cpus: 4,
    memoryMi: 4096,
    record: false,
    invariants: false,
    namespace: 'v0',
    settle: false,
    hpaTimeline: false,
    scanners: 10,
    rate: 20,
    cutAtS: 60,
    cutS: 60,
    tickets: 4202, // 20 × (30 + 180) + 2
  });
  const all = gate({ scanners: 200, rate: 100, 'cut-at': 30, 'cut-s': 45, warm: 20, main: 90, cpus: 8, 'memory-mi': 8192, generators: 2,
    namespace: 'v0-base', settle: true, 'hpa-timeline': true, record: true, 'run-id': '2026-11-03-k10-v0-local-1k',
    'prom-url': 'http://localhost:9090', invariants: true, out: 'o' });
  assertShape(all, {
    command: 'v0',
    scenario: 'gate',
    users: 200,
    warmS: 20,
    mainS: 90,
    cpus: 8,
    memoryMi: 8192,
    record: true,
    runId: '2026-11-03-k10-v0-local-1k',
    profile: 'local-1k',
    invariants: true,
    out: 'o',
    generators: 2,
    namespace: 'v0-base',
    settle: true,
    hpaTimeline: true,
    promUrl: 'http://localhost:9090',
    scanners: 200,
    rate: 100,
    cutAtS: 30,
    cutS: 45,
    tickets: 11002, // 100 × (20 + 90) + 2
  });
  for (const n of [1, 7, 1000]) {
    const r = parseArgs(gate({ scanners: n, rate: 1 }));
    assert.equal(r.users, n);
    assert.equal(r.scanners, n);
  }
  for (const missing of ['scanners', 'rate']) expectUsage(gate({ [missing]: undefined }), new RegExp(missing));
  expectUsage(['v0', 'gate']);
  // --users는 받지 않는다(--scanners와 함께든 대신이든)
  expectUsage(gate({ users: 10 }));
  expectUsage(gate({ users: 10 }), /users/);
  expectUsage(argvOf(['v0', 'gate'], { users: 10, rate: 20 }));
});

test('BSL090_K10_gate_scanners와rate는1~1000이다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(parseArgs(gate({ scanners: 1, rate: 1 })).scanners, 1);
  assert.equal(parseArgs(gate({ scanners: 1000, rate: 1 })).scanners, 1000);
  expectUsage(gate({ scanners: 0, rate: 1 }));
  expectUsage(gate({ scanners: 1001, rate: 1 }));
  expectUsage(gate({ scanners: 1001, rate: 1 }), /scanners/);
  // rate 1,000: 티켓 1,000 × (1 + 98) + 2 = 99,002, IP 몫 1,000 ≤ 6 × 167 = 1,002, 끊기 1 + 1 < 98
  const fast = { scanners: 167, warm: 1, main: 98, 'cut-at': 1, 'cut-s': 1 };
  assert.equal(parseArgs(gate({ ...fast, rate: 1000 })).rate, 1000);
  assert.equal(parseArgs(gate({ ...fast, rate: 1000 })).tickets, 99002);
  // 1,001은 티켓(99,101)·IP 몫(1,001 ≤ 1,002)은 지키지만 gate의 범위(1~1,000) 밖이다
  expectUsage(gate({ ...fast, rate: 1001 }));
  expectUsage(gate({ ...fast, rate: 1001 }), /rate/);
  expectUsage(gate({ rate: 0 }));
  for (const v of ['-1', '1.5', '+1', 'abc', '', '1e2', ' 1']) {
    expectUsage(gate({ scanners: v }));
    expectUsage(gate({ rate: v }));
  }
});

test('BSL090_K10_gate_망끊기는cut-at≥1·cut-at+cut-s<main이고_기본은60·60·main180 [ASVS v5.0.0-2.2.1]', () => {
  const d = parseArgs(gate());
  assert.deepStrictEqual([d.cutAtS, d.cutS, d.mainS, d.warmS], [60, 60, 180, 30]);
  assert.equal(parseArgs(gate({ main: 180 })).mainS, 180);
  // cut-at ≥ 1
  assert.equal(parseArgs(gate({ 'cut-at': 1 })).cutAtS, 1);
  expectUsage(gate({ 'cut-at': 0 }));
  expectUsage(gate({ 'cut-at': 0 }), /cut-at/);
  // cut-at + cut-s < main(같으면 거부)
  assert.equal(parseArgs(gate({ 'cut-at': 119 })).cutAtS, 119); // 119 + 60 = 179 < 180
  expectUsage(gate({ 'cut-at': 120 })); // 180
  assert.equal(parseArgs(gate({ 'cut-s': 119 })).cutS, 119);
  expectUsage(gate({ 'cut-s': 120 }));
  assert.equal(parseArgs(gate({ 'cut-s': 1 })).cutS, 1);
  assert.equal(parseArgs(gate({ 'cut-at': 100, 'cut-s': 79 })).cutS, 79);
  expectUsage(gate({ 'cut-at': 100, 'cut-s': 80 }));
  // main을 바꾸면 기본 끊기(60 + 60 = 120)와 견준다
  assert.equal(parseArgs(gate({ main: 121 })).mainS, 121);
  expectUsage(gate({ main: 120 }));
  expectUsage(gate({ main: 60 })); // 다른 시나리오의 기본 main(60)은 gate의 기본 끊기를 담지 못한다
  // 가장 짧은 본구간 5초도 끊기를 맞추면 받는다
  assert.equal(parseArgs(gate({ main: 5, 'cut-at': 1, 'cut-s': 3 })).mainS, 5);
  expectUsage(gate({ main: 5, 'cut-at': 1, 'cut-s': 4 }));
  expectUsage(gate({ main: 5, 'cut-at': 2, 'cut-s': 3 }));
  // 가장 긴 본구간(티켓 10 × (30 + 7,200) + 2 = 72,302)
  assert.equal(parseArgs(gate({ rate: 10, main: 7200, 'cut-at': 7000, 'cut-s': 199 })).cutS, 199);
  expectUsage(gate({ rate: 10, main: 7200, 'cut-at': 7000, 'cut-s': 200 }));
  // 끊는 길이도 main 말고는 따로 정한 상한이 없다(1 + 7,198 = 7,199 < 7,200)
  assert.equal(parseArgs(gate({ rate: 10, main: 7200, 'cut-at': 1, 'cut-s': 7198 })).cutS, 7198);
  expectUsage(gate({ rate: 10, main: 7200, 'cut-at': 1, 'cut-s': 7199 }));
  for (const v of ['-1', '+1', 'abc', '']) {
    expectUsage(gate({ 'cut-at': v }));
    expectUsage(gate({ 'cut-s': v }));
  }
});

test('BSL090_K10_gate_티켓수rate×(warm+main)+2는100000이하다 [ASVS v5.0.0-2.2.1]', () => {
  // 기본 warm 30 + main 180 = 210초
  assert.equal(parseArgs(gate({ scanners: 100, rate: 476 })).tickets, 99962);
  expectUsage(gate({ scanners: 100, rate: 477 })); // 100,172
  // + 2까지 센다: 500 × 200 = 100,000이어도 + 2라 넘는다
  assert.equal(parseArgs(gate({ scanners: 100, rate: 500, warm: 19 })).tickets, 99502);
  expectUsage(gate({ scanners: 100, rate: 500, warm: 20 }));
  // 닿을 수 있는 가장 가까운 두 값(정확히 100,000장은 rate ≤ 1,000·warm + main ≤ 10,800으로 만들 수 없다):
  // 277 × (30 + 331) + 2 = 99,999는 받고, 271 × (30 + 339) + 2 = 100,001은 거부('+ 1'로 세면 100,000이라 받았을 값)
  assert.equal(parseArgs(gate({ scanners: 100, rate: 277, main: 331 })).tickets, 99999);
  expectUsage(gate({ scanners: 100, rate: 271, main: 339 }));
  // 가장 작은 실행: 1 × (1 + 5) + 2 = 8장
  assert.equal(parseArgs(gate({ scanners: 1, rate: 1, warm: 1, main: 5, 'cut-at': 1, 'cut-s': 1 })).tickets, 8);
  assert.equal(parseArgs(gate()).tickets, 4202);
});

test('BSL090_K10_gate_IP몫은rate×10≤6×한도×scanners다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(GATEWAY_RATE_PER_IP, 10, '아래 경계는 입구의 IP당 한도 초당 10으로 셈했다');
  assert.equal(parseArgs(gate({ scanners: 10, rate: 60 })).rate, 60);
  expectUsage(gate({ scanners: 10, rate: 61 }));
  assert.equal(parseArgs(gate({ scanners: 1, rate: 6 })).rate, 6);
  expectUsage(gate({ scanners: 1, rate: 7 }));
  // rate 476(기본 길이의 티켓 상한 안): scanners 80부터(6 × 80 = 480), 79면 474라 거부
  assert.equal(parseArgs(gate({ scanners: 80, rate: 476 })).rate, 476);
  expectUsage(gate({ scanners: 79, rate: 476 }));
});

test('BSL090_K10_gate_토큰수명의준비시간은scanners로센다 [ASVS v5.0.0-2.2.1]', () => {
  const slow = { rate: 1, main: 7200 };
  // scanners 1,000: 준비 2 × ⌈1,000 ÷ 200⌉ + 3 = 13초. 13 + warm + 7,200 + 60 + 600 ≤ 10,800 → warm ≤ 2,927
  assert.equal(parseArgs(gate({ ...slow, scanners: 1000, warm: 2927 })).warmS, 2927);
  expectUsage(gate({ ...slow, scanners: 1000, warm: 2928 }));
  // scanners 1: 준비 2 × 1 + 3 = 5초 → warm ≤ 2,935
  assert.equal(parseArgs(gate({ ...slow, scanners: 1, warm: 2935 })).warmS, 2935);
  expectUsage(gate({ ...slow, scanners: 1, warm: 2936 }));
});

test('BSL090_K10_gate_--record의프로파일기본은scanners로정한다', () => {
  // 티켓이 10만 장에 가까워도 검표 스태프 수(1,000 이하)로 정한다
  assert.equal(parseArgs(gate({ scanners: 100, rate: 476, ...REC })).profile, 'local-1k');
  assert.equal(parseArgs(gate({ scanners: 1000, rate: 1, ...REC })).profile, 'local-1k');
  assert.equal(parseArgs(gate({ scanners: 1, rate: 1, ...REC })).profile, 'local-1k');
  assert.equal(parseArgs(gate({ ...REC, profile: 'local-gate' })).profile, 'local-gate');
  assert.equal(Object.hasOwn(parseArgs(gate()), 'profile'), false);
  expectUsage(gate({ profile: 'local-gate' })); // --record 없이 --profile은 거부(그대로)
});

// ---------------------------------------------------------------------------------------------
// 인자가 놓일 자리
// ---------------------------------------------------------------------------------------------

/** [인자, 값(true면 값 없는 인자), 돌려주는 칸, 그 칸의 값, 받는 시나리오] */
const PLACED = [
  ['generators', 2, 'generators', 2, ALL_V0],
  ['namespace', 'v0-base', 'namespace', 'v0-base', ALL_V0],
  ['settle', true, 'settle', true, ALL_V0],
  ['hpa-timeline', true, 'hpaTimeline', true, ALL_V0],
  ['keep', true, 'keep', true, ['seat-hold']],
  ['db-stats', true, 'dbStats', true, ['seat-hold', 'payment']],
  ['fault-drop-pct', 10, 'faultDropPct', 10, ['payment']],
  ['fault-delay-pct', 10, 'faultDelayPct', 10, ['payment']],
  ['kill-app-at', 30, 'killAppAtS', 30, ['payment']],
  ['connections', 100, 'connections', 100, ['seat-deltas']],
  ['listener-pods', 1, 'listenerPods', 1, ['seat-deltas']],
  ['scanners', 10, 'scanners', 10, ['gate']],
  ['cut-at', 30, 'cutAtS', 30, ['gate']],
  ['cut-s', 30, 'cutS', 30, ['gate']],
  ['hold-size', 3, 'holdSize', 3, ['seat-hold', 'seat-deltas']],
];

test('BSL090_새인자는정한시나리오에서만받고_calibrate는받지않는다 [ASVS v5.0.0-2.2.1]', () => {
  for (const [flag, v, key, value, allowed] of PLACED) {
    for (const [name, mk] of Object.entries(MAKERS)) {
      const argv = mk({ [flag]: v });
      if (allowed.includes(name)) assert.equal(parseArgs(argv)[key], value, `${name} --${flag}`);
      else expectUsage(argv, new RegExp(flag));
    }
    expectUsage(cal({ [flag]: v }), new RegExp(flag));
  }
  // --prom-url은 모든 v0 시나리오가 --record와 함께 받고, calibrate는 --record가 있어도 받지 않는다
  for (const [name, mk] of Object.entries(MAKERS)) assert.equal(parseArgs(mk({ ...REC, 'prom-url': 'http://127.0.0.1:9090' })).promUrl, 'http://127.0.0.1:9090', name);
  expectUsage(cal({ record: true, 'prom-url': 'http://127.0.0.1:9090' }), /prom-url/);
  // 정리 명령은 여전히 인자를 받지 않는다
  expectUsage(['cleanup', '--generators', '2']);
  expectUsage(['cleanup', '--settle']);
});

test('BSL090_K4_K10_새시나리오는다른시나리오전용인자를받지않는다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(parseArgs(sd()).scenario, 'seat-deltas');
  assert.equal(parseArgs(gate()).scenario, 'gate');
  const others = [
    ['users', 10, ['gate']],
    ['hold-size', 2, ['gate']],
    ['mode', 'spread', ['seat-deltas', 'gate']],
    ['hot-count', 1, ['seat-deltas', 'gate']],
    ['pairs', 1, ['seat-deltas', 'gate']],
    ['release-ms', 0, ['seat-deltas', 'gate']],
    ['seats-per-order', 2, ['seat-deltas', 'gate']],
    ['entry-rate', 100, ['seat-deltas', 'gate']],
    ['admit-per-second', 28, ['seat-deltas', 'gate']],
    ['rates', '1000', ['seat-deltas', 'gate']],
    ['target-cpus', 8, ['seat-deltas', 'gate']],
  ];
  for (const [flag, v, scenarios] of others) {
    for (const name of scenarios) expectUsage(MAKERS[name]({ [flag]: v }), new RegExp(flag));
  }
  // 모르는 인자·남는 위치 인자·객체 원형 이름 인자
  for (const mk of [sd, gate]) {
    for (const a of [[...mk(), '--bogus', '1'], [...mk(), 'extra'], [...mk(), '--__proto__', '1'], [...mk(), '--constructor', '1'], [...mk(), '-rate', '5']]) {
      expectUsage(a);
    }
  }
});

test('BSL090_새인자도값이없거나_두번주거나_--이름=값꼴이면거부한다 [ASVS v5.0.0-2.2.1]', () => {
  assert.equal(parseArgs(q({ generators: 2 })).generators, 2);
  assert.equal(parseArgs(sd({ 'listener-pods': 2 })).listenerPods, 2);
  // 값이 없다(끝이거나 다음이 --로 시작)
  for (const a of [
    [...q(), '--generators'],
    [...q(), '--generators', '--settle'],
    [...q(), '--namespace'],
    [...q(), '--namespace', '--settle'],
    [...q(REC), '--prom-url'],
    [...q(REC), '--prom-url', '--invariants'],
    [...pay(), '--fault-drop-pct'],
    [...pay(), '--fault-delay-pct', '--db-stats'],
    [...pay(), '--kill-app-at'],
    [...sd(), '--listener-pods'],
    ['v0', 'seat-deltas', '--users', '1000', '--rate', '300', '--connections'],
    ['v0', 'seat-deltas', '--users', '1000', '--connections', '--rate', '300'],
    ['v0', 'gate', '--scanners', '--rate', '20'],
    ['v0', 'gate', '--scanners', '10', '--rate', '20', '--cut-at'],
    [...gate(), '--cut-s', '--settle'],
  ]) {
    expectUsage(a);
  }
  // 같은 인자 두 번(값이 같아도)
  for (const a of [
    [...q({ generators: 2 }), '--generators', '2'],
    [...q({ namespace: 'v0' }), '--namespace', 'v0-base'],
    [...q({ ...REC, 'prom-url': 'http://127.0.0.1:9090' }), '--prom-url', 'http://127.0.0.1:9090'],
    [...pay({ 'fault-drop-pct': 10 }), '--fault-drop-pct', '10'],
    [...pay({ 'kill-app-at': 10 }), '--kill-app-at', '20'],
    [...sd(), '--connections', '5000'],
    [...sd({ 'listener-pods': 1 }), '--listener-pods', '1'],
    [...gate(), '--scanners', '10'],
    [...gate({ 'cut-at': 1 }), '--cut-at', '2'],
    [...gate({ 'cut-s': 1 }), '--cut-s', '1'],
  ]) {
    expectUsage(a);
  }
  // --이름=값 꼴은 모르는 인자
  for (const a of [
    [...q(), '--generators=2'],
    [...q(), '--namespace=v0-base'],
    [...q(REC), '--prom-url=http://127.0.0.1:9090'],
    [...pay(), '--fault-drop-pct=10'],
    [...pay(), '--kill-app-at=10'],
    [...sd(), '--listener-pods=1'],
    ['v0', 'seat-deltas', '--users', '1000', '--rate', '300', '--connections=5000'],
    ['v0', 'gate', '--scanners=10', '--rate', '20'],
    [...gate(), '--cut-at=30'],
  ]) {
    expectUsage(a);
  }
});

// ---------------------------------------------------------------------------------------------
// 문서의 명령(loadtest/README.md '쓰는 법', docs/verification.md §3.10 'K별 실행')
// ---------------------------------------------------------------------------------------------

/** README 코드 블록의 실행 도구 명령(node loadtest/run.mjs …)을 인자 목록으로. 줄 끝 주석(#)은 떼고 <ID>는 바른 실행 ID로 바꾼다 */
function readmeCommands() {
  return readFileSync(README, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+#.*$/, '').trim())
    .filter((l) => l.startsWith('node loadtest/run.mjs '))
    .map((l) => l.split(/\s+/).slice(2).map((a) => (a === '<ID>' ? '2026-11-03-k1-v0-local-100k-before' : a)));
}

test('BSL090_NFR-013_README의실행도구명령은_모두parseArgs가받는다(문서와인자규칙이어긋나지않는다)', () => {
  const cmds = readmeCommands();
  // 보정 1, v0 예시 3, Before 측정 5(K1·K2·K4·K7 ②·K10)
  assert.ok(cmds.length >= 9, `README 명령 ${cmds.length}개: ${JSON.stringify(cmds)}`);
  for (const argv of cmds) assert.doesNotThrow(() => parseArgs(argv), `README 명령을 거부했다: ${argv.join(' ')}`);
});

test('BSL090_K1_K2_K4_K7_K10_README의Before측정명령은_§3.10K별실행표의조건값이다', () => {
  const find = (scenario, pred) => {
    const hits = readmeCommands().filter((a) => a[0] === 'v0' && a[1] === scenario).map((a) => parseArgs(a)).filter(pred);
    assert.equal(hits.length, 1, `README에 ${scenario} Before 측정 명령이 하나가 아니다(${hits.length}개)`);
    return hits[0];
  };
  // K1(Q-T2): 대기자 10만 명(local-100k), 진입 1,000/s, 입장 초당 28명, 예열 30초·본구간 120초. K9는 같은 실행의 --hpa-timeline(복제 1에서 시작 --settle)
  const k1 = find('queue', (a) => a.users === 100000);
  assert.deepEqual([k1.entryRate, k1.admitPerSecond, k1.warmS, k1.mainS, k1.settle, k1.hpaTimeline, k1.record, k1.profile, k1.promUrl],
    [1000, 28, 30, 120, true, true, true, 'local-100k', 'http://127.0.0.1:9090']);
  // K2(S-T1): 가상 사용자 1,000명, 2,000/s, 인기 좌석 하나, 잡은 홀드를 놓지 않는다(첫 한 명만 201), DB 통계
  const k2 = find('seat-hold', (a) => a.keep);
  assert.deepEqual([k2.users, k2.rate, k2.mode, k2.hotCount, k2.keep, k2.dbStats], [1000, 2000, 'hot', 1, true, true]);
  // K4(S-T12): 변경분 연결 5,000개 = 받는 파드 10개 × 500개. 홀드 흩음 2석을 잡자마자 놓아 좌석 상태 변경 초당 500건(NFR-004의 500건까지)
  const k4 = find('seat-deltas', () => true);
  assert.deepEqual([k4.connections, k4.listenerPods, k4.holdSize], [5000, 10, 2]);
  assert.equal(k4.rate * k4.holdSize * 2, 500, '잡기 + 놓기의 좌석 상태 변경(초당)');
  // K7 ②(P-T1·P-T3): 1만 건(100/s × 본구간 100초), 응답 버림 5%, 늦춤 2%, 본구간 50초에 앱 파드 하나를 강제로 끝냄, 불변식 검사
  const k7 = find('payment', (a) => a.faultDropPct > 0);
  assert.deepEqual([k7.rate, k7.rate * k7.mainS, k7.warmS, k7.faultDropPct, k7.faultDelayPct, k7.killAppAtS, k7.invariants], [100, 10000, 10, 5, 2, 50, true]);
  // K10(O-T1): 스캐너 10대가 1초에 1장씩, 온라인 60초 → 망 끊김 60초 → 복구 60초
  const k10 = find('gate', () => true);
  assert.deepEqual([k10.scanners, k10.rate, k10.cutAtS, k10.cutS, k10.mainS - k10.cutAtS - k10.cutS], [10, 10, 60, 60, 60]);
});

test('BSL090_K1_K2_K3_K7_§3.10K별실행표에서README에없는조건도_parseArgs가받는다', () => {
  const rec = (profileUsers) => ['--record', '--run-id', `2026-11-03-k1-v0-${profileUsers}`];
  // K1: 1천·1만 명(local-1k·local-10k). 10만 명이 목표를 못 지키면 2만·4만·6만 명을 한 번씩 더 잰다
  for (const [users, profile] of [[1000, 'local-1k'], [10000, 'local-10k'], [20000, 'local-100k'], [40000, 'local-100k'], [60000, 'local-100k']]) {
    const a = parseArgs(['v0', 'queue', '--users', String(users), '--entry-rate', '1000', '--admit-per-second', '28', '--warm', '30', '--main', '120', '--settle', ...rec(`${users}`)]);
    assert.deepEqual([a.users, a.profile], [users, profile], `K1 ${users}명`);
  }
  // K2 흩음: 1,000명, 2,000/s, 2석을 잡자마자 놓는다(IP 몫 2,000 × 2 ≤ 0.6 × 10 × 1,000)
  const spread = parseArgs(['v0', 'seat-hold', '--users', '1000', '--rate', '2000', '--mode', 'spread', '--hold-size', '2', '--db-stats']);
  assert.deepEqual([spread.mode, spread.holdSize, spread.releaseMs, spread.keep], ['spread', 2, 0, false]);
  // K3(S-T10): 1,000명, 500/s, 같은 좌석 둘을 엇갈린 순서로 50쌍, DB 통계(교착 수)
  const crossed = parseArgs(['v0', 'seat-hold', '--users', '1000', '--rate', '500', '--mode', 'crossed', '--pairs', '50', '--db-stats']);
  assert.deepEqual([crossed.mode, crossed.pairs, crossed.dbStats], ['crossed', 50, true]);
  // K7 ①: 300/s(피크), 예열 10초·본구간 50초, 2석. 가상 사용자 하나가 결제 하나라 300 × 60 + 2명이 가장 적은 수다
  const peak = parseArgs(['v0', 'payment', '--users', '18002', '--rate', '300', '--warm', '10', '--main', '50', '--seats-per-order', '2', '--invariants']);
  assert.deepEqual([peak.rate, peak.seatsPerOrder, peak.warmS, peak.mainS], [300, 2, 10, 50]);
  expectUsage(['v0', 'payment', '--users', '18001', '--rate', '300', '--warm', '10', '--main', '50']);
});
