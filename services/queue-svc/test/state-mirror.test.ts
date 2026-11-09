// 대기 상태 파일의 폴링 힌트와 S3 사본(docs/features/queue-admission.md §4 HOT-020 절, ADR-0223 결정 8·9, Q-T17·Q-T66).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEventSchedules } from '../src/modules/entry/index.js';
import { MemoryStateSnapshots } from '../src/modules/state/adapters/memory-state-snapshots.js';
import { MemoryStateMirrors } from '../src/modules/state/adapters/memory-state-mirrors.js';
import { StateFiles } from '../src/modules/state/application/state-files.js';
import { buildStateFiles, type QueueStateBody, type StateSnapshot } from '../src/modules/state/domain/state.js';
import { openSchedule, newEvent } from './support.js';

const T = Date.parse('2026-11-09T03:00:00Z');
const schedule = openSchedule(T);
const snap = (o: Partial<StateSnapshot>): StateSnapshot => ({ seq: 100_000, serving: 0, removed: new Uint8Array(0), skipped: [], servingLog: [], calls: [], ...o });
const hints = (files: { body: string }[]) => files.map((f) => (JSON.parse(f.body) as QueueStateBody).pollHintMs);
/** 초당 100번호로 움직이는 serving_log(차례 진행 속도 100/초) */
const moving = { serving: 10_000, servingLog: Array.from({ length: 11 }, (_, i) => ({ slot: T / 1000 - 11 + i, serving: 10_000 + i * 100 })) };

describe('폴링 힌트(Q-T17·Q-T66)', () => {
  test('[Q-T17] [Q-T66] 표시가없으면_힌트는0이다', () => {
    expect(new Set(hints(buildStateFiles(snap(moving), schedule, T)))).toEqual(new Set([0]));
  });

  test('[Q-T17] [Q-T66] 회차표시가켜지면_임박구간은1초_1~5분구간은10초_그밖구간은40초다', () => {
    const files = buildStateFiles(snap({ ...moving, notice: { stateDegraded: true } }), schedule, T);
    const h = hints(files);
    // serving 10,000, 속도 100/초: 구간 11(번호 11,001~)까지 앞 인원 1,000 → 10초라 임박
    expect(h[11]).toBe(1000);
    // 앞 인원 6,001~30,000(60~300초) 구간은 10초
    expect(h[20]).toBe(10_000);
    expect(h[40]).toBe(10_000);
    // 앞 인원 30,001 넘게(300초 넘게) 구간은 40초
    expect(h[60]).toBe(40_000);
    // 임박 표시와 힌트의 구간이 같은 잣대다
    expect(files[11]!.imminent).toBe(true);
  });

  test('[Q-T17] [Q-T66] 전체범위표시도_같은힌트를싣는다', () => {
    const h = hints(buildStateFiles(snap(moving), schedule, T, { stateDegraded: true }));
    expect(h[11]).toBe(1000);
    expect(h[60]).toBe(40_000);
  });

  test('[Q-T17] [Q-T66] 속도가0이면_임박구간만1초이고_그밖은40초다(화면의거리별주기와같다)', () => {
    const files = buildStateFiles(snap({ serving: 1_000, seq: 5_000, notice: { stateDegraded: true } }), schedule, T);
    const h = hints(files);
    expect(h[0]).toBe(1000);
    expect(h[1]).toBe(1000);
    expect(h[4]).toBe(40_000);
  });

  test('[Q-T66] 속도가0이면_화면의임박판정(serving구간+1까지)과같다', () => {
    // serving 500(구간 0): 화면은 mySegment ≤ 구간 0 + 1을 임박으로 본다. 다음 번호의 구간이 그대로 0이어도 구간 1은 임박이다
    const files = buildStateFiles(snap({ serving: 500, seq: 5_000, notice: { stateDegraded: true } }), schedule, T);
    const h = hints(files);
    expect(h[0]).toBe(1000);
    expect(h[1]).toBe(1000);
    expect(h[2]).toBe(40_000);
  });
});

