// 규칙 모델 검사 실행기 시험(wbs 0.9.1, docs/verification.md §2.2·§2.6, V-T1). Quint·Java 없이 돈다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { PINS } from './fetch-tools.mjs';
import { extractTlcTrace, judge, kstTimestamp, loadManifest, mbtActions, parseSimulation, parseTlc, refoundIsCounterexample, resultRecord, runsInSimulation, simulationFor, invariantsFor, stepActions } from './spec-check.mjs';

const SPEC = `module queue {
  val inv_a = true
  val inv_b = true
}
module queue_ok { import queue.* }
module queue_bad { import queue.* }
`;
const manifest = (over = {}) => ({
  simulation: { samples: 10000, maxSteps: 40, seed: '0x5eed' },
  specs: [
    {
      name: 'queue',
      file: 'specs/queue.qnt',
      title: '대기열',
      adrs: ['0056'],
      scope: '사람 2명',
      invariants: ['inv_a', 'inv_b'],
      checks: [
        { main: 'queue_ok', expect: 'hold', why: '지켜짐' },
        { main: 'queue_bad', expect: 'violate', invariant: 'inv_b', why: 'V-T1' },
      ],
      ...over,
    },
  ],
});
const load = (m, files = { 'specs/queue.qnt': SPEC }) => loadManifest(JSON.stringify(m), (f) => {
  if (!(f in files)) throw new Error(`없음 ${f}`);
  return files[f];
});

test('V-T1 목록_검사마다 모듈·불변식이 명세 파일에 있으면 읽는다', () => {
  const m = load(manifest());
  assert.equal(m.specs[0].checks.length, 2);
  assert.equal(m.simulation.samples, 10000);
});

test('V-T1 목록_명세가 여럿이면 이름이 겹치지 않아야 한다(결과 파일 specs/results/<이름>.json이 겹친다, wbs 0.9.2)', () => {
  const m = manifest();
  m.specs.push({ ...m.specs[0] });
  assert.throws(() => load(m), /queue.*두 번/);
  m.specs[1] = { ...m.specs[0], name: 'seat' };
  assert.equal(load(m).specs.length, 2);
});

test('V-T1 목록_명세 이름 겹침은 대소문자를 가리지 않는다(NTFS·바인드 마운트에서 결과 폴더가 같아진다, 코드 리뷰 2026-11-02)', () => {
  const m = manifest();
  m.specs.push({ ...m.specs[0], name: 'Queue' });
  assert.throws(() => load(m), /두 번/);
});

test('V-T1 목록_같은 명세 안 모듈 이름 겹침도 대소문자를 가리지 않는다(반례 파일 <모듈>.tlc.txt가 겹친다, 코드 리뷰 2026-11-02)', () => {
  const m = manifest();
  m.specs[0].checks.push({ main: 'Queue_ok', expect: 'hold', why: '대소문자만 다름' });
  const files = { 'specs/queue.qnt': `${SPEC}module Queue_ok { import queue.* }
` };
  assert.throws(() => load(m, files), /두 번/);
});

test('V-T1 목록_지켜짐 검사는 불변식 일부만 고를 수 있다(모형에 전제로 넣은 불변식은 검사로 세지 않게, 코드 리뷰 2026-11-02)', () => {
  const m = manifest();
  m.specs[0].checks[0].invariants = ['inv_a'];
  const loaded = load(m);
  assert.deepEqual(invariantsFor(loaded.specs[0], loaded.specs[0].checks[0]), ['inv_a']);
  assert.deepEqual(invariantsFor(loaded.specs[0], loaded.specs[0].checks[1]), ['inv_b']);
  for (const bad of [[], ['inv_zzz'], 'inv_a']) {
    m.specs[0].checks[0].invariants = bad;
    assert.throws(() => load(m), /invariants/);
  }
  m.specs[0].checks[0].invariants = ['inv_a'];
  m.specs[0].checks[1].invariants = ['inv_a'];
  assert.throws(() => load(m), /invariants/);
});

test('V-T1 목록_명세 이름은 결과 폴더 이름이 되므로 식별자 모양만 받는다(경로 밖으로 쓰지 않게)', () => {
  for (const name of ['../queue', 'a/b', 'queue seat', '']) assert.throws(() => load(manifest({ name })), /name/);
});

