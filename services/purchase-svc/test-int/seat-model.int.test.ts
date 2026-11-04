// 좌석 홀드·판매 확정 모델 기반 시험(wbs 2.5.5, docs/verification.md §2.4, V-T40, BUILD_ORDER PRF-151). 실제 Valkey(노드 하나짜리 클러스터 모드)와
// PostgreSQL 18 위에서 운영 코드(inventory 모듈의 좌석 Redis Lua·판매 확정 SQL·홀드 원장·다시 만들기)를 돌린다. 명령은 명세 specs/seat.qnt의 동작과 이름이 같다
// (대응과 흉내는 seat-model/system.ts 머리말). 대기열 시험(admission-ctrl/test-int/queue-model.int.test.ts, ADR-0184)과 같은 꼴이다.
// ① 무작위 명령 순서(fc.asyncModelRun): 명세 검사 모듈 범위 넷에서 걸음마다 명세 불변식 ①~⑤, 좌석 Redis 보유 수·한도 행·판 번호의 일치, 명세가 앞 상태에서
//    내다본 결과, 앞 상태에서 계산한 명세 다음 상태(seat-model/spec.ts, 칸마다)가 지켜진다.
// ② 경합(fc.scheduler): 운영 코드의 Redis·DB 호출을 보내는 차례를 스케줄러가 섞는다(걸음마다 하네스가 스케줄러를 돌린다, system.ts). 서로 다른 두 시도의 걸음을
//    함께 돌리는 무작위 순서 한 번(쌍 걸음 수를 단언), 상태를 손으로 만든 집중 시험 셋(시간이 다 된 홀드의 묶기와 만료 반복(갈래별 횟수 단언), 겹치는 두 판매 예약,
//    마감 초과 묶기 뒤의 실패 해제)과 맞수가 이기는 차례를 고정한 시험. 재현 시험 둘(늦은 묶기, K3)은 PRF-160에 넘긴 것을 고정한다.
// ③ 동작 기록 재생: tools/spec-check traces가 낸 명세 기록을 같은 이름의 동작으로 다시 돌려, 걸음마다 시도·좌석 Redis(주 노드·복제본)·purchase DB가 명세와 같다.
//    알려진 차이(system.ts KNOWN)가 설명하는 칸만 빼고 견주며, 모든 걸음을 재생해야 한다.
// 이름 대조는 명령 모음(COMMANDS)의 열쇠와 SPEC_ACTIONS를 견준다(SPEC_ACTIONS와 명세 step의 대조는 CI 형식 검사 tools/spec-check가 한다).
// 실패하면 fast-check가 줄인 순서를 찍는다. 운영 코드의 결함이면 그 순서를 회귀 시험으로 이 파일에 고정한다(2026-11-05 지금은 없다).
// 변이 확인(2026-11-05, 커밋하지 않음): 홀드 Lua 한도 검사 끔·묶기 Lua 판 번호 검사 끔은 ①이, 판매 예약 좌석 정렬 끔(교착 40P01)은 겹치는 판매 예약 집중 시험이,
// ON CONFLICT 대상을 기본 키로 바꿈(23505)은 ①과 그 집중 시험이, 실패 해제의 holdId 대조 끔은 묶기와 만료 집중 시험(같은 계정 맞수)이 잡았다.
// 횟수: MBT_RUNS(기본 40, 경합 집중은 5배. 로컬에서 이 파일 1분 35초 안팎, 2026-11-05). 실패를 다시 돌리려면 MBT_SEED·MBT_PATH(fast-check가 찍는 seed·path). 걸음 기록: MBT_DEBUG=<파일>. 줄이지 않고 처음 실패에서 멈추기: MBT_NO_SHRINK=1.
import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createHotRedis, type Database, type HotRedis } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { SPEC_ACTIONS } from './seat-model/actions.js';
import { COMMANDS, commandArbs, pairArb, type World } from './seat-model/commands.js';
import { readTrace, replay, scopeOf } from './seat-model/itf.js';
import { type Scope, SeatSystem, type SystemOptions, settleAll } from './seat-model/system.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SPEC_FILE = resolve(HERE, '..', '..', '..', 'specs', 'seat.qnt');
const TRACES = join(HERE, 'seat-model', 'traces');
const RUNS = Number(process.env.MBT_RUNS ?? 40);
const replayParams = {
  ...(process.env.MBT_SEED ? { seed: Number(process.env.MBT_SEED) } : {}),
  ...(process.env.MBT_PATH ? { path: process.env.MBT_PATH } : {}),
  // 변이 확인처럼 실패만 빨리 보려면 줄이지 않는다
  ...(process.env.MBT_NO_SHRINK ? { endOnFailure: true } : {}),
  // 줄이기가 길어져 vitest 시간 한도(600초)에 걸리기 전에 멈추고 실패로 알린다
  interruptAfterTimeLimit: 480_000,
  markInterruptAsFailure: true,
};
const specText = readFileSync(SPEC_FILE, 'utf8');

