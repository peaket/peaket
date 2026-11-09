// 대기열·입장 제어 모델 기반 시험(wbs 2.3.4, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-120). 실제 Valkey(노드 하나짜리 클러스터 모드)
// 위에서 운영 코드(queue-svc 진입·입장 확정, admission-ctrl 리더·묶음 게시)를 돌린다. 명령은 명세 specs/queue.qnt의 동작과 이름이 같다.
// ① 무작위 명령 순서(fc.asyncModelRun): 범위 다섯(복제 지연 1·2, 묶음 있음·없음, 입장 확정 한 번·네 호출, 도착 시각 칸)에서 걸음마다 명세 불변식 ①~⑦와
//    '입장한 대기표의 입장 키가 남음'(ADR-0183 결정 2·3)이 지켜진다.
// ② 경합(fc.scheduler): 운영 코드의 모든 Redis 호출이 끝나는 순서를 스케줄러가 섞는다(걸음마다 하네스가 스케줄러를 돌린다, system.ts). 무작위 명령 순서
//    위에서 한 번, 차례가 온 대기표 하나에 같은 대기표 요청 2~3개와 지금 목표 변경만 섞는 집중 시험으로 한 번 본다.
// ③ 동작 기록 재생: tools/spec-check traces가 낸 명세 기록을 같은 이름의 동작으로 다시 돌려, 걸음마다 탭 단계·대기표와 카운터·serving·세대·리더 세대가
//    명세와 같다.
//    진입 Degraded의 칸 떼기·닫기(HOT-061)도 같은 틀이다: 명세 enterNumberArrival·plan ARRCLOSE를 운영 코드로 돌려 ⑥·⑦(칸 번호 중복, 받은 번호가 빠진 번호)을 본다.
// 실패하면 fast-check가 줄인 순서를 찍는다. 운영 코드의 결함이면 그 순서를 회귀 시험으로 이 파일에 고정한다(2026-11-04 지금은 없다).
// 횟수: MBT_RUNS(기본 25, 집중 경합은 4배). 실패를 다시 돌리려면 MBT_SEED·MBT_PATH(fast-check가 찍는 seed·path). 걸음 기록: MBT_DEBUG=<파일>.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHotRedis, type HotRedis } from '@peaket/platform';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startValkey, type ValkeyContainer } from '../../queue-svc/test-int/valkey.js';
import { SPEC_ACTIONS } from './queue-model/actions.js';
import { COMMANDS, commandArbs, type World } from './queue-model/commands.js';
import { readTrace, replay, scopeOf } from './queue-model/itf.js';
import { NODE_EPOCH, QueueSystem, type Scope, type SystemOptions } from './queue-model/system.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SPEC_FILE = resolve(HERE, '..', '..', '..', 'specs', 'queue.qnt');
const TRACES = join(HERE, 'queue-model', 'traces');
const RUNS = Number(process.env.MBT_RUNS ?? 25);
const replayParams = { ...(process.env.MBT_SEED ? { seed: Number(process.env.MBT_SEED) } : {}), ...(process.env.MBT_PATH ? { path: process.env.MBT_PATH } : {}) };

let valkey: ValkeyContainer;
let redis: HotRedis;
beforeAll(async () => {
  valkey = await startValkey({ cluster: true, configEpoch: NODE_EPOCH });
  redis = await createHotRedis({ url: valkey.url });
});
afterAll(async () => {
  await redis?.close().catch(() => undefined);
  valkey?.stop();
});

let runNo = 0;
let last: QueueSystem | undefined;
const setup = (scope: Scope, o: SystemOptions = {}) => async () => {
  last = new QueueSystem(redis, scope, `${process.pid}x${++runNo}`, o);
  await last.init();
  const w: World = { s: last };
  return { model: w, real: w };
};
const finish = async () => {
  await last!.checkAdmissionKeys();
  if (last!.violations.length > 0) throw new Error(`불변식 위반:\n${last!.violations.join('\n')}`);
};