test('V-T1 목록_명세 파일에 없는 모듈을 고르면 거절한다', () => {
  const m = manifest();
  m.specs[0].checks[0].main = 'queue_missing';
  assert.throws(() => load(m), /queue_missing/);
});

test('V-T1 목록_명세에 정의되지 않은 불변식을 적으면 거절한다', () => {
  assert.throws(() => load(manifest({ invariants: ['inv_a', 'inv_zzz'] })), /inv_zzz/);
});

test('V-T1 목록_반례를 기대하는 변형은 깨질 불변식을 목록 안에서 하나 적어야 한다', () => {
  const m = manifest();
  delete m.specs[0].checks[1].invariant;
  assert.throws(() => load(m), /invariant/);
  m.specs[0].checks[1].invariant = 'inv_other';
  assert.throws(() => load(m), /inv_other/);
});

test('V-T1 목록_지켜짐을 기대하는 검사가 하나도 없으면 거절한다(변형만으로는 명세를 검사하지 않는다)', () => {
  const m = manifest();
  m.specs[0].checks = m.specs[0].checks.filter((c) => c.expect === 'violate');
  assert.throws(() => load(m), /hold/);
});

test('V-T1 목록_기대 값·ADR 번호·까닭이 틀리면 거절한다', () => {
  const a = manifest();
  a.specs[0].checks[0].expect = 'maybe';
  assert.throws(() => load(a), /expect/);
  assert.throws(() => load(manifest({ adrs: ['56'] })), /adrs/);
  const b = manifest();
  delete b.specs[0].checks[0].why;
  assert.throws(() => load(b), /why/);
});

test('V-T1 목록_같은 모듈을 두 번 적거나 시뮬레이션 횟수가 없으면 거절한다', () => {
  const m = manifest();
  m.specs[0].checks.push({ ...m.specs[0].checks[0] });
  assert.throws(() => load(m), /두 번/);
  const s = manifest();
  delete s.simulation.samples;
  assert.throws(() => load(s), /samples/);
});

const TLC_OK = `TLC2 Version 2.20 of Day Month 20?? (rev: 1a2b3c4)
Running breadth-first search Model-Checking with fp 12 and seed 1 with 8 workers on 8 cores
Model checking completed. No error has been found.
  Estimates of the probability that TLC did not check all reachable states
  because two distinct states had the same fingerprint:
  calculated (optimistic):  val = 3.4E-7
1234567 states generated, 234567 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 42.
Finished in 01min 23s at (2026-11-02 12:00:00)`;

const TLC_BAD = `TLC2 Version 2.20 of Day Month 20?? (rev: 1a2b3c4)
Error: Invariant q_inv is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
12345 states generated, 2345 distinct states found, 100 states left on queue.
The depth of the complete state graph search is 12.`;

test('V-T1 결과_TLC 출력에서 판·상태 수·깊이·지문 충돌 확률·위반 여부를 읽는다', () => {
  assert.deepEqual(parseTlc(TLC_OK), {
    tlc: 'TLC2 Version 2.20 of Day Month 20?? (rev: 1a2b3c4)',
    statesGenerated: 1234567,
    distinctStates: 234567,
    statesLeft: 0,
    depth: 42,
    fingerprintCollision: '3.4E-7',
    completed: true,
    violated: false,
  });
  const bad = parseTlc(TLC_BAD);
  assert.equal(bad.violated, true);
  assert.equal(bad.completed, false);
  assert.equal(bad.distinctStates, 2345);
  assert.equal(bad.depth, 12);
});

test('V-T1 결과_끝까지 돌지 않은 TLC 출력(상태 수 줄이 없음)은 완료도 위반도 아니다', () => {
  const r = parseTlc('TLC2 Version 2.20\nOut of memory');
  assert.equal(r.completed, false);
  assert.equal(r.violated, false);
  assert.equal(r.distinctStates, null);
});

test('V-T1 결과_시뮬레이션 출력에서 깨진 불변식 이름을 읽는다', () => {
  assert.deepEqual(parseSimulation('[violation] Found an issue (43ms).\n  ❌ inv_b\n  ✅ inv_a\nerror: Invariant violated'), { violated: true, failing: ['inv_b'] });
  assert.deepEqual(parseSimulation('[ok] No violation found (4720ms at 2119 traces/second).'), { violated: false, failing: [] });
  assert.throws(() => parseSimulation('error: [QNT404] Name not found'), /읽지 못했다/);
});

