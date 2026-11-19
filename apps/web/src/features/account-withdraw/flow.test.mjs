// 탈퇴 흐름(flow.ts) 시험(docs/features/identity.md §8 '탈퇴 화면 연결' '미사용 티켓 확인과 취소', BUILD_ORDER BOT-036·PRF-174,
// I-T16·I-T68 ⑨·I-T26 ②). 가짜 fetch·저장소로 본다. 값은 정본(openapi unusedTickets, POL-032 예)에서 적는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { afterWithdraw, createWithdrawApi, leaveForReauth, linkedProvidersQuietly, markPending, PENDING_KEY, PENDING_TTL_MS, reauthFailureText, reauthForm, takePending, takePendingAt, untilText } from './flow.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, type, extra = {}) => json(status, { type: `https://peaket.example/problems/${type}`, status, ...extra });

function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, credentials: init.credentials });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}

const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};

test('I-T16_로그인수단목록은연결한순서의제공자이고_401이면갱신뒤한번더_갱신도안되면login이다', async () => {
  const ok = fakeFetch((u) => (u.endsWith('/v1/identity/providers') ? json(200, { providers: [{ provider: 'naver', linkedAt: 'x', lastLoginAt: null }, { provider: 'kakao' }] }) : json(500)));
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: ok }).providers(), { kind: 'ok', providers: ['naver', 'kakao'] });
  assert.equal(ok.calls[0].url, 'https://api.test/v1/identity/providers');
  assert.equal(ok.calls[0].credentials, 'include');
  let n = 0;
  const expired = fakeFetch((u) => (u.endsWith('/access-tokens') ? json(401) : (n++, json(401))));
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: expired }).providers(), { kind: 'login' });
  assert.equal(n, 1);
  const empty = fakeFetch(() => json(200, { providers: [{ provider: 'apple' }] }));
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: empty }).providers(), { kind: 'error' });
});

test('I-T16_재인증결과는같은출처POST /reauth/token으로한번받고_실패종류를가른다', async () => {
  const ok = fakeFetch(() => json(200, { reauthToken: 'tok-1', provider: 'kakao', strength: 'verified' }));
  // 재인증 결과의 제공자를 그대로 쓴다(돌아왔을 때 로그인 수단 목록을 다시 부르지 않게, 다시 보기 낮음 4)
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: ok }).pickupReauth(), { kind: 'token', token: 'tok-1', provider: 'kakao' });
  assert.equal(ok.calls[0].url, '/reauth/token');
  assert.equal(ok.calls[0].method, 'POST');
  assert.equal(ok.calls[0].credentials, 'same-origin');
  for (const [type, reason] of [['reauth-stale', 'stale'], ['reauth-account-mismatch', 'account-mismatch'], ['reauth-reverify-required', 'reverify-required'], ['reauth-failed', 'failed'], ['reauth-result-missing', 'missing'], ['other', 'failed']]) {
    const f = fakeFetch(() => problem(type === 'reauth-result-missing' ? 404 : 409, type));
    assert.deepEqual(await createWithdrawApi({ origin: '', fetch: f }).pickupReauth(), { kind: 'failed', reason });
  }
});

test('I-T16_탈퇴는DELETE와X-Reauth-Token머리로보내고_204완료_202미룸_403재인증_그밖오류다', async () => {
  const done = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await createWithdrawApi({ origin: 'https://api.test', fetch: done }).withdraw('tok-1', false), { kind: 'done' });
  const c = done.calls[0];
  assert.equal(c.url, 'https://api.test/v1/identity/account');
  assert.equal(c.method, 'DELETE');
  assert.equal(c.headers['x-reauth-token'], 'tok-1');
  assert.equal(c.body, '{}');
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => new Response(null, { status: 202 })) }).withdraw('t', false), { kind: 'deferred' });
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(403, 'reauth-required')) }).withdraw('t', false), { kind: 'reauth' });
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(500, 'internal')) }).withdraw('t', false), { kind: 'error' });
});

