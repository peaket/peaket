// 대기 상태 파일(docs/features/queue-admission.md §4 '대기 상태 파일의 첫 구현', openapi QueueState, ADR-0110, Q-T7)
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryStateSnapshots } from '../src/modules/state/adapters/memory-state-snapshots.js';
import { nextBoundary, StateFiles, StateUnavailable } from '../src/modules/state/application/state-files.js';
import { ACTIVE_FOR_MS, AHEAD_SEGMENTS, buildStateFiles, MAX_ACTIVE_EVENTS, type QueueStateBody, type StateSnapshot } from '../src/modules/state/domain/state.js';
import { MemoryEventSchedules } from '../src/modules/entry/index.js';
import { QueueStoreUnavailable } from '../src/modules/entry/domain/queue.js';
import { openSchedule } from './support.js';

const T = Date.parse('2026-11-03T03:00:00Z');
const schedule = openSchedule(T);
const parse = (body: string) => JSON.parse(body) as QueueStateBody;

function snap(o: Partial<StateSnapshot> & { removedNumbers?: number[] } = {}): StateSnapshot {
  const { removedNumbers = [], ...rest } = o;
  const seq = rest.seq ?? 0;
  const bits = new Uint8Array((Math.max(seq, ...removedNumbers, 0) >> 3) + 1);
  for (const n of removedNumbers) bits[n >> 3]! |= 0x80 >> (n & 7);
  return { seq, serving: 0, removed: bits, skipped: [], servingLog: [], calls: [], ...rest };
}

/** 화면이 하는 앞 인원 계산(docs/frontend.md §4 '앞 인원'): (내 번호 − serving − 1) − (그 사이 빠진 번호) */
function aheadFromFile(f: QueueStateBody, n: number): number {
  const seg = Math.floor((n - 1) / 1000);
  const bits = Buffer.from(f.removedBitmap, 'base64');
  let inSegBefore = 0;
  for (let k = 0; k < n - (seg * 1000 + 1); k++) inSegBefore += (bits[k >> 3]! >> (7 - (k & 7))) & 1;
  const between = f.removedBeforeSegment + inSegBefore - f.removedUpToServing;
  return Math.max(0, n - f.serving - 1 - between);
}