test('V-T1 판정_지켜짐을 기대한 검사는 위반이 없고 TLC가 끝까지 돌아야 통과한다', () => {
  const c = { main: 'queue_ok', expect: 'hold' };
  assert.equal(judge(c, { violated: false, failing: [], completed: true }).ok, true);
  assert.match(judge(c, { violated: true, failing: ['inv_a'], completed: false }).message, /inv_a/);
  assert.equal(judge(c, { violated: false, failing: [], completed: false }).ok, false);
  // 시뮬레이션은 전수가 아니라 완료 여부를 보지 않는다
  assert.equal(judge(c, { violated: false, failing: [] }, 'simulate').ok, true);
});

test('V-T1 판정_반례를 기대한 변형에서 반례가 없으면 검사가 살아 있지 않다고 실패한다', () => {
  const c = { main: 'queue_bad', expect: 'violate', invariant: 'inv_b' };
  assert.equal(judge(c, { violated: true, failing: ['inv_b'] }).ok, true);
  const none = judge(c, { violated: false, failing: [], completed: true });
  assert.equal(none.ok, false);
  assert.match(none.message, /살아 있지 않다/);
  // 다른 불변식이 깨진 것은 이 변형이 노린 반례가 아니다
  assert.equal(judge(c, { violated: true, failing: ['inv_a'] }).ok, false);
});

test('V-T1 기록_결과 파일에 명세 해시·커밋·범위·도구 판·상태 수·깊이·위반 여부·반례 경로가 남는다', () => {
  const r = resultRecord({
    spec: { name: 'queue', file: 'specs/queue.qnt', scope: '사람 2명', adrs: ['0056'] },
    specSha256: 'a'.repeat(64),
    commit: { sha: 'b'.repeat(40), dirty: false },
    tools: { quint: '0.33.1', apalache: '0.62.4', tlc: 'TLC2 Version 2.20', java: '21.0.13' },
    now: new Date('2026-11-02T03:04:05Z'),
    checks: [
      { check: { main: 'queue_ok', expect: 'hold', why: '지켜짐' }, invariants: ['inv_a', 'inv_b'], tlc: parseTlc(TLC_OK), seconds: 83.2, verdict: { ok: true, message: '' } },
      { check: { main: 'queue_bad', expect: 'violate', invariant: 'inv_b', why: 'V-T1' }, invariants: ['inv_b'], tlc: parseTlc(TLC_BAD), seconds: 1.5, verdict: { ok: true, message: '' }, counterexample: 'specs/results/queue/queue_bad.itf.json' },
    ],
  });
  assert.equal(r.spec, 'queue');
  assert.equal(r.date, '2026-11-02T12:04:05+09:00');
  assert.equal(r.specSha256, 'a'.repeat(64));
  assert.deepEqual(r.commit, { sha: 'b'.repeat(40), dirty: false });
  assert.equal(r.tools.tlc, 'TLC2 Version 2.20');
  assert.equal(r.ok, true);
  assert.equal(r.checks[0].result, 'hold');
  assert.equal(r.checks[0].distinctStates, 234567);
  assert.equal(r.checks[0].depth, 42);
  assert.equal(r.checks[1].result, 'violate');
  assert.equal(r.checks[1].counterexample, 'specs/results/queue/queue_bad.itf.json');
  const failed = resultRecord({ ...r, spec: { name: 'q', file: 'f', scope: 's', adrs: [] }, specSha256: 'c', commit: { sha: 'd', dirty: true }, tools: {}, now: new Date(0),
    checks: [{ check: { main: 'm', expect: 'hold', why: 'w' }, invariants: [], tlc: parseTlc(TLC_BAD), seconds: 1, verdict: { ok: false, message: 'x' } }] });
  assert.equal(failed.ok, false);
});

test('V-T1 기록_시각은 시스템 시간대와 상관없이 한국 시각(+09:00)으로 쓴다', () => {
  assert.equal(kstTimestamp(new Date('2026-12-31T15:00:00Z')), '2027-01-01T00:00:00+09:00');
});

