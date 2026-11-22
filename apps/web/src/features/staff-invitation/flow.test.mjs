// 초대 수락·거절 흐름(flow.ts) 시험(SCR-050, d5 §5.26, docs/features/identity.md §6.1 '휴대폰 화면 실제 연결', §12 I-T91 ①~④, ADR-0362 결정 1~5·8,
// BUILD_ORDER F-05-7 시험 담당). 경계(fetch)만 가짜로 두고 흐름 모듈·회차 공개 요약 읽기 도구는 진짜를 쓴다.
// 응답 모양은 docs/api/openapi.yaml(StaffInvitationView·EventPublicSummary·Problem)에서, 상태 이름은 identity §12 I-T91에서 가져왔다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventSummaryReader } from '../../entities/event-summary/index.ts';
import { afterAccept, afterReject, canAcceptIn, consentLinesOf, createStaffInvitationApi, loadInvitation } from './index.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, type) => json(status, { type: `https://peaket.example/problems/${type}`, title: 't', status });

function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', body: init.body ?? null, credentials: init.credentials, cache: init.cache, headers: init.headers ?? {} });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}

// 시험 값: 코드의 목업(LUMEN·스텔라)과 다른 합성 값
const EVENT = '0190f3a1-7c2e-7a00-8000-00000000e050';
const LOOKUP = {
  eventId: EVENT,
  role: 'gate_staff',
  validFrom: '2026-12-04T06:30:00.000Z',
  validUntil: '2026-12-04T14:00:00.000Z',
  invitedEmailMasked: 'h***@example.org',
  consents: {
    collection: '목적: 현장 검표 배정과 스캔 기록\n항목: 계정 ID·닉네임·역할·스캔 기록',
    provision: '받는 자: 그 회차의 파트너\n목적: 현장 인력 관리',
    consentVersion: 'staff-2026-11-23',
  },
};
const SUMMARY = { eventId: EVENT, title: '겨울 실내악 밤', startsAt: '2026-12-04T10:00:00.000Z', sellerName: '(주)바람소리기획' };
const ORIGIN = 'https://api.peaket.test';

/** 조회·요약·수락·거절 경로에 답을 정해 두는 가짜 서버 */
function server(o = {}) {
  return fakeFetch(async (url, init) => {
    if (url.endsWith('/v1/identity/access-tokens')) return o.refresh ?? json(401);
    if (url.endsWith('/v1/staff-invitation-lookups')) return typeof o.lookup === 'function' ? o.lookup(init) : (o.lookup ?? json(200, LOOKUP));
    if (url.includes('/v1/events/')) return typeof o.summary === 'function' ? o.summary() : (o.summary ?? json(200, SUMMARY));
    if (url.endsWith('/v1/staff-invitation-acceptances')) return o.accept ?? json(200, {});
    if (url.endsWith('/v1/staff-invitation-rejections')) return o.reject ?? new Response(null, { status: 204 });
    return json(404);
  });
}
const wire = (f) => ({ api: createStaffInvitationApi({ origin: ORIGIN, fetch: f }), events: createEventSummaryReader({ origin: ORIGIN, fetch: f }) });

test('I-T91 ① 조회 200이면 회차 공개 요약의 상호·공연명·회차 시작과 조회의 역할·유효 시간·가린 이메일로 동의 전이고 [수락]을 켤 수 있다', async () => {
  const f = server();
  const { api, events } = wire(f);
  const load = await loadInvitation({ api, events, token: 'tok-inv-1' });
  assert.equal(load.state, '동의 전');
  assert.deepEqual(load.summary, SUMMARY);
  assert.deepEqual(load.invitation, LOOKUP);
  assert.equal(canAcceptIn(load), true);
  // 조회: 토큰은 본문으로만(주소·쿼리에 없다), 쿠키를 싣고 캐시하지 않는다
  const lookup = f.calls.find((c) => c.url.endsWith('/v1/staff-invitation-lookups'));
  assert.equal(lookup.url, `${ORIGIN}/v1/staff-invitation-lookups`);
  assert.equal(lookup.method, 'POST');
  assert.deepEqual(JSON.parse(lookup.body), { inviteToken: 'tok-inv-1' });
  assert.equal(lookup.credentials, 'include');
  assert.equal(lookup.cache, 'no-store');
  // 회차 공개 요약: 조회가 준 eventId로, 쿠키 없이
  const summary = f.calls.find((c) => c.url.includes('/v1/events/'));
  assert.equal(summary.url, `${ORIGIN}/v1/events/${EVENT}`);
  assert.equal(summary.method, 'GET');
  assert.equal(summary.credentials, 'omit');
  for (const c of f.calls) assert.ok(!c.url.includes('tok-inv-1'), `주소에 토큰이 없다: ${c.url}`);
});

