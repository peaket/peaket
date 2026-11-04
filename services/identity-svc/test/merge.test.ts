// 계정 병합의 identity 쪽(docs/features/identity.md §2.1 '계정 병합의 첫 구현', BUILD_ORDER BOT-042, I-T31·I-T32·I-T34, POL-034).
// 메모리 저장소와 가짜 CheckAccountMerge 세 개로 본다. PostgreSQL은 test-int/merge.int.test.ts.
import { AccountMerged } from '@peaket/contracts/asyncapi';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemoryMergeProposals } from '../src/modules/session/adapters/memory-merge-proposals.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AddProvider } from '../src/modules/session/application/add-provider.js';
import { ConfirmMerge } from '../src/modules/session/application/confirm-merge.js';
import { GetMergeProposal } from '../src/modules/session/application/get-merge-proposal.js';
import { MergeError } from '../src/modules/session/application/merge-error.js';
import { MergePlanner } from '../src/modules/session/application/plan-merge.js';
import { SetAccountHold } from '../src/modules/session/application/set-account-hold.js';
import type { CheckResult } from '../src/modules/session/domain/merge.js';
import { type AccountEraser, type AccountRow, type MergeChecker, MergeCheckUnavailable } from '../src/modules/session/domain/ports.js';
import { ISSUER, kit, newKey } from './support.js';

type Svc = 'purchase' | 'ticket' | 'core';

async function setup() {
  const sessions = new MemorySessionStore();
  const k = await kit(sessions);
  const verified = new Set<string>();
  const eraser: AccountEraser = { erase: async () => false, pidsOf: async (id) => (verified.has(id) ? ['pid'] : []) };
  const results: Record<Svc, CheckResult | 'down' | 'boom'> = { purchase: { blocks: [], counts: {} }, ticket: { blocks: [], counts: {} }, core: { blocks: [], counts: {} } };
  const checkers: MergeChecker[] = (['purchase', 'ticket', 'core'] as const).map((service) => ({
    service,
    check: async () => {
      const r = results[service];
      if (r === 'down') throw new MergeCheckUnavailable(service);
      if (r === 'boom') throw new Error('뜻밖의 오류');
      return r;
    },
  }));
  const proposals = new MemoryMergeProposals(k.clock);
  const planner = new MergePlanner(sessions, eraser, checkers, proposals, k.clock, undefined, k.signals);
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, k.clock);
  const add = new AddProvider(sessions, reauth, k.clock, planner);
  const view = new GetMergeProposal(proposals, k.clock);
  const confirm = new ConfirmMerge(sessions, reauth, planner, proposals, k.clock);
  const login = (provider: 'kakao' | 'naver' | 'google', sub: string, email: string | null = null) =>
    k.create.run({ idempotencyKey: newKey(), provider, providerUserId: sub, email, emailVerified: email !== null, deviceId: `dev-${sub}` });
  const token = async (s: { accountId: string; sessionId: string }) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, k.clock.now())).token;
  /** 카카오 계정 A(지금 로그인)와 구글 계정 B(다른 계정)를 만들고, A에서 B의 구글을 추가해 병합 제안을 받는다 */
  const propose = async () => {
    const a = await login('kakao', `k-${newKey().slice(0, 6)}`, 'a@peaket.test');
    const gsub = `g-${newKey().slice(0, 6)}`;
    const b = await login('google', gsub, 'b@peaket.test');
    const r = await add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await token(a), provider: 'google', providerUserId: gsub });
    return { a, b, gsub, r };
  };
  return { sessions, k, verified, results, proposals, planner, add, view, confirm, login, token, propose, holds: new SetAccountHold(sessions, k.clock), clock: k.clock };
}

const err = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof MergeError) return e.code;
    throw e;
  }
};

