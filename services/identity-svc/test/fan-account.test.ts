// 팬 계정 요약·가입 마무리·닉네임 확인·가입 취소·가입 전 계정 치우기(docs/features/identity.md §8 '팬 계정 요약·세션 종료 사유·가입 마무리의 첫 구현',
// BUILD_ORDER BOT-047, ADR-0235, ADR-0202, ADR-0203, I-T77·I-T79·I-T80·I-T81·I-T82). 메모리 저장소로 본다. PostgreSQL은 test-int/fan-account.int.test.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MemoryNicknameCheckLimits } from '../src/modules/session/adapters/memory-nickname-check-limits.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CancelSignup } from '../src/modules/session/application/cancel-signup.js';
import { CheckNickname, NicknameCheckLimited } from '../src/modules/session/application/check-nickname.js';
import { CompleteSignup, SignupError } from '../src/modules/session/application/complete-signup.js';
import { GetAccountSummary } from '../src/modules/session/application/get-account-summary.js';
import { PurgeIncompleteSignups } from '../src/modules/session/application/purge-incomplete-signups.js';
import type { AccountClaims, SessionStore, SessionTx } from '../src/modules/session/domain/ports.js';
import { CONSENT_NOTICE_VERSIONS, INCOMPLETE_SIGNUP_PURGE_MS, NICKNAME_CHECK_LIMIT, nicknameKey, nicknameProblem } from '../src/modules/session/domain/signup.js';
import { SESSION_IDLE_MS } from '../src/modules/session/domain/session.js';
import { kit, newKey } from './support.js';

const FORM = { ageOver14: true as const, consents: { terms: true as const, privacy: true as const, marketing: false, phone: false }, nickname: '피켓팬' };

async function setup() {
  const sessions = new MemorySessionStore();
  const verified = new Set<string>();
  const failLock = new Set<string>();
  const staff = new Set<string>();
  const claims: AccountClaims = { of: async (id) => (verified.has(id) ? { scopes: ['ticket:buy'], pid: 'pid-x' } : { scopes: [] }) };
  const k = await kit(sessions, { claims });
  const staffPort = { hasAssigned: async (id: string) => staff.has(id) };
  const summary = new GetAccountSummary(sessions, claims, staffPort, k.clock);
  const complete = new CompleteSignup(sessions, summary, k.clock, k.signals);
  const limits = new MemoryNicknameCheckLimits(k.clock);
  const check = new CheckNickname(sessions, limits, k.clock, k.signals);
  const cancel = new CancelSignup(sessions, k.clock, k.signals);
  /** 정비가 볼 본인확인 기록(메모리 저장소는 본인확인 표를 보지 못해 null이다. 모르면 지우지 않으므로 대역을 끼운다) */
  const purgeStore = { transaction: <T>(fn: (tx: SessionTx) => Promise<T>) => sessions.transaction((tx) => fn({ ...tx, verifiedOf: async (a: string) => verified.has(a), lockAccount: async (a: string) => { if (failLock.has(a)) throw new Error('잠금 실패'); return tx.lockAccount(a); } })) } as unknown as SessionStore;
  const purge = new PurgeIncompleteSignups(purgeStore, k.clock);
  const login = (sub: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: sub, email: `${sub}@example.test`, emailVerified: true, deviceId: `dev-${sub}` });
  return { sessions, k, verified, failLock, staff, summary, complete, check, cancel, purge, login };
}

const id = (s: { accountId: string; sessionId: string }) => ({ accountId: s.accountId, sessionId: s.sessionId });
const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError || e instanceof SignupError) return e.code;
    throw e;
  }
};