test('V-T1 목록_tlc false인 검사(정본 범위 전체처럼 전수 검사가 너무 큰 범위)는 받고, tlc가 참·거짓이 아니면 거절한다', () => {
  const m = manifest();
  m.specs[0].checks.push({ main: 'queue_full', expect: 'hold', tlc: false, why: '전체 범위는 시뮬레이션만' });
  const files = { 'specs/queue.qnt': `${SPEC}module queue_full { import queue.* }\n` };
  assert.equal(load(m, files).specs[0].checks[2].tlc, false);
  m.specs[0].checks[2].tlc = 'no';
  assert.throws(() => load(m, files), /tlc/);
});

test('V-T1 목록_지켜짐을 기대하는 검사가 모두 tlc false면 거절한다(전수 검사가 하나는 있어야 한다)', () => {
  const m = manifest();
  m.specs[0].checks[0].tlc = false;
  assert.throws(() => load(m), /전수/);
});

test('V-T1 목록_반례가 드문 변형은 검사마다 시뮬레이션 횟수(samples)를 늘려 적을 수 있고, 양의 정수가 아니면 거절한다(wbs 0.9.2)', () => {
  const m = manifest();
  m.specs[0].checks[1].samples = 50000;
  const loaded = load(m);
  assert.deepEqual(simulationFor(loaded, loaded.specs[0].checks[1]), { samples: 50000, maxSteps: 40, seed: '0x5eed' });
  assert.deepEqual(simulationFor(loaded, loaded.specs[0].checks[0]), { samples: 10000, maxSteps: 40, seed: '0x5eed' });
  for (const bad of [0, -1, 1.5, '50000']) {
    m.specs[0].checks[1].samples = bad;
    assert.throws(() => load(m), /samples/);
  }
});

test('V-T1 기록_시뮬레이션으로만 본 검사는 방법·횟수를 남기고 상태 수는 비운다', () => {
  const r = resultRecord({
    spec: { name: 'queue', file: 'specs/queue.qnt', scope: 's', adrs: [] },
    specSha256: 'a',
    commit: { sha: 'b', dirty: false },
    tools: {},
    now: new Date(0),
    checks: [
      { check: { main: 'queue_ok', expect: 'hold', why: 'w' }, invariants: ['inv_a'], tlc: parseTlc(TLC_OK), seconds: 1, verdict: { ok: true, message: '' } },
      { check: { main: 'queue_full', expect: 'hold', tlc: false, why: 'w' }, invariants: ['inv_a'], sim: { violated: false, failing: [], samples: 10000, maxSteps: 40, seed: '0x5eed' }, seconds: 9, verdict: { ok: true, message: '' } },
    ],
  });
  assert.equal(r.checks[0].method, 'tlc');
  assert.equal(r.checks[1].method, 'simulate');
  assert.equal(r.checks[1].result, 'hold');
  assert.equal(r.checks[1].samples, 10000);
  assert.equal(r.checks[1].distinctStates, null);
});

test('V-T1 기록_TLC 출력에서 가장 짧은 반례 경로(상태 목록)만 잘라 낸다', () => {
  const out = `Starting...
Error: Invariant q_inv is violated.
Error: The behavior up to this point is:
State 1: <Initial predicate>
/\ x = 0

State 2: <q_step line 3, col 1 to line 9, col 20 of module m>
/\ x = 1

12345 states generated, 2345 distinct states found, 100 states left on queue.
The depth of the complete state graph search is 2.
Finished in 1s at (2026-11-02 12:00:00)`;
  const t = extractTlcTrace(out);
  assert.match(t, /^Error: Invariant q_inv is violated\.\nError: The behavior up to this point is:\nState 1:/);
  assert.match(t, /State 2: /);
  assert.doesNotMatch(t, /states generated|Starting/);
  assert.equal(extractTlcTrace('Model checking completed. No error has been found.'), null);
});