describe('파일 만들기', () => {
  test('Q-T7_빠진번호(비트맵·건너뛴구간)를무작위로대량넣어도_파일로계산한앞인원이원장과모든번호에서같다', () => {
    let x = 7;
    const rnd = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const seq = 5_437;
    const removedNumbers = Array.from({ length: seq }, (_, i) => i + 1).filter(() => rnd() < 0.2);
    const skipped = [
      { start: 1_201, end: 1_260 },
      { start: 4_000, end: 4_013 },
    ];
    for (const serving of [0, 1, 999, 1_000, 1_001, 1_250, 2_718]) {
      const s = snap({ seq, serving, removedNumbers, skipped });
      const files = buildStateFiles(s, schedule, T).map((f) => parse(f.body));
      const gone = (n: number) => removedNumbers.includes(n) || skipped.some((r) => r.start <= n && n <= r.end);
      let truth = 0;
      for (let n = serving + 1; n <= seq; n++) {
        expect(aheadFromFile(files[Math.floor((n - 1) / 1000)]!, n), `serving ${serving}, 번호 ${n}`).toBe(truth);
        if (!gone(n)) truth++;
      }
    }
  });

  test('구간비트맵의k번째비트(바이트안높은비트부터)는_번호s×1000+1+k이고_seq뒤번호는켜지않는다', () => {
    const s = snap({ seq: 2_010, removedNumbers: [1, 8, 1_000, 1_001, 1_009, 2_011] });
    const [f0, f1, f2] = buildStateFiles(s, schedule, T).map((f) => Buffer.from(parse(f.body).removedBitmap, 'base64'));
    expect(f0!.length).toBe(125);
    expect(f0![0]).toBe(0b1000_0001); // 번호 1(k=0)과 8(k=7)
    expect(f0![124]).toBe(0b0000_0001); // 번호 1000(k=999)
    expect(f1![0]).toBe(0b1000_0000); // 번호 1001
    expect(f1![1]).toBe(0b1000_0000); // 번호 1009(k=8)
    expect([...f2!].every((b) => b === 0)).toBe(true); // 2011은 seq 뒤
  });

  test('누계: removedBeforeSegment는번호1~s×1000의빠진번호수_removedUpToServing은1~serving의빠진번호수(건너뛴구간포함)', () => {
    const s = snap({ seq: 3_000, serving: 1_500, removedNumbers: [10, 999, 1_200], skipped: [{ start: 1_998, end: 2_002 }] });
    const files = buildStateFiles(s, schedule, T).map((f) => parse(f.body));
    // 구간 3부터는 seq(3,000) 뒤라 seq까지의 빠진 번호 전부(셋 + 건너뛴 다섯)
    expect(files.slice(0, 4).map((f) => f.removedBeforeSegment)).toEqual([0, 2, 6, 8]);
    expect(files[0]!.removedUpToServing).toBe(3);
  });

  test('seq가든구간뒤로도_100구간[가정]까지는같은값으로만들어_방금생긴구간이404가아니다', () => {
    expect(buildStateFiles(snap({ seq: 0 }), schedule, T)).toHaveLength(1 + AHEAD_SEGMENTS);
    expect(buildStateFiles(snap({ seq: 1_001 }), schedule, T)).toHaveLength(2 + AHEAD_SEGMENTS);
    const files = buildStateFiles(snap({ seq: 1_500, removedNumbers: [3, 1_400] }), schedule, T).map((f) => parse(f.body));
    // 아직 낸 번호가 없는 구간: 비트맵은 0이고 앞 누계는 seq까지의 빠진 번호 전부
    expect(files[5]!.removedBeforeSegment).toBe(2);
    expect(Buffer.from(files[5]!.removedBitmap, 'base64').every((b) => b === 0)).toBe(true);
  });

  test('진행속도는_다지난최근10칸(지금칸제외)동안지난유효번호수÷기록이있는가장오래된칸부터지난칸끝까지의칸수다', () => {
    const now = Math.floor(T / 1000);
    // 창은 지금 - 10 ~ 지금 - 1. 창 앞 기준 serving 100, 창 안 마지막 serving 400, 그 사이 빠진 번호 둘. 가장 오래된 기록 칸은 지금 - 5
    const s = snap({ seq: 1_000, serving: 450, removedNumbers: [150, 151], servingLog: [{ slot: now - 12, serving: 100 }, { slot: now - 5, serving: 250 }, { slot: now - 1, serving: 400 }, { slot: now, serving: 450 }] });
    // 창 앞 기준 칸이 있으면 창 10칸 전체로 나눈다(전진이 없던 칸도 센다)
    expect(parse(buildStateFiles(s, schedule, T)[0]!.body).servingRate).toBe(Math.round(((400 - 100 - 2) / 10) * 1000) / 1000);
    // 쉰 뒤 첫 전진: 지금 - 11에 1,000, 지금 - 1에 1,100이면 10초 평균은 초당 10이다
    const idle = [{ slot: now - 11, serving: 1_000 }, { slot: now - 1, serving: 1_100 }];
    expect(parse(buildStateFiles(snap({ seq: 2_000, serving: 1_100, servingLog: idle }), schedule, T)[0]!.body).servingRate).toBe(10);
    // 칸마다 100씩 오르면 경계에서 재도 초당 100이다(막 시작한 지금 칸을 나누는 수에 넣지 않는다)
    const even = Array.from({ length: 12 }, (_, i) => ({ slot: now - 11 + i, serving: 100 * i }));
    expect(parse(buildStateFiles(snap({ seq: 2_000, serving: 1_100, servingLog: even }), schedule, T)[0]!.body).servingRate).toBe(100);
    // 창 앞 기록이 없으면 기준은 0, 창 안에 기록이 없으면 0
    expect(parse(buildStateFiles(snap({ seq: 50, serving: 30, servingLog: [{ slot: now - 2, serving: 30 }] }), schedule, T)[0]!.body).servingRate).toBe(15);
    expect(parse(buildStateFiles(snap({ seq: 50, serving: 30, servingLog: [{ slot: now - 20, serving: 30 }] }), schedule, T)[0]!.body).servingRate).toBe(0);
    // 시계가 어긋나 미래 칸이 있어도 창 앞 기준을 잃지 않는다
    const skew = [...even, { slot: now + 1, serving: 1_200 }, { slot: now + 2, serving: 1_300 }];
    expect(parse(buildStateFiles(snap({ seq: 2_000, serving: 1_300, servingLog: skew }), schedule, T)[0]!.body).servingRate).toBe(100);
  });

  test('입장임박은_serving이든구간과다음번호의구간부터첫번호까지예상대기60초이내인구간까지이고_속도가0이면그둘만이며_지난구간은아니다', () => {
    const now = Math.floor(T / 1000);
    // 칸마다 100씩: 창 앞 기준(지금 - 10칸) 4,000 → 지금 5,000, 1,000번 ÷ 10칸 = 초당 100
    const log = Array.from({ length: 12 }, (_, i) => ({ slot: now - 11 + i, serving: 3_900 + 100 * i }));
    const s = snap({ seq: 20_000, serving: 5_000, servingLog: log });
    const imminent = buildStateFiles(s, schedule, T).flatMap((f, i) => (f.imminent ? [i] : []));
    // 구간 5(5001~6000)는 앞 0명, 구간 10(10001~)은 앞 5,000명 = 50초, 구간 11은 60초, 구간 12는 70초
    expect(imminent).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    const still = buildStateFiles(snap({ seq: 20_000, serving: 5_000 }), schedule, T).flatMap((f, i) => (f.imminent ? [i] : []));
    expect(still).toEqual([4, 5]);
    expect(buildStateFiles(snap({ seq: 3_000, serving: 0 }), schedule, T).slice(0, 3).map((f) => f.imminent)).toEqual([true, false, false]);
    // serving이 구간 끝(1,000)이면 다음에 부를 1,001이 든 구간 1도 임박이다(속도가 0이어도)
    expect(buildStateFiles(snap({ seq: 3_000, serving: 1_000 }), schedule, T).slice(0, 3).map((f) => f.imminent)).toEqual([true, true, false]);
  });

  test('servingSteps는_입장임박구간파일에만_최근5초의[전진시각,그전진의마지막번호]를시각순으로싣는다', () => {
    // 경계(T) 뒤 읽기 전에 일어난 전진(T + 200)도 serving에 들어 있으므로 함께 싣는다
    const calls = [{ atMs: T - 6_000, last: 100 }, { atMs: T + 200, last: 400 }, { atMs: T - 300, last: 300 }, { atMs: T - 4_900, last: 200 }];
    const files = buildStateFiles(snap({ seq: 5_000, serving: 400, calls }), schedule, T).map((f) => parse(f.body));
    expect(files[0]!.servingSteps).toEqual([[T - 4_900, 200], [T - 300, 300], [T + 200, 400]]);
    expect(files[3]!.servingSteps).toBeUndefined();
  });

  test('판매종료뒤에만든파일은ENDED_그전은ON_SALE이고_공개파일이라회차값만싣는다', () => {
    const saleEnd = schedule.startsAtMs - 24 * 3600_000;
    expect(parse(buildStateFiles(snap({ seq: 1 }), schedule, saleEnd - 1)[0]!.body).saleStatus).toBe('ON_SALE');
    expect(parse(buildStateFiles(snap({ seq: 1 }), schedule, saleEnd)[0]!.body).saleStatus).toBe('ENDED');
    expect(Object.keys(parse(buildStateFiles(snap({ seq: 1 }), schedule, T)[0]!.body)).sort()).toEqual(
      ['admissionPaused', 'generatedAtMs', 'pollHintMs', 'removedBeforeSegment', 'removedBitmap', 'removedUpToServing', 'saleStatus', 'serving', 'servingRate', 'servingSteps', 'soldOutTiers'].sort(),
    );
  });
});

