// 스캐너 승인(휴대폰 쪽) 흐름(flow.ts) 시험(SCR-051, d5 §5.27, docs/features/identity.md §6.1 '승인 화면의 파트너 이름'·'휴대폰 화면 실제 연결',
// §12 I-T62 ①~③·I-T92 ①~③, ADR-0362 결정 8, BUILD_ORDER F-05-7 시험 담당). 경계(fetch)만 가짜로 두고 흐름 모듈·회차 공개 요약 읽기 도구는 진짜를 쓴다.
// 응답 모양은 docs/api/openapi.yaml(DeviceApprovalView·EventPublicSummary·Problem), 상태 이름은 identity §12 I-T92·d5 §5.27 상태 표에서 가져왔다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventSummaryReader } from '../../entities/event-summary/index.ts';
import { afterDecide, approvalCodeLabel, createStaffApprovalApi, loadApproval } from './index.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, type) => json(status, { type: `https://peaket.example/problems/${type}`, title: 't', status });
function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', body: init.body ?? null, credentials: init.credentials });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}

const ORIGIN = 'https://api.peaket.test';
const EV1 = '0190f3a1-7c2e-7a00-8000-00000000e511';
const EV2 = '0190f3a1-7c2e-7a00-8000-00000000e512';
const A1 = { assignmentId: '0190f3a1-7c2e-7a00-8000-00000000a511', eventId: EV1, role: 'gate_lead', status: 'ASSIGNED', validFrom: '2026-12-04T04:30:00.000Z', validUntil: '2026-12-04T13:00:00.000Z' };
const A2 = { assignmentId: '0190f3a1-7c2e-7a00-8000-00000000a512', eventId: EV2, role: 'gate_staff', status: 'ASSIGNED', validFrom: '2026-12-05T03:30:00.000Z', validUntil: '2026-12-05T12:00:00.000Z' };
const VIEW = { deviceName: '서문-14', userCode: 'KQRT-ZPLM', assignments: [A1], canProxy: false };
const S1 = { title: '겨울 실내악 밤', startsAt: '2026-12-04T09:00:00.000Z', sellerName: '(주)바람소리기획' };
const S2 = { title: '겨울 실내악 밤', startsAt: '2026-12-05T08:00:00.000Z', sellerName: '(주)바람소리기획' };

function server(o = {}) {
  return fakeFetch(async (url, init) => {
    if (url.endsWith('/v1/identity/access-tokens')) return o.refresh ?? json(401);
    if (url.endsWith('/v1/device-approval-lookups')) return o.lookup ?? json(200, VIEW);
    if (url.endsWith(`/v1/events/${EV1}`)) return typeof o.s1 === 'function' ? o.s1() : (o.s1 ?? json(200, S1));
    if (url.endsWith(`/v1/events/${EV2}`)) return o.s2 ?? json(200, S2);
    if (url.endsWith('/v1/device-approvals')) return o.decide ?? new Response(null, { status: 204 });
    return json(404);
  });
}
const wire = (f) => ({ api: createStaffApprovalApi({ origin: ORIGIN, fetch: f }), events: createEventSummaryReader({ origin: ORIGIN, fetch: f }) });
const approvals = (f) => f.calls.filter((c) => c.url.endsWith('/v1/device-approvals'));

test('I-T92 ① 조회 200의 배정 하나는 승인 대기이고 기기 이름·확인 코드·회차 공개 요약의 상호·공연명을 보인다 [ASVS v5.0.0-7.6.2]', async () => {
  const f = server();
  const load = await loadApproval({ ...wire(f), code: 'KQRT-ZPLM' });
  assert.equal(load.state, '승인 대기');
  assert.equal(load.view.deviceName, '서문-14');
  assert.equal(load.view.code, 'KQRT-ZPLM');
  assert.equal(load.view.partnerName, '(주)바람소리기획');
  assert.equal(load.view.canProxy, false);
  assert.equal(load.view.assignments.length, 1);
  assert.equal(load.view.assignments[0].assignmentId, A1.assignmentId);
  // 공연명 + 회차 시작(KST 18:00 = 09:00Z)
  assert.equal(load.view.assignments[0].title, '겨울 실내악 밤 12/4(금) 18:00');
  // 확인 코드는 본문으로만, 주소에 없다
  const lookup = f.calls.find((c) => c.url.endsWith('/v1/device-approval-lookups'));
  assert.deepEqual(JSON.parse(lookup.body), { userCode: 'KQRT-ZPLM' });
  for (const c of f.calls) assert.ok(!c.url.includes('KQRT'), c.url);
  // 조회만으로는 승인 요청을 보내지 않는다(사람이 누를 때만)
  assert.equal(approvals(f).length, 0);
});

