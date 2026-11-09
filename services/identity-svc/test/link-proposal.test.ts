// 가입 때 계정 연결 제안과 소유권 증명(docs/features/identity.md §2.1 '가입 때 연결 제안의 첫 구현', BUILD_ORDER BOT-040, I-T29·I-T30, FR-048, POL-034).
// 메모리 저장소·메모리 제안 저장소로 본다. PostgreSQL·Valkey는 test-int/link-proposal.int.test.ts.
import { describe, expect, test } from 'vitest';
import { MemoryLinkProposals } from '../src/modules/session/adapters/memory-link-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { GetLinkProposal } from '../src/modules/session/application/get-link-proposal.js';
import { SeparateAccount } from '../src/modules/session/application/separate-account.js';
import { SessionError } from '../src/modules/session/application/session-error.js';
import { LINK_PROPOSAL_TTL_MS } from '../src/modules/session/domain/session.js';
import { kit, newKey } from './support.js';

async function setup(o: { linkDown?: boolean } = {}) {
  const sessions = new MemorySessionStore();
  const k0 = await kit(sessions);
  const links = new MemoryLinkProposals(k0.clock, { down: o.linkDown });
  const k = await kit(sessions, { clock: k0.clock, links });
  const login = (provider: 'kakao' | 'naver' | 'google', sub: string, email: string | null, emailVerified: boolean, link?: { proposalId: string; binding: string }) =>
    k.create.outcome({ idempotencyKey: newKey(), provider, providerUserId: sub, email, emailVerified, deviceId: 'dev-1', ...(link ? { link } : {}) });
  const view = new GetLinkProposal(links, k.clock);
  const separate = new SeparateAccount(k.create, links);
  return { sessions, links, k, login, view, separate, clock: k.clock };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof SessionError) return e.code;
    throw e;
  }
};

const sessionOf = (o: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['login']>>) => {
  if (o.kind !== 'session') throw new Error(`세션이 아니다: ${o.kind}`);
  return o;
};
const proposalOf = (o: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['login']>>) => {
  if (o.kind !== 'link-proposed') throw new Error(`연결 제안이 아니다: ${o.kind}`);
  return o;
};

describe('가입 때 연결 제안(I-T29)', () => {
  test('I-T29_검증이메일이같은활성계정이정확히하나면_세션대신연결제안이고계정을만들지않는다(대소문자·앞뒤공백은같게본다)', async () => {
    const t = await setup();
    const a = sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const before = t.sessions.accountCount();
    const p = proposalOf(await t.login('google', 'g-1', '  Fan@Peaket.TEST ', true));
    expect(p.proposalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(p.binding).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.sessions.accountCount()).toBe(before);
    expect(await t.view.run({ proposalId: p.proposalId, binding: p.binding })).toEqual({
      existingProvider: 'kakao',
      newProvider: 'google',
      expiresAt: t.clock.now() + LINK_PROPOSAL_TTL_MS,
      attemptsLeft: 3,
    });
    // identity에는 묶음 값의 해시만 남는다
    expect(JSON.stringify(t.links.dump())).not.toContain(p.binding);
    expect(a.accountId).toBeTruthy();
  });

  test('I-T29_이메일이검증되지않았거나·같은이메일계정이여럿이거나·대상이활성이아니거나·대상의이메일이검증되지않았거나·대상이그제공자를이미가졌으면_제안없이새계정이다', async () => {
    const t = await setup();
    sessionOf(await t.login('kakao', 'k-1', 'one@peaket.test', true));
    // 새 제공자가 검증 이메일을 주지 않았다(네이버는 늘 false)
    expect((await t.login('naver', 'n-1', 'one@peaket.test', false)).kind).toBe('session');
    // 같은 이메일의 검증 계정이 둘이 됐다(위 네이버 계정은 검증 표시가 없어 세지 않는다) → 하나 더 만들고 나서 셋째는 제안 없음
    sessionOf(await t.login('kakao', 'k-2', 'two@peaket.test', true));
    expect(t.sessions.forceCreate('two@peaket.test', true)).toBeTruthy();
    expect((await t.login('google', 'g-2', 'two@peaket.test', true)).kind).toBe('session');
    // 대상 계정의 이메일이 검증되지 않았다
    sessionOf(await t.login('naver', 'n-3', 'three@peaket.test', false));
    expect((await t.login('google', 'g-3', 'three@peaket.test', true)).kind).toBe('session');
    // 대상이 활성이 아니다(탈퇴 유예)
    const d = sessionOf(await t.login('kakao', 'k-4', 'four@peaket.test', true));
    t.sessions.setStatus(d.accountId, 'WITHDRAWAL_PENDING');
    expect((await t.login('google', 'g-4', 'four@peaket.test', true)).kind).toBe('session');
    // 대상에 같은 제공자가 다른 sub로 이미 있다
    sessionOf(await t.login('google', 'g-5a', 'five@peaket.test', true));
    expect((await t.login('google', 'g-5b', 'five@peaket.test', true)).kind).toBe('session');
    // 이메일이 없다
    expect((await t.login('google', 'g-6', null, true)).kind).toBe('session');
    expect(t.links.dump()).toEqual([]);
  });

  test('I-T29_이미연결된제공자계정의로그인은_제안을보지않고그계정으로간다', async () => {
    const t = await setup();
    const a = sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    expect(sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true)).accountId).toBe(a.accountId);
    expect(t.links.dump()).toEqual([]);
  });

  test('제안저장소에닿지못하면_UNAVAILABLE이고계정을만들지않는다_제안대상이아닌로그인은저장소없이된다', async () => {
    const t = await setup({ linkDown: true });
    sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const before = t.sessions.accountCount();
    expect(await code(t.login('google', 'g-1', 'fan@peaket.test', true))).toBe('UNAVAILABLE');
    expect(t.sessions.accountCount()).toBe(before);
  });
});