describe('판매 상태(HOT-010, ADR-0214)', () => {
  const statusOf = (s: StateSnapshot, at = T, platform?: Parameters<typeof buildStateFiles>[3]) => parse(buildStateFiles(s, schedule, at, platform)[0]!.body);

  test('Q-T51_파일의판매상태는_판매종료>SOLD_OUT>PAUSED>ALL_HELD>TIER_SOLD_OUT>ON_SALE차례로덧씌운다', () => {
    const saleEnd = schedule.startsAtMs - 24 * 3600_000;
    const cases: [StateSnapshot['notice'], string, number?][] = [
      [undefined, 'ON_SALE'],
      [{ saleState: 'ON_SALE' }, 'ON_SALE'],
      [{ saleState: 'ALL_HELD' }, 'ALL_HELD'],
      [{ saleState: 'SOLD_OUT' }, 'SOLD_OUT'],
      [{ saleState: 'ENDED' }, 'ENDED'],
      [{ saleState: 'ON_SALE', soldOutTiers: ['R'] }, 'TIER_SOLD_OUT'],
      [{ saleState: 'ALL_HELD', soldOutTiers: ['R'] }, 'ALL_HELD'],
      [{ saleState: 'ALL_HELD', paused: true }, 'PAUSED'],
      [{ saleState: 'ON_SALE', suspended: true, soldOutTiers: ['R'] }, 'PAUSED'],
      [{ saleState: 'SOLD_OUT', paused: true }, 'SOLD_OUT'],
      [{ saleState: 'SOLD_OUT' }, 'ENDED', saleEnd],
      [{ saleState: 'ON_SALE', paused: true }, 'ENDED', saleEnd],
    ];
    for (const [notice, want, at] of cases) expect(statusOf(snap({ seq: 1, notice }), at).saleStatus, JSON.stringify({ notice, at })).toBe(want);
  });

  test('Q-T51_전체범위공지의일시정지(paused·suspended)도_PAUSED이고_매진·판매종료는그보다앞선다', () => {
    expect(statusOf(snap({ seq: 1 }), T, { paused: true }).saleStatus).toBe('PAUSED');
    expect(statusOf(snap({ seq: 1, notice: { saleState: 'ALL_HELD' } }), T, { suspended: true }).saleStatus).toBe('PAUSED');
    expect(statusOf(snap({ seq: 1, notice: { saleState: 'SOLD_OUT' } }), T, { paused: true }).saleStatus).toBe('SOLD_OUT');
  });

  test('Q-T54③_등급매진이면_대기는이어지고(TIER_SOLD_OUT)_soldOutTiers에그등급만든다', () => {
    const f = statusOf(snap({ seq: 3, serving: 1, notice: { saleState: 'ON_SALE', soldOutTiers: ['R'] } }));
    expect(f.saleStatus).toBe('TIER_SOLD_OUT');
    expect(f.soldOutTiers).toEqual(['R']);
    expect(f.serving).toBe(1);
    expect(statusOf(snap({ seq: 1, notice: { saleState: 'SOLD_OUT', soldOutTiers: ['R', 'S'] } })).soldOutTiers).toEqual(['R', 'S']);
  });

  test('공지배너는_회차공지가먼저이고_없으면전체범위공지이며_둘다없으면칸을싣지않는다', () => {
    expect(statusOf(snap({ seq: 1, notice: { banner: '회차 공지' } }), T, { banner: '전체 공지' }).banner).toBe('회차 공지');
    expect(statusOf(snap({ seq: 1 }), T, { banner: '전체 공지' }).banner).toBe('전체 공지');
    expect('banner' in statusOf(snap({ seq: 1 }))).toBe(false);
  });

  test('BAS-042_admissionPaused는_ctl의admitPaused가켜졌고만료전일때만참이다(리더와같은규칙)', () => {
    expect(statusOf(snap({ seq: 1 })).admissionPaused).toBe(false);
    expect(statusOf(snap({ seq: 1, admit: { paused: true, untilMs: null } })).admissionPaused).toBe(true);
    expect(statusOf(snap({ seq: 1, admit: { paused: true, untilMs: T + 1 } })).admissionPaused).toBe(true);
    expect(statusOf(snap({ seq: 1, admit: { paused: true, untilMs: T } })).admissionPaused).toBe(false);
    expect(statusOf(snap({ seq: 1, admit: { paused: false, untilMs: null } })).admissionPaused).toBe(false);
  });

  test('전체범위공지는_켤때와매초생성때한번씩읽고_못읽으면앞값을쓴다', async () => {
    const clock = fakeClock({ now: T + 400 });
    const snapshots = new MemoryStateSnapshots();
    const schedules = new MemoryEventSchedules();
    await schedules.set('ev1', schedule);
    await schedules.set('ev2', schedule);
    snapshots.setPlatform({ paused: true, banner: '전체 공지' });
    const files = new StateFiles(snapshots, schedules, clock, { webOrigin: 'https://www.peaket.example', autoTick: false });
    expect(parse((await files.file('ev1', 0))!.body)).toMatchObject({ saleStatus: 'PAUSED', banner: '전체 공지' });
    await files.file('ev2', 0);
    const before = snapshots.platformReads;
    snapshots.setPlatform({});
    await files.tick(T + 1000);
    expect(snapshots.platformReads - before).toBe(1);
    expect(parse((await files.file('ev2', 0))!.body).saleStatus).toBe('ON_SALE');
    snapshots.setPlatform({ suspended: true });
    snapshots.failPlatformNext = new QueueStoreUnavailable(new Error('잠시 안 됨'));
    await files.tick(T + 2000);
    // 못 읽은 초는 앞 값(전체 범위 공지 없음)으로 만든다
    expect(parse((await files.file('ev1', 0))!.body)).toMatchObject({ saleStatus: 'ON_SALE', generatedAtMs: T + 2000 });
  });

  test('[ASVS v5.0.0-14.3.2] 판매상태·매진등급·공지·입장일시정지를더해도_공개파일은회차값만싣는다', () => {
    const f = statusOf(snap({ seq: 1, notice: { saleState: 'ON_SALE', soldOutTiers: ['R'], banner: '안내' }, admit: { paused: true, untilMs: null } }));
    expect(Object.keys(f).sort()).toEqual(
      ['admissionPaused', 'banner', 'generatedAtMs', 'pollHintMs', 'removedBeforeSegment', 'removedBitmap', 'removedUpToServing', 'saleStatus', 'serving', 'servingRate', 'servingSteps', 'soldOutTiers'].sort(),
    );
  });
});