// 명령 순서: 한 걸음에서 할 수 있는 명령은 몇 개뿐이라(나머지는 check가 건너뛴다) 길게 만든다. 실패하면 fast-check가 배열을 줄인다
const plan = (scope: Scope, length = { minLength: 600, maxLength: 1000 }) => fc.array(fc.oneof(...commandArbs(scope)), length);

test('V-T40 명령 이름이 명세 동작 이름(SPEC_ACTIONS)과 같다', () => {
  expect(Object.keys(COMMANDS).sort()).toEqual([...SPEC_ACTIONS].sort());
});

const FULL: Scope = {
  tickets: [[1, 1], [1, 2], [2, 1], [2, 2]],
  ctrls: [1, 2],
  lag: 1,
  openBatch: true,
  admitSteps: true,
  maxFailovers: 2,
  personFailovers: true,
  maxLeaderChanges: 2,
  epochJumps: [1, 3],
};
// 설정 세대는 장애 전환 한 번에 1 또는 3 오른다(새로 만든 클러스터). 처음의 곱하기는 3 이상이면 RB-05를 잃은 뒤 같은 번호가 다시 나갔고,
// 복제 확인 뒤 재개(ADR-0186)로 바꿔 복제 지연 2 범위도 [1, 3]으로 돈다
const VARIANTS: Array<[string, Scope]> = [
  ['복제 지연 1·묶음·네 호출', FULL],
  ['복제 지연 2·묶음·한 번', { ...FULL, lag: 2, admitSteps: false }],
  ['복제 지연 2·묶음 없음·네 호출', { ...FULL, lag: 2, openBatch: false }],
  ['복제 지연 1·묶음 없음·한 번', { ...FULL, openBatch: false, admitSteps: false }],
  // 진입 Degraded의 도착 시각 칸(HOT-061): 칸 2개(크기 2), 장애 전환 2회. 칸 번호가 겹치지 않고 받은 번호가 빠진 번호가 되지 않는지 본다
  ['복제 지연 1·칸 2개·한 번', { tickets: [[1, 1], [1, 2], [2, 1]], ctrls: [1], lag: 1, openBatch: false, admitSteps: false, maxFailovers: 2, personFailovers: false, maxLeaderChanges: 0, epochJumps: [1], arrSlots: [1, 2], arrSize: 2, skipBase: 5 }],
];

test.each(VARIANTS)('모델 기반 무작위 명령 순서(%s): 명세 불변식 ①~⑦이 지켜진다', async (_name, scope) => {
  await fc.assert(
    fc.asyncProperty(plan(scope), async (cmds) => {
      await fc.asyncModelRun(setup(scope), cmds);
      await finish();
    }),
    { numRuns: RUNS, ...replayParams },
  );
}, 600_000);

test('경합(스케줄러): 같은 대기표의 요청 둘과 지금 목표 변경이 엇갈려도 한 사람 입장 하나와 입장 키가 지켜진다', async () => {
  const scope: Scope = { tickets: [[1, 1], [1, 2], [2, 1]], ctrls: [1], lag: 1, openBatch: false, admitSteps: false, maxFailovers: 1, personFailovers: true, maxLeaderChanges: 0, epochJumps: [1] };
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), plan(scope, { minLength: 200, maxLength: 400 }), async (sch, cmds) => {
      await fc.asyncModelRun(setup(scope, { scheduler: sch }), cmds);
      await finish();
    }),
    { numRuns: RUNS, ...replayParams },
  );
}, 600_000);