describe('병합 제안(I-T31)', () => {
  test('I-T31_다른계정의로그인수단을추가하면OTHER_ACCOUNT와병합제안이고_둘다본인확인전이면지금계정이대표다', async () => {
    const t = await setup();
    const { a, b, r } = await t.propose();
    expect(r.result).toBe('OTHER_ACCOUNT');
    expect(r.mergeProposalId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const v = await t.view.run({ accountId: a.accountId, proposalId: r.mergeProposalId! });
    expect(v).toMatchObject({ primaryAccountId: a.accountId, mergedAccountId: b.accountId, status: 'PROPOSED', blockers: [], moved: { providers: 1, tickets: 0, reviews: 0 } });
    // 화면 문구에 쓰는 값(BOT-043): 추가하려던 종류, 지금 계정이 남는 쪽인지, 남는 계정의 본인확인 여부
    expect(v).toMatchObject({ newProvider: 'google', requesterRole: 'PRIMARY', primaryVerified: false });
  });

  test('I-T31_지금계정만본인확인을마쳤으면지금계정이대표이고_조회는PRIMARY와남는계정의본인확인참이다', async () => {
    const t = await setup();
    const x = await t.login('kakao', 'k-x1');
    await t.login('google', 'g-y1');
    t.verified.add(x.accountId);
    const r = await t.add.add({ accountId: x.accountId, sessionId: x.sessionId, reauthToken: await t.token(x), provider: 'google', providerUserId: 'g-y1' });
    expect(await t.view.run({ accountId: x.accountId, proposalId: r.mergeProposalId! })).toMatchObject({ primaryAccountId: x.accountId, status: 'PROPOSED', requesterRole: 'PRIMARY', primaryVerified: true });
  });

  test('I-T31_다른계정만본인확인을마쳤으면그계정이대표이고_둘다마쳤으면BOTH_VERIFIED로막는다', async () => {
    const t = await setup();
    const x = await t.login('kakao', 'k-x', 'x@peaket.test');
    const y = await t.login('google', 'g-y', 'y@peaket.test');
    t.verified.add(y.accountId);
    const r1 = await t.add.add({ accountId: x.accountId, sessionId: x.sessionId, reauthToken: await t.token(x), provider: 'google', providerUserId: 'g-y' });
    expect(await t.view.run({ accountId: x.accountId, proposalId: r1.mergeProposalId! })).toMatchObject({ primaryAccountId: y.accountId, mergedAccountId: x.accountId, status: 'PROPOSED', requesterRole: 'MERGED', primaryVerified: true });
    t.verified.add(x.accountId);
    const r2 = await t.add.add({ accountId: x.accountId, sessionId: x.sessionId, reauthToken: await t.token(x), provider: 'google', providerUserId: 'g-y' });
    expect(await t.view.run({ accountId: x.accountId, proposalId: r2.mergeProposalId! })).toMatchObject({ status: 'BLOCKED', blockers: ['BOTH_VERIFIED'] });
  });

  test('I-T31_세서비스와identity의막는사유를코드로옮기고_요약에흡수계정의개수를싣는다', async () => {
    const t = await setup();
    t.results.purchase = { blocks: [{ service: 'purchase', reason: 'PURCHASE_SESSION' }, { service: 'purchase', reason: 'PAYMENT_PENDING_ORDER' }], counts: { orders: 3 } };
    t.results.ticket = { blocks: [{ service: 'ticket', reason: 'TICKET_IN_ENTRY_WINDOW' }], counts: {} };
    t.results.core = { blocks: [{ service: 'core', reason: 'LIMITED_MERCH_OVER_LIMIT' }], counts: { wishes: 5, subscriptions: 2, addresses: 1 } };
    const { a, b } = await t.propose();
    expect(await t.holds.run({ sourceRef: '0190f3a1-7c2e-7a00-8000-0000000000a1', accountId: b.accountId, kind: 'APPEAL', state: 'OPEN', sourceVersion: 1 })).toBe('APPLIED');
    t.sessions.setStatus(b.accountId, 'WITHDRAWAL_PENDING');
    const p = await t.planner.plan({ requesterAccountId: a.accountId, requesterSessionId: a.sessionId, otherAccountId: b.accountId, newProvider: 'google', newProviderUserId: 'g-x' });
    expect(await t.view.run({ accountId: a.accountId, proposalId: p! })).toMatchObject({
      status: 'BLOCKED',
      blockers: ['ACTIVE_PURCHASE_SESSION', 'PENDING_PAYMENT', 'QUOTA_EXCEEDED', 'WITHDRAWAL_IN_PROGRESS', 'APPEAL_PENDING', 'ENTRY_STARTED'],
      moved: { orders: 3, wishes: 5, subscriptions: 2, addresses: 1, providers: 1, tickets: 0, reviews: 0 },
    });
  });

  test('세서비스가운데하나라도답하지않으면_제안없이OTHER_ACCOUNT만이다', async () => {
    const t = await setup();
    t.results.ticket = 'down';
    const { r } = await t.propose();
    expect(r).toEqual({ result: 'OTHER_ACCOUNT' });
  });

  test('제안은제안한계정만읽고_10분이지나면없다', async () => {
    const t = await setup();
    const { a, b, r } = await t.propose();
    expect(await err(t.view.run({ accountId: b.accountId, proposalId: r.mergeProposalId! }))).toBe('NOT_FOUND');
    t.clock.advance(10 * 60_000 + 1);
    expect(await err(t.view.run({ accountId: a.accountId, proposalId: r.mergeProposalId! }))).toBe('NOT_FOUND');
  });
});

describe('병합 확정(I-T32·I-T34)', () => {
  test('I-T32_확정하면로그인수단을대표로옮기고흡수계정을MERGED로잠그며_흡수계정세션을모두끝내고병합사건을한번적는다', async () => {
    const t = await setup();
    const { a, b, gsub, r } = await t.propose();
    const bSessions = t.sessions.activeCount(b.accountId);
    expect(bSessions).toBe(1);
    await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
    expect(t.sessions.accountOf(b.accountId)).toMatchObject({ status: 'MERGED', mergedInto: a.accountId, email: null });
    expect(t.sessions.activeCount(b.accountId)).toBe(0);
    expect(t.sessions.terminations(b.accountId).map(([, why]) => why)).toEqual(['MERGED']);
    expect((await t.login('google', gsub)).accountId).toBe(a.accountId);
    const ev = t.sessions.outboxMessages().filter((m) => m.topic === 'identity.accounts-merged');
    expect(ev).toHaveLength(1);
    const v = JSON.parse(Buffer.from(ev[0]!.payload).toString('utf8'));
    expect(v).toEqual({ mergeId: expect.any(String), primaryAccountId: a.accountId, mergedAccountId: b.accountId, confirmedAt: new Date(t.clock.now()).toISOString() });
    expect(AccountMerged.safeParse(v).success).toBe(true);
    expect(t.sessions.mergesOf(a.accountId)).toEqual([{ mergedAccountId: b.accountId, mergedProvider: 'google', moved: expect.objectContaining({ providers: 1 }) }]);
    // 같은 제안으로 다시 확정하면 없다(멱등하게 한 번만)
    expect(await err(t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) }))).toBe('NOT_FOUND');
    expect(t.sessions.outboxMessages().filter((m) => m.topic === 'identity.accounts-merged')).toHaveLength(1);
  });

  test('확정은재인증이맞아야하고_그사이막는사유가생겼으면BLOCKED_흡수계정에티켓이있으면INVARIANT_서비스가답하지않으면UNAVAILABLE이며병합하지않는다', async () => {
    const t = await setup();
    const { a, b, r } = await t.propose();
    const id = r.mergeProposalId!;
    expect(await err(t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: id, reauthToken: 'nope' }))).toBe('REAUTH_REQUIRED');
    t.results.purchase = { blocks: [{ service: 'purchase', reason: 'SEAT_HOLD' }], counts: {} };
    const blocked = await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: id, reauthToken: await t.token(a) }).catch((e: unknown) => e);
    expect(blocked instanceof MergeError && blocked.code === 'BLOCKED' && blocked.blockers).toEqual(['ACTIVE_PURCHASE_SESSION']);
    t.results.purchase = { blocks: [], counts: {} };
    t.results.ticket = { blocks: [{ service: 'ticket', reason: 'ABSORBED_HAS_TICKETS' }], counts: {} };
    expect(await err(t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: id, reauthToken: await t.token(a) }))).toBe('INVARIANT');
    // 불변식 위반은 SEV3 지표를 한 번 올린다(I-T32)
    expect(t.k.signals.seen.filter((x) => x === 'merge-invariant')).toHaveLength(1);
    t.results.ticket = 'down';
    expect(await err(t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: id, reauthToken: await t.token(a) }))).toBe('UNAVAILABLE');
    expect(t.sessions.accountOf(b.accountId)?.status).toBe('ACTIVE');
  });

  test('다른계정은제안을확정할수없다(제안한계정만)', async () => {
    const t = await setup();
    const { b, r } = await t.propose();
    expect(await err(t.confirm.run({ accountId: b.accountId, sessionId: b.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(b) }))).toBe('NOT_FOUND');
  });

  test('지금계정이흡수되는쪽이면_확정뒤그세션도끝난다(흡수된세션안내)', async () => {
    const t = await setup();
    const x = await t.login('kakao', 'k-x2');
    const y = await t.login('google', 'g-y2');
    t.verified.add(y.accountId);
    const r = await t.add.add({ accountId: x.accountId, sessionId: x.sessionId, reauthToken: await t.token(x), provider: 'google', providerUserId: 'g-y2' });
    await t.confirm.run({ accountId: x.accountId, sessionId: x.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(x) });
    expect(t.sessions.accountOf(x.accountId)).toMatchObject({ status: 'MERGED', mergedInto: y.accountId });
    expect(t.sessions.activeCount(x.accountId)).toBe(0);
    expect((await t.login('kakao', 'k-x2')).accountId).toBe(y.accountId);
  });
});