test('V-T1 기록_반례가 있으면 TLC 경로 파일과 시뮬레이션 동작 기록 경로가 결과 파일에 남는다', () => {
  const r = resultRecord({
    spec: { name: 'queue', file: 'specs/queue.qnt', scope: 's', adrs: [] },
    specSha256: 'a',
    commit: { sha: 'b', dirty: false },
    tools: {},
    now: new Date(0),
    checks: [
      { check: { main: 'queue_ok', expect: 'hold', why: 'w' }, invariants: ['inv_a'], tlc: parseTlc(TLC_OK), seconds: 1, verdict: { ok: true, message: '' } },
      { check: { main: 'queue_bad', expect: 'violate', invariant: 'inv_b', why: 'w' }, invariants: ['inv_b'], tlc: parseTlc(TLC_BAD), seconds: 1, verdict: { ok: true, message: '' },
        tlcTrace: 'specs/results/queue/queue_bad.tlc.txt', counterexample: 'specs/results/queue/queue_bad.itf.json' },
    ],
  });
  assert.equal(r.checks[1].tlcTrace, 'specs/results/queue/queue_bad.tlc.txt');
  assert.equal(r.checks[1].counterexample, 'specs/results/queue/queue_bad.itf.json');
  assert.equal('tlcTrace' in r.checks[0], false);
});

test('V-T1 기록_시뮬레이션으로 다시 찾은 동작 기록은 노린 불변식이 실제로 깨졌을 때만 반례로 남긴다(코드 리뷰 2026-11-02)', () => {
  const v = { main: 'queue_bad', expect: 'violate', invariant: 'inv_b' };
  assert.equal(refoundIsCounterexample(v, { violated: true, failing: ['inv_b'] }, ['inv_b']), true);
  assert.equal(refoundIsCounterexample(v, { violated: true, failing: ['inv_a'] }, ['inv_a', 'inv_b']), false);
  assert.equal(refoundIsCounterexample(v, { violated: false, failing: [] }, ['inv_b']), false);
  // 불변식 하나로 돌리면 Quint는 깨진 이름을 찍지 않는다(2026-11-02 실행에서 확인). 노린 불변식 하나만 넘겼으면 위반만으로 반례다
  assert.equal(refoundIsCounterexample(v, { violated: true, failing: [] }, ['inv_b']), true);
  assert.equal(refoundIsCounterexample(v, { violated: true, failing: [] }, ['inv_a', 'inv_b']), false);
  // 지켜져야 할 검사가 TLC에서 깨졌을 때는 어느 불변식이든 깨진 기록이어야 한다
  const h = { main: 'queue_ok', expect: 'hold' };
  assert.equal(refoundIsCounterexample(h, { violated: true, failing: ['inv_a'] }, ['inv_a', 'inv_b']), true);
  assert.equal(refoundIsCounterexample(h, { violated: false, failing: [] }, ['inv_a', 'inv_b']), false);
});

// ---- 진행성 검사(wbs 0.9.3: '승인된 주문은 발권 또는 환불로 끝남'. 공정성을 단 시간 논리 속성을 TLC로 본다) ----
const LIVE_SPEC = `${SPEC}module queue_live { import queue.* }
module queue_stuck { import queue.* }
`;
const liveFiles = { 'specs/queue.qnt': LIVE_SPEC.replace('val inv_b = true', 'val inv_b = true\n  temporal live_ok = true\n  temporal  live_b= true') };
const liveManifest = () => {
  const m = manifest({ temporal: ['live_ok', 'live_b'] });
  m.specs[0].checks.push({ main: 'queue_live', expect: 'hold', temporal: 'live_ok', why: '진행성' });
  m.specs[0].checks.push({ main: 'queue_stuck', expect: 'violate', temporal: 'live_b', why: '진행성 변형' });
  return m;
};

test('V-T1 목록_진행성 검사는 명세의 temporal 이름 하나를 TLC로만 보고, 불변식은 보지 않는다(wbs 0.9.3)', () => {
  const loaded = load(liveManifest(), liveFiles);
  const [, , live, stuck] = loaded.specs[0].checks;
  assert.equal(live.temporal, 'live_ok');
  assert.deepEqual(invariantsFor(loaded.specs[0], live), []);
  assert.deepEqual(invariantsFor(loaded.specs[0], stuck), []);
  // 반례를 기대하는 진행성 변형은 invariant 없이 temporal이 노린 속성이다
  assert.equal(stuck.invariant, undefined);
  assert.equal(runsInSimulation(live), false);
  assert.equal(runsInSimulation(loaded.specs[0].checks[0]), true);
});