test('I-T68⑨_409withdrawal-confirmation-required면fraudHold를돌려주고_확인한뒤다시보내면acknowledgeFraudHold를싣는다', async () => {
  const until = '2027-01-03T15:00:00.000Z';
  const f = fakeFetch((_u, _i, n) => (n === 1 ? problem(409, 'withdrawal-confirmation-required', { fraudHold: { state: 'RESTRICTED', until } }) : new Response(null, { status: 204 })));
  const api = createWithdrawApi({ origin: '', fetch: f });
  assert.deepEqual(await api.withdraw('tok', false), { kind: 'fraudHold', state: 'RESTRICTED', until });
  assert.deepEqual(await api.withdraw('tok', true), { kind: 'done' });
  assert.equal(f.calls[1].body, JSON.stringify({ acknowledgeFraudHold: true }));
  // 모양이 틀린 409는 오류다
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(409, 'withdrawal-confirmation-required', { fraudHold: { state: 'X' } })) }).withdraw('t', false), { kind: 'error' });
  assert.equal(untilText(until), '2027년 1월 4일');
});

test('탈퇴재인증표시는_10분안이고한번만믿으며_재인증양식은돌아올곳과빈목적을싣는다', () => {
  const s = memoryStore();
  assert.equal(takePending(s, 1_000), false);
  markPending(s, 1_000);
  assert.equal(s.m.get(PENDING_KEY), '1000');
  assert.equal(takePending(s, 1_000 + PENDING_TTL_MS), true);
  assert.equal(takePending(s, 1_000 + PENDING_TTL_MS), false);
  markPending(s, 1_000);
  assert.equal(takePending(s, 1_001 + PENDING_TTL_MS), false);
  s.set(PENDING_KEY, 'junk');
  assert.equal(takePending(s, 5), false);
  assert.deepEqual(reauthForm('naver', 'account-withdraw'), { action: '/reauth/naver', fields: { returnTo: '/my/settings', purpose: 'account-withdraw' } });
});

test('I-T16_재인증실패문구는이유마다다르고_갱신은재인증양식을보내기전에부를수있다', async () => {
  assert.equal(reauthFailureText('stale'), '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요');
  assert.match(reauthFailureText('account-mismatch'), /다른 계정으로 다시 로그인했습니다/);
  assert.match(reauthFailureText('expired'), /만료되었거나 이미 쓰였습니다/);
  assert.equal(reauthFailureText('failed'), reauthFailureText('missing'));
  const f = fakeFetch((u) => (u.endsWith('/v1/identity/access-tokens') ? new Response(null, { status: 204 }) : json(500)));
  assert.equal(await createWithdrawApi({ origin: 'https://api.test', fetch: f }).refresh(), 'ok');
  assert.equal(f.calls[0].url, 'https://api.test/v1/identity/access-tokens');
  assert.equal(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => json(401)) }).refresh(), 'rejected');
});

/** 재인증으로 떠나기(leaveForReauth)를 한 번 돌리고 남긴 것을 모은다 */
async function leave(refresh, { closeWhileRefreshing = false, provider = 'kakao', pick = async () => 'naver' } = {}) {
  const s = memoryStore();
  const submitted = [];
  let picked = 0;
  let refreshed = 0;
  let cancelled = false;
  const out = await leaveForReauth({
    // closeWhileRefreshing: 갱신을 기다리는 사이 사용자가 창을 닫는다
    api: { refresh: async () => (refreshed++, (cancelled = closeWhileRefreshing), refresh) },
    storage: s,
    now: () => 7,
    provider,
    pickProvider: async () => (picked++, pick()),
    submit: (p) => submitted.push(p),
    cancelled: () => cancelled,
  });
  return { out, pending: s.m.get(PENDING_KEY), submitted, picked, refreshed };
}

test('I-T16_떠나기전갱신은401일때만로그인이고_연결끊김·5xx는잠시뒤다시이며_갱신을기다리는사이창을닫으면떠나지않는다(BOT-036이넘긴것)', async () => {
  const refreshOf = async (res) => createWithdrawApi({ origin: '', fetch: fakeFetch(() => (res instanceof Error ? Promise.reject(res) : res)) }).refresh();
  assert.equal(await refreshOf(new Response(null, { status: 204 })), 'ok');
  assert.equal(await refreshOf(json(401)), 'rejected');
  assert.equal(await refreshOf(json(503)), 'unavailable');
  assert.equal(await refreshOf(json(500)), 'unavailable');
  assert.equal(await refreshOf(new TypeError('Failed to fetch')), 'unavailable');
  assert.deepEqual(await leave('ok'), { out: 'left', pending: '7', submitted: ['kakao'], picked: 0, refreshed: 1 });
  assert.deepEqual(await leave('rejected'), { out: 'login', pending: undefined, submitted: [], picked: 0, refreshed: 1 });
  assert.deepEqual(await leave('unavailable'), { out: 'retry', pending: undefined, submitted: [], picked: 0, refreshed: 1 });
  // 갱신이 끝났을 때 창이 닫혀 있으면 표시도 남기지 않고 떠나지 않는다
  assert.deepEqual(await leave('ok', { closeWhileRefreshing: true }), { out: 'cancelled', pending: undefined, submitted: [], picked: 0, refreshed: 1 });
  assert.match(reauthFailureText('unavailable'), /잠시 뒤 다시 시도해 주세요/);
});

