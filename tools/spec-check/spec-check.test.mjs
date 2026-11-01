// 규칙 모델 검사 실행기 시험(wbs 0.9.1, docs/verification.md §2.2·§2.6, V-T1). Quint·Java 없이 돈다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractTlcTrace, judge, kstTimestamp, loadManifest, parseSimulation, parseTlc, refoundIsCounterexample, resultRecord, simulationFor, invariantsFor } from './spec-check.mjs';

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