test('I-T92 ① 확인 코드 낭독 이름은 한 글자씩이고 하이픈을 말로 읽는다', () => {
  assert.equal(approvalCodeLabel('KQRT-ZPLM'), '확인 코드 K Q R T 하이픈 Z P L M');
});

test('I-T92 ① 배정이 둘이면 배정 고르기이고 승인은 고른 배정의 assignmentId를 보낸다. 하나면 그 배정을 보낸다', async () => {
  const two = server({ lookup: json(200, { ...VIEW, assignments: [A1, A2] }) });
  const load = await loadApproval({ ...wire(two), code: 'KQRT-ZPLM' });
  assert.equal(load.state, '배정 고르기');
  assert.deepEqual(load.view.assignments.map((a) => [a.assignmentId, a.label]), [
    [A1.assignmentId, '겨울 실내악 밤 12/4(금) 18:00 · 현장 책임자'],
    [A2.assignmentId, '겨울 실내악 밤 12/5(토) 17:00 · 현장 스태프'],
  ]);
  const { api } = wire(two);
  assert.deepEqual(await api.decide({ userCode: 'KQRT-ZPLM', decision: 'APPROVE', assignmentId: A2.assignmentId }), { kind: 'done' });
  assert.deepEqual(JSON.parse(approvals(two)[0].body), { userCode: 'KQRT-ZPLM', decision: 'APPROVE', assignmentId: A2.assignmentId });
  assert.equal(approvals(two)[0].credentials, 'include');
});

test('I-T92 ① 대리 승인은 canProxy가 true일 때만이고 켜면 proxy: true를 싣는다', async () => {
  const lead = server({ lookup: json(200, { ...VIEW, canProxy: true }) });
  const load = await loadApproval({ ...wire(lead), code: 'KQRT-ZPLM' });
  assert.equal(load.view.canProxy, true);
  const { api } = wire(lead);
  await api.decide({ userCode: 'KQRT-ZPLM', decision: 'APPROVE', assignmentId: A1.assignmentId, proxy: true });
  assert.deepEqual(JSON.parse(approvals(lead)[0].body), { userCode: 'KQRT-ZPLM', decision: 'APPROVE', assignmentId: A1.assignmentId, proxy: true });
  // canProxy가 없거나 false면 false다(칸을 보이지 않는다)
  assert.equal((await loadApproval({ ...wire(server({ lookup: json(200, { deviceName: 'x', userCode: 'K', assignments: [A1] }) })), code: 'K' })).view.canProxy, false);
});

test('I-T92 ② 조회 403 셋은 이유만 보이고 기기 이름·코드·배정·버튼이 없다. 404는 코드 만료, 429는 시도 초과다 (I-T62 ②)', async () => {
  const cases = [
    ['staff-assignment-missing', '권한 없음 · 배정 없음'],
    ['other-partner-device', '권한 없음 · 다른 파트너 기기'],
    ['outside-staff-hours', '권한 없음 · 운영 시간 밖'],
  ];
  for (const [type, state] of cases) {
    const f = server({ lookup: problem(403, type) });
    const load = await loadApproval({ ...wire(f), code: 'KQRT-ZPLM' });
    assert.deepEqual(load, { state }, `${type}: 보기 값(기기 이름·코드·배정·파트너 이름)이 없다`);
    assert.equal(f.calls.filter((c) => c.url.includes('/v1/events/')).length, 0, '파트너 이름을 읽지 않는다');
  }
  assert.deepEqual(await loadApproval({ ...wire(server({ lookup: problem(404, 'not-found') })), code: 'K' }), { state: '코드 만료' });
  assert.deepEqual(await loadApproval({ ...wire(server({ lookup: problem(429, 'device-approval-limited') })), code: 'K' }), { state: '시도 초과' });
  assert.deepEqual(await loadApproval({ ...wire(server({ lookup: json(502) })), code: 'K' }), { state: '불러오지 못함' });
  // I-T62 ② 그 코드로 승인을 보내도 403이면 같은 이유 화면이다
  const { api } = wire(server({ decide: problem(403, 'other-partner-device') }));
  assert.equal(afterDecide(await api.decide({ userCode: 'K', decision: 'APPROVE' }), 'APPROVE'), '권한 없음 · 다른 파트너 기기');
});