test('I-T16_재인증할제공자를모르면로그인수단목록의첫제공자로채워실제재인증으로가고_목록을못읽으면갱신도하지않는다(BOT-036이넘긴것)', async () => {
  assert.deepEqual(await leave('ok', { provider: null }), { out: 'left', pending: '7', submitted: ['naver'], picked: 1, refreshed: 1 });
  assert.deepEqual(await leave('ok', { provider: null, pick: async () => null }), { out: 'no-provider', pending: undefined, submitted: [], picked: 1, refreshed: 0 });
});

test('I-T16_탈퇴403문구는만료와이미쓴토큰을함께덮어5분으로좁히지않고_본인확인재통과문구는정본과같다(BOT-036이넘긴것)', () => {
  assert.equal(reauthFailureText('expired'), '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다. 다시 로그인해 주세요');
  assert.doesNotMatch(reauthFailureText('expired'), /5분/);
  assert.equal(reauthFailureText('reverify-required'), '휴대폰 본인확인을 다시 한 뒤 계속할 수 있습니다');
});

test('I-T16_탈퇴요청·목록이401이고갱신이일시장애면로그인이아니라잠시뒤다시이고_갱신이401일때만로그인이다(새맥락리뷰)', async () => {
  // 탈퇴 요청 401 → 갱신 503: 로그인 화면으로 가지 않는다(재인증 토큰과 확인 창을 둔다, 화면은 '잠시 뒤 다시' 토스트)
  const seq = (...rs) => fakeFetch((_u, _i, n) => rs[n - 1]());
  const w503 = seq(() => json(401), () => json(503));
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: w503 }).withdraw('tok', false), { kind: 'error' });
  const wNet = seq(() => json(401), () => Promise.reject(new TypeError('Failed to fetch')));
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: wNet }).withdraw('tok', false), { kind: 'error' });
  const w401 = seq(() => json(401), () => json(401));
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: w401 }).withdraw('tok', false), { kind: 'login' });
  // 갱신이 되면 같은 토큰으로 한 번 더 보낸다
  const wOk = seq(() => json(401), () => new Response(null, { status: 204 }), () => new Response(null, { status: 204 }));
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: wOk }).withdraw('tok', false), { kind: 'done' });
  assert.equal(wOk.calls[2].headers['x-reauth-token'], 'tok');
  // 로그인 수단 목록도 같다
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: seq(() => json(401), () => json(503)) }).providers(), { kind: 'error' });
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: seq(() => json(401), () => json(401)) }).providers(), { kind: 'login' });
});

test('I-T16_토큰갱신은주입한잠금안에서돈다(잠금대역으로순서를본다)', async () => {
  const order = [];
  const lock = async (fn) => {
    order.push('lock');
    const out = await fn();
    order.push('unlock');
    return out;
  };
  const f = fakeFetch((u) => (order.push(`fetch ${new URL(u, 'https://x').pathname}`), new Response(null, { status: 204 })));
  assert.equal(await createWithdrawApi({ origin: 'https://api.test', fetch: f, lock }).refresh(), 'ok');
  assert.deepEqual(order, ['lock', 'fetch /v1/identity/access-tokens', 'unlock']);
});

test('I-T16_확인창이열린동안의제공자채우기는목록이실패해도(로그인필요포함)떠나지않고비운채로둔다(새맥락리뷰)', async () => {
  const api = (answer) => ({ providers: async () => answer });
  assert.deepEqual(await linkedProvidersQuietly(api({ kind: 'ok', providers: ['naver', 'kakao'] })), ['naver', 'kakao']);
  assert.equal(await linkedProvidersQuietly(api({ kind: 'login' })), null);
  assert.equal(await linkedProvidersQuietly(api({ kind: 'error' })), null);
  assert.equal(await linkedProvidersQuietly({ providers: async () => Promise.reject(new Error('x')) }), null);
});

