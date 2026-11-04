// 로그인 수단 연결·해제 흐름(flow.ts) 시험(docs/features/identity.md §2.1 '설정의 로그인 수단 연결·해제의 첫 구현', BUILD_ORDER BOT-041, I-T33·I-T34). 가짜 fetch·저장소로 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addResultText,
  confirmMergeText,
  createLoginMethodsApi,
  dayText,
  isMergeProposalId,
  linkForm,
  markPending,
  mergeAfterConfirm,
  mergeAfterGet,
  mergeToOpen,
  mergeView,
  PENDING_KEY,
  PENDING_TTL_MS,
  reauthForm,
  takePending,
  unlinkResultText,
} from './flow.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: init.headers ?? {} });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}
const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};

test('I-T33_목록은연결한순서와마지막로그인을주고_401이면갱신뒤한번더_갱신도안되면login이다', async () => {
  const ok = fakeFetch(() => json(200, { providers: [{ provider: 'kakao', linkedAt: '2026-09-01T00:00:00.000Z', lastLoginAt: '2026-11-04T00:00:00.000Z' }, { provider: 'google', linkedAt: '2026-10-02T00:00:00.000Z', lastLoginAt: null }, { provider: 'apple', linkedAt: 'x' }] }));
  assert.deepEqual(await createLoginMethodsApi({ origin: 'https://api.test', fetch: ok }).list(), {
    kind: 'ok',
    methods: [
      { provider: 'kakao', linkedAt: '2026-09-01T00:00:00.000Z', lastLoginAt: '2026-11-04T00:00:00.000Z' },
      { provider: 'google', linkedAt: '2026-10-02T00:00:00.000Z', lastLoginAt: null },
    ],
  });
  assert.deepEqual(await createLoginMethodsApi({ origin: '', fetch: fakeFetch(() => json(401)) }).list(), { kind: 'login' });
});

test('I-T33_해제는DELETE와X-Reauth-Token머리이고_204완료_409last-login-method마지막_404없음_403재인증이다', async () => {
  const done = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await createLoginMethodsApi({ origin: 'https://api.test', fetch: done }).unlink('google', 'tok'), { kind: 'done' });
  assert.equal(done.calls[0].url, 'https://api.test/v1/identity/providers/google');
  assert.equal(done.calls[0].method, 'DELETE');
  assert.equal(done.calls[0].headers['x-reauth-token'], 'tok');
  const ans = async (r) => createLoginMethodsApi({ origin: '', fetch: fakeFetch(() => r) }).unlink('kakao', 't');
  assert.deepEqual(await ans(json(409, { type: 'https://peaket.example/problems/last-login-method' })), { kind: 'last' });
  assert.deepEqual(await ans(json(404, { type: 'not-found' })), { kind: 'missing' });
  assert.deepEqual(await ans(json(403, { type: 'reauth-required' })), { kind: 'reauth' });
  assert.deepEqual(await ans(json(409, { type: 'other' })), { kind: 'error' });
  assert.equal(unlinkResultText({ kind: 'last' }).text, '마지막 로그인 수단은 해제할 수 없습니다');
});

test('재인증뒤할일은10분안이고한번만믿으며_모양이틀리면버린다_재인증·추가양식은돌아올곳과토큰을싣는다', () => {
  const s = memoryStore();
  markPending(s, { action: 'add', provider: 'google', at: 1_000 });
  assert.deepEqual(takePending(s, 1_000 + PENDING_TTL_MS), { action: 'add', provider: 'google', at: 1_000 });
  assert.equal(takePending(s, 2_000), null);
  markPending(s, { action: 'unlink', provider: 'naver', at: 1_000 });
  assert.equal(takePending(s, 1_001 + PENDING_TTL_MS), null);
  s.set(PENDING_KEY, '{"action":"drop","provider":"kakao","at":1}');
  assert.equal(takePending(s, 5), null);
  assert.deepEqual(reauthForm('kakao'), { action: '/reauth/kakao', fields: { returnTo: '/my/settings/providers', purpose: '' } });
  assert.deepEqual(linkForm('google', 'tok'), { action: '/link/google', fields: { reauthToken: 'tok', returnTo: '/my/settings/providers' } });
});

