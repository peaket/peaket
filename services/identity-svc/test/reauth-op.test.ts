// 재인증 토큰의 받는 쪽 작업(op): identity가 직접 받는 다섯 작업은 자기 op 토큰만 받는다
// (docs/features/identity.md §7.1 ④·§12 I-T85 ③, docs/security/authz-matrix.md §6 '받는 쪽 작업 op의 값', ADR-0293 결정 5).
// 메모리 저장소로 유스케이스를 끝까지 부르고, 거절이면 상태(계정·세션·로그인 수단·병합 제안)와 재인증 사용 기록(reauth_token_use)이 그대로인지 본다.
// 값은 정본 표에서 옮겨 적는다(코드의 FAN_REAUTH_OPS를 가져오지 않는다).
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemoryLinkProposals } from '../src/modules/session/adapters/memory-link-proposals.js';
import { MemoryMergeProposals } from '../src/modules/session/adapters/memory-merge-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { ConfirmMerge } from '../src/modules/session/application/confirm-merge.js';
import { EndDeviceSession } from '../src/modules/session/application/end-device-session.js';
import { IssueReauthToken } from '../src/modules/session/application/issue-reauth-token.js';
import { MergeError } from '../src/modules/session/application/merge-error.js';
import { MergePlanner } from '../src/modules/session/application/plan-merge.js';
import { SessionError } from '../src/modules/session/application/session-error.js';
import { UnlinkProvider } from '../src/modules/session/application/unlink-provider.js';
import { WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import { type AccountEraser, noReverifications } from '../src/modules/session/domain/ports.js';
import type { ReauthOperation } from '../src/modules/session/domain/session.js';
import { fanReauthToken, ISSUER, kit, newKey } from './support.js';

/** identity가 받는 다섯 작업(authz-matrix §6 표의 '받는 서비스 identity-svc'이고 받는 쪽이 있는 줄) */
const IDENTITY_OPS = ['ACCOUNT_WITHDRAW', 'SESSION_END', 'LOGIN_METHOD_REMOVE', 'LOGIN_METHOD_ADD', 'ACCOUNT_MERGE'] as const;
type IdentityOp = (typeof IDENTITY_OPS)[number];
/** 그 작업과 같은 세션·같은 act(FAN_SENSITIVE)인데 op가 다른 토큰들: 다른 identity 작업 넷과 TICKET_CANCEL */
const othersOf = (op: IdentityOp): ReauthOperation[] => [...IDENTITY_OPS.filter((o) => o !== op), 'TICKET_CANCEL'];

async function setup() {
  const sessions = new MemorySessionStore();
  const k0 = await kit(sessions);
  const links = new MemoryLinkProposals(k0.clock);
  const k = await kit(sessions, { clock: k0.clock, links });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, k.clock);
  const proposals = new MemoryMergeProposals(k.clock);
  const planner = new MergePlanner(sessions, { pidsOf: async () => [] }, [], proposals, k.clock, undefined, k.signals);
  const erased: string[] = [];
  const eraser: AccountEraser = {
    erase: async (accountId) => {
      erased.push(accountId);
      return false;
    },
    pidsOf: async () => [],
  };
  const login = (o: { provider?: 'kakao' | 'naver' | 'google'; sub: string; deviceId?: string }) =>
    k.create.run({ idempotencyKey: newKey(), provider: o.provider ?? 'kakao', providerUserId: o.sub, email: null, deviceId: o.deviceId ?? 'dev-a' });
  /**
   * 같은 세션·같은 act(FAN_SENSITIVE, 여기 쓰는 op는 모두 그 묶음)에 op만 고른 토큰. 서명기를 거치지 않고 정본 모양대로 만든다:
   * 받는 쪽이 op를 보는지만 본다(서명기가 op를 싣는지는 I-T85 ②가 본다)
   */
  const token = (s: { accountId: string; sessionId: string }, op: ReauthOperation) => fanReauthToken(k.keys, { ...s, act: 'FAN_SENSITIVE', op, now: k.clock.now() });
  /** op 칸이 없는 옛 꼴의 토큰(같은 팬 토큰 키·세션·act FAN_SENSITIVE) */
  const oplessToken = (s: { accountId: string; sessionId: string }) => fanReauthToken(k.keys, { ...s, act: 'FAN_SENSITIVE', op: undefined, now: k.clock.now() });
  /** 재인증 사용 기록(reauth_token_use) 줄 수. 정비 지우기로 센다(센 줄은 지워진다) */
  const reauthUses = () => sessions.purgeReauthUses(Number.MAX_SAFE_INTEGER);
  return {
    sessions,
    k,
    login,
    token,
    oplessToken,
    reauthUses,
    erased,
    proposals,
    withdraw: new WithdrawAccount(sessions, reauth, eraser, k.clock),
    end: new EndDeviceSession(sessions, reauth, k.clock, k.signals),
    add: new AddProvider(sessions, reauth, k.clock, planner, k.signals),
    unlink: new UnlinkProvider(sessions, reauth, k.clock, k.signals),
    confirm: new ConfirmMerge(sessions, reauth, planner, proposals, k.clock, k.signals),
  };
}
type T = Awaited<ReturnType<typeof setup>>;