test('I-T16_탈퇴요청이도는동안창을닫았으면늦게온응답가운데완료(204·202)만반영하고_보관안내·재인증·오류·로그인필요는버린다(새맥락마지막검토)', () => {
  const hold = { kind: 'fraudHold', state: 'RESTRICTED', until: '2027-01-03T15:00:00.000Z' };
  const tickets = { kind: 'unusedTickets', count: 2, ticketAmount: 165_833, deductionAmount: 19_916, refundAmount: 145_917, transferableCount: 1, deferredRefundCount: 1 };
  for (const [r, open, closed] of [
    [{ kind: 'done' }, 'done', 'done'],
    [{ kind: 'deferred' }, 'deferred', 'deferred'],
    [hold, 'hold', 'ignore'],
    [tickets, 'tickets', 'ignore'],
    [{ kind: 'reauth' }, 'reauth', 'ignore'],
    [{ kind: 'login' }, 'login', 'ignore'],
    [{ kind: 'error' }, 'error', 'ignore'],
  ]) {
    assert.equal(afterWithdraw(r, { closed: false }), open, r.kind);
    assert.equal(afterWithdraw(r, { closed: true }), closed, `${r.kind}(닫은 뒤)`);
  }
});

// ---- I-T26 ②: 409 unusedTickets를 읽고 두 번째 누름에만 확인 값을 싣는다(identity §8 '미사용 티켓 확인과 취소', BAT-013) ----
test('I-T26 ②_409unusedTickets면환급예상여섯칸을돌려주고_첫요청본문에는확인값이없으며_확인뒤같은토큰에confirmCancelUnusedTickets를싣는다', async () => {
  const quote = { count: 2, ticketAmount: 165_833, deductionAmount: 19_916, refundAmount: 145_917, transferableCount: 1, deferredRefundCount: 1 };
  const f = fakeFetch((_u, _i, n) => (n === 1 ? problem(409, 'withdrawal-confirmation-required', { unusedTickets: quote }) : new Response(null, { status: 204 })));
  const api = createWithdrawApi({ origin: 'https://api.test', fetch: f });
  assert.deepEqual(await api.withdraw('tok-1', false), { kind: 'unusedTickets', ...quote });
  // 첫 누름은 안내만 받는다: 확인 값을 싣지 않는다(안내 없이 취소하지 않는다)
  assert.equal(f.calls[0].body, '{}');
  assert.equal(f.calls[0].headers['x-reauth-token'], 'tok-1');
  // 두 번째 누름은 같은 토큰에 확인 값을 싣는다
  assert.deepEqual(await api.withdraw('tok-1', false, { confirmCancelUnusedTickets: true }), { kind: 'done' });
  assert.equal(f.calls[1].body, JSON.stringify({ confirmCancelUnusedTickets: true }));
  assert.equal(f.calls[1].headers['x-reauth-token'], 'tok-1');
  // 보관 안내를 지났으면 두 값을 함께 실어도 된다
  const both = fakeFetch(() => new Response(null, { status: 204 }));
  await createWithdrawApi({ origin: '', fetch: both }).withdraw('t', true, { confirmCancelUnusedTickets: true });
  assert.equal(both.calls[0].body, JSON.stringify({ acknowledgeFraudHold: true, confirmCancelUnusedTickets: true }));
  // 세 번째 인자를 주지 않는 옛 호출은 지금처럼 빈 본문이다
  const old = fakeFetch(() => new Response(null, { status: 204 }));
  await createWithdrawApi({ origin: '', fetch: old }).withdraw('t', false);
  assert.equal(old.calls[0].body, '{}');
});

test('I-T26 ②_409unusedTickets의모양이틀리면(0장·음수·빠진칸·정수아님)오류로보고_낮은금액을보이지않는다', async () => {
  const bad = [
    {},
    { count: 0, ticketAmount: 0, deductionAmount: 0, refundAmount: 0, transferableCount: 0, deferredRefundCount: 0 },
    { count: -1, ticketAmount: 1, deductionAmount: 0, refundAmount: 1, transferableCount: 0, deferredRefundCount: 0 },
    { count: 1, ticketAmount: 1, deductionAmount: 0, refundAmount: 1, transferableCount: 0 },
    { count: 1, ticketAmount: 1.5, deductionAmount: 0, refundAmount: 1.5, transferableCount: 0, deferredRefundCount: 0 },
    { count: 1, ticketAmount: '1', deductionAmount: 0, refundAmount: 1, transferableCount: 0, deferredRefundCount: 0 },
  ];
  for (const unusedTickets of bad) {
    const r = await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(409, 'withdrawal-confirmation-required', { unusedTickets })) }).withdraw('t', false);
    assert.deepEqual(r, { kind: 'error' }, JSON.stringify(unusedTickets));
  }
  // 보관 안내와 겹치면 보관 안내가 먼저다(서버가 둘 다 싣지 않아도 화면 규칙은 같다)
  const both = { fraudHold: { state: 'CASE_OPEN', until: '2027-01-03T15:00:00.000Z' }, unusedTickets: { count: 2, ticketAmount: 1, deductionAmount: 0, refundAmount: 1, transferableCount: 0, deferredRefundCount: 0 } };
  assert.deepEqual(await createWithdrawApi({ origin: '', fetch: fakeFetch(() => problem(409, 'withdrawal-confirmation-required', both)) }).withdraw('t', false), {
    kind: 'fraudHold',
    state: 'CASE_OPEN',
    until: '2027-01-03T15:00:00.000Z',
  });
});