let valkey: ValkeyContainer | undefined;
let server: PostgresContainer | undefined;
let redis: HotRedis;
/** 운영 코드가 쓰는 풀과 관측·씨앗용 풀 */
let db: Database;
let admin: Database;

beforeAll(async () => {
  [valkey, server] = await Promise.all([startValkey({ cluster: true }), startPostgres()]);
  await migratePurchase(server.url);
  await ensureSeatHoldPartitions(server.url);
  redis = await createHotRedis({ url: valkey.url });
  db = createDatabase({ url: server.url, profile: 'general', max: 8, applicationName: 'seat-model' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'seat-model-admin' });
  // 겹치는 판매 예약 집중 시험만: 고른 회차의 seat_sale 행 삽입마다 20ms 쉬어(시험용 트리거, 운영 표에는 없다) 두 삽입 문장이 겹치는 틈을 넓힌다.
  // 좌석을 정렬하지 않고 넣으면 이 틈에서 교착(40P01)이 난다
  await admin.db.execute(sql.raw(`
    create table if not exists mbt_slow_insert (event_id uuid primary key);
    create or replace function mbt_slow_insert() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from mbt_slow_insert where event_id = new.event_id) then perform pg_sleep(0.02); end if;
      return new;
    end $$;
    drop trigger if exists mbt_slow_insert on seat_sale;
    create trigger mbt_slow_insert before insert on seat_sale for each row execute function mbt_slow_insert();`));
});
afterAll(async () => {
  await Promise.allSettled([redis?.close(), db?.close(), admin?.close()]);
  valkey?.stop();
  server?.stop();
});

let last: SeatSystem | undefined;
const make = async (scope: Scope, o: SystemOptions = {}) => {
  last = new SeatSystem(redis, db, admin, scope, o);
  await last.init();
  return last;
};
const setup = (scope: Scope, o: SystemOptions = {}) => async () => {
  const w: World = { s: await make(scope, o) };
  return { model: w, real: w };
};
/** 무작위 실행에서 난 알려진 차이 수(K1~K3, 끝에 찍는다) */
const knownCount: Record<string, number> = { K1: 0, K2: 0, K3: 0 };
const finish = (s: SeatSystem = last!) => {
  for (const k of s.known) knownCount[k.kind] = (knownCount[k.kind] ?? 0) + 1;
  if (s.violations.length > 0) throw new Error(`불변식 위반:\n${s.violations.join('\n')}`);
};

// 명령 순서: 한 걸음에서 할 수 있는 명령은 몇 개뿐이라(나머지는 check가 건너뛴다) 길게 만든다. 실패하면 fast-check가 배열을 줄인다
const plan = (scope: Scope, length = { minLength: 600, maxLength: 1000 }) => fc.array(fc.oneof(...commandArbs(scope)), length);

test('V-T40 명령 모음의 열쇠가 명령 이름(SPEC_ACTIONS)과 같다(14개)', () => {
  expect(Object.keys(COMMANDS).sort()).toEqual([...SPEC_ACTIONS].sort());
  expect(SPEC_ACTIONS).toHaveLength(14);
});

const manifest = JSON.parse(readFileSync(join(TRACES, 'manifest.json'), 'utf8')) as { specSha256: string; files: string[] };

test('V-T40 재생 기록이 지금 명세로 만든 것이다(아니면 node tools/spec-check/run-local.mjs traces --spec seat)', () => {
  expect(manifest.specSha256).toBe(createHash('sha256').update(readFileSync(SPEC_FILE)).digest('hex'));
  expect(manifest.files.length).toBeGreaterThan(0);
  // 목록에 적힌 기록 파일이 모두 있다(해시만 보고 파일이 사라진 것을 놓치지 않게)
  for (const f of manifest.files) expect(existsSync(join(TRACES, f)), f).toBe(true);
});

