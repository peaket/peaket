// 남은 시간(deadline) 전파(docs/api/guidelines.md §5, ADR-0009 결정 4, openspec 변경 add-service-template 결정 4).
// 시각은 주입한 시계로 잰다(시간 의존 로직은 Clock 주입).
import { describe, expect, test } from 'vitest';
import { DEADLINE_HEADER, DEFAULT_MAX_DEADLINE_MS, Deadline, ProblemError, fakeClock } from '../src/index.js';

describe('남은 시간', () => {
  test('GL5_받은남은시간에서_흐른시간을빼고_다음호출에는상한과작은쪽을준다', () => {
    const clock = fakeClock();
    const d = Deadline.fromHeader('40', { clock, maxMs: DEFAULT_MAX_DEADLINE_MS });
    clock.advance(10);
    expect(d.remainingMs()).toBe(30);
    expect(d.budgetFor(100)).toBe(30);
    expect(d.budgetFor(20)).toBe(20);
    clock.advance(100);
    expect(d.remainingMs()).toBe(0); // 줄어들기만 하고 음수가 되지 않는다
  });

  test('GL5_헤더이름과_기본상한은_정본값이다', () => {
    expect(DEADLINE_HEADER).toBe('x-peaket-deadline-ms');
    expect(DEFAULT_MAX_DEADLINE_MS).toBe(15_000); // Envoy 경로 시간 초과 기본값(docs/infra.md §4.1)
  });

  test.each([
    ['상한보다 큼', '999999'],
    ['없음', undefined],
    ['빈 값', ''],
    ['숫자 아님', 'abc'],
    ['0', '0'],
    ['음수', '-5'],
    ['소수', '1.5'],
    ['지수 표기', '1e3'],
    ['여러 값', ['40', '50']],
  ])('GL5_%s이면_서비스상한에서시작한다', (_name, value) => {
    const clock = fakeClock();
    expect(Deadline.fromHeader(value as string | string[] | undefined, { clock, maxMs: 500 }).remainingMs()).toBe(500);
  });

  test('GL5_모자라면_시작하지않고_504_deadline-exceeded', () => {
    const clock = fakeClock();
    const d = Deadline.fromHeader('5', { clock, maxMs: 1000 });
    let thrown: unknown;
    try {
      d.ensure(20);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProblemError);
    expect((thrown as ProblemError).status).toBe(504);
    expect((thrown as ProblemError).type).toBe('https://peaket.example/problems/deadline-exceeded');
    expect(() => d.ensure(5)).not.toThrow();
  });

  test('GL5_gRPC에는_벽시계로바꾼_절대시각을준다', () => {
    const clock = fakeClock({ now: Date.parse('2026-11-01T00:00:00.000Z') });
    const d = Deadline.fromHeader('200', { clock, maxMs: 1000 });
    clock.advance(50);
    expect(d.toDate().toISOString()).toBe('2026-11-01T00:00:00.200Z');
  });

  test('GL5_상한은_양의정수여야한다', () => {
    expect(() => Deadline.after(0, fakeClock())).toThrow(/양의 정수/);
    expect(() => Deadline.fromHeader('10', { clock: fakeClock(), maxMs: -1 })).toThrow(/양의 정수/);
  });
});