/** 유스케이스의 결과: 던진 오류의 code, 돌려준 문자열, 그 밖은 OK */
const outcome = async (p: Promise<unknown>) => {
  try {
    const v = await p;
    return typeof v === 'string' ? v : 'OK';
  } catch (e) {
    if (e instanceof AccountError || e instanceof MergeError) return e.code;
    throw e;
  }
};

/**
 * 작업마다: 준비(상태를 만든다), 부르기(토큰으로 작업을 부른다), 상태 찍기(거절 뒤 그대로인지 견줄 값), 성공 결과.
 * 준비가 쓴 재인증 토큰(병합 제안을 만드는 추가)의 사용 기록은 거절 확인 전에 지운다
 */
interface Case {
  prepare(t: T): Promise<{ me: { accountId: string; sessionId: string }; run(token: string): Promise<unknown>; snapshot(): unknown }>;
  ok: string;
}
const CASES: Record<IdentityOp, Case> = {
  ACCOUNT_WITHDRAW: {
    ok: 'OK',
    prepare: async (t) => {
      const me = await t.login({ sub: 'k-wd' });
      const run = (reauthToken: string) => t.withdraw.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken, body: {} });
      return { me, run, snapshot: () => [t.sessions.accountOf(me.accountId)?.status, t.sessions.activeCount(me.accountId), t.sessions.providerCount(me.accountId), [...t.erased]] };
    },
  },
  SESSION_END: {
    ok: 'OK',
    prepare: async (t) => {
      const other = await t.login({ sub: 'k-se', deviceId: 'dev-phone' });
      const me = await t.login({ sub: 'k-se', deviceId: 'dev-pc' });
      const run = (reauthToken: string) => t.end.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken, targetSessionId: other.sessionId });
      return { me, run, snapshot: () => [t.sessions.peekSession(other.sessionId)?.terminatedAt, t.sessions.activeCount(me.accountId), t.sessions.terminations(me.accountId)] };
    },
  },
  LOGIN_METHOD_REMOVE: {
    ok: 'OK',
    prepare: async (t) => {
      const me = await t.login({ sub: 'k-rm' });
      expect(await t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me, 'LOGIN_METHOD_ADD'), provider: 'google', providerUserId: 'g-rm' })).toBe('LINKED');
      const run = (reauthToken: string) => t.unlink.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken, provider: 'google' });
      return { me, run, snapshot: () => [t.sessions.providerCount(me.accountId), t.sessions.outboxMessages().length] };
    },
  },
  LOGIN_METHOD_ADD: {
    ok: 'LINKED',
    prepare: async (t) => {
      const me = await t.login({ sub: 'k-ad' });
      const run = (reauthToken: string) => t.add.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken, provider: 'google', providerUserId: 'g-ad' });
      return { me, run, snapshot: () => [t.sessions.providerCount(me.accountId), t.sessions.outboxMessages().length] };
    },
  },
  ACCOUNT_MERGE: {
    ok: 'OK',
    prepare: async (t) => {
      const me = await t.login({ sub: 'k-mg', deviceId: 'dev-a' });
      const b = await t.login({ provider: 'google', sub: 'g-mg', deviceId: 'dev-b' });
      const r = await t.add.add({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: await t.token(me, 'LOGIN_METHOD_ADD'), provider: 'google', providerUserId: 'g-mg' });
      expect(r.result).toBe('OTHER_ACCOUNT');
      const id = r.mergeProposalId!;
      const run = (reauthToken: string) => t.confirm.run({ accountId: me.accountId, sessionId: me.sessionId, proposalId: id, reauthToken });
      return {
        me,
        run,
        snapshot: () => [t.sessions.accountOf(b.accountId)?.status, t.sessions.providerCount(me.accountId), t.sessions.providerCount(b.accountId), t.sessions.peekSession(b.sessionId)?.terminatedAt],
      };
    },
  },
};

