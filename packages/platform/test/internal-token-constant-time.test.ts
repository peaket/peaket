// SEC-06R(W7-audit, R-628 회귀 시험 공백) → W9-fix3 F2(W7-audit S4, 시험 담당 w9f3-test 2026-11-17): 공용 비교 하나가 받은 값과 기대 값을 각각
// SHA-256(utf8)으로 줄인 32바이트를 node:crypto의 timingSafeEqual로 정확히 한 번 견준다. 길이가 달라도 일찍 끝내지 않는다.
// HTTP InternalTokenGuard와 내부 gRPC(토큰·처리자 증명) 둘 다 이것을 쓴다(docs/architecture.md §3.2 'REST' 행, asvs/settlement.md v5.0.0-11.2.4).
// 옛 ⑤의 '길이가 다르면 timingSafeEqual 0번' 단언은 정본이 바뀌어 뒤집었다(시험 이의가 아니다, 계획 docs/review/plans/W9-fix3.md §4).
// timingSafeEqual 엿보기가 다른 시험 파일에 번지지 않게 이 파일에만 node:crypto 감싸기를 둔다.
import * as grpc from '@grpc/grpc-js';
import type { ExecutionContext } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { InternalTokenGuard } from '../src/auth.js';
import {
  INTERNAL_GRPC_ACTOR_HEADER,
  INTERNAL_GRPC_ACTOR_PROOF_HEADER,
  INTERNAL_GRPC_CALLER_HEADER,
  INTERNAL_GRPC_TOKEN_HEADER,
  internalGrpcActorProof,
  verifyInternalGrpcActor,
} from '../src/internal-grpc.js';
import { constantTimeEqual } from '../src/secret-compare.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
const spy = vi.mocked(timingSafeEqual);

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

const contextWith = (headers: Record<string, string | string[] | undefined>): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as unknown as ExecutionContext;

const EXPECTED = 'shared-secret-for-constant-time';
/** [이름, 받은 값]. 같은 값만 true다 */
const GIVEN: ReadonlyArray<readonly [string, string]> = [
  ['같은 값', EXPECTED],
  ['같은 길이 틀린 값', `${EXPECTED.slice(0, -1)}X`],
  ['짧은 값', 'short'],
  ['긴 값', `${EXPECTED}-longer`],
  ['빈 값', ''],
];
/** 글자 수는 같고 utf8 바이트 수가 다른 한글 값(기대 값도 한글로 둔다) */
const KOREAN_EXPECTED = '피켓내부토큰값';
const KOREAN_SAME_CHARS = 'abcdefg';

/** 엿본 부름이 정확히 한 번이고 두 인자가 SHA-256(받은 값)·SHA-256(기대 값) 32바이트인지 본다 */
function expectOneHashedCompare(given: string, expected: string, what: string): void {
  expect(spy, what).toHaveBeenCalledTimes(1);
  const [a, b] = spy.mock.calls[0]!;
  expect(Buffer.isBuffer(a) && Buffer.isBuffer(b), what).toBe(true);
  expect([(a as Buffer).length, (b as Buffer).length], what).toEqual([32, 32]);
  expect([(a as Buffer).toString('hex'), (b as Buffer).toString('hex')], what).toEqual([sha256(given).toString('hex'), sha256(expected).toString('hex')]);
}