describe('이의 제기 계류 account_hold(SetAccountHold)', () => {
  test('판번호가클때만반영하고_같은건에다른계정·종류면CONFLICT_닫힌행은30일뒤지운다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-h');
    const ref = '0190f3a1-7c2e-7a00-8000-0000000000b1';
    expect(await t.holds.run({ sourceRef: ref, accountId: a.accountId, kind: 'DISPUTE', state: 'OPEN', sourceVersion: 2 })).toBe('APPLIED');
    expect(await t.holds.run({ sourceRef: ref, accountId: a.accountId, kind: 'DISPUTE', state: 'CLOSED', sourceVersion: 1 })).toBe('STALE');
    expect(await t.holds.run({ sourceRef: ref, accountId: a.accountId, kind: 'APPEAL', state: 'CLOSED', sourceVersion: 3 })).toBe('CONFLICT');
    expect(await t.holds.run({ sourceRef: ref, accountId: a.accountId, kind: 'DISPUTE', state: 'CLOSED', sourceVersion: 3 })).toBe('APPLIED');
    expect(await t.sessions.transaction((tx) => tx.openHoldsOf(a.accountId))).toBe(0);
    t.clock.advance(30 * 86_400_000 + 1);
    expect(await t.sessions.transaction((tx) => tx.purgeClosedHolds(t.clock.now() - 30 * 86_400_000))).toBe(1);
  });
});