test('V-T1 목록_진행성 이름이 명세 파일에 없거나 목록 밖이면 거절한다', () => {
  const m = liveManifest();
  m.specs[0].temporal = ['live_ok', 'live_zzz'];
  assert.throws(() => load(m, liveFiles), /live_zzz/);
  for (const bad of ['live_ok', [], ['a b']]) {
    m.specs[0].temporal = bad;
    assert.throws(() => load(m, liveFiles), /temporal/);
  }
  const n = liveManifest();
  n.specs[0].checks[2].temporal = 'live_zzz';
  assert.throws(() => load(n, liveFiles), /live_zzz/);
  // 명세에 temporal 목록이 없으면 검사도 진행성을 적을 수 없다
  const o = liveManifest();
  delete o.specs[0].temporal;
  assert.throws(() => load(o, liveFiles), /temporal/);
});

test('V-T1 목록_진행성 검사는 시뮬레이션만(tlc false)·불변식·시뮬레이션 횟수와 함께 쓰지 않는다(시뮬레이션은 시간 논리를 보지 않는다)', () => {
  for (const extra of [{ tlc: false }, { invariants: ['inv_a'] }, { invariant: 'inv_a' }, { samples: 100 }]) {
    const m = liveManifest();
    Object.assign(m.specs[0].checks[2], extra);
    assert.throws(() => load(m, liveFiles), /temporal|진행성/, JSON.stringify(extra));
  }
});

const TLC_LIVE_BAD = `TLC2 Version 2026.11.01.195612
Checking 2 branches of temporal properties for the complete state space with 18 total distinct states at (2026-11-01 19:56:12)
Error: Temporal property q_temporalProps was violated.
Error: The following behavior constitutes a counter-example:
State 1: <Initial predicate>
live2_live_x = <<0, 0>>
State 2: <live2_live_inc(1) line 25, col 3 to line 30, col 7 of module live2>
live2_live_x = <<1, 0>>
State 3: Stuttering
Finished checking temporal properties in 00s at 2026-11-01 19:56:12
13 states generated, 9 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 5.`;

test('V-T1 결과_TLC의 진행성 위반 출력은 위반으로 읽고 반례 경로(멈춘 걸음까지)만 잘라 낸다', () => {
  const r = parseTlc(TLC_LIVE_BAD);
  assert.equal(r.violated, true);
  assert.equal(r.completed, false);
  assert.equal(r.distinctStates, 9);
  const t = extractTlcTrace(TLC_LIVE_BAD);
  assert.match(t, /^Error: Temporal property q_temporalProps was violated\.\nError: The following behavior constitutes a counter-example:\nState 1:/);
  assert.match(t, /State 3: Stuttering\n$/);
  assert.doesNotMatch(t, /Finished checking|states generated|Checking 2 branches/);
});

test('V-T1 판정_진행성 검사는 노린 시간 논리 속성 이름으로 판정한다', () => {
  const hold = { main: 'queue_live', expect: 'hold', temporal: 'live_ok' };
  assert.equal(judge(hold, { violated: false, failing: [], completed: true }).ok, true);
  assert.match(judge(hold, { violated: true, failing: ['live_ok'], completed: false }).message, /live_ok/);
  const stuck = { main: 'queue_stuck', expect: 'violate', temporal: 'live_b' };
  assert.equal(judge(stuck, { violated: true, failing: ['live_b'] }).ok, true);
  const none = judge(stuck, { violated: false, failing: [], completed: true });
  assert.equal(none.ok, false);
  assert.match(none.message, /live_b/);
});

test('V-T1 기록_진행성 검사는 속성 이름과 TLC 경로를 남기고 불변식 목록은 비운다', () => {
  const r = resultRecord({
    spec: { name: 'queue', file: 'specs/queue.qnt', scope: 's', adrs: [] },
    specSha256: 'a',
    commit: { sha: 'b', dirty: false },
    tools: {},
    now: new Date(0),
    checks: [
      { check: { main: 'queue_live', expect: 'hold', temporal: 'live_ok', why: 'w' }, invariants: [], tlc: parseTlc(TLC_OK), seconds: 1, verdict: { ok: true, message: '' } },
      { check: { main: 'queue_stuck', expect: 'violate', temporal: 'live_b', why: 'w' }, invariants: [], tlc: parseTlc(TLC_LIVE_BAD), seconds: 1, verdict: { ok: true, message: '' },
        tlcTrace: 'specs/results/queue/queue_stuck.tlc.txt' },
    ],
  });
  assert.equal(r.checks[0].temporal, 'live_ok');
  assert.deepEqual(r.checks[0].invariants, []);
  assert.equal(r.checks[0].result, 'hold');
  assert.equal(r.checks[1].temporal, 'live_b');
  assert.equal(r.checks[1].result, 'violate');
  assert.equal('targetInvariant' in r.checks[1], false);
  assert.equal(r.checks[1].tlcTrace, 'specs/results/queue/queue_stuck.tlc.txt');
  assert.equal('counterexample' in r.checks[1], false);
});