describe('팬 계정 요약(I-T77)', () => {
  test('I-T77_① 가입 전 계정은 닉네임 null, signupCompleted false다', async () => {
    const t = await setup();
    const s = await t.login('a');
    expect(await t.summary.run(id(s))).toEqual({ nickname: null, signupCompleted: false, verified: false, hasStaffAssignment: false });
  });

  test('I-T77_②③④ 가입을 마치면 닉네임·signupCompleted true, 본인확인·스태프 배정은 포트의 값이다 [ASVS v5.0.0-14.3.2]', async () => {
    const t = await setup();
    const s = await t.login('b');
    await t.complete.run({ ...id(s), input: FORM });
    t.verified.add(s.accountId);
    t.staff.add(s.accountId);
    expect(await t.summary.run(id(s))).toEqual({ nickname: '피켓팬', signupCompleted: true, verified: true, hasStaffAssignment: true });
  });

  test('I-T77_⑥ 끝난 세션으로는 읽지 못한다(SESSION_ENDED) [ASVS v5.0.0-7.4.1]', async () => {
    const t = await setup();
    const s = await t.login('c');
    await t.sessions.transaction((tx) => tx.terminateSessions([s.sessionId], 'LOGOUT', t.k.clock.now()));
    expect(await errCode(t.summary.run(id(s)))).toBe('SESSION_ENDED');
  });

  test('I-T77 다른 계정의 세션 ID로는 읽지 못한다', async () => {
    const t = await setup();
    const a = await t.login('owner');
    const b = await t.login('other');
    expect(await errCode(t.summary.run({ accountId: a.accountId, sessionId: b.sessionId }))).toBe('SESSION_ENDED');
  });
});

describe('가입 마무리(I-T79)', () => {
  test('I-T79_① 필수만으로 마치면 요약이 바뀌고 다시 부르면 409다', async () => {
    const t = await setup();
    const s = await t.login('d');
    const r = await t.complete.run({ ...id(s), input: FORM });
    expect(r).toEqual({ nickname: '피켓팬', signupCompleted: true, verified: false, hasStaffAssignment: false });
    const rows = await t.sessions.transaction((tx) => tx.signupStateOf(s.accountId));
    expect(rows?.ageVerified).toBe(true);
    expect(rows?.consentKinds.sort()).toEqual(['PRIVACY_REQUIRED', 'TERMS']);
    expect(await errCode(t.complete.run({ ...id(s), input: FORM }))).toBe('ALREADY_COMPLETED');
  });

  test('I-T79_② 선택 동의는 동의했을 때만 행이 생긴다', async () => {
    const t = await setup();
    const s = await t.login('e');
    await t.complete.run({ ...id(s), input: { ...FORM, consents: { ...FORM.consents, marketing: true, phone: true }, phone: '01012345678' } });
    const rows = await t.sessions.transaction((tx) => tx.signupStateOf(s.accountId));
    expect(rows?.consentKinds.sort()).toEqual(['MARKETING', 'PRIVACY_PHONE', 'PRIVACY_REQUIRED', 'TERMS']);
    expect(t.k.signals.seen).toContain('signup-completed:yes');
  });

  test('I-T79 닉네임 규칙을 어기면 NICKNAME_INVALID다', async () => {
    const t = await setup();
    const s = await t.login('f');
    expect(await errCode(t.complete.run({ ...id(s), input: { ...FORM, nickname: '👍👍' } }))).toBe('NICKNAME_INVALID');
    expect(await errCode(t.complete.run({ ...id(s), input: { ...FORM, nickname: '가' } }))).toBe('NICKNAME_INVALID');
  });

  test('I-T79_⑦ 만 14세 미만으로 정리 중인 계정은 가입을 마치지 못하고 UNDER_14다', async () => {
    const t = await setup();
    const s = await t.login('g');
    await t.sessions.transaction((tx) => tx.markClosure(s.accountId, 'UNDER_14', t.k.clock.now()));
    expect(await errCode(t.complete.run({ ...id(s), input: FORM }))).toBe('UNDER_14');
  });

  test('I-T79_⑧ 동의 행의 고지 문안 판은 그 동의가 가리키는 문서의 시행일이다', async () => {
    const t = await setup();
    const s = await t.login('g2');
    await t.complete.run({ ...id(s), input: { ...FORM, consents: { ...FORM.consents, marketing: true, phone: true }, phone: '01012345678' } });
    const policy = readFileSync(new URL('../../../apps/web/src/entities/policy-doc/model.ts', import.meta.url), 'utf8');
    const effective = (slug: string) => new RegExp(`slug: '${slug}',[\\s\\S]*?effective: '([0-9-]+)'`).exec(policy)?.[1];
    expect(CONSENT_NOTICE_VERSIONS.TERMS).toBe(effective('terms'));
    expect(CONSENT_NOTICE_VERSIONS.PRIVACY_REQUIRED).toBe(effective('privacy'));
    expect(CONSENT_NOTICE_VERSIONS.PRIVACY_PHONE).toBe(effective('privacy'));
    expect(t.sessions.consentsOf(s.accountId).map((c) => [c.kind, c.noticeVersion]).sort()).toEqual([
      ['MARKETING', CONSENT_NOTICE_VERSIONS.MARKETING],
      ['PRIVACY_PHONE', CONSENT_NOTICE_VERSIONS.PRIVACY_PHONE],
      ['PRIVACY_REQUIRED', CONSENT_NOTICE_VERSIONS.PRIVACY_REQUIRED],
      ['TERMS', CONSENT_NOTICE_VERSIONS.TERMS],
    ]);
  });
});

