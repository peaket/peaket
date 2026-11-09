// 주문 생성의 본인확인 재확인 판정(domain/recheck.ts judgeRecheck, docs/features/payment.md §2 '주문 생성의 첫 구현' 본인확인 재확인, ADR-0055, BUILD_ORDER PRF-161).
// 정본 표의 모든 칸: VERIFIED(pid 일치·previous_pid 일치·불일치·토큰 pid 없음), DENIED, 실패 까닭 일곱 × 토큰(ticket:buy·pid 있음/없음).
// 재확인 응답이 없을 때의 토큰 판정은 P-T35, 그 안전한 실패는 [ASVS v5.0.0-16.5.2]·[ASVS v5.0.0-16.5.3]이다.
import { describe, expect, test } from 'vitest';
import {
  FALLBACK_REASONS,
  type FallbackReason,
  judgeRecheck,
  type RecheckAnswer,
  type RecheckFailure,
  type RecheckToken,
  TICKET_BUY_SCOPE,
} from '../src/modules/booking/index.js';

const PID = 'pid-0001';
const PREV = 'pid-0000';
const BUY: RecheckToken = { pid: PID, scopes: ['ticket:buy'] };

describe('상수', () => {
  test('PT35_대체 판정 까닭은 다섯이고 지표 이름표 차례는 circuit_open·deadline·unavailable·exhausted·internal이다. 대체 판정에 필요한 스코프는 ticket:buy다', () => {
    expect(FALLBACK_REASONS).toEqual(['circuit_open', 'deadline', 'unavailable', 'exhausted', 'internal']);
    expect(TICKET_BUY_SCOPE).toBe('ticket:buy');
  });
});

describe('VERIFIED: 토큰 pid가 pid·previous_pid 가운데 하나와 같아야 통과', () => {
  test('PT35_pid가 토큰 pid와 같으면 PASS', () => {
    expect(judgeRecheck({ status: 'VERIFIED', pid: PID }, BUY)).toEqual({ kind: 'PASS' });
    expect(judgeRecheck({ status: 'VERIFIED', pid: PID, previousPid: PREV }, BUY)).toEqual({ kind: 'PASS' });
  });

  test('PT35_previous_pid가 토큰 pid와 같으면 PASS(pid가 바뀐 직후의 토큰)', () => {
    expect(judgeRecheck({ status: 'VERIFIED', pid: 'pid-0002', previousPid: PID }, BUY)).toEqual({ kind: 'PASS' });
  });

  test('PT35_pid·previous_pid 둘 다와 다르면 DENY이고 대체 판정 까닭이 없다', () => {
    expect(judgeRecheck({ status: 'VERIFIED', pid: 'pid-0002', previousPid: 'pid-0003' }, BUY)).toEqual({ kind: 'DENY' });
    expect(judgeRecheck({ status: 'VERIFIED', pid: 'pid-0002' }, BUY)).toEqual({ kind: 'DENY' });
  });

  test('PT35_토큰에 pid가 없으면 DENY다: previous_pid가 없는 응답(undefined)과 없는 토큰 pid(undefined)를 같다고 보지 않는다 [ASVS v5.0.0-16.5.3]', () => {
    expect(judgeRecheck({ status: 'VERIFIED', pid: PID }, { scopes: ['ticket:buy'] })).toEqual({ kind: 'DENY' });
    expect(judgeRecheck({ status: 'VERIFIED', pid: PID, previousPid: PREV }, { scopes: ['ticket:buy'] })).toEqual({ kind: 'DENY' });
  });

  test('PT35_pid 비교는 글 그대로다: 대소문자만 달라도 DENY', () => {
    expect(judgeRecheck({ status: 'VERIFIED', pid: 'PID-0001' }, BUY)).toEqual({ kind: 'DENY' });
    expect(judgeRecheck({ status: 'VERIFIED', pid: 'x', previousPid: 'PID-0001' }, BUY)).toEqual({ kind: 'DENY' });
  });

  test('PT35_재확인이 답했으면 스코프는 보지 않는다: pid가 같으면 토큰에 ticket:buy가 없어도 PASS(스코프는 앞의 가드가 본다)', () => {
    expect(judgeRecheck({ status: 'VERIFIED', pid: PID }, { pid: PID, scopes: [] })).toEqual({ kind: 'PASS' });
  });
});

describe('DENIED: 그대로 거부(대체 판정 없음)', () => {
  test('PT35_verified 거짓이면 토큰에 ticket:buy·pid가 모두 있어도 DENY이고 대체 판정 까닭이 없다 [ASVS v5.0.0-16.5.3]', () => {
    expect(judgeRecheck({ status: 'DENIED' }, BUY)).toEqual({ kind: 'DENY' });
    expect(judgeRecheck({ status: 'DENIED' }, { scopes: [] })).toEqual({ kind: 'DENY' });
  });
});

