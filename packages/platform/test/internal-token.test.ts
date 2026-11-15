// 서비스 사이 내부 HTTP 공유 토큰 검사(C2-03·OPS-05). 운영은 토큰이 없으면 시작을 막고, 비교는 길이가 같을 때 상수 시간이다.
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, test } from 'vitest';
import { InternalTokenGuard } from '../src/auth.js';

const contextWith = (headers: Record<string, string | string[] | undefined>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

describe('InternalTokenGuard [C2-03·OPS-05]', () => {
  test('맞는 토큰만 통과하고 없거나 틀리면 막는다', () => {
    const guard = new InternalTokenGuard('shared-secret', true);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': 'shared-secret' }))).toBe(true);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': 'wrong-secret' }))).toBe(false);
    expect(guard.canActivate(contextWith({}))).toBe(false);
  });

  test('길이가 다른 토큰도 막고, 같은 이름의 머리가 여럿이면 첫 값만 본다', () => {
    const guard = new InternalTokenGuard('shared-secret', true);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': 'short' }))).toBe(false);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': ['shared-secret', 'other'] }))).toBe(true);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': ['other', 'shared-secret'] }))).toBe(false);
  });

  test('운영에서 토큰이 없으면 시작을 막는다(닫힘 실패)', () => {
    const guard = new InternalTokenGuard(undefined, true);
    expect(() => guard.onModuleInit()).toThrow('PEAKET_INTERNAL_TOKEN');
  });

  test('local·ci에서는 토큰이 없어도 통과한다(시험·로컬 편의)', () => {
    const guard = new InternalTokenGuard(undefined, false);
    expect(() => guard.onModuleInit()).not.toThrow();
    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  test('토큰이 있으면 환경과 관계없이 틀린 요청을 막는다', () => {
    const guard = new InternalTokenGuard('shared-secret', false);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': 'wrong' }))).toBe(false);
    expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': 'shared-secret' }))).toBe(true);
  });
});