test('I-T34_추가결과값마다안내문구가있고_모르는값은null이며_날짜는KST로보인다', () => {
  for (const v of ['linked', 'already-linked', 'type-taken', 'other-account', 'reauth-required', 'failed']) assert.ok(addResultText(v), v);
  assert.equal(addResultText('linked').tone, 'success');
  assert.equal(addResultText('nope'), null);
  assert.equal(addResultText(null), null);
  assert.equal(dayText('2026-08-31T16:00:00.000Z'), '2026.09.01');
  assert.equal(dayText(null), null);
});

// ── 계정 합치기(SCR-040 ④~⑥, docs/features/identity.md §2.1 '계정 병합의 첫 구현' 화면, BUILD_ORDER BOT-043, I-T31·I-T32) ──
const PID = 'A'.repeat(22);
const proposalBody = (o = {}) => ({
  proposalId: PID,
  primaryAccountId: 'p',
  mergedAccountId: 'm',
  status: 'PROPOSED',
  moved: { tickets: 0, orders: 3, wishes: 5, reviews: 0, subscriptions: 2, addresses: 1, providers: 1 },
  blockers: [],
  expiresAt: '2026-11-04T03:10:00.000Z',
  newProvider: 'google',
  requesterRole: 'PRIMARY',
  primaryVerified: true,
  ...o,
});

test('I-T31_병합제안조회는GET이고_200이면값을옮기며_404는만료_401은갱신뒤login_모양이틀리면error다', async () => {
  const ok = fakeFetch(() => json(200, proposalBody()));
  const r = await createLoginMethodsApi({ origin: 'https://api.test', fetch: ok }).getMerge(PID);
  assert.equal(ok.calls[0].url, `https://api.test/v1/identity/merge-proposals/${PID}`);
  assert.equal(ok.calls[0].method, 'GET');
  assert.deepEqual(r, {
    kind: 'ok',
    proposal: {
      id: PID,
      status: 'PROPOSED',
      blockers: [],
      moved: { providers: 1, wishes: 5, subscriptions: 2, addresses: 1, orders: 3 },
      expiresAt: Date.parse('2026-11-04T03:10:00.000Z'),
      newProvider: 'google',
      requesterRole: 'PRIMARY',
      primaryVerified: true,
    },
  });
  const ans = async (res) => createLoginMethodsApi({ origin: '', fetch: fakeFetch(() => res) }).getMerge(PID);
  assert.deepEqual(await ans(json(404, { type: 'not-found' })), { kind: 'expired' });
  assert.deepEqual(await ans(json(401)), { kind: 'login' });
  assert.deepEqual(await ans(json(200, proposalBody({ status: 'MERGED' }))), { kind: 'error' });
  assert.deepEqual(await ans(json(200, proposalBody({ blockers: ['NOPE'] }))), { kind: 'error' });
  assert.deepEqual(await ans(json(503)), { kind: 'error' });
  // 모양이 틀린 제안 ID는 부르지 않는다
  const none = fakeFetch(() => json(200, proposalBody()));
  assert.deepEqual(await createLoginMethodsApi({ origin: '', fetch: none }).getMerge('../x'), { kind: 'expired' });
  assert.equal(none.calls.length, 0);
});