test('V-T1 목록_반례 경로가 길어 시뮬레이션이 닿지 않는 변형은 simulate false로 전수 검사에서만 본다(wbs 0.9.3)', () => {
  const m = manifest();
  m.specs[0].checks[1].simulate = false;
  const loaded = load(m);
  assert.equal(runsInSimulation(loaded.specs[0].checks[1]), false);
  assert.equal(runsInSimulation(loaded.specs[0].checks[0]), true);
  // 시뮬레이션만 하는 검사(tlc false)와 함께 쓰면 아무 검사도 돌지 않는다
  m.specs[0].checks[1].tlc = false;
  assert.throws(() => load(m), /simulate/);
  delete m.specs[0].checks[1].tlc;
  for (const bad of [true, 'no', 0]) {
    m.specs[0].checks[1].simulate = bad;
    assert.throws(() => load(m), /simulate/);
  }
  // 시뮬레이션 횟수와 함께 쓰면 뜻이 없다
  m.specs[0].checks[1].simulate = false;
  m.specs[0].checks[1].samples = 100;
  assert.throws(() => load(m), /simulate/);
});

test('V-T1 결과_진행 줄(Progress, 쉼표 숫자)이 아니라 맨 끝 요약 줄의 상태 수를 읽는다(코드 리뷰 2026-11-02)', () => {
  const out = `TLC2 Version 2026.11.01
Progress(17) at 2026-11-01 20:08:22: 1,341 states generated, 180 distinct states found, 0 states left on queue.
Model checking completed. No error has been found.
1341 states generated, 180 distinct states found, 0 states left on queue.
The depth of the complete state graph search is 17.`;
  const r = parseTlc(out);
  assert.equal(r.statesGenerated, 1341);
  assert.equal(r.distinctStates, 180);
});

test('V-T1 목록_지켜짐 전수 검사 하나는 불변식을 보는 검사여야 하고, 진행성 검사에 simulate를 적으면 거절한다(코드 리뷰 2026-11-02)', () => {
  // 불변식 지켜짐 검사가 모두 시뮬레이션만이고 진행성 검사만 TLC면, 불변식을 전수로 보는 검사가 없다
  const m = liveManifest();
  m.specs[0].checks[0].tlc = false;
  assert.throws(() => load(m, liveFiles), /전수/);
  const n = liveManifest();
  n.specs[0].checks[2].simulate = false;
  assert.throws(() => load(n, liveFiles), /simulate/);
});

// ---- 모델 기반 시험과 잇기(wbs 2.3.4, V-T40) ----
const MBT_SPEC = `module queue {
  val inv_a = true
  val inv_b = true
  action evKeep: bool = all { x' = x }
  action enterNumber(p: int): bool = evKeep
  action admit(p: int, ok: bool): bool = evKeep
  action rb05: bool = evKeep
  action unused: bool = evKeep
  action step = {
    nondet p = Set(1).oneOf()
    // leave(p)는 주석이라 세지 않는다
    any { enterNumber(p), admit(p, true), rb05 }
  }
}
module queue_ok { import queue.* }
module queue_bad { import queue.* }
`;
const ACTIONS = (names) => `export const SPEC_ACTIONS = [\n  ${names.map((n) => `'${n}'`).join(',\n  ')},\n] as const;\n`;
const MBT_MODULES = [{ main: 'queue_ok', traces: 2 }];
const mbtFiles = (names, specText = MBT_SPEC, hash = createHash('sha256').update(specText).digest('hex'), over = {}) => ({
  'specs/queue.qnt': specText,
  'test/actions.ts': ACTIONS(names),
  'test/traces/manifest.json': JSON.stringify({ specSha256: hash, quint: PINS.quint, modules: MBT_MODULES, ...over }),
});
const MBT = { actions: 'test/actions.ts', traces: 'test/traces', modules: MBT_MODULES };