test('I-T74_탈퇴재인증표시의남긴시각을한번만돌려준다(원격로그아웃표시와견준다, BOT-044)', () => {
  const s = memoryStore();
  markPending(s, 1000);
  assert.equal(takePendingAt(s, 1000 + PENDING_TTL_MS), 1000);
  assert.equal(takePendingAt(s, 2000), null, '한 번만');
  markPending(s, 1000);
  assert.equal(takePendingAt(s, 1001 + PENDING_TTL_MS), null, '10분이 지남');
  assert.equal(s.m.size, 0);
});

// ---- I-T85 ⑤(docs/features/identity.md §12, docs/frontend.md §4.1 '재인증', ADR-0293 결정 3) ----
// 값은 docs/security/authz-matrix.md §6 '받는 쪽 작업 op의 값' 표의 웹 purpose에서 옮겨 적는다
/** 주석을 뺀 원문(주석의 예시 글이 단언을 통과시키지 않게) */
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const SETTINGS_FLOWS = codeOnly(readFileSync(new URL('../../_pages/settings/ui/SettingsFlows.tsx', import.meta.url), 'utf8'));
const WITHDRAW_BROWSER = codeOnly(readFileSync(new URL('./browser.ts', import.meta.url), 'utf8'));
/** 원문에서 `name({` 부르기 하나의 인자 덩이(닫는 `})`까지) */
function callBlock(src, name) {
  const at = src.indexOf(`${name}({`);
  assert.ok(at >= 0, `${name} 부르기가 있다`);
  let depth = 0;
  for (let i = at + name.length; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`${name} 부르기가 닫히지 않는다`);
}

test('I-T85 ⑤-1 설정의 재인증 양식은 탈퇴면 purpose account-withdraw, 다른 기기 로그아웃이면 session-end다(같은 양식 함수를 써도)', () => {
  assert.deepEqual(reauthForm('kakao', 'account-withdraw'), { action: '/reauth/kakao', fields: { returnTo: '/my/settings', purpose: 'account-withdraw' } });
  assert.deepEqual(reauthForm('google', 'session-end'), { action: '/reauth/google', fields: { returnTo: '/my/settings', purpose: 'session-end' } });
  // 화면 연결: 다른 기기 로그아웃의 떠나기(leaveForDeviceReauth)는 session-end, 탈퇴의 떠나기(leaveForReauth)는 account-withdraw를 싣는다
  const device = callBlock(SETTINGS_FLOWS, 'leaveForDeviceReauth');
  assert.match(device, /submit:\s*\(p\)\s*=>\s*submitReauthForm\(p,\s*'session-end'\)/);
  assert.doesNotMatch(device, /account-withdraw/);
  const withdraw = callBlock(SETTINGS_FLOWS, 'leaveForReauth');
  assert.match(withdraw, /submit:\s*\(p\)\s*=>\s*submitReauthForm\(p,\s*'account-withdraw'\)/);
  assert.doesNotMatch(withdraw, /session-end/);
  // 한 인자로만 부르는 곳이 없다(기본값으로 빠지지 않는다)
  assert.doesNotMatch(SETTINGS_FLOWS, /submitReauthForm\(\s*[A-Za-z_$][\w$]*\s*\)/);
  // 양식 제출 함수는 받은 purpose를 그대로 양식에 넘기고 기본값을 두지 않는다
  assert.match(WITHDRAW_BROWSER, /export function submitReauthForm\(provider: Provider, purpose: SettingsReauthPurpose\): void \{\s*const \{ action, fields \} = reauthForm\(provider, purpose\);/);
});
