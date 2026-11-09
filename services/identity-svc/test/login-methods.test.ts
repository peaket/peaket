// 설정의 로그인 수단 연결·해제(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34, FR-017, POL-034).
// 메모리 저장소로 본다. PostgreSQL은 test-int/login-methods.int.test.ts.
import { LoginMethodChanged } from '@peaket/contracts/asyncapi';
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemoryLinkProposals } from '../src/modules/session/adapters/memory-link-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { ListProviders } from '../src/modules/session/application/list-providers.js';
import { UnlinkProvider } from '../src/modules/session/application/unlink-provider.js';
import { ISSUER, kit, newKey } from './support.js';

async function setup() {
  const sessions = new MemorySessionStore();
  const k0 = await kit(sessions);
  const links = new MemoryLinkProposals(k0.clock);
  const k = await kit(sessions, { clock: k0.clock, links });
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, k.clock);
  const login = async (provider: 'kakao' | 'naver' | 'google', sub: string, email: string | null = null, emailVerified = false) =>
    k.create.run({ idempotencyKey: newKey(), provider, providerUserId: sub, email, emailVerified, deviceId: 'dev-1' });
  const token = async (s: { accountId: string; sessionId: string }, purpose: 'sensitive' | 'high-risk' = 'sensitive') =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose }, k.clock.now())).token;
  return {
    sessions,
    k,
    login,
    token,
    links,
    add: new AddProvider(sessions, reauth, k.clock),
    unlink: new UnlinkProvider(sessions, reauth, k.clock),
    list: new ListProviders(sessions),
    clock: k.clock,
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError) return e.code;
    throw e;
  }
};
const events = (t: { sessions: MemorySessionStore }) =>
  t.sessions
    .outboxMessages()
    .filter((m) => m.topic === 'identity.login-methods-changed')
    .map((m) => JSON.parse(Buffer.from(m.payload).toString('utf8')) as Record<string, unknown>);

describe('로그인 수단 추가(SCR-040 ②)', () => {
  test('I-T34_재인증뒤새제공자를이계정에이으면LINKED이고_같은트랜잭션에서연결사건을한번적는다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    const r = await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-1' });
    expect(r).toBe('LINKED');
    expect((await t.login('google', 'g-1')).accountId).toBe(a.accountId);
    const ev = events(t);
    expect(ev).toEqual([{ eventKey: expect.any(String), accountId: a.accountId, change: 'LINKED', provider: 'google', occurredAt: new Date(t.clock.now()).toISOString() }]);
    expect(LoginMethodChanged.safeParse(ev[0]).success).toBe(true);
  });

  test('이미이계정이면ALREADY_LINKED_같은종류가다른sub로있으면PROVIDER_TYPE_TAKEN_다른계정이면OTHER_ACCOUNT이고_잇지않으며사건도없다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    await t.login('google', 'g-other');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'kakao', providerUserId: 'k-1' })).toBe('ALREADY_LINKED');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'kakao', providerUserId: 'k-2' })).toBe('PROVIDER_TYPE_TAKEN');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-other' })).toBe('OTHER_ACCOUNT');
    expect(t.sessions.providerCount(a.accountId)).toBe(1);
    expect(events(t)).toEqual([]);
  });

  test('재인증토큰이없거나·다른세션의것이거나·한번쓴것이면REAUTH_REQUIRED다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    const b = await t.login('kakao', 'k-1');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: '', provider: 'google', providerUserId: 'g-1' })).toBe('REAUTH_REQUIRED');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(b), provider: 'google', providerUserId: 'g-1' })).toBe('REAUTH_REQUIRED');
    const once = await t.token(a);
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: once, provider: 'google', providerUserId: 'g-1' })).toBe('LINKED');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: once, provider: 'naver', providerUserId: 'n-1' })).toBe('REAUTH_REQUIRED');
  });
});

