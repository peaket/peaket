// 새 결제 일시 정지 판단(docs/features/seat-hold.md §5 '되돌리는 조건', BUILD_ORDER HOT-070·PRF-201, ADR-0085).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { HoldPauseView, type PaymentPauseAnswer } from '../src/modules/inventory/index.js';

const OPEN: PaymentPauseAnswer = { status: 'OK', pauses: [] };
const paused = (sinceMs: number): PaymentPauseAnswer => ({ status: 'OK', pauses: [{ eventId: 'e1', pausedSinceMs: sinceMs }] });
const FAILED: PaymentPauseAnswer = { status: 'FAILED' };

function view(answers: PaymentPauseAnswer[]) {
  const clock = fakeClock({ now: 10_000 });
  let i = 0;
  const outcomes: string[] = [];
  const v = new HoldPauseView({ read: async () => answers[Math.min(i++, answers.length - 1)]! }, clock, (o) => outcomes.push(o));
  return { v, clock, outcomes };
}
const state = async (v: HoldPauseView) => (await v.refresh(['e1'])).get('e1');

describe('HoldPauseView', () => {
  test('S-T23 정지면 정지 시작을 돌려주고, 0이면 처음 본 시각을 쓴다', async () => {
    const a = view([paused(5_000)]);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    const b = view([paused(0), paused(0)]);
    expect(await state(b.v)).toEqual({ kind: 'PAUSED', sinceMs: 10_000 });
    b.clock.advance(1_000);
    expect(await state(b.v)).toEqual({ kind: 'PAUSED', sinceMs: 10_000 });
  });
  test('S-T23 PRF-201 열림 답은 연속 두 번이어야 OPEN이고, 한 번은 앞 판단을 유지한다', async () => {
    const a = view([paused(5_000), OPEN, OPEN]);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(1_000);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('S-T23 열림 다음 정지가 오면 연속이 끊긴다', async () => {
    const a = view([paused(5_000), OPEN, paused(6_000), OPEN, OPEN]);
    await state(a.v);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 6_000 });
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 6_000 });
    a.clock.advance(1_000);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('처음부터 열린 회차는 한 번은 UNSETTLED다(되돌릴 것도 옮길 것도 없다)', async () => {
    const a = view([OPEN, OPEN]);
    expect(await state(a.v)).toEqual({ kind: 'UNSETTLED' });
    a.clock.advance(1_000);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('S-T23 ④ 답이 끊기면 10초까지 마지막 답을 쓰고 그 뒤에는 OPEN이다', async () => {
    const a = view([paused(5_000), FAILED, FAILED, FAILED]);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(10_001);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
    expect(a.outcomes).toEqual(['ok', 'failed', 'stale']);
  });
  test('S-T23 ④ 첫 실패부터 정확히 10초까지는 마지막 답을 쓰고 10초를 넘어야 OPEN이다(경계)', async () => {
    const a = view([paused(5_000), FAILED, FAILED, FAILED]);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(10_000);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(1);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('S-T23 ④ L7 답을 받으면 실패 시작을 지운다: 그 뒤의 첫 실패부터 다시 10초를 잰다', async () => {
    const a = view([paused(5_000), FAILED, paused(5_000), FAILED, FAILED]);
    await state(a.v);
    await state(a.v);
    a.clock.advance(9_000);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(9_000);
    // 앞 실패가 끝났으므로 이 실패는 첫 실패다(앞 실패에서 18초가 지났어도 OPEN이 아니다)
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(10_001);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('S-T23 L6 열림 뒤 정지가 오면 첫 열림 시각도 지운다: 다시 열릴 때 그 시각부터 1초를 잰다', async () => {
    const a = view([OPEN, paused(6_000), OPEN, OPEN, OPEN]);
    await state(a.v);
    a.clock.advance(2_000);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 6_000 });
    a.clock.advance(100);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 6_000 });
    a.clock.advance(1_000);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('S-T23 ④ 파드가 막 떴고 답이 없으면 뜬 시각부터 10초 뒤 OPEN이다', async () => {
    const a = view([FAILED]);
    expect(await state(a.v)).toEqual({ kind: 'UNSETTLED' });
    a.clock.advance(10_001);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('조회가 던져도 던지지 않고 답 없음으로 친다', async () => {
    const clock = fakeClock({ now: 1 });
    const v = new HoldPauseView({ read: async () => { throw new Error('x'); } }, clock);
    await expect(v.refresh(['e1'])).resolves.toBeInstanceOf(Map);
  });
  test('L6 연속 두 번 열림이어도 첫 열림부터 1초가 지나야 OPEN이다', async () => {
    const a = view([paused(5_000), OPEN, OPEN, OPEN]);
    await state(a.v);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(1_000);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('L6 조회 실패가 끼면 연속 열림을 처음부터 다시 센다', async () => {
    const a = view([paused(5_000), OPEN, FAILED, OPEN, OPEN]);
    await state(a.v);
    await state(a.v);
    a.clock.advance(2_000);
    await state(a.v);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(2_000);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
  test('L7 답 없음 10초는 연속 실패가 시작된 때부터 잰다', async () => {
    const a = view([paused(5_000), FAILED, FAILED]);
    await state(a.v);
    a.clock.advance(60_000);
    expect(await state(a.v)).toEqual({ kind: 'PAUSED', sinceMs: 5_000 });
    a.clock.advance(10_001);
    expect(await state(a.v)).toEqual({ kind: 'OPEN' });
  });
});