// 범위: 명세 검사 모듈 셋(전수 검사 범위, 정본 범위, 진행성 범위)과, 장애 전환 한 번을 주 노드 승격에만 쓰는 전수 검사 범위
const PROPOSED = scopeOf(specText, 'seat_proposed');
const VARIANTS: Array<[string, Scope]> = [
  ['seat_proposed: 좌석 3·사람 2·시도 3·장애 1', PROPOSED],
  ['seat_proposed_full: 좌석 3·사람 3·시도 6·요청 9', scopeOf(specText, 'seat_proposed_full')],
  ['seat_live: 좌석 2·사람 2·겹치는 요청', scopeOf(specText, 'seat_live')],
  ['seat_proposed에서 승격만', { ...PROPOSED, fullLoss: false }],
];

test.each(VARIANTS)('모델 기반 무작위 명령 순서(%s): 명세 불변식과 내다본 결과가 지켜진다', async (_name, scope) => {
  await fc.assert(
    fc.asyncProperty(plan(scope), async (cmds) => {
      await fc.asyncModelRun(setup(scope), cmds);
      finish();
    }),
    { numRuns: RUNS, ...replayParams },
  );
}, 600_000);

test('경합(스케줄러): 서로 다른 두 시도의 걸음을 함께 돌려 Redis·DB 호출 차례를 섞어도 불변식과 일치가 지켜진다(쌍 걸음이 실행마다 평균 3번 이상)', async () => {
  // 판매 예약 걸음은 혼자 도는 무게를 낮춰 대개 쌍으로 돈다. 사람 둘이 시도 둘씩(한 좌석 요청이 많아 한 사람의 두 시도가 함께 묶여 판매 예약이 한도 행을 두고 겹친다), 주 노드 승격 두 번(승격이 묶기를 잃으면
  // 두 시도가 같은 좌석을 묶어 판매 예약이 같은 좌석을 두고 겹친다)
  const scope: Scope = {
    people: [1, 2],
    seats: [1, 2, 3],
    limit: 2,
    attempts: [[1, 1], [1, 2], [2, 1], [2, 2]],
    requests: [[1], [2], [3], [1, 2], [2, 3]],
    maxFailovers: 2,
    fullLoss: false,
    promote: true,
    failRelease: true,
  };
  let runs = 0;
  let pairs = 0;
  let sales = 0;
  let overlap = 0;
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.array(fc.oneof({ arbitrary: pairArb(scope), weight: 40 }, ...commandArbs(scope, { saleStep: 1 })), { minLength: 300, maxLength: 500 }), async (sch, cmds) => {
      await fc.asyncModelRun(setup(scope, { scheduler: sch }), cmds);
      runs += 1;
      pairs += last!.pairSteps;
      sales += last!.pairSales;
      overlap += last!.pairSalesOverlap;
      finish();
    }),
    { numRuns: RUNS, ...replayParams },
  );
  console.info(`경합 쌍 걸음: 실행 ${runs}번에 ${pairs}번(판매 예약 둘을 함께 돌린 것 ${sales}번, 그 가운데 같은 좌석·한도 행을 두고 겹친 것 ${overlap}번)`);
  expect(pairs / runs).toBeGreaterThanOrEqual(3);
  expect(sales).toBeGreaterThan(0);
}, 600_000);

const TWO: Scope = { people: [1, 2], seats: [1, 2, 3], limit: 2, attempts: [[1, 1], [1, 2], [2, 1]], requests: [[1, 2]], maxFailovers: 0, fullLoss: false, promote: false, failRelease: true };

