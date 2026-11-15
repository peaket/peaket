// SEC-06R(W7-audit, R-628 회귀 시험 공백): 공용 InternalTokenGuard는 길이가 같은 토큰을 node:crypto의 timingSafeEqual로 비교하고,
// 길이가 다르면 비교 없이 거절한다(docs/architecture.md §3.2 'REST' 행, asvs/settlement.md v5.0.0-11.2.4).
// timingSafeEqual 엿보기가 다른 시험 파일에 번지지 않게 이 파일에만 node:crypto 감싸기를 둔다.
import type { ExecutionContext } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { InternalTokenGuard } from '../src/auth.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const spy = vi.mocked(timingSafeEqual);

const contextWith = (headers: Record<string, string | string[] | undefined>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

describe('SEC-06R 공용 내부 토큰 상수 시간 비교', () => {
  test('SEC-06R ⑤ InternalTokenGuard는 길이가 같은 토큰을 timingSafeEqual로 비교한다', () => {
    const expected = 'shared-secret-for-constant-time';
    const guard = new InternalTokenGuard(expected, true);

    spy.mockClear();
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': expected }))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0]!;
    expect(Buffer.isBuffer(a) && Buffer.isBuffer(b)).toBe(true);
    expect([(a as Buffer).toString('utf8'), (b as Buffer).toString('utf8')]).toEqual([expected, expected]);

    spy.mockClear();
    const sameLengthWrong = `${expected.slice(0, -1)}X`;
    expect(sameLengthWrong).toHaveLength(expected.length);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': sameLengthWrong }))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockClear();
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': 'short' }))).toBe(false);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': `${expected}-longer` }))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(0);
  });
});