describe('소유권 증명으로 연결(I-T30)', () => {
  test('I-T30_제안의대상계정으로기존제공자로그인하면_새제공자를그계정에잇고그계정세션이며제안이지워진다', async () => {
    const t = await setup();
    const a = sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    const r = sessionOf(await t.login('kakao', 'k-1', null, false, { proposalId: p.proposalId, binding: p.binding }));
    expect(r.accountId).toBe(a.accountId);
    expect(r.linkedProvider).toBe('google');
    expect(r.newAccount).toBe(false);
    // 다음부터 구글로도 같은 계정이다
    expect(sessionOf(await t.login('google', 'g-1', 'fan@peaket.test', true)).accountId).toBe(a.accountId);
    expect(await code(t.view.run({ proposalId: p.proposalId, binding: p.binding }))).toBe('NOT_FOUND');
  });

  test('I-T30_다른계정으로로그인하면_세션도계정도없이남은시도가줄고_세번째에제안이지워진다', async () => {
    const t = await setup();
    sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    sessionOf(await t.login('kakao', 'k-other', 'other@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    const link = { proposalId: p.proposalId, binding: p.binding };
    const before = t.sessions.accountCount();
    // 계정이 없는 카카오 계정, 다른 PEAKET 계정, 다시 없는 계정
    expect(await t.login('kakao', 'k-none', null, false, link)).toEqual({ kind: 'link-mismatch', attemptsLeft: 2 });
    expect(await t.login('kakao', 'k-other', null, false, link)).toEqual({ kind: 'link-mismatch', attemptsLeft: 1 });
    expect(t.sessions.activeCount((await t.sessions.transaction((tx) => tx.findAccountByProvider('kakao', 'k-other')))!.id)).toBe(1);
    expect(await t.login('kakao', 'k-none', null, false, link)).toEqual({ kind: 'link-mismatch', attemptsLeft: 0 });
    expect(t.sessions.accountCount()).toBe(before);
    expect(await code(t.view.run(link))).toBe('NOT_FOUND');
    // 지운 뒤에는 제안이 없다(만료 안내)
    expect(await code(t.login('kakao', 'k-1', null, false, link))).toBe('NOT_FOUND');
  });

  test('I-T30_제안이없거나10분이지났거나묶음값이다르면_NOT_FOUND이고아무것도만들지않는다', async () => {
    const t = await setup();
    sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    const before = t.sessions.accountCount();
    expect(await code(t.login('kakao', 'k-1', null, false, { proposalId: p.proposalId, binding: 'x'.repeat(43) }))).toBe('NOT_FOUND');
    expect(await code(t.view.run({ proposalId: p.proposalId, binding: 'x'.repeat(43) }))).toBe('NOT_FOUND');
    expect(await code(t.login('kakao', 'k-1', null, false, { proposalId: 'A'.repeat(22), binding: p.binding }))).toBe('NOT_FOUND');
    // 묶음 값이 틀려도 실패 횟수를 올리지 않는다(남의 제안을 지우지 못하게)
    expect((await t.view.run({ proposalId: p.proposalId, binding: p.binding })).attemptsLeft).toBe(3);
    t.clock.advance(LINK_PROPOSAL_TTL_MS + 1);
    expect(await code(t.login('kakao', 'k-1', null, false, { proposalId: p.proposalId, binding: p.binding }))).toBe('NOT_FOUND');
    expect(t.sessions.accountCount()).toBe(before);
  });

  test('I-T30_그사이새제공자계정이다른계정에묶였으면_잇지않고대상계정으로만로그인한다', async () => {
    const t = await setup();
    const a = sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    // 같은 구글 계정이 다른 길(검증 없는 이메일)로 먼저 계정을 만들었다
    const other = sessionOf(await t.login('google', 'g-1', null, false));
    const r = sessionOf(await t.login('kakao', 'k-1', null, false, { proposalId: p.proposalId, binding: p.binding }));
    expect(r.accountId).toBe(a.accountId);
    expect(r.linkedProvider).toBeNull();
    expect(sessionOf(await t.login('google', 'g-1', null, false)).accountId).toBe(other.accountId);
  });
});

describe('리뷰 재현(2026-11-04)', () => {
  test('I-T30_대상계정이활성이아니게되면(탈퇴유예)_주인의로그인도실패로세지않고제안을지우며NOT_FOUND이고잇지않는다', async () => {
    const t = await setup();
    const a = sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    t.sessions.setStatus(a.accountId, 'WITHDRAWAL_PENDING');
    expect(await code(t.login('kakao', 'k-1', null, false, { proposalId: p.proposalId, binding: p.binding }))).toBe('NOT_FOUND');
    expect(t.links.dump()).toEqual([]);
    expect(t.sessions.providerCount(a.accountId)).toBe(1);
  });
});

describe('연결하지 않고 새 계정 만들기(FR-048)', () => {
  test('새계정만들기는_제안을지우고새제공자로새계정과세션을만들며_다시부르거나묶음값이다르면NOT_FOUND다', async () => {
    const t = await setup();
    const a = sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    expect(await code(t.separate.run({ proposalId: p.proposalId, binding: 'y'.repeat(43), idempotencyKey: newKey(), deviceId: null }))).toBe('NOT_FOUND');
    const s = await t.separate.run({ proposalId: p.proposalId, binding: p.binding, idempotencyKey: newKey(), deviceId: 'dev-2' });
    expect(s.newAccount).toBe(true);
    expect(s.accountId).not.toBe(a.accountId);
    expect(sessionOf(await t.login('google', 'g-1', 'fan@peaket.test', true)).accountId).toBe(s.accountId);
    expect(t.sessions.accountOf(s.accountId)).toMatchObject({ email: 'fan@peaket.test', emailVerified: true });
    expect(await code(t.separate.run({ proposalId: p.proposalId, binding: p.binding, idempotencyKey: newKey(), deviceId: null }))).toBe('NOT_FOUND');
  });

  test('새계정만들기의응답을잃고같은멱등키로다시보내면_같은세션을돌려주고_쓴제안은다른키·연결로그인·조회에없는제안이다(BOT-040이넘긴것)', async () => {
    const t = await setup();
    sessionOf(await t.login('kakao', 'k-1', 'fan@peaket.test', true));
    const p = proposalOf(await t.login('google', 'g-1', 'fan@peaket.test', true));
    const key = newKey();
    const s = await t.separate.run({ proposalId: p.proposalId, binding: p.binding, idempotencyKey: key, deviceId: 'dev-2' });
    const again = await t.separate.run({ proposalId: p.proposalId, binding: p.binding, idempotencyKey: key, deviceId: 'dev-2' });
    expect(again).toMatchObject({ accountId: s.accountId, sessionId: s.sessionId, newAccount: true });
    expect(again.refreshToken).not.toBe(s.refreshToken);
    // 묶음 값이 다르면 같은 키여도 없는 제안이다
    expect(await code(t.separate.run({ proposalId: p.proposalId, binding: 'y'.repeat(43), idempotencyKey: key, deviceId: null }))).toBe('NOT_FOUND');
    expect(await code(t.view.run({ proposalId: p.proposalId, binding: p.binding }))).toBe('NOT_FOUND');
    expect(await code(t.login('kakao', 'k-1', null, false, { proposalId: p.proposalId, binding: p.binding }))).toBe('NOT_FOUND');
    // 수명이 지나면 같은 키도 없는 제안이다
    t.clock.advance(LINK_PROPOSAL_TTL_MS + 1);
    expect(await code(t.separate.run({ proposalId: p.proposalId, binding: p.binding, idempotencyKey: key, deviceId: null }))).toBe('NOT_FOUND');
  });
});