test('I-T91 ① 두 동의 카드의 고지 원문은 줄마다 이름·내용으로 나뉘고 글자 그대로다(HTML로 해석하지 않는다) [ASVS v5.0.0-3.2.2]', () => {
  assert.deepEqual(consentLinesOf('목적: 현장 검표 배정과 스캔 기록\n항목: 계정 ID·닉네임·역할·스캔 기록\n\n보유: 회차 종료 뒤 1년\r\n거부권과 불이익: 배정 불가'), [
    { term: '목적', detail: '현장 검표 배정과 스캔 기록' },
    { term: '항목', detail: '계정 ID·닉네임·역할·스캔 기록' },
    { term: '보유', detail: '회차 종료 뒤 1년' },
    { term: '거부권과 불이익', detail: '배정 불가' },
  ]);
  // 꺾쇠·엔티티를 그대로 둔다(화면은 글자로만 그린다). 이름 없는 줄은 내용만, 문안을 고쳐 쓰지 않는다
  assert.deepEqual(consentLinesOf('항목: <b>닉네임</b> &amp; 역할\n<img src=x onerror=alert(1)>'), [
    { term: '항목', detail: '<b>닉네임</b> &amp; 역할' },
    { term: '', detail: '<img src=x onerror=alert(1)>' },
  ]);
});

test('I-T91 ② 수락은 조회가 준 consentVersion과 두 동의를 보내고 200이면 수락 완료다', async () => {
  const served = { ...LOOKUP, consents: { ...LOOKUP.consents, consentVersion: 'staff-2027-01-02' } };
  const f = server({ lookup: json(200, served) });
  const { api, events } = wire(f);
  const load = await loadInvitation({ api, events, token: 'tok-inv-2' });
  const r = await api.accept({ inviteToken: 'tok-inv-2', consentVersion: load.invitation.consents.consentVersion });
  assert.deepEqual(r, { kind: 'accepted' });
  assert.equal(afterAccept(r), '수락 완료');
  const call = f.calls.find((c) => c.url.endsWith('/v1/staff-invitation-acceptances'));
  assert.equal(call.method, 'POST');
  assert.equal(call.credentials, 'include');
  assert.deepEqual(JSON.parse(call.body), { inviteToken: 'tok-inv-2', consentCollection: true, consentProvision: true, consentVersion: 'staff-2027-01-02' });
});

test('I-T91 ② 수락 실패 답은 정본 상태로 갈린다: 403 셋·409·410·422 둘, 고지 판이 낡았으면 다시 조회한다', async () => {
  const cases = [
    [problem(403, 'staff-invitation-email-mismatch'), '이메일 불일치'],
    [problem(403, 'staff-invitation-email-unverified'), '검증 이메일 없음'],
    [problem(403, 'identity-verification-required'), '본인확인 필요'],
    [problem(409, 'staff-assignment-exists'), '이미 배정'],
    [problem(410, 'invitation-invalid'), '만료'],
    [problem(422, 'consent-required'), '동의 누락'],
    [problem(422, 'consent-version-outdated'), 'reload'],
    [json(500, { status: 500 }), 'retry'],
    [problem(403, 'something-else'), 'retry'],
  ];
  for (const [res, want] of cases) {
    const { api } = wire(server({ accept: res }));
    assert.equal(afterAccept(await api.accept({ inviteToken: 't', consentVersion: 'staff-2026-11-23' })), want, `${res.status} → ${want}`);
  }
  // 연결이 끊기면 그 자리 안내(상태는 그대로)
  const down = createStaffInvitationApi({ origin: ORIGIN, fetch: async () => { throw new TypeError('끊김'); } });
  assert.equal(afterAccept(await down.accept({ inviteToken: 't', consentVersion: 'v' })), 'retry');
});