describe('AccountHoldService 받는 층', () => {
  test('SetAccountHold는_열거를옮겨반영여부를주고_같은건에다른계정·종류면ALREADY_EXISTS_모양이틀리면INVALID_ARGUMENT다', async () => {
    const { accountHoldHandlers } = await import('../src/modules/session/inbound/session.grpc.js');
    const t = await setup();
    const a = await t.login('kakao', 'k-g');
    const h = accountHoldHandlers({ hold: t.holds }, () => {}) as Record<string, (call: { request: Record<string, unknown> }, cb: (e: unknown, v?: unknown) => void) => void>;
    const call = (request: Record<string, unknown>) => new Promise<{ e: unknown; v: unknown }>((res) => h.SetAccountHold!({ request }, (e, v) => res({ e, v })));
    const base = { account_id: a.accountId, kind: 'ACCOUNT_HOLD_KIND_DISPUTE', source_ref: '0190f3a1-7c2e-7a00-8000-0000000000d1', state: 'ACCOUNT_HOLD_STATE_OPEN', source_version: 1 };
    expect((await call(base)).v).toEqual({ changed: true });
    expect((await call(base)).v).toEqual({ changed: false });
    expect(((await call({ ...base, kind: 'ACCOUNT_HOLD_KIND_APPEAL', source_version: 2 })).e as { code: number }).code).toBe(6);
    expect(((await call({ ...base, source_ref: 'nope', source_version: 3 })).e as { code: number }).code).toBe(3);
  });
});

/** 처음 한 번의 그 (제공자, sub) 조회만 옛 계정을 돌려준다(로그인이 잠그기 전에 읽은 값을 흉내, 새 맥락 리뷰 중간 4) */
function staleOnce(store: MemorySessionStore, provider: string, sub: string, row: AccountRow): void {
  const orig = store.transaction.bind(store);
  let used = false;
  store.transaction = ((fn: Parameters<MemorySessionStore['transaction']>[0]) =>
    orig((tx) =>
      fn(
        new Proxy(tx, {
          get(target, k, recv) {
            if (k !== 'findAccountByProvider') return Reflect.get(target, k, recv);
            return async (p: Parameters<typeof tx.findAccountByProvider>[0], s: string) => {
              if (!used && p === provider && s === sub) {
                used = true;
                return row;
              }
              return target.findAccountByProvider(p, s);
            };
          },
        }),
      ),
    )) as MemorySessionStore['transaction'];
}