/** 토큰 넷: ticket:buy·pid 둘 다 / ticket:buy만 / pid만 / 둘 다 없음 */
const TOKENS: [string, RecheckToken, boolean][] = [
  ['ticket:buy와 pid', { pid: PID, scopes: ['ticket:buy'] }, true],
  ['ticket:buy만(pid 없음)', { scopes: ['ticket:buy'] }, false],
  ['pid만(ticket:buy 없음)', { pid: PID, scopes: ['ticket:read'] }, false],
  ['둘 다 없음', { scopes: [] }, false],
];

/** 대체 판정 없이 503(설정 오류)인 까닭. unexpected는 정본 목록 밖의 gRPC 코드·gRPC가 아닌 예외다(리뷰 고침 M2 2026-11-05) */
const MISCONFIG: Exclude<RecheckFailure, FallbackReason>[] = ['permission_denied', 'invalid_argument', 'unexpected'];

describe('FAILED: 실패 까닭 일곱 × 토큰 넷', () => {
  const cases = FALLBACK_REASONS.flatMap((reason) => TOKENS.map(([name, token, pass]) => [reason, name, token, pass] as [FallbackReason, string, RecheckToken, boolean]));

  test.each(cases)('PT35_답이 없는 까닭 %s, 토큰 %s → 둘 다 있으면 PASS_FALLBACK, 아니면 DENY(같은 까닭) [ASVS v5.0.0-16.5.2]', (reason, _name, token, pass) => {
    const answer: RecheckAnswer = { status: 'FAILED', reason };
    expect(judgeRecheck(answer, token)).toEqual(pass ? { kind: 'PASS_FALLBACK', reason } : { kind: 'DENY', fallbackReason: reason });
  });

  const misconfigCases = MISCONFIG.flatMap((reason) => TOKENS.map(([name, token]) => [reason, name, token] as [RecheckFailure, string, RecheckToken]));

  test.each(misconfigCases)('PT35_설정 오류 %s는 토큰 %s여도 대체 판정 없이 MISCONFIGURED(같은 까닭)다 [ASVS v5.0.0-16.5.3]', (reason, _name, token) => {
    expect(judgeRecheck({ status: 'FAILED', reason }, token)).toEqual({ kind: 'MISCONFIGURED', reason });
  });

  test('PT35_토큰 pid가 빈 글이면 pid가 없는 것으로 본다: ticket:buy가 있어도 DENY(같은 까닭) [ASVS v5.0.0-16.5.3]', () => {
    for (const reason of FALLBACK_REASONS) {
      expect(judgeRecheck({ status: 'FAILED', reason }, { pid: '', scopes: ['ticket:buy'] })).toEqual({ kind: 'DENY', fallbackReason: reason });
    }
  });

  test('PT35_스코프는 글 그대로 같은 것만 본다: ticket:buyer·TICKET:BUY·ticket:buy:x는 ticket:buy가 아니다 [ASVS v5.0.0-16.5.3]', () => {
    for (const scopes of [['ticket:buyer'], ['TICKET:BUY'], ['ticket:buy:x'], ['ticket', 'buy']]) {
      expect({ scopes, v: judgeRecheck({ status: 'FAILED', reason: 'deadline' }, { pid: PID, scopes }) }).toEqual({ scopes, v: { kind: 'DENY', fallbackReason: 'deadline' } });
    }
  });

  test('PT35_다른 스코프와 함께 있어도 ticket:buy가 있으면 된다(차례 무관)', () => {
    expect(judgeRecheck({ status: 'FAILED', reason: 'internal' }, { pid: PID, scopes: ['profile:read', 'ticket:buy', 'ticket:read'] })).toEqual({ kind: 'PASS_FALLBACK', reason: 'internal' });
  });
});

describe('던지지 않는다', () => {
  test('모든 칸에서 값을 돌려주고 던지지 않는다', () => {
    const answers: RecheckAnswer[] = [
      { status: 'VERIFIED', pid: PID },
      { status: 'VERIFIED', pid: PID, previousPid: PREV },
      { status: 'DENIED' },
      ...[...FALLBACK_REASONS, ...MISCONFIG].map((reason): RecheckAnswer => ({ status: 'FAILED', reason })),
    ];
    for (const a of answers) for (const [, t] of TOKENS) expect(() => judgeRecheck(a, t)).not.toThrow();
  });
});