describe('닉네임 확인과 중복 키(I-T80)', () => {
  test('I-T80_① 규칙을 어기면 invalid, 화면 규칙과 같은 값이다 [ASVS v5.0.0-14.2.1]', async () => {
    const t = await setup();
    const s = await t.login('h');
    for (const bad of ['👍', '루멘🎤', '👩‍🎤팬', 'a  b', 'a\tb', '<b>', 'ab!', '#tag', '1️⃣2️⃣', '가️나', 'ab‍c', '가나❤', `a${'́'.repeat(60)}b`, '지', '열두글자를넘는닉네임입니다', '', '   ']) {
      expect(await t.check.run({ ...id(s), nickname: bad }), JSON.stringify(bad)).toEqual({ available: false, reason: 'invalid' });
    }
    for (const good of ['지민', 'LUMEN_fan', 'a.b-c', '루멘 팬', 'Ölçek', '一二三', '열두글자열두글자열두글자', 'नमस्ते']) expect(nicknameProblem(good), good).toBeNull();
    expect(await t.check.run({ ...id(s), nickname: '지민' })).toEqual({ available: true });
  });

  test('I-T80_① 보이지 않는 글자(결합 자리 표시·변형 선택자·제로폭·한글 채움 문자)는 규칙 위반이다', () => {
    for (const bad of ['가͏나', '가나︀', '가나\u{E0100}', '가ㅤ나', 'ㅤㅤ', '가ﾠ나', 'ᅟ가나', '가ᅠ나', '가​나', '가­나', '가⁠나', '가﻿나']) expect(nicknameProblem(bad), JSON.stringify(bad)).toBe('chars');
  });

  test('I-T80_⑧ 세션이 끝났으면 닉네임 확인도 SESSION_ENDED이고 요청 수를 쓰지 않는다', async () => {
    const t = await setup();
    const s = await t.login('m2');
    await t.sessions.transaction((tx) => tx.terminateSessions([s.sessionId], 'LOGOUT', t.k.clock.now()));
    expect(await errCode(t.check.run({ ...id(s), nickname: '지민' }))).toBe('SESSION_ENDED');
  });

  test('I-T80_② 대소문자·전각이 다른 같은 닉네임은 taken이다', async () => {
    const t = await setup();
    const a = await t.login('i');
    const b = await t.login('j');
    await t.complete.run({ ...id(a), input: { ...FORM, nickname: 'Peaket' } });
    expect(await t.check.run({ ...id(b), nickname: 'peaket' })).toEqual({ available: false, reason: 'taken' });
    expect(await t.check.run({ ...id(b), nickname: 'ＰＥＡＫＥＴ' })).toEqual({ available: false, reason: 'taken' });
    expect(nicknameKey('Peaket')).toBe(nicknameKey('ＰＥＡＫＥＴ'));
  });

  test('I-T80_③ 가입 마무리에서 같은 키는 NICKNAME_TAKEN이고 계정은 그대로다', async () => {
    const t = await setup();
    const a = await t.login('k');
    const b = await t.login('l');
    await t.complete.run({ ...id(a), input: FORM });
    expect(await errCode(t.complete.run({ ...id(b), input: FORM }))).toBe('NICKNAME_TAKEN');
    expect((await t.summary.run(id(b))).signupCompleted).toBe(false);
  });

  test('I-T80_⑤ 세션마다 31번째 요청은 한도에 걸리고 1분 뒤 다시 된다', async () => {
    const t = await setup();
    const s = await t.login('m');
    for (let i = 0; i < NICKNAME_CHECK_LIMIT; i++) await t.check.run({ ...id(s), nickname: '지민' });
    await expect(t.check.run({ ...id(s), nickname: '지민' })).rejects.toBeInstanceOf(NicknameCheckLimited);
    expect(t.k.signals.seen).toContain('nickname-limited');
    t.k.clock.advance(60_001);
    expect(await t.check.run({ ...id(s), nickname: '지민' })).toEqual({ available: true });
  });

  test('I-T80_⑥ 탈퇴·흡수로 닉네임이 지워지면 그 키를 다시 쓸 수 있다', async () => {
    const t = await setup();
    const a = await t.login('n');
    const b = await t.login('o');
    await t.complete.run({ ...id(a), input: FORM });
    await t.sessions.transaction((tx) => tx.eraseAccount(a.accountId, t.k.clock.now()));
    expect(await t.check.run({ ...id(b), nickname: FORM.nickname })).toEqual({ available: true });
    await t.complete.run({ ...id(b), input: FORM });
    expect((await t.summary.run(id(b))).nickname).toBe(FORM.nickname);
  });

  test('I-T80_⑥ 흡수로 닉네임이 지워져도 그 키를 다시 쓸 수 있고 흡수 계정의 동의 행은 사라진다', async () => {
    const t = await setup();
    const absorbed = await t.login('n2');
    const primary = await t.login('o2');
    const other = await t.login('o3');
    await t.complete.run({ ...id(absorbed), input: { ...FORM, nickname: '흡수될닉네임' } });
    await t.sessions.transaction((tx) => tx.mergeAccounts({ mergeId: 'merge-n', primaryAccountId: primary.accountId, absorbedAccountId: absorbed.accountId, mergedProvider: 'kakao', moved: {}, requestedAt: t.k.clock.now(), now: t.k.clock.now() }));
    expect(t.sessions.consentsOf(absorbed.accountId)).toEqual([]);
    expect(await t.check.run({ ...id(other), nickname: '흡수될닉네임' })).toEqual({ available: true });
  });
});