describe('W9F3 F2 공용 내부 토큰 상수 시간 비교', () => {
  test('W9F3 F2 SEC-06R ⑤ 공용 비교는 길이와 상관없이 해시 둘을 한 번 견준다 [ASVS v5.0.0-11.2.4]', () => {
    expect(KOREAN_SAME_CHARS.length).toBe(KOREAN_EXPECTED.length);
    expect(Buffer.byteLength(KOREAN_SAME_CHARS, 'utf8')).not.toBe(Buffer.byteLength(KOREAN_EXPECTED, 'utf8'));
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ...GIVEN.map(([what, given]) => [what, given, EXPECTED] as const),
      ['글자 수는 같고 바이트 수가 다른 한글 값', KOREAN_SAME_CHARS, KOREAN_EXPECTED],
      ['같은 한글 값', KOREAN_EXPECTED, KOREAN_EXPECTED],
    ];
    for (const [what, given, expected] of cases) {
      // 공용 비교를 바로 부른다
      spy.mockClear();
      expect(constantTimeEqual(given, expected), `${what}: 결과`).toBe(given === expected);
      expectOneHashedCompare(given, expected, `${what}: constantTimeEqual`);
      // HTTP 가드도 같은 비교를 쓴다(core InternalToken401Guard는 이 가드를 잇는다)
      spy.mockClear();
      const guard = new InternalTokenGuard(expected, true);
      expect(guard.canActivate(contextWith({ 'x-peaket-internal-token': given })), `${what}: 가드 결과`).toBe(given === expected);
      expectOneHashedCompare(given, expected, `${what}: InternalTokenGuard`);
    }
    // 기대 값이 빈 문자열이면 늘 false다(가드는 그 앞에서 막는다)
    expect(constantTimeEqual('', '')).toBe(false);
    expect(constantTimeEqual('anything', '')).toBe(false);
  });

  test('W9F3 F2 내부 gRPC 토큰·처리자 증명도 공용 비교를 쓴다 [ASVS v5.0.0-11.2.4]', () => {
    const TOKEN = 'internal-grpc-shared-token-0123456789';
    const ACTOR = '0194d000-0000-7000-8000-0000000000aa';
    const metadataWith = (o: { token?: string; caller?: string; actor?: string; proof?: string }): grpc.Metadata => {
      const m = new grpc.Metadata();
      if (o.token !== undefined) m.set(INTERNAL_GRPC_TOKEN_HEADER, o.token);
      if (o.caller !== undefined) m.set(INTERNAL_GRPC_CALLER_HEADER, o.caller);
      if (o.actor !== undefined) m.set(INTERNAL_GRPC_ACTOR_HEADER, o.actor);
      if (o.proof !== undefined) m.set(INTERNAL_GRPC_ACTOR_PROOF_HEADER, o.proof);
      return m;
    };
    const proof = internalGrpcActorProof(TOKEN, ACTOR);

    // 길이가 다른 토큰: 'token'으로 거절하고, 비교는 해시 32바이트 둘로 한 번
    spy.mockClear();
    const shortToken = 'short';
    expect(verifyInternalGrpcActor(metadataWith({ token: shortToken, caller: 'ops-svc', actor: ACTOR, proof }), TOKEN, { caller: 'ops-svc', actor: ACTOR })).toEqual({ ok: false, reason: 'token' });
    expectOneHashedCompare(shortToken, TOKEN, '길이 다른 gRPC 토큰');

    // 토큰은 맞고 길이가 다른 처리자 증명: 'actor'로 거절하고, 두 번째 비교도 해시 32바이트 둘
    spy.mockClear();
    const shortProof = 'x';
    expect(verifyInternalGrpcActor(metadataWith({ token: TOKEN, caller: 'ops-svc', actor: ACTOR, proof: shortProof }), TOKEN, { caller: 'ops-svc', actor: ACTOR })).toEqual({ ok: false, reason: 'actor' });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [a, b] of spy.mock.calls) expect([(a as Buffer).length, (b as Buffer).length]).toEqual([32, 32]);
    const [pa, pb] = spy.mock.calls[1]!;
    expect([(pa as Buffer).toString('hex'), (pb as Buffer).toString('hex')]).toEqual([sha256(shortProof).toString('hex'), sha256(proof).toString('hex')]);

    // 대조: 모두 맞으면 통과
    spy.mockClear();
    expect(verifyInternalGrpcActor(metadataWith({ token: TOKEN, caller: 'ops-svc', actor: ACTOR, proof }), TOKEN, { caller: 'ops-svc', actor: ACTOR })).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