test('경합 집중(스케줄러): 차례가 온 대기표의 요청 2~3개와 지금 목표 변경이 어떤 순서로 끝나도 입장 키가 남고 다른 대기표는 거절된다', async () => {
  const scope: Scope = { tickets: [[1, 1], [1, 2]], ctrls: [1], lag: 1, openBatch: false, admitSteps: false, maxFailovers: 0, personFailovers: false, maxLeaderChanges: 0, epochJumps: [1] };
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.integer({ min: 2, max: 3 }), fc.oneof(fc.constant('afterFirstAdmit' as const), fc.integer({ min: 0, max: 12 })), async (sch, copies, raiseAfter) => {
      const { real } = await setup(scope, { scheduler: sch })();
      const s = real.s;
      // 탭 (1,1)이 대기표를 들고 차례가 온 상태(진입 세 단계 → 리더가 BUMP·전진)
      await s.step('enterPreempt', () => s.enterPreempt([1, 1]));
      await s.step('enterNumber', () => s.enterNumber([1, 1]));
      await s.step('enterRecord', () => s.enterRecord([1, 1]));
      s.acquire(1);
      await s.step('applyWrite', async () => void (await s.applyWrite(1)));
      s.plan(1, 'ADVANCE');
      await s.step('applyWrite', async () => void (await s.applyWrite(1)));
      expect(s.tab([1, 1]).phase).toBe('HELD');
      await s.step(`admit ×${copies} 목표 경합 ${raiseAfter}`, async () => void (await s.admit([1, 1], { copies, raiseAfter })));
      // 곧 입장만 받았으면 목표가 올라간 뒤 다시 보낸다
      if (s.tab([1, 1]).phase === 'HELD') await s.step('admit 다시', async () => void (await s.admit([1, 1])));
      expect(s.tab([1, 1]).phase).toBe('ADMITTED');
      await finish();
    }),
    { numRuns: RUNS * 4, ...replayParams },
  );
}, 600_000);

// 무작위 실행은 이 순서에 잘 닿지 않아(25회로 변이를 못 잡았다, HOT-061) 명세 반례(queue_arrival_close_no_gen)의 순서를 그대로 고정한다.
// 세대 확인을 뺀 닫기 Lua에서는 둘째 사람의 번호가 빠진 번호가 되어 실패한다
test('V-T40 집중(HOT-061): 장애 전환으로 쓴 번호 수를 잃은 칸을 닫아도 받은 번호가 빠진 번호가 되지 않는다', async () => {
  const scope: Scope = { tickets: [[1, 1], [2, 1]], ctrls: [1], lag: 1, openBatch: false, admitSteps: false, maxFailovers: 1, personFailovers: false, maxLeaderChanges: 0, epochJumps: [1], arrSlots: [1], arrSize: 2, skipBase: 5 };
  const { real } = await setup(scope)();
  const s = real.s;
  // 리더가 세대를 올린다
  s.acquire(1);
  await s.step('applyWrite', async () => void (await s.applyWrite(1)));
  // 두 사람이 같은 칸에서 번호를 받는다. 둘째 번호의 쓴 수는 아직 복제되지 않았다(복제 지연 1). 둘째가 번호를 기록한다
  await s.step('enterPreempt', () => s.enterPreempt([1, 1]));
  await s.step('enterPreempt', () => s.enterPreempt([2, 1]));
  await s.step('enterNumberArrival', () => s.enterNumberArrival([1, 1], 1));
  await s.step('enterNumberArrival', () => s.enterNumberArrival([2, 1], 1));
  await s.step('enterRecord', () => s.enterRecord([2, 1]));
  expect(s.tab([2, 1]).phase).toBe('HELD');
  const seq = s.tab([2, 1]).seq;
  expect(seq).toBe(2);
  // 장애 전환이 쓴 번호 수를 잃고(칸의 used가 1로 돌아감) RB-05가 세대를 올린 뒤 리더가 칸을 닫는다
  await s.failoverEv(1);
  s.note('failoverEv');
  await s.step('rb05', async () => void (await s.rb05()));
  s.replicateEv();
  s.note('replicateEv');
  await s.step('rb05Confirm', async () => void (await s.rb05Confirm()));
  s.plan(1, 'ARRCLOSE');
  s.note('plan');
  await s.step('applyWrite', async () => void (await s.applyWrite(1)));
  // 닫기가 실제로 돌았다: 칸 1이 닫히고 믿지 못하는 칸으로 표시됐다
  expect(s.observed().arr).toMatchObject({ closedUpto: 1, lostUpto: 1 });
  expect(s.observed().removed).not.toContain(seq);
  await finish();
}, 60_000);