test('I-T32_병합확정은POST와X-Reauth-Token이고_202accepted_409merge-blocked는사유_merge-invariant-violated_404만료_403재인증_503잠시뒤다', async () => {
  const ok = fakeFetch(() => new Response(null, { status: 202 }));
  assert.deepEqual(await createLoginMethodsApi({ origin: 'https://api.test', fetch: ok }).confirmMerge(PID, 'tok'), { kind: 'accepted' });
  assert.equal(ok.calls[0].url, `https://api.test/v1/identity/merge-proposals/${PID}/confirmation`);
  assert.equal(ok.calls[0].method, 'POST');
  assert.equal(ok.calls[0].headers['x-reauth-token'], 'tok');
  const ans = async (res) => createLoginMethodsApi({ origin: '', fetch: fakeFetch(() => res) }).confirmMerge(PID, 't');
  assert.deepEqual(await ans(json(409, { type: 'https://peaket.example/problems/merge-blocked', blockers: ['PENDING_PAYMENT', 'NOPE'] })), { kind: 'blocked', blockers: ['PENDING_PAYMENT'] });
  assert.deepEqual(await ans(json(409, { type: 'https://peaket.example/problems/merge-invariant-violated' })), { kind: 'invariant' });
  assert.deepEqual(await ans(json(404)), { kind: 'expired' });
  assert.deepEqual(await ans(json(403)), { kind: 'reauth' });
  assert.deepEqual(await ans(json(503)), { kind: 'unavailable' });
  assert.deepEqual(await ans(json(401)), { kind: 'login' });
  assert.deepEqual(await ans(json(500)), { kind: 'error' });
  for (const k of ['accepted', 'blocked', 'invariant', 'expired', 'reauth', 'unavailable', 'error']) assert.ok(confirmMergeText({ kind: k }).text, k);
  assert.match(confirmMergeText({ kind: 'reauth' }).text, /5분/);
  assert.match(confirmMergeText({ kind: 'unavailable' }).text, /잠시 뒤 다시/);
  assert.match(confirmMergeText({ kind: 'invariant' }).text, /고객센터/);
});

test('합치기로재인증을떠날때의할일은제안ID를싣고_돌아오면한번만믿으며_제안ID모양이틀리면버린다', () => {
  const s = memoryStore();
  markPending(s, { action: 'merge', provider: 'kakao', proposalId: PID, at: 1_000 });
  assert.deepEqual(takePending(s, 2_000), { action: 'merge', provider: 'kakao', proposalId: PID, at: 1_000 });
  assert.equal(takePending(s, 2_000), null);
  markPending(s, { action: 'merge', provider: 'kakao', proposalId: 'short', at: 1_000 });
  assert.equal(takePending(s, 2_000), null);
  assert.equal(isMergeProposalId(PID), true);
  assert.equal(isMergeProposalId('A'.repeat(21)), false);
  assert.equal(isMergeProposalId(undefined), false);
});

const TITLES = { ACTIVE_PURCHASE: '진행', QUOTA_EXCEEDED: '한도', BOTH_VERIFIED: '둘다', WITHDRAWAL_OR_APPEAL: '탈퇴', ENTRY_STARTED: '입장' };
const view = (o) => ({ id: PID, status: 'PROPOSED', blockers: [], moved: { providers: 1, wishes: 5, subscriptions: 2, addresses: 1, orders: 3 }, expiresAt: 600_000, newProvider: 'google', requesterRole: 'PRIMARY', primaryVerified: true, ...o });

test('I-T31_합치기요약은남는계정·옮겨오는것과개수·주문안내·남은초를싣고_지금계정이흡수되는쪽이면남는계정은새제공자쪽이다', () => {
  const v = mergeView(view(), 0, TITLES);
  assert.match(v.question, /구글 계정은 이미 다른 PEAKET 계정입니다.*되돌릴 수 없습니다/);
  assert.equal(v.survivor, '지금 계정 · 본인확인 완료');
  assert.equal(v.absorbed, '구글로 로그인하는 계정');
  assert.deepEqual(v.moves, [
    { label: '로그인 수단', value: '1개' },
    { label: '찜', value: '5개' },
    { label: '알림 신청', value: '2개' },
    { label: '배송지', value: '1곳' },
  ]);
  assert.match(v.movesNote, /주문 3건/);
  assert.equal(v.remaining, 600);
  assert.equal(mergeView(view({ moved: { providers: 2, wishes: 0, subscriptions: 0, addresses: 0, orders: 0 } }), 0, TITLES).movesNote, undefined);
  assert.equal(mergeView(view(), 599_001, TITLES).remaining, 1);
  const m = mergeView(view({ requesterRole: 'MERGED', primaryVerified: true }), 0, TITLES);
  assert.equal(m.survivor, '구글로 로그인하는 계정 · 본인확인 완료');
  assert.equal(m.absorbed, '지금 계정');
  assert.equal(mergeView(view({ primaryVerified: false }), 0, TITLES).survivor, '지금 계정');
});