describe('새 맥락 리뷰 고침(BOT-042)', () => {
  test('높음1_제안뒤흡수계정만본인확인을마쳤으면대표가바뀌므로_확정은NOT_FOUND이고병합하지않으며제안을지운다', async () => {
    const t = await setup();
    const { a, b, r } = await t.propose();
    t.verified.add(b.accountId);
    expect(await err(t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) }))).toBe('NOT_FOUND');
    expect(t.sessions.accountOf(b.accountId)?.status).toBe('ACTIVE');
    expect(await t.proposals.get(r.mergeProposalId!)).toBeNull();
  });

  test('낮음12_확정전에추가하려던로그인수단이흡수계정에서떨어졌으면NOT_FOUND이고병합하지않는다', async () => {
    const t = await setup();
    const { a, b, r } = await t.propose();
    await t.sessions.transaction(async (tx) => {
      await tx.linkProvider(b.accountId, 'naver', 'n-b12', t.clock.now());
      await tx.unlinkProvider(b.accountId, 'google');
    });
    expect(await err(t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) }))).toBe('NOT_FOUND');
    expect(t.sessions.accountOf(b.accountId)?.status).toBe('ACTIVE');
    expect(await t.proposals.get(r.mergeProposalId!)).toBeNull();
  });

  test('중간3_지금계정에같은종류가있으면다른계정의것이라도PROVIDER_TYPE_TAKEN이고병합제안을만들지않는다', async () => {
    const t = await setup();
    const a = await t.login('kakao', 'k-a3');
    await t.login('kakao', 'k-b3');
    expect(await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'kakao', providerUserId: 'k-b3' })).toEqual({ result: 'PROVIDER_TYPE_TAKEN' });
  });

  test('낮음10_병합제안을만들다뜻밖의오류가나도_로그인수단추가는OTHER_ACCOUNT만돌려준다', async () => {
    const t = await setup();
    t.results.core = 'boom';
    const { r } = await t.propose();
    expect(r).toEqual({ result: 'OTHER_ACCOUNT' });
  });

  test('중간4_로그인이잠그기전에읽은계정이병합으로옮겨졌으면_옮겨간계정이탈퇴정리중이어도그계정으로간다(새계정을만들거나수단을빼앗지않는다)', async () => {
    const t = await setup();
    const { a, b, gsub, r } = await t.propose();
    await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
    t.sessions.setStatus(a.accountId, 'WITHDRAWAL_PENDING');
    staleOnce(t.sessions, 'google', gsub, { id: b.accountId, status: 'ACTIVE' });
    const s = await t.login('google', gsub);
    expect(s.accountId).toBe(a.accountId);
    expect(s.newAccount).toBe(false);
    expect(await t.sessions.transaction((tx) => tx.findAccountByProvider('google', gsub))).toMatchObject({ id: a.accountId });
    expect(t.sessions.activeCount(b.accountId)).toBe(0);
  });

  test('중간4_로그인이잠그기전에읽은계정이병합으로옮겨졌으면그대표계정으로_해제로사라졌으면새계정으로간다', async () => {
    const t = await setup();
    const { a, b, gsub, r } = await t.propose();
    await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
    staleOnce(t.sessions, 'google', gsub, { id: b.accountId, status: 'ACTIVE' });
    expect((await t.login('google', gsub)).accountId).toBe(a.accountId);
    const x = await t.login('kakao', 'k-gone');
    await t.sessions.transaction(async (tx) => {
      await tx.linkProvider(x.accountId, 'naver', 'n-gone', t.clock.now());
      await tx.unlinkProvider(x.accountId, 'kakao');
    });
    staleOnce(t.sessions, 'kakao', 'k-gone', { id: x.accountId, status: 'ACTIVE' });
    const y = await t.login('kakao', 'k-gone');
    expect(y.accountId).not.toBe(x.accountId);
    expect(y.newAccount).toBe(true);
  });

  test('중간6_대표계정이탈퇴해계정을지우면그계정의병합이력도지운다', async () => {
    const t = await setup();
    const { a, r } = await t.propose();
    await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
    expect(t.sessions.mergesOf(a.accountId)).toHaveLength(1);
    await t.sessions.transaction((tx) => tx.eraseAccount(a.accountId, t.clock.now()));
    expect(t.sessions.mergesOf(a.accountId)).toEqual([]);
  });

  test('다시검토낮음1_사슬앞단의병합이력도_사슬끝대표계정이탈퇴하면함께지운다', async () => {
    const t = await setup();
    // A가 B를 흡수한 뒤 C가 A를 흡수한다(사슬 B → A → C를 한 단계로 고친다)
    const a = await t.login('kakao', 'k-ch-a');
    await t.login('google', 'g-ch-b');
    const r = await t.add.add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.token(a), provider: 'google', providerUserId: 'g-ch-b' });
    await t.confirm.run({ accountId: a.accountId, sessionId: a.sessionId, proposalId: r.mergeProposalId!, reauthToken: await t.token(a) });
    const c = await t.login('naver', 'n-ch-c');
    const r2 = await t.add.add({ accountId: c.accountId, sessionId: c.sessionId, reauthToken: await t.token(c), provider: 'kakao', providerUserId: 'k-ch-a' });
    await t.confirm.run({ accountId: c.accountId, sessionId: c.sessionId, proposalId: r2.mergeProposalId!, reauthToken: await t.token(c) });
    expect(t.sessions.mergesOf(a.accountId)).toHaveLength(1);
    expect(t.sessions.mergesOf(c.accountId)).toHaveLength(1);
    await t.sessions.transaction((tx) => tx.eraseAccount(c.accountId, t.clock.now()));
    expect(t.sessions.mergesOf(a.accountId)).toEqual([]);
    expect(t.sessions.mergesOf(c.accountId)).toEqual([]);
  });

  test('다시검토낮음3_로그인중에로그인수단이세번넘게옮겨지면UNAVAILABLE이고세션을만들지않는다', async () => {
    const t = await setup();
    const x = await t.login('kakao', 'k-hop');
    const orig = t.sessions.transaction.bind(t.sessions);
    let n = 0;
    t.sessions.transaction = ((fn: Parameters<MemorySessionStore['transaction']>[0]) =>
      orig((tx) =>
        fn(
          new Proxy(tx, {
            get(target, k, recv) {
              if (k !== 'findAccountByProvider') return Reflect.get(target, k, recv);
              // 찾을 때마다 다른 계정(병합이 계속 겹치는 경우를 흉내)
              return async () => ({ id: `0190f3a1-7c2e-7a00-8000-${String(++n).padStart(12, '0')}`, status: 'ACTIVE' as const });
            },
          }),
        ),
      )) as MemorySessionStore['transaction'];
    const e = await t.login('kakao', 'k-hop').catch((err: unknown) => err);
    expect((e as { code?: string }).code).toBe('UNAVAILABLE');
    expect(t.sessions.activeCount(x.accountId)).toBe(1);
  });
});