describe('I-T85 ③ identity가 받는 다섯 작업은 자기 op 토큰만 받는다', () => {
  for (const op of IDENTITY_OPS) {
    test(`I-T85 ③ ${op}: 다른 identity 작업·TICKET_CANCEL의 op, op 없는 토큰은 REAUTH_REQUIRED이고 사용 기록·상태가 그대로이며 자기 op만 성공한다`, async () => {
      const t = await setup();
      const c = CASES[op];
      const { me, run, snapshot } = await c.prepare(t);
      await t.reauthUses(); // 준비가 쓴 기록을 지운다
      const before = JSON.stringify(snapshot());
      for (const other of othersOf(op)) {
        expect(await outcome(run(await t.token(me, other))), `${op} ← ${other}`).toBe('REAUTH_REQUIRED');
      }
      expect(await outcome(run(await t.oplessToken(me))), `${op} ← op 없음`).toBe('REAUTH_REQUIRED');
      expect(await t.reauthUses(), `${op} 거절 뒤 사용 기록`).toBe(0);
      expect(JSON.stringify(snapshot()), `${op} 거절 뒤 상태`).toBe(before);
      // 자기 op 토큰은 지금처럼 성공하고 사용 기록이 하나 생긴다(위 0이 세는 방법의 결함이 아님을 함께 본다)
      expect(await outcome(run(await t.token(me, op))), `${op} ← ${op}`).toBe(c.ok);
      expect(JSON.stringify(snapshot())).not.toBe(before);
      expect(await t.reauthUses()).toBe(1);
    });
  }

  test('I-T85 ③ 거절된 op 토큰을 먼저 보낸 뒤에도 같은 세션의 자기 op 토큰은 한 번만 쓰인다(op 어긋남이 jti를 잡지 않는다)', async () => {
    const t = await setup();
    const { me, run } = await CASES.SESSION_END.prepare(t);
    const wrong = await t.token(me, 'ACCOUNT_WITHDRAW');
    expect(await outcome(run(wrong))).toBe('REAUTH_REQUIRED');
    // 거절한 토큰은 그 토큰의 자기 작업(탈퇴)에는 아직 쓸 수 있다: 잡히지 않았다
    expect(await outcome(t.withdraw.run({ accountId: me.accountId, sessionId: me.sessionId, reauthToken: wrong, body: {} }))).toBe('OK');
  });
});

// 리뷰 반영(BAT-408 리뷰 RV-04·RV-05, 2026-11-19): 발급의 operation 검사는 gRPC 표와 유스케이스 두 곳이다(겹친 가드).
// 유스케이스를 직접 불러 그쪽 검사만 따로 본다(다른 받는 층이 생겨도 이 검사가 남는다, identity §7.1 ③, ADR-0293 결정 4)
describe('I-T85 ② 발급 유스케이스의 operation 검사', () => {
  test('I-T85 ②-4 IssueReauthToken.run에 operation이 없거나·빈 값·모르는 값·proto 이름·객체 원형 이름이면 INVALID_ARGUMENT이고 서명·발급 신호가 0이다 (RV-04·RV-05)', async () => {
    const sessions = new MemorySessionStore();
    const k = await kit(sessions);
    const signed: unknown[] = [];
    // 서명기를 감싸 reauth 부르기를 센다(나머지는 그대로 넘긴다)
    const signer = new Proxy(k.signer, {
      get(target, p) {
        if (p === 'reauth') return (c: unknown, now: number) => (signed.push(c), target.reauth(c as Parameters<typeof target.reauth>[0], now));
        const v = Reflect.get(target, p, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const issue = new IssueReauthToken(sessions, signer, k.signals, noReverifications, k.clock);
    const a = await k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-iss', email: null, deviceId: 'dev-a' });
    const ask = (operation: unknown) =>
      issue.run({ sessionId: a.sessionId, accountId: a.accountId, provider: 'kakao', providerUserId: 'k-iss', strength: 'verified', operation: operation as ReauthOperation });
    const codeOf = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'OK';
      } catch (e) {
        if (e instanceof SessionError) return e.code;
        throw e;
      }
    };
    for (const bad of [undefined, null, '', 'BOGUS', 'session_end', 'session-end', 'REAUTH_OPERATION_SESSION_END', 'BOOKER_EXPORT', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 0, 2, ['SESSION_END']]) {
      expect(await codeOf(ask(bad)), JSON.stringify(bad) ?? 'undefined').toBe('INVALID_ARGUMENT');
    }
    expect(signed).toHaveLength(0);
    expect(k.signals.seen.filter((x) => x.startsWith('reauth:'))).toEqual([]);
    // 대조: 표의 값이면 같은 세션에서 바로 나온다(위 0이 세는 방법의 결함이 아니다)
    expect((await ask('SESSION_END')).result).toBe('ISSUED');
    expect(signed).toHaveLength(1);
  });
});