test('I-T92 ③ 승인 204는 승인됨, 거부 204는 거부함, 403 proxy-approval-forbidden은 권한 없음 · 대리 승인, 409 device-approval-conflict는 다른 승인이 먼저 처리됨이다', async () => {
  const run = async (res, decision) => afterDecide(await wire(server({ decide: res })).api.decide({ userCode: 'K', decision }), decision);
  assert.equal(await run(new Response(null, { status: 204 }), 'APPROVE'), '승인됨');
  assert.equal(await run(new Response(null, { status: 204 }), 'DENY'), '거부함');
  assert.equal(await run(problem(403, 'proxy-approval-forbidden'), 'APPROVE'), '권한 없음 · 대리 승인');
  assert.equal(await run(problem(409, 'device-approval-conflict'), 'APPROVE'), '다른 승인이 먼저 처리됨');
  assert.equal(await run(problem(404, 'not-found'), 'APPROVE'), '코드 만료');
  assert.equal(await run(problem(429, 'device-approval-limited'), 'APPROVE'), '시도 초과');
  assert.equal(await run(json(500), 'APPROVE'), 'retry');
  // 거부도 같은 경로·본문 꼴이다
  const f = server();
  await wire(f).api.decide({ userCode: 'KQRT-ZPLM', decision: 'DENY' });
  assert.deepEqual(JSON.parse(approvals(f)[0].body), { userCode: 'KQRT-ZPLM', decision: 'DENY' });
});

test('I-T62 ① 조회 응답에는 파트너 이름이 없고 화면은 회차 공개 요약의 sellerName을 배정 파트너로 보인다', async () => {
  const f = server({ s1: json(200, { ...S1, sellerName: '(주)들꽃무대' }) });
  const load = await loadApproval({ ...wire(f), code: 'K' });
  assert.equal(load.view.partnerName, '(주)들꽃무대');
});

test('I-T62 ③ 회차 공개 요약 404면 이름 없이 유효 시간 줄을 보이고 승인은 된다', async () => {
  const f = server({ s1: problem(404, 'not-found') });
  const { api, events } = wire(f);
  const load = await loadApproval({ api, events, code: 'KQRT-ZPLM' });
  assert.equal(load.state, '파트너 이름을 읽지 못함');
  assert.equal(load.view.partnerName, null);
  assert.equal(load.view.deviceName, '서문-14');
  assert.equal(load.view.code, 'KQRT-ZPLM');
  // 공연명 대신 배정의 유효 시간 짧은 줄(KST 13:30~22:00) · 역할
  assert.equal(load.view.assignments[0].title, '12/4 13:30~22:00 · 현장 책임자');
  assert.equal(load.view.assignments[0].meta, undefined);
  assert.equal(afterDecide(await api.decide({ userCode: 'KQRT-ZPLM', decision: 'APPROVE', assignmentId: A1.assignmentId }), 'APPROVE'), '승인됨');
});

test('I-T92 조회 401(갱신도 401)은 로그인 필요다 [ASVS v5.0.0-3.3.2]', async () => {
  const f = server({ lookup: json(401), refresh: json(401) });
  assert.deepEqual(await loadApproval({ ...wire(f), code: 'K' }), { state: '로그인 필요' });
  assert.equal(approvals(f).length, 0);
  // 코드가 없으면(조각도 탭 저장소 값도 없음) 요청 없이 코드 만료다
  const none = server();
  assert.deepEqual(await loadApproval({ ...wire(none), code: null }), { state: '코드 만료' });
  assert.equal(none.calls.length, 0);
});

test('I-T92 기기 이름에 꺾쇠를 넣어도 글자 그대로 보기 값에 남는다(화면이 HTML로 해석하지 않는다) [ASVS v5.0.0-3.2.2]', async () => {
  const f = server({ lookup: json(200, { ...VIEW, deviceName: '<b>서문</b>-14' }) });
  assert.equal((await loadApproval({ ...wire(f), code: 'K' })).view.deviceName, '<b>서문</b>-14');
});