describe('만 14세 미만 가입 취소(I-T81)', () => {
  test('I-T81_① 가입 전 계정은 정리 중으로 바뀌고 세션이 모두 끝난다', async () => {
    const t = await setup();
    const s = await t.login('p');
    const other = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'p', email: 'p@example.test', emailVerified: true, deviceId: 'dev-p2' });
    await t.cancel.run(id(s));
    expect(await t.sessions.transaction((tx) => tx.closureReasonOf(s.accountId))).toBe('UNDER_14');
    expect((await t.sessions.liveSessionsOf(s.accountId, t.k.clock.now())).map((x) => x.sessionId)).toEqual([]);
    expect(await errCode(t.summary.run(id(s)))).toBe('SESSION_ENDED');
    expect(await errCode(t.summary.run(id(other)))).toBe('SESSION_ENDED');
  });

  test('I-T81_② 가입을 마친 계정은 ALREADY_COMPLETED이고 그대로다', async () => {
    const t = await setup();
    const s = await t.login('q');
    await t.complete.run({ ...id(s), input: FORM });
    expect(await errCode(t.cancel.run(id(s)))).toBe('ALREADY_COMPLETED');
    expect((await t.summary.run(id(s))).signupCompleted).toBe(true);
  });

  test('I-T81_③ 세션이 끝났으면 SESSION_ENDED다', async () => {
    const t = await setup();
    const s = await t.login('r');
    await t.sessions.transaction((tx) => tx.terminateSessions([s.sessionId], 'LOGOUT', t.k.clock.now()));
    expect(await errCode(t.cancel.run(id(s)))).toBe('SESSION_ENDED');
  });
});