test('I-T31_막는사유는다섯범주로모아줄마다해당없음이나사유를보이고_첫사유를알림으로_불변식위반은고객센터안내만이다', () => {
  const v = mergeView(view({ status: 'BLOCKED', blockers: ['PENDING_PAYMENT', 'APPEAL_PENDING'] }), 0, TITLES);
  assert.deepEqual(
    v.checks.map((c) => [c.title, c.blocked]),
    [
      ['진행', true],
      ['한도', false],
      ['둘다', false],
      ['탈퇴', true],
      ['입장', false],
    ],
  );
  assert.equal(v.checks[1].detail, '해당 없음');
  assert.match(v.checks[0].detail, /결제/);
  assert.match(v.checks[3].detail, /이의 제기/);
  assert.match(v.blockedReason, /결제/);
  const inv = mergeView(view({ status: 'BLOCKED', blockers: [] }), 0, TITLES);
  assert.deepEqual(inv.checks, []);
  assert.match(inv.blockedReason, /고객센터/);
});

test('I-T34_다른계정의로그인수단인데병합제안이없으면_잠시뒤다시추가하라고안내한다', () => {
  assert.match(addResultText('other-account').text, /다른 PEAKET 계정/);
  assert.match(addResultText('other-account', { merge: false }).text, /잠시 뒤 다시/);
  assert.equal(addResultText('other-account', { merge: true }), null);
});

// ── 합치기 카드의 상태 바뀜(LiveLoginMethods가 그대로 쓴다, 새 맥락 리뷰 중간 3) ──
const TOKEN = { token: 'tok', via: 'kakao' };
const ready = (o = {}) => ({ id: PID, view: view(), phase: 'ready', token: TOKEN, ...o });

test('I-T31_제안을읽은뒤_PROPOSED는ready이고재인증토큰이있으면확인창을열며_BLOCKED는토큰을버리고_404만료_오류는안내와함께카드를치운다', () => {
  assert.deepEqual(mergeAfterGet(PID, { kind: 'ok', proposal: view() }, TOKEN), { merge: { id: PID, view: view(), phase: 'ready', token: TOKEN } });
  assert.deepEqual(mergeAfterGet(PID, { kind: 'ok', proposal: view() }), { merge: { id: PID, view: view(), phase: 'ready' } });
  // 돌아왔는데 그사이 막혔으면 확인 창을 열지 않는다
  assert.deepEqual(mergeAfterGet(PID, { kind: 'ok', proposal: view({ status: 'BLOCKED', blockers: ['QUOTA_EXCEEDED'] }) }, TOKEN), {
    merge: { id: PID, view: view({ status: 'BLOCKED', blockers: ['QUOTA_EXCEEDED'] }), phase: 'blocked' },
  });
  assert.deepEqual(mergeAfterGet(PID, { kind: 'expired' }, TOKEN), { merge: { id: PID, view: null, phase: 'expired' } });
  assert.deepEqual(mergeAfterGet(PID, { kind: 'login' }), { login: true });
  const e = mergeAfterGet(PID, { kind: 'error' }, TOKEN);
  assert.equal(e.merge.phase, 'dismissed');
  assert.equal(e.merge.token, undefined);
  assert.match(e.notice.text, /불러오지 못했습니다/);
});