describe('S3 사본(Q-T66)', () => {
  const setup = async (o: { mirrors?: MemoryStateMirrors; failing?: boolean } = {}) => {
    const clock = fakeClock({ now: T + 10 });
    const snapshots = new MemoryStateSnapshots();
    const schedules = new MemoryEventSchedules();
    const eventId = newEvent();
    await schedules.set(eventId, openSchedule(T));
    snapshots.set(eventId, { seq: 1_500, serving: 10 });
    const mirrors = o.mirrors ?? new MemoryStateMirrors();
    mirrors.failing = o.failing ?? false;
    const failures: unknown[] = [];
    const files = new StateFiles(snapshots, schedules, clock, { webOrigin: 'https://w', autoTick: false }, undefined, mirrors, mirrors, { failed: () => failures.push(1) });
    await files.file(eventId, 0);
    return { clock, snapshots, eventId, mirrors, files, failures };
  };

  test('[Q-T66] 사본은_요청경로와같은키에_같은본문과Expires로쓴다', async () => {
    const { eventId, mirrors, files } = await setup();
    await files.tick(T + 10_000);
    await files.mirrorsSettled();
    const f0 = mirrors.written.get(`queue/fallback/v1/queues/${eventId}/segment-states/0.json`);
    expect(f0).toBeDefined();
    expect(JSON.parse(f0!.body)).toMatchObject({ generatedAtMs: T + 10_000 });
    expect(f0!.contentType).toBe('application/json; charset=utf-8');
    expect(f0!.cacheControl).toBe('public');
    expect(f0!.expiresAtMs).toBe(T + 11_000);
    // 임박이 아닌 구간은 같은 Cache-Control이고 Expires가 없다(구간 50은 (초 + 50) % 10 = 0인 경계에 쓴다)
    const far = mirrors.written.get(`queue/fallback/v1/queues/${eventId}/segment-states/50.json`);
    expect(far!.cacheControl).toBe('public, max-age=1, stale-while-revalidate=2');
    expect(far!.expiresAtMs).toBeUndefined();
  });

  /** 같은 회차·같은 사본 저장소를 쓰는 다른 파드 */
  const pod = async (eventId: string, mirrors: MemoryStateMirrors) => {
    const clock = fakeClock({ now: T + 10 });
    const snapshots = new MemoryStateSnapshots();
    const schedules = new MemoryEventSchedules();
    await schedules.set(eventId, openSchedule(T));
    snapshots.set(eventId, { seq: 1_500, serving: 10 });
    const files = new StateFiles(snapshots, schedules, clock, { webOrigin: 'https://w', autoTick: false }, undefined, mirrors, mirrors, { failed: () => {} });
    await files.file(eventId, 0);
    return { clock, files };
  };

  test('[Q-T66] 파드둘이같은경계를만들면_잡은파드만쓴다', async () => {
    const mirrors = new MemoryStateMirrors();
    const a = await setup({ mirrors });
    const { files: b } = await pod(a.eventId, mirrors);
    await a.files.tick(T + 1000);
    await b.tick(T + 1000);
    await a.files.mirrorsSettled();
    await b.mirrorsSettled();
    expect(mirrors.puts.filter((p) => p.endsWith('/segment-states/0.json'))).toHaveLength(1);
  });

  test('[Q-T66] 입장임박구간은매초_그밖구간은거리별주기로쓴다(1~5분5초·그밖10초)', async () => {
    const { clock, eventId, mirrors, files } = await setup();
    const near = `queue/fallback/v1/queues/${eventId}/segment-states/0.json`;
    // 구간 1은 serving 구간 + 1이라 속도 0이면 임박(매초)이다. 구간 2가 먼 구간이다
    const far = `queue/fallback/v1/queues/${eventId}/segment-states/2.json`;
    const count = (k: string) => mirrors.puts.filter((p) => p === k).length;
    for (let t = T + 1000, i = 0; i < 12; i++, t += 1000) {
      clock.advance(1000);
      await files.tick(t);
      await files.mirrorsSettled();
    }
    expect(count(near)).toBe(12);
    // 구간 2는 먼 구간(10초 주기): (초 + 2) % 10 = 0인 경계 T+8초 한 번
    expect(count(far)).toBe(1);
  });

  test('[Q-T66] 쓰는파드가경계마다바뀌어도_구간별주기가지켜진다', async () => {
    const mirrors = new MemoryStateMirrors();
    const a = await setup({ mirrors });
    const b = await pod(a.eventId, mirrors);
    const far = `queue/fallback/v1/queues/${a.eventId}/segment-states/2.json`;
    const count = (k: string) => mirrors.puts.filter((p) => p === k).length;
    // 경계마다 번갈아 파드 하나가 먼저 잡는다
    for (let t = T + 1000, i = 0; i < 20; i++, t += 1000) {
      a.clock.advance(1000);
      b.clock.advance(1000);
      const [first, second] = i % 2 === 0 ? [a.files, b.files] : [b.files, a.files];
      await first.tick(t);
      await first.mirrorsSettled();
      await second.tick(t);
      await second.mirrorsSettled();
    }
    // T+8초·T+18초 두 번뿐이다(쓰는 파드가 바뀌어도 주기가 2초로 줄지 않는다)
    expect(count(far)).toBe(2);
    expect(count(`queue/fallback/v1/queues/${a.eventId}/segment-states/0.json`)).toBe(20);
  });

  test('[ASVS v5.0.0-16.5.2] [Q-T66] 사본쓰기가실패해도_파일생성은계속되고_실패를센다', async () => {
    const { eventId, mirrors, files, failures } = await setup({ failing: true });
    await files.tick(T + 1000);
    await files.mirrorsSettled();
    expect(failures.length).toBeGreaterThan(0);
    const f = await files.file(eventId, 0);
    expect(JSON.parse(f!.body)).toMatchObject({ generatedAtMs: T + 1000 });
    expect(mirrors.written.size).toBe(0);
  });

  test('[Q-T66] 포트가없으면_사본을쓰지않고_생성은그대로다', async () => {
    const clock = fakeClock({ now: T + 10 });
    const snapshots = new MemoryStateSnapshots();
    const schedules = new MemoryEventSchedules();
    const eventId = newEvent();
    await schedules.set(eventId, openSchedule(T));
    snapshots.set(eventId, { seq: 1, serving: 0 });
    const files = new StateFiles(snapshots, schedules, clock, { webOrigin: 'https://w', autoTick: false });
    await files.file(eventId, 0);
    await files.tick(T + 1000);
    await files.mirrorsSettled();
    expect(JSON.parse((await files.file(eventId, 0))!.body)).toMatchObject({ generatedAtMs: T + 1000 });
  });
});