test('경합 집중(스케줄러): 시간이 다 된 홀드의 묶기·만료 반복·다른 홀드(다른 사람 또는 같은 계정)가 어떤 차례로 끝나도 한쪽만 좌석을 갖고 판매까지 맞다', async () => {
  // 맞서는 홀드: 21(다른 사람) 또는 12(같은 계정의 다른 시도. 실패 해제가 holdId까지 대조하는지 본다)
  const branches = { pinWins: 0, rivalWins: 0 };
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.constantFrom(21, 12), fc.boolean(), fc.tuple(fc.nat(6), fc.nat(6), fc.nat(6)), async (sch, rival, chained, [dPin, dSweep, dHold]) => {
      const s = await make(TWO, { scheduler: sch });
      await s.step('hold(11, [1,2])', () => s.hold(11, [1, 2]));
      await s.step('accept(11)', () => s.accept(11));
      await s.step('ttlPasses(11)', () => s.ttlPasses(11));
      s.checking = false;
      // 흐름마다 스케줄러가 빈 작업을 d번 푼 뒤 시작한다(만료 반복은 호출이 넷이라 늦게 시작한 홀드·묶기와도 엇갈리게)
      const after = async (d: number, f: () => Promise<unknown>) => {
        for (let i = 0; i < d; i++) await sch.schedule(Promise.resolve(), 'wait');
        return f();
      };
      // 같은 계정의 맞수는 만료가 넣은 '방금 놓은 좌석' 30초 때문에 만료 바로 뒤에는 잡지 못한다: 만료 → 30초 지남 → 홀드를 한 흐름으로 이어 묶기와 엇갈리게 한다
      const rivalFlow =
        rival === 12 || chained
          ? [after(dSweep, async () => {
              await s.expire();
              await s.clearRel();
              await s.hold(rival, [1]);
            })]
          : [after(dSweep, () => s.expire()), after(dHold, () => s.hold(rival, [1]))];
      await s.step(`경합 pin(11) ∥ 만료 반복 ∥ hold(${rival}, [1])${rival === 12 || chained ? '(만료 뒤)' : ''}`, () =>
        settleAll([after(dPin, () => s.pin(11)), ...rivalFlow]),
      );
      s.checking = true;
      const a = s.att(11);
      const b = s.att(rival);
      if (a.phase === 'PINNED') {
        // 묶기가 이겼다(내 홀드를 묶었거나, 만료 뒤 빈 좌석을 다시 잡았다): 맞서는 홀드는 거절
        branches.pinWins += 1;
        expect(b.phase).toBe('DONE');
        expect([s.obs.red.seats[1], s.obs.red.seats[2]]).toEqual([{ hid: 11, pinned: true }, { hid: 11, pinned: true }]);
        await s.step('saleStep(11)', () => s.saleStep(11));
        await s.step('saleStep(11)', () => s.saleStep(11));
        await s.step('approve(11)', () => s.approve(11));
        expect(s.obs.db.sale).toEqual({ 1: [11], 2: [11], 3: [] });
      } else {
        // 만료 뒤 맞서는 홀드가 먼저 잡았다: 묶기는 TAKEN. 좌석 해제 사건 소비자는 잡은 좌석이 없어도 실패 해제를 부르고, 남의 홀드(같은 계정이어도)는 풀지 않는다
        branches.rivalWins += 1;
        expect(a.phase).toBe('FAILED');
        expect(b.phase).toBe('HELD');
        await s.step('releaseFailed(11)', () => s.releaseFailed(11));
        expect(s.obs.red.seats[1]).toEqual({ hid: rival, pinned: false });
        expect(s.holding(11)).toBe(false);
      }
      finish(s);
    }),
    { numRuns: RUNS * 5, ...replayParams },
  );
  // 두 갈래가 다 나와야 이 시험이 차례를 섞은 것이다
  expect(branches.pinWins).toBeGreaterThan(0);
  expect(branches.rivalWins).toBeGreaterThan(0);
}, 600_000);

test.each([21, 12])('경합 차례 고정: 만료 → 맞수 %i의 홀드 → 묶기면 묶기는 실패하고, 실패 해제는 맞수(같은 계정이어도)의 좌석을 풀지 않는다', async (rival) => {
  const s = await make(TWO);
  await s.step('hold(11, [1,2])', () => s.hold(11, [1, 2]), undefined, { a: 'hold', h: 11, l: [1, 2] });
  await s.step('accept(11)', () => s.accept(11), undefined, { a: 'accept', h: 11 });
  await s.step('ttlPasses(11)', () => s.ttlPasses(11), undefined, { a: 'ttlPasses', h: 11 });
  await s.step('expire(11)', () => s.expire(11), undefined, { a: 'expire', h: 11 });
  await s.step(`hold(${rival}, [1])`, () => s.hold(rival, [1]), undefined, { a: 'hold', h: rival, l: [1] });
  await s.step('pin(11)', () => s.pin(11), undefined, { a: 'pin', h: 11 });
  expect([s.att(11).phase, s.att(rival).phase]).toEqual(['FAILED', 'HELD']);
  // 좌석 해제 사건 소비자는 잡은 좌석이 없어도 부른다: 0석이고 맞수의 홀드는 그대로
  await s.step('releaseFailed(11)', () => s.releaseFailed(11), undefined, { a: 'releaseFailed', h: 11 });
  expect(s.obs.red.seats[1]).toEqual({ hid: rival, pinned: false });
  expect(s.holding(11)).toBe(false);
  finish(s);
});

