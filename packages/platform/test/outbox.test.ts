// Outbox ID·일 파티션 경계·정비 시간(openspec 변경 add-idempotency-and-outbox 결정 7·8, docs/data.md §2 파티션 표 규칙, ADR-0083·0116).
import { describe, expect, test } from 'vitest';
import {
  CONTROL_TOPICS,
  OUTBOX_PARTITION_DEFAULTS,
  fakeClock,
  inMaintenanceWindow,
  kstDayStart,
  outboxPartitionOf,
  uuidLowerBound,
  uuidv7,
  uuidv7Time,
} from '../src/index.js';

const KST = (s: string) => Date.parse(`${s}+09:00`);

describe('UUIDv7(결정 7)', () => {
  test('FND080_UUIDv7은_주입한시계의밀리초를앞48비트에두고_판7과변형10이다', () => {
    const clock = fakeClock({ now: Date.parse('2026-11-01T00:00:00.123Z') });
    const a = uuidv7(clock);
    const b = uuidv7(clock);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(uuidv7Time(a)).toBe(clock.now());
    expect(a.slice(0, 13).replace('-', '')).toBe(clock.now().toString(16).padStart(12, '0'));
  });

  test('FND080_경계UUID는_밀리초를앞48비트에두고나머지를0으로채운다', () => {
    const ms = KST('2026-11-01T00:00:00');
    const hex = ms.toString(16).padStart(12, '0');
    expect(uuidLowerBound(ms)).toBe(`${hex.slice(0, 8)}-${hex.slice(8)}-0000-0000-000000000000`);
    // 같은 날 만든 ID는 그날 경계 이상, 다음 날 경계 미만이다(PostgreSQL uuid는 바이트 순서로 비교한다)
    const clock = fakeClock({ now: KST('2026-11-01T23:59:59.999') });
    const id = uuidv7(clock);
    expect(id >= uuidLowerBound(ms)).toBe(true);
    expect(id < uuidLowerBound(KST('2026-11-02T00:00:00'))).toBe(true);
  });
});

describe('일 파티션(결정 8)', () => {
  test('FND080_하루는_한국시각0시에바뀐다', () => {
    expect(kstDayStart(Date.parse('2026-11-01T14:59:59.999Z'))).toBe(KST('2026-11-01T00:00:00'));
    expect(kstDayStart(Date.parse('2026-11-01T15:00:00.000Z'))).toBe(KST('2026-11-02T00:00:00'));
  });

  test('FND080_파티션이름은한국시각날짜이고_범위는그날0시부터다음날0시까지다', () => {
    const p = outboxPartitionOf(KST('2026-11-01T00:00:00'));
    expect(p).toEqual({ name: 'outbox_p20261101', from: uuidLowerBound(KST('2026-11-01T00:00:00')), to: uuidLowerBound(KST('2026-11-02T00:00:00')) });
    expect(() => outboxPartitionOf(KST('2026-11-01T00:00:01'))).toThrow();
  });

  test('FND080_정비시간은_한국시각04시부터06시전까지다', () => {
    expect(inMaintenanceWindow(KST('2026-11-01T03:59:59.999'))).toBe(false);
    expect(inMaintenanceWindow(KST('2026-11-01T04:00:00'))).toBe(true);
    expect(inMaintenanceWindow(KST('2026-11-01T05:59:59.999'))).toBe(true);
    expect(inMaintenanceWindow(KST('2026-11-01T06:00:00'))).toBe(false);
  });

  test('FND080_미리만들기7일_보관3일_경보기준3일을확정한다', () => {
    expect(OUTBOX_PARTITION_DEFAULTS).toEqual({ daysAhead: 7, keepDays: 3, minAheadDays: 3 });
  });
});

test('FND080_제어사건주제이름(ADR-0143결정3)', () => {
  expect(CONTROL_TOPICS).toEqual({ settings: 'control.settings', sessionsTerminated: 'control.sessions-terminated' });
});