test('I-T32_확정결과마다_남는쪽은처리중과목록다시읽기_흡수되는쪽은세션이끝나흡수안내로_막힘은사유_만료_재인증만료는토큰버림_503은토큰을두고확인창에안내다', () => {
  assert.deepEqual(mergeAfterConfirm(ready(), { kind: 'accepted' }), { merge: { id: PID, view: view(), phase: 'merging' }, reload: true });
  // 지금 계정이 흡수되는 쪽: 세션이 끝났으므로 새 문서로 흡수 안내(로그인 전 셸)
  assert.deepEqual(mergeAfterConfirm(ready({ view: view({ requesterRole: 'MERGED' }) }), { kind: 'accepted' }), { go: '/my/settings/providers?ended=MERGED' });
  assert.deepEqual(mergeAfterConfirm(ready(), { kind: 'blocked', blockers: ['PENDING_PAYMENT'] }), { merge: { id: PID, view: view({ status: 'BLOCKED', blockers: ['PENDING_PAYMENT'] }), phase: 'blocked' } });
  assert.deepEqual(mergeAfterConfirm(ready(), { kind: 'invariant' }), { merge: { id: PID, view: view({ status: 'BLOCKED', blockers: [] }), phase: 'blocked' } });
  assert.deepEqual(mergeAfterConfirm(ready(), { kind: 'expired' }), { merge: { id: PID, view: view(), phase: 'expired' } });
  const re = mergeAfterConfirm(ready(), { kind: 'reauth' });
  assert.deepEqual(re.merge, { id: PID, view: view(), phase: 'ready' });
  assert.match(re.notice.text, /5분/);
  // 503: 서버는 토큰을 쓰지 않았다. 토큰과 확인 창을 두고 창 안에 '잠시 뒤 다시'를 보인다(새 맥락 리뷰 낮음 6)
  const un = mergeAfterConfirm(ready(), { kind: 'unavailable' });
  assert.deepEqual(un.merge, { id: PID, view: view(), phase: 'ready', token: TOKEN, error: confirmMergeText({ kind: 'unavailable' }).text });
  assert.equal(un.notice, undefined);
  assert.deepEqual(mergeAfterConfirm(ready(), { kind: 'login' }), { login: true });
  const er = mergeAfterConfirm(ready(), { kind: 'error' });
  assert.equal(er.merge.token, undefined);
  assert.ok(er.notice.text);
  // 다시 확정하면 창 안의 안내는 지운다
  assert.equal(mergeAfterConfirm(ready({ error: 'x' }), { kind: 'accepted' }).merge.error, undefined);
});

test('시작할때열제안은_합치기할일이면그제안과받은토큰_그밖의할일이나할일이없으면주소의제안이고_토큰받기가실패하면토큰없이연다', () => {
  const merge = { action: 'merge', provider: 'naver', proposalId: PID, at: 1 };
  assert.deepEqual(mergeToOpen(merge, undefined, { kind: 'token', token: 't' }), { id: PID, token: { token: 't', via: 'naver' } });
  assert.deepEqual(mergeToOpen(merge, undefined, { kind: 'failed' }), { id: PID });
  // 해제·추가 할 일과 주소의 제안이 겹치면 주소의 제안을 연다(로딩에 멈추지 않게, 새 맥락 리뷰 중간 1)
  const URL_ID = 'B'.repeat(22);
  assert.deepEqual(mergeToOpen({ action: 'unlink', provider: 'kakao', at: 1 }, URL_ID, { kind: 'failed' }), { id: URL_ID });
  assert.deepEqual(mergeToOpen(null, URL_ID, null), { id: URL_ID });
  assert.equal(mergeToOpen(null, undefined, null), null);
  assert.equal(mergeToOpen({ action: 'unlink', provider: 'kakao', at: 1 }, undefined, { kind: 'token', token: 't' }), null);
});