describe('로그인 수단 해제(SCR-040 ③, I-T33)', () => {
  test('I-T33_마지막하나뿐인로그인수단의해제는409(LAST_LOGIN_METHOD)이고_재인증토큰을쓰지않아다시쓸수있다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    const tok = await t.token(a);
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: tok, provider: 'kakao' }))).toBe('LAST_LOGIN_METHOD');
    expect(t.sessions.providerCount(a.accountId)).toBe(1);
    // 되돌린 트랜잭션이라 토큰은 아직 쓰지 않았다
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: tok, provider: 'google', providerUserId: 'g-1' })).toBe('LINKED');
  });

  test('I-T33·I-T34_둘이면재인증을통과했을때만해제되어UNLINKED사건을적고_없는종류는NOT_FOUND_재인증없으면REAUTH_REQUIRED다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-1' })).toBe('LINKED');
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: 'x', provider: 'google' }))).toBe('REAUTH_REQUIRED');
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'naver' }))).toBe('NOT_FOUND');
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google' }))).toBe('OK');
    expect((await t.list.run(a.accountId)).map((p) => p.provider)).toEqual(['kakao']);
    expect(events(t).map((e) => [e.change, e.provider])).toEqual([
      ['LINKED', 'google'],
      ['UNLINKED', 'google'],
    ]);
    // 해제한 구글로 다시 로그인하면 새 계정이다(지금 세션은 끝내지 않는다)
    expect(t.sessions.activeCount(a.accountId)).toBe(1);
    expect((await t.login('google', 'g-1')).accountId).not.toBe(a.accountId);
  });
});

describe('마지막 로그인 시각과 가입 때 연결의 사건', () => {
  test('로그인세션을만들때마다그제공자의lastLoginAt을적고_목록이준다(처음연결만하고로그인하지않은수단은null)', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    const first = t.clock.now();
    t.clock.advance(1_000);
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-1' })).toBe('LINKED');
    t.clock.advance(60_000);
    await t.login('kakao', 'k-1');
    const list = await t.list.run(a.accountId);
    expect(list).toEqual([
      { provider: 'kakao', linkedAt: new Date(first).toISOString(), lastLoginAt: new Date(t.clock.now()).toISOString() },
      { provider: 'google', linkedAt: new Date(first + 1_000).toISOString(), lastLoginAt: null },
    ]);
  });

  test('I-T34_가입때연결제안으로이은연결도_LINKED사건을적는다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1', 'fan@peaket.test', true);
    const p = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'g-1', email: 'fan@peaket.test', emailVerified: true, deviceId: null });
    if (p.kind !== 'link-proposed') throw new Error(p.kind);
    const r = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-1', email: null, deviceId: null, link: { proposalId: p.proposalId, binding: p.binding } });
    expect(r.kind).toBe('session');
    expect(events(t)).toMatchObject([{ accountId: a.accountId, change: 'LINKED', provider: 'google' }]);
  });
});

describe('리뷰 재현(2026-11-04)', () => {
  test('중간1_재인증뒤그세션이끝났으면(다른기기에서로그아웃)_AddProvider는REAUTH_REQUIRED이고잇지않는다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    const tok = await t.token(a);
    await t.k.end.run({ sessionId: a.sessionId, accountId: a.accountId });
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: tok, provider: 'google', providerUserId: 'g-1' })).toBe('REAUTH_REQUIRED');
    expect(t.sessions.providerCount(a.accountId)).toBe(1);
  });

  test('중간2_가입때연결제안이남은사이설정에서같은종류를이었으면_제안의연결은잇지않고대상계정으로만로그인한다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1', 'fan@peaket.test', true);
    const p = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'google', providerUserId: 'g-2', email: 'fan@peaket.test', emailVerified: true, deviceId: null });
    if (p.kind !== 'link-proposed') throw new Error(p.kind);
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-1' })).toBe('LINKED');
    const r = await t.k.create.outcome({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'k-1', email: null, deviceId: null, link: { proposalId: p.proposalId, binding: p.binding } });
    if (r.kind !== 'session') throw new Error(r.kind);
    expect(r).toMatchObject({ accountId: a.accountId, linkedProvider: null });
    expect((await t.list.run(a.accountId)).map((x) => x.provider)).toEqual(['kakao', 'google']);
    expect(t.sessions.providerCount(a.accountId)).toBe(2);
  });

  test('I-T33_해제도_다른세션의재인증토큰이나한번쓴토큰이면REAUTH_REQUIRED다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-1');
    const b = await t.login('kakao', 'k-1');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-1' })).toBe('LINKED');
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(b), provider: 'google' }))).toBe('REAUTH_REQUIRED');
    const tok = await t.token(a);
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: tok, provider: 'google' }))).toBe('OK');
    expect(await t.add.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'naver', providerUserId: 'n-1' })).toBe('LINKED');
    expect(await code(t.unlink.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: tok, provider: 'naver' }))).toBe('REAUTH_REQUIRED');
  });
});