test('경합 집중(스케줄러): 겹치는 두 판매 예약이 어떤 차례로 끝나도 좌석마다 판매 하나·한도 안이고 교착이 없다', async () => {
  // 서로 다른 두 사람이 겹치는 좌석(반대 순서 포함)을, 또는 한 사람이 한도를 넘는 두 주문을 함께 판매 예약한다
  const cases: Array<[string, Array<readonly [number, number[]]>]> = [
    ['반대 순서 [1,2] ∥ [2,1]', [[11, [1, 2]], [21, [2, 1]]]],
    ['한 좌석 겹침 [1,2] ∥ [3,2]', [[11, [1, 2]], [21, [3, 2]]]],
    ['같은 좌석 [2,1] ∥ [1,2]', [[11, [2, 1]], [21, [1, 2]]]],
    ['한 사람 한도 [1] ∥ [3,2]', [[11, [1]], [12, [3, 2]]]],
  ];
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.constantFrom(...cases), async (sch, [, orders]) => {
      const s = await make(TWO, { scheduler: sch });
      await admin.db.execute(sql`insert into mbt_slow_insert (event_id) values (${s.eventId}::uuid)`);
      s.checking = false;
      let outs: string[] = [];
      await s.step('판매 예약 경합', async () => {
        outs = await s.reserveTogether(orders);
      });
      expect(outs.filter((o) => o === 'RESERVED')).toHaveLength(1);
      expect(outs).not.toContain('DEADLOCK');
      finish(s);
    }),
    { numRuns: RUNS * 5, ...replayParams },
  );
}, 600_000);

/** 마감 초과 묶기 뒤 실패 해제 하나로는 늦게 닿은 묶기가 좌석을 다시 잡아 남은 횟수(보고용, PRF-160에 넘긴다) */
let lateRegrabs = 0;

test('경합 집중(스케줄러): 마감 초과 묶기 뒤의 실패 해제와 다른 사람의 홀드가 엇갈려도, 소비자의 다시 해제 뒤 실패한 시도에 좌석이 남지 않는다', async () => {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.integer({ min: 0, max: 6 }), async (sch, waits) => {
      const s = await make(TWO, { scheduler: sch });
      await s.step('hold(11, [1,2])', () => s.hold(11, [1, 2]));
      await s.step('accept(11)', () => s.accept(11));
      s.checking = false;
      // 마감: 스케줄러가 빈 작업을 waits번 푼 뒤 끝난다(묶기 호출의 문과 엇갈린다)
      const deadline = (async () => {
        for (let i = 0; i <= waits; i++) await sch.schedule(Promise.resolve(), 'deadline');
      })();
      let saga: Awaited<ReturnType<SeatSystem['pinWithDeadline']>> = { saga: 'FAILED' };
      await s.step('경합 마감 있는 pin(11) ∥ hold(21, [2])', async () => {
        [saga] = (await settleAll<unknown>([s.pinWithDeadline(11, deadline), s.hold(21, [2]), deadline])) as [typeof saga];
      });
      const a = s.att(11);
      if (a.phase === 'FAILED' && s.holding(11)) {
        // 늦게 닿은 묶기가 실패 해제 뒤에 좌석을 다시 잡았다: 묶인 좌석은 만료되지 않으므로 소비자가 한 번 더 풀어야 한다
        lateRegrabs += 1;
        expect(saga.saga).toBe('TIMEOUT');
        await s.step('releaseFailed(11) 다시', () => s.releaseFailed(11));
      }
      s.checking = true;
      if (a.phase === 'PINNED') {
        expect(s.att(21).phase).toBe('DONE');
        expect([s.obs.red.seats[1], s.obs.red.seats[2]]).toEqual([{ hid: 11, pinned: true }, { hid: 11, pinned: true }]);
      } else {
        expect(a.phase).toBe('FAILED');
        expect(s.holding(11)).toBe(false);
        expect(s.obs.red.quota[1]).toBe(0);
      }
      finish(s);
    }),
    { numRuns: RUNS * 5, ...replayParams },
  );
}, 600_000);