// TLC가 찾은 가장 짧은 반례(specs/results/queue/queue_arrival_entry_no_gen.tlc.txt)의 순서: 진입 Lua가 칸 기록의 세대를 보지 않으면 쓴 번호 수를 잃은 칸에서 같은 번호를 다시 낸다. 앞 사람이 그 번호를 돌렸으면 새로 받은 번호가 이미 빠진 번호다
test('V-T40 집중(HOT-061): 장애 전환 뒤 옛 칸의 쿠키는 그 칸의 번호를 다시 받지 않는다', async () => {
  const scope: Scope = { tickets: [[1, 1], [2, 1], [3, 1]], ctrls: [1], lag: 1, openBatch: false, admitSteps: false, maxFailovers: 1, personFailovers: false, maxLeaderChanges: 0, epochJumps: [1], arrSlots: [1], arrSize: 2, skipBase: 5 };
  const { real } = await setup(scope)();
  const s = real.s;
  // 두 사람이 같은 칸에서 번호를 받고(둘째 번호의 쓴 수는 복제 전) 둘째가 기록한다
  await s.step('enterPreempt', () => s.enterPreempt([1, 1]));
  await s.step('enterPreempt', () => s.enterPreempt([2, 1]));
  await s.step('enterPreempt', () => s.enterPreempt([3, 1]));
  await s.step('enterNumberArrival', () => s.enterNumberArrival([1, 1], 1));
  await s.step('enterNumberArrival', () => s.enterNumberArrival([2, 1], 1));
  await s.step('enterRecord', () => s.enterRecord([2, 1]));
  const lost = s.tab([2, 1]).seq;
  expect(lost).toBe(2);
  // 장애 전환이 쓴 번호 수를 잃고, 둘째가 이탈해 번호를 돌린다. 그 뒤 RB-05와 복제 확인이 끝난다
  await s.failoverEv(1);
  s.note('failoverEv');
  await s.step('leave', () => s.leave([2, 1]));
  await s.step('rb05', async () => void (await s.rb05()));
  s.replicateEv();
  s.note('replicateEv');
  await s.step('rb05Confirm', async () => void (await s.rb05Confirm()));
  // 셋째 사람의 쿠키도 같은 칸이다. 옛 칸은 믿지 못하는 칸이라 카운터 끝의 번호를 받는다(잃은 번호를 다시 주지 않는다)
  await s.step('enterNumberArrival', () => s.enterNumberArrival([3, 1], 1));
  await s.step('enterRecord', () => s.enterRecord([3, 1]));
  expect(s.tab([3, 1]).phase).toBe('HELD');
  expect(s.tab([3, 1]).seq).not.toBe(lost);
  await finish();
}, 60_000);

// ---- 동작 기록 재생 ----
const manifest = JSON.parse(readFileSync(join(TRACES, 'manifest.json'), 'utf8')) as { specSha256: string; files: string[] };
const specText = readFileSync(SPEC_FILE, 'utf8');

test('V-T40 재생 기록이 지금 명세로 만든 것이다(아니면 node tools/spec-check/run-local.mjs traces --spec queue)', () => {
  expect(manifest.specSha256).toBe(createHash('sha256').update(readFileSync(SPEC_FILE)).digest('hex'));
});

test.each(manifest.files)('V-T40 재생 %s: 걸음마다 구현이 명세와 같은 상태에 닿는다', async (file) => {
  const { module, states } = readTrace(join(TRACES, file));
  const s = new QueueSystem(redis, scopeOf(specText, module), `${process.pid}r${++runNo}`, { specRanks: true });
  await s.init();
  const out = await replay(s, states);
  await s.checkAdmissionKeys();
  expect({ mismatch: out.mismatch, violations: s.violations }).toEqual({ mismatch: null, violations: [] });
  expect(out.replayed).toBe(out.steps);
}, 120_000);
