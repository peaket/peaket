// GAT-360 중복 입장 급증 경보 시험(시험 먼저). 10분 10건 [가정] 경계와 입장 창 밖 해제를 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { DUPLICATE_SURGE_WINDOW_MS, DuplicateSurge, duplicateSurgeKind } from '../src/modules/scanner/application/duplicate-surge.js';

const NOW = Date.parse('2026-10-25T08:12:30Z');
const EVENT = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';

function world(count: number, entry = { opens: NOW - 3_600_000, closes: NOW + 3_600_000 }) {
  const opened: unknown[] = [];
  const resolved: unknown[] = [];
  const gate = { countDuplicateFlags: async () => count };
  const shifts = { eventsWithPlacements: async () => [EVENT] };
  const policy = { get: async () => ({ promoterId: 'p', reentryAllowed: false, entryOpensAtMs: entry.opens, entryClosesAtMs: entry.closes }) };
  const sink = { open: async (a: unknown) => void opened.push(a), resolve: async (r: unknown) => void resolved.push(r) };
  const surge = new DuplicateSurge({ gate, shifts, policy, sink, clock: fakeClock({ now: NOW }) });
  return { surge, opened, resolved };
}

describe('중복 입장 급증 경보', () => {
  test('GAT-360 9건은 열지 않고 10건에서 한 번 열며 10분 창 값과 기준을 싣는다', async () => {
    const nine = world(9);
    expect(await nine.surge.run()).toMatchObject({ opened: 0, resolved: 0 });
    expect(nine.opened).toEqual([]);

    const ten = world(10);
    expect(await ten.surge.run()).toMatchObject({ opened: 1, resolved: 0 });
    expect(ten.opened).toEqual([
      {
        eventKey: EVENT,
        kind: duplicateSurgeKind(EVENT),
        severity: 'SEV3',
        source: 'ticket-svc',
        reason: '중복 입장 이상 표시가 10분에 10건입니다',
        detail: { kind: 'DUPLICATE_SURGE', count: 10, windowMs: DUPLICATE_SURGE_WINDOW_MS, threshold: 10, eventId: EVENT },
        atMs: NOW,
      },
    ]);
    // 같은 상태에서 다시 돌아도 한 번만 연다
    await ten.surge.run();
    expect(ten.opened).toHaveLength(1);
  });

  test('GAT-360 기준 아래로 내려가거나 입장 창이 닫히면 경보를 푼다', async () => {
    let count = 12;
    const opened: unknown[] = [];
    const resolved: unknown[] = [];
    const gate = { countDuplicateFlags: async () => count };
    const shifts = { eventsWithPlacements: async () => [EVENT] };
    let closes = NOW + 3_600_000;
    const policy = { get: async () => ({ promoterId: 'p', reentryAllowed: false, entryOpensAtMs: NOW - 3_600_000, entryClosesAtMs: closes }) };
    const sink = { open: async (a: unknown) => void opened.push(a), resolve: async (r: unknown) => void resolved.push(r) };
    const surge = new DuplicateSurge({ gate, shifts, policy, sink, clock: fakeClock({ now: NOW }) });
    await surge.run();
    expect(opened).toHaveLength(1);
    count = 9;
    await surge.run();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ eventKey: EVENT, kind: duplicateSurgeKind(EVENT) });

    // 다시 10건이 되면 다시 열고, 입장 창이 지나면 푼다
    count = 11;
    await surge.run();
    expect(opened).toHaveLength(2);
    closes = NOW - 1;
    await surge.run();
    expect(resolved).toHaveLength(2);
  });
});