test('재현(결함 후보, PRF-160에 넘김): 실패 해제가 먼저 돌고 마감을 넘긴 묶기가 뒤에 닿으면 묶인 좌석이 실패한 시도에 남는다(만료되지 않는다)', async () => {
  const s = await make(TWO);
  await s.step('hold(11, [1,2])', () => s.hold(11, [1, 2]));
  await s.step('accept(11)', () => s.accept(11));
  s.checking = false;
  // 결과 모름으로 실패 → 실패 해제가 먼저, 그 뒤에 묶기 Lua가 닿는다
  s.att(11).phase = 'FAILED';
  await s.step('releaseFailed(11)', () => s.releaseFailed(11));
  const late = await s.lateRegrab(11);
  expect(late).toBe('OK');
  expect([s.obs.red.seats[1], s.obs.red.seats[2]]).toEqual([{ hid: 11, pinned: true }, { hid: 11, pinned: true }]);
  // 묶인 좌석은 만료 인덱스에 없다: 시간이 다 돼도 만료 반복이 풀지 못한다
  expect(await s.expire()).toBe(0);
  // 소비자가 한 번 더 풀면 풀린다
  await s.step('releaseFailed(11) 다시', () => s.releaseFailed(11));
  expect(s.holding(11)).toBe(false);
  finish(s);
});

test('재현_K3(PRF-160에 넘김): 원장 행 없이 다시 만든 판매 좌석은 holdId가 주문 ID라, 승인 거절 뒤 그 홀드의 holdId로 부른 실패 해제가 풀지 못한다', async () => {
  const scope: Scope = { people: [1], seats: [1], limit: 2, attempts: [[1, 1]], requests: [[1]], maxFailovers: 1, fullLoss: true, promote: false, failRelease: true };
  const s = await make(scope);
  await s.step('hold(11, [1])', () => s.hold(11, [1]));
  await s.step('accept(11)', () => s.accept(11));
  await s.step('pin(11)', () => s.pin(11));
  await s.step('saleStep(11)', () => s.saleStep(11));
  expect(s.att(11).phase).toBe('RESERVED');
  // 적재(relay) 전에 전체 유실 → 다시 만들기: 판매 좌석을 원장 행 없이 되살린다
  await s.loseAll();
  await s.note('loseAll');
  await s.step('rebuild', () => s.rebuild());
  expect(s.obs.red.seats[1]).toEqual({ hid: 11, pinned: true });
  await s.step('decline(11)', () => s.decline(11));
  s.checking = false;
  let released = -1;
  await s.step('releaseFailed(11) holdId로', async () => {
    released = await s.releaseFailed(11, s.holdIdOf(11));
  });
  // 그 홀드의 holdId로는 0석: 판매가 없는데 묶인 좌석이 남는다(만료 인덱스에도 없다)
  expect(released).toBe(0);
  expect(s.obs.red.seats[1]).toEqual({ hid: 11, pinned: true });
  // 하네스의 맞춤(K3): 주문 ID로 한 번 더 부르면 풀린다
  s.checking = true;
  await s.step('releaseFailed(11)', () => s.releaseFailed(11));
  expect(s.known.map((k) => k.kind)).toContain('K3');
  expect(s.holding(11)).toBe(false);
  finish(s);
});

// ---- 동작 기록 재생 ----
test.each(manifest.files)('V-T40 재생 %s: 걸음마다 운영 코드가 명세와 같은 상태에 닿는다', async (file) => {
  const { module, states } = readTrace(join(TRACES, file));
  const s = new SeatSystem(redis, db, admin, scopeOf(specText, module));
  await s.init();
  const out = await replay(s, states);
  expect({ mismatch: out.mismatch, known: out.known, violations: s.violations }).toEqual({ mismatch: null, known: null, violations: [] });
  expect(out.replayed).toBe(out.steps);
  expect(out.steps).toBe(states.length - 1);
}, 120_000);

afterAll(() => {
  console.info(`이 파일의 실행에서 난 알려진 차이(재현 시험 포함): K1 ${knownCount.K1}번, K2 ${knownCount.K2}번, K3 ${knownCount.K3}번`);
  if (lateRegrabs > 0) console.info(`마감 초과 묶기 뒤 실패 해제 하나로는 늦은 묶기가 좌석을 다시 잡은 횟수: ${lateRegrabs}(소비자의 다시 해제로 풀었다)`);
});