test('V-T40 이름목록_명세 step이 고르는 동작은 선언된 action 가운데 step 본문에 나오는 것이다(도우미·주석·쓰지 않는 동작은 빼고 이름순)', () => {
  assert.deepEqual(stepActions(MBT_SPEC), ['admit', 'enterNumber', 'rb05']);
});

test('V-T40 이름목록_step 본문 주석 안의 중괄호는 세지 않는다', () => {
  const src = MBT_SPEC.replace('    // leave(p)는 주석이라 세지 않는다', '    // 주석의 } 닫는 괄호와 leave(p)');
  assert.deepEqual(stepActions(src), ['admit', 'enterNumber', 'rb05']);
});

test('V-T40 재생_기록을 만든 Quint 판이나 기록을 낼 모듈 목록이 바뀌면 다시 만들라고 거절한다', () => {
  const ok = ['enterNumber', 'admit', 'rb05'];
  const hash = createHash('sha256').update(MBT_SPEC).digest('hex');
  assert.throws(() => load(manifest({ mbt: MBT }), mbtFiles(ok, MBT_SPEC, hash, { quint: '0.0.1' })), /Quint 0\.0\.1로 만들었다/);
  assert.throws(() => load(manifest({ mbt: MBT }), mbtFiles(ok, MBT_SPEC, hash, { modules: [{ main: 'queue_ok', traces: 4 }] })), /모듈 목록이/);
});

test('V-T40 이름목록_시험 파일의 SPEC_ACTIONS 목록을 적힌 순서대로 읽는다', () => {
  assert.deepEqual(mbtActions(ACTIONS(['rb05', 'admit'])), ['rb05', 'admit']);
  assert.throws(() => mbtActions('export const X = []'), /SPEC_ACTIONS/);
});

test('V-T40 이름목록_명세와 시험 명령 이름이 같고 기록이 지금 명세로 만든 것이면 받는다', () => {
  const m = load(manifest({ mbt: MBT }), mbtFiles(['enterNumber', 'admit', 'rb05']));
  assert.equal(m.specs[0].mbt.actions, 'test/actions.ts');
});

test('V-T40 이름목록_명세에만 있거나 시험에만 있거나 두 번 적힌 이름이 있으면 병합을 막는다', () => {
  assert.throws(() => load(manifest({ mbt: MBT }), mbtFiles(['enterNumber', 'admit'])), /명세에만: rb05/);
  assert.throws(() => load(manifest({ mbt: MBT }), mbtFiles(['enterNumber', 'admit', 'rb05', 'leave'])), /시험에만: leave/);
  assert.throws(() => load(manifest({ mbt: MBT }), mbtFiles(['enterNumber', 'admit', 'rb05', 'admit'])), /두 번: admit/);
});

test('V-T40 재생_동작 기록이 다른 명세(해시)로 만든 것이거나 목록이 없으면 다시 만들라고 거절하고, traces 명령은 해시를 보지 않는다', () => {
  const stale = mbtFiles(['enterNumber', 'admit', 'rb05'], MBT_SPEC, 'ab'.repeat(32));
  assert.throws(() => load(manifest({ mbt: MBT }), stale), /지금 명세로 만든 것이 아니다.*traces --spec queue/);
  const none = mbtFiles(['enterNumber', 'admit', 'rb05']);
  delete none['test/traces/manifest.json'];
  assert.throws(() => load(manifest({ mbt: MBT }), none), /manifest\.json\)이 없다/);
  assert.equal(loadManifest(JSON.stringify(manifest({ mbt: MBT })), (f) => stale[f], { traceHash: false }).specs.length, 1);
});

test('V-T40 목록_mbt는 시험 파일·기록 폴더·기록을 낼 모듈(명세에 있는 것)과 기록 수를 적어야 한다', () => {
  const files = mbtFiles(['enterNumber', 'admit', 'rb05']);
  assert.throws(() => load(manifest({ mbt: { ...MBT, modules: [] } }), files), /mbt는/);
  assert.throws(() => load(manifest({ mbt: { ...MBT, modules: [{ main: 'queue_none', traces: 2 }] } }), files), /queue_none가/);
  assert.throws(() => load(manifest({ mbt: { ...MBT, modules: [{ main: 'queue_ok', traces: 0 }] } }), files), /양의 정수/);
});