test('I-T91 ③ 회차 공개 요약이 404·410이거나 닿지 않으면 파트너 이름을 읽지 못함이고 [수락]이 꺼지며, 다시 불러오면 다시 묻는다', async () => {
  for (const summary of [() => problem(404, 'not-found'), () => problem(410, 'sale-suspended'), () => { throw new TypeError('끊김'); }, () => json(200, { title: '', startsAt: 'x' })]) {
    const f = server({ summary });
    const { api, events } = wire(f);
    const load = await loadInvitation({ api, events, token: 'tok-inv-3' });
    assert.equal(load.state, '파트너 이름을 읽지 못함');
    assert.equal(load.summary, undefined);
    // 역할·유효 시간은 보이도록 조회 값은 남는다
    assert.deepEqual(load.invitation, LOOKUP);
    assert.equal(canAcceptIn(load), false);
  }
  // [다시 불러오기]: 못 읽음은 기억하지 않아 같은 읽기 도구가 다시 묻고, 이번에 읽히면 동의 전이다
  let n = 0;
  const f = server({ summary: () => (n++ === 0 ? problem(410, 'sale-suspended') : json(200, SUMMARY)) });
  const { api, events } = wire(f);
  assert.equal((await loadInvitation({ api, events, token: 't' })).state, '파트너 이름을 읽지 못함');
  const again = await loadInvitation({ api, events, token: 't' });
  assert.equal(again.state, '동의 전');
  assert.equal(canAcceptIn(again), true);
  assert.equal(f.calls.filter((c) => c.url.includes('/v1/events/')).length, 2);
});

test('I-T91 ④ 거절은 POST /v1/staff-invitation-rejections에 토큰을 본문으로 보내고 204는 거절함, 410은 만료다', async () => {
  const f = server();
  const { api } = wire(f);
  const r = await api.reject('tok-inv-4');
  assert.deepEqual(r, { kind: 'rejected' });
  assert.equal(afterReject(r), '거절함');
  const call = f.calls.find((c) => c.url.endsWith('/v1/staff-invitation-rejections'));
  assert.equal(call.url, `${ORIGIN}/v1/staff-invitation-rejections`);
  assert.equal(call.method, 'POST');
  assert.deepEqual(JSON.parse(call.body), { inviteToken: 'tok-inv-4' });
  assert.equal(afterReject(await wire(server({ reject: problem(410, 'invitation-invalid') })).api.reject('t')), '만료');
  assert.equal(afterReject(await wire(server({ reject: json(500) })).api.reject('t')), 'retry');
});

test('I-T91 조회 401(갱신도 401)은 로그인 필요, 410은 만료, 5xx는 불러오지 못함이고 요약을 묻지 않는다 [ASVS v5.0.0-3.3.2]', async () => {
  const login = server({ lookup: json(401), refresh: json(401) });
  assert.equal((await loadInvitation({ ...wire(login), token: 't' })).state, '로그인 필요');
  // 401 뒤 갱신을 한 번 해 보고, 갱신이 거절되면 다시 보내지 않는다
  assert.equal(login.calls.filter((c) => c.url.endsWith('/v1/identity/access-tokens')).length, 1);
  assert.equal(login.calls.filter((c) => c.url.endsWith('/v1/staff-invitation-lookups')).length, 1);
  // 갱신이 되면 한 번 더 보내 이어 간다
  let n = 0;
  const renewed = server({ lookup: () => (n++ === 0 ? json(401) : json(200, LOOKUP)), refresh: new Response(null, { status: 204 }) });
  assert.equal((await loadInvitation({ ...wire(renewed), token: 't' })).state, '동의 전');
  const expired = server({ lookup: problem(410, 'invitation-invalid') });
  assert.equal((await loadInvitation({ ...wire(expired), token: 't' })).state, '만료');
  const broken = server({ lookup: json(503) });
  assert.equal((await loadInvitation({ ...wire(broken), token: 't' })).state, '불러오지 못함');
  for (const f of [login, expired, broken]) assert.equal(f.calls.filter((c) => c.url.includes('/v1/events/')).length, 0);
});

test('I-T91 토큰이 없으면(조각도 탭 저장소 값도 없음) 요청 없이 만료 화면이다', async () => {
  const f = server();
  assert.deepEqual(await loadInvitation({ ...wire(f), token: null }), { state: '만료' });
  assert.equal(f.calls.length, 0);
});