describe('세 서비스 CheckAccountMerge 클라이언트(gRPC)', () => {
  test('새맥락리뷰중간5_플랫폼클라이언트로부르고_사유·개수를옮기며_답이없으면MergeCheckUnavailable이다', async () => {
    const protoLoader = await import('@grpc/proto-loader');
    const { purchaseV1Account } = await import('@peaket/contracts/proto');
    const { startGrpcServer } = await import('../src/grpc-server.js');
    const { GrpcMergeChecker } = await import('../src/modules/session/adapters/grpc-merge-checkers.js');
    const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: { AccountMergeCheckService: grpc.ServiceClientConstructor } } } };
    const seen: unknown[] = [];
    const server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [
        {
          definition: pkg.peaket.purchase.v1.AccountMergeCheckService.service,
          handlers: {
            CheckAccountMerge: (call: { request: unknown }, cb: (e: null, v: object) => void) => {
              seen.push(call.request);
              cb(null, { blocks: [{ reason: 'MERGE_BLOCK_REASON_SEAT_HOLD', account_id: 'b', ref_id: 'e' }], absorbed_orders: 3 });
            },
          },
        },
      ],
    });
    const c = new GrpcMergeChecker('purchase', `127.0.0.1:${server.port}`);
    try {
      expect(await c.check({ primaryAccountId: 'p', absorbedAccountId: 'b' })).toEqual({ blocks: [{ service: 'purchase', reason: 'SEAT_HOLD' }], counts: { orders: 3 } });
      expect(seen).toEqual([{ primary_account_id: 'p', absorbed_account_id: 'b' }]);
    } finally {
      c.close();
      await server.close();
    }
    const dead = new GrpcMergeChecker('purchase', `127.0.0.1:${server.port}`);
    try {
      await expect(dead.check({ primaryAccountId: 'p', absorbedAccountId: 'b' })).rejects.toBeInstanceOf(MergeCheckUnavailable);
    } finally {
      dead.close();
    }
    expect(() => new GrpcMergeChecker('purchase', 'no-port')).toThrow();
  });
});