describe('켜기·매초 다시 만들기', () => {
  const setup = async () => {
    const clock = fakeClock({ now: T + 400 });
    const snapshots = new MemoryStateSnapshots();
    const schedules = new MemoryEventSchedules();
    await schedules.set('ev1', schedule);
    const files = new StateFiles(snapshots, schedules, clock, { webOrigin: 'https://www.peaket.example', autoTick: false });
    return { clock, snapshots, schedules, files };
  };

  test('일정사본이없는회차는켜지않고null이다_대기열Redis를읽지않는다', async () => {
    const { snapshots, files } = await setup();
    expect(await files.file('nope', 0)).toBeNull();
    expect(files.activeForTest()).toBe(0);
    expect(snapshots.reads).toBe(0);
  });

  test('처음물을때한번읽고_생성시각은그초경계다_같은초의다른요청은다시읽지않는다_마지막구간뒤는null', async () => {
    const { snapshots, files } = await setup();
    snapshots.set('ev1', { seq: 1_500 });
    const f = await files.file('ev1', 1);
    expect(f?.generatedAtMs).toBe(T);
    await files.file('ev1', 0);
    expect(await files.file('ev1', 2 + AHEAD_SEGMENTS)).toBeNull();
    expect(snapshots.reads).toBe(1);
  });

  test('매초경계에켠회차를다시만들고_마지막요청뒤60초가지나면끈다', async () => {
    const { clock, snapshots, files } = await setup();
    snapshots.set('ev1', { seq: 10, serving: 1 });
    await files.file('ev1', 0);
    snapshots.set('ev1', { seq: 10, serving: 7 });
    await files.tick(T + 1_000);
    const f = await files.file('ev1', 0);
    expect(f?.generatedAtMs).toBe(T + 1_000);
    expect(parse(f!.body).serving).toBe(7);
    clock.advance(ACTIVE_FOR_MS + 2_000);
    await files.tick(T + ACTIVE_FOR_MS + 3_000);
    expect(files.activeForTest()).toBe(0);
  });

  test('켤때처음만들지못하면StateUnavailable이고_매초다시만들다실패하면앞파일을그대로낸다', async () => {
    const { snapshots, files } = await setup();
    snapshots.failNext = new QueueStoreUnavailable(new Error('down'));
    await expect(files.file('ev1', 0)).rejects.toBeInstanceOf(StateUnavailable);
    snapshots.set('ev1', { seq: 5, serving: 2 });
    expect(parse((await files.file('ev1', 0))!.body).serving).toBe(2);
    snapshots.failNext = new QueueStoreUnavailable(new Error('down'));
    await files.tick(T + 1_000);
    expect((await files.file('ev1', 0))?.generatedAtMs).toBe(T);
  });

  test('켜는중에같은회차요청이몰려도_일정사본과대기열Redis를한번씩만읽는다', async () => {
    const { snapshots, schedules, files } = await setup();
    let gets = 0;
    const counting = { get: async (id: string) => (gets++, schedules.get(id)) };
    const f = new StateFiles(snapshots, counting, fakeClock({ now: T + 400 }), { webOrigin: 'x', autoTick: false });
    snapshots.set('ev1', { seq: 3_000 });
    const got = await Promise.all(Array.from({ length: 50 }, (_, i) => f.file('ev1', i % 3)));
    expect(got.every((x) => x !== null)).toBe(true);
    expect(gets).toBe(1);
    expect(snapshots.reads).toBe(1);
  });

  test('켜는중에돈매초생성은그회차를건너뛰고_켜기가끝난뒤의매초생성이새파일을만든다', async () => {
    const { snapshots, schedules } = await setup();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let n = 0;
    const gated = { readPlatform: async () => ({}), read: async (id: string) => (n++ === 0 ? (await slow, { ...(await snapshots.read(id)), serving: 1 }) : { ...(await snapshots.read(id)), serving: 2 }) };
    const f = new StateFiles(gated, schedules, fakeClock({ now: T + 400 }), { webOrigin: 'x', autoTick: false });
    const first = f.file('ev1', 0);
    await new Promise((r) => setImmediate(r));
    await f.tick(T + 1_000);
    expect(n).toBe(1);
    release();
    expect((await first)?.generatedAtMs).toBe(T);
    await f.tick(T + 2_000);
    const now = await f.file('ev1', 0);
    expect(now?.generatedAtMs).toBe(T + 2_000);
    expect(parse(now!.body).serving).toBe(2);
  });

  test('매초생성에서일시장애가아닌오류(키형이틀림)가나도_던지지않고다른회차는그대로만든다', async () => {
    const { snapshots, schedules, files } = await setup();
    await schedules.set('ev2', schedule);
    snapshots.set('ev2', { seq: 3, serving: 1 });
    await files.file('ev1', 0);
    await files.file('ev2', 0);
    snapshots.failNext = new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    snapshots.set('ev2', { seq: 3, serving: 3 });
    await expect(files.tick(T + 1_000)).resolves.toBeUndefined();
    expect(parse((await files.file('ev2', 0))!.body).serving).toBe(3);
  });

  test('켤때일정사본을대기열Redis에서못읽어도_StateUnavailable이다(500이아니라503으로나가게)', async () => {
    const { snapshots } = await setup();
    const down = { get: async () => Promise.reject(new QueueStoreUnavailable(new Error('down'))) };
    const f = new StateFiles(snapshots, down, fakeClock({ now: T }), { webOrigin: 'x', autoTick: false });
    await expect(f.file('ev1', 0)).rejects.toBeInstanceOf(StateUnavailable);
    expect(f.activeForTest()).toBe(0);
  });

  test('매초생성은회차를함께만들어_느린회차하나가다른회차를붙잡지않는다', async () => {
    const { snapshots, schedules } = await setup();
    await schedules.set('slow', schedule);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let slowReads = 0;
    const s = { readPlatform: async () => ({}), read: async (id: string) => (id === 'slow' && slowReads++ > 0 ? (await gate, snapshots.read(id)) : snapshots.read(id)) };
    const f = new StateFiles(s, schedules, fakeClock({ now: T + 400 }), { webOrigin: 'x', autoTick: false });
    await f.file('slow', 0);
    await f.file('ev1', 0);
    const t = f.tick(T + 1_000);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect((await f.file('ev1', 0))?.generatedAtMs).toBe(T + 1_000);
    release();
    await t;
  });

  test('일정사본을확인하기전의회차는_켠목록에넣지않아_무작위회차ID가몰려도진짜회차를밀어내지않는다', async () => {
    const { snapshots, files } = await setup();
    snapshots.set('ev1', { seq: 5 });
    await files.file('ev1', 0);
    await Promise.all(Array.from({ length: MAX_ACTIVE_EVENTS + 5 }, (_, i) => files.file(`fake${i}`, 0)));
    expect(files.activeForTest()).toBe(1);
    expect(snapshots.reads).toBe(1);
    await files.file('ev1', 0);
    expect(snapshots.reads).toBe(1);
  });

  test('켜기의생성시각은_대기열Redis를읽기바로전의초경계다(일정사본읽기가경계를넘으면그다음경계)', async () => {
    const { clock, snapshots, schedules } = await setup();
    clock.advance(500); // T + 900
    const slow = { get: async (id: string) => (clock.advance(200), schedules.get(id)) }; // 사본 읽기가 경계(T + 1,000)를 넘김
    const f = new StateFiles(snapshots, slow, clock, { webOrigin: 'x', autoTick: false });
    expect((await f.file('ev1', 0))?.generatedAtMs).toBe(T + 1_000);
  });

  test('타이머가경계보다조금일찍깨도_같은경계를두번돌지않는다', () => {
    expect(nextBoundary(T + 999, T + 1_000)).toBe(T + 2_000);
    expect(nextBoundary(T + 1_000, T + 1_000)).toBe(T + 2_000);
    expect(nextBoundary(T + 400, undefined)).toBe(T + 1_000);
  });

  test('켠회차수에는상한이있어_넘으면가장오래묻지않은회차부터끈다', async () => {
    const { clock, schedules, files } = await setup();
    for (let i = 0; i <= MAX_ACTIVE_EVENTS; i++) {
      await schedules.set(`e${i}`, schedule);
      clock.advance(1);
      await files.file(`e${i}`, 0);
    }
    expect(files.activeForTest()).toBe(MAX_ACTIVE_EVENTS);
  });
});