describe('가입 전 계정 치우기(I-T82)', () => {
  test('I-T82_①③ 30일이 지나고 세션이 없는 가입 전 계정만 지운다', async () => {
    const t = await setup();
    const a = await t.login('s');
    t.k.clock.advance(SESSION_IDLE_MS + 1);
    t.k.clock.advance(INCOMPLETE_SIGNUP_PURGE_MS - SESSION_IDLE_MS);
    expect(await t.purge.run()).toEqual({ purged: 1 });
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(a.accountId))).toBe('DELETED');
    expect(await t.sessions.transaction((tx) => tx.signupStateOf(a.accountId))).toMatchObject({ consentKinds: [], ageVerified: false, nickname: null });
    expect(await t.sessions.transaction((tx) => tx.providersOf(a.accountId))).toEqual([]);
  });

  test('I-T82_④ 본인확인을 마친 가입 전 계정은 지우지 않는다(탈퇴 사건 없이 pid를 잃지 않게)', async () => {
    const t = await setup();
    const a = await t.login('s2');
    t.verified.add(a.accountId);
    t.k.clock.advance(INCOMPLETE_SIGNUP_PURGE_MS + SESSION_IDLE_MS);
    expect(await t.purge.run()).toEqual({ purged: 0 });
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(a.accountId))).toBe('ACTIVE');
  });

  test('I-T82_⑤ 본인확인 표를 볼 수 없으면(모름) 지우지 않는다', async () => {
    const t = await setup();
    const a = await t.login('s3');
    t.k.clock.advance(INCOMPLETE_SIGNUP_PURGE_MS + SESSION_IDLE_MS);
    expect(await new PurgeIncompleteSignups(t.sessions, t.k.clock).run()).toEqual({ purged: 0 });
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(a.accountId))).toBe('ACTIVE');
  });

  test('I-T82_⑥ 한 계정이 실패해도 나머지를 끝까지 다루고 끝에 실패를 알린다', async () => {
    const t = await setup();
    const bad = await t.login('s4');
    const good = await t.login('s5');
    t.failLock.add(bad.accountId);
    t.k.clock.advance(INCOMPLETE_SIGNUP_PURGE_MS + SESSION_IDLE_MS);
    await expect(t.purge.run()).rejects.toThrow('1건');
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(good.accountId))).toBe('DELETED');
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(bad.accountId))).toBe('ACTIVE');
  });

  test('I-T82_② 30일이 안 됐거나 세션이 살아 있거나 가입을 마친 계정은 그대로다', async () => {
    const t = await setup();
    const young = await t.login('t');
    expect(await t.purge.run()).toEqual({ purged: 0 });
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(young.accountId))).toBe('ACTIVE');

    const done = await t.login('u');
    await t.complete.run({ ...id(done), input: FORM });
    const live = await t.login('v');
    t.k.clock.advance(INCOMPLETE_SIGNUP_PURGE_MS + 1);
    // 다시 로그인한 세션이 살아 있으면 건너뛴다
    const relogin = await t.k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'v', email: 'v@example.test', emailVerified: true, deviceId: 'dev-v' });
    expect(relogin.accountId).toBe(live.accountId);
    expect(await t.purge.run()).toEqual({ purged: 1 });
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(live.accountId))).toBe('ACTIVE');
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(done.accountId))).toBe('ACTIVE');
    expect(await t.sessions.transaction((tx) => tx.accountStatusOf(young.accountId))).toBe('DELETED');
  });
});
