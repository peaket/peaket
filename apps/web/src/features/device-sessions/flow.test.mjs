// 로그인한 기기 흐름(flow.ts) 시험(docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현', d5 §5.17, BUILD_ORDER BOT-044, ADR-0209, I-T74).
// 가짜 fetch·저장소로 본다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseReturn, createDevicesApi, endResultText, leaveForDeviceReauth, markPending, otherLoginsOf, PENDING_KEY, PENDING_TTL_MS, reauthPurposeFor, scannerRowName, takePending, toDeviceSessions, toScannerSessions } from './flow.ts';

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const problem = (status, type) => json(status, { type: `https://peaket.example/problems/${type}`, status });

function fakeFetch(handler) {
  const calls = [];
  const f = async (input, init = {}) => {
    calls.push({ url: input, method: init.method ?? 'GET', headers: init.headers ?? {}, credentials: init.credentials, cache: init.cache });
    return handler(input, init, calls.length);
  };
  f.calls = calls;
  return f;
}
const memoryStore = () => {
  const m = new Map();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k), m };
};
const ROW = { sessionId: '0190f3a1-7c2e-7a00-8000-0000000000a1', deviceName: 'Safari · iPhone', lastActiveAt: '2026-11-03T05:00:00.000Z', current: false, otherSessions: 0 };
const ME = { sessionId: '0190f3a1-7c2e-7a00-8000-0000000000a2', deviceName: 'Chrome · Windows', lastActiveAt: '2026-11-05T03:00:00.000Z', current: true, otherSessions: 0 };

test('I-T74_목록은GET /v1/identity/sessions를쿠키와no-store로부르고_줄을그대로준다_401이면갱신뒤한번더이고갱신도401이면login이다', async () => {
  const ok = fakeFetch(() => json(200, { items: [ME, ROW] }));
  assert.deepEqual(await createDevicesApi({ origin: 'https://api.test', fetch: ok }).list(), { kind: 'ok', items: [ME, ROW] });
  assert.equal(ok.calls[0].url, 'https://api.test/v1/identity/sessions');
  assert.equal(ok.calls[0].method, 'GET');
  assert.equal(ok.calls[0].credentials, 'include');
  assert.equal(ok.calls[0].cache, 'no-store');
  let n = 0;
  const again = fakeFetch((u) => (u.endsWith('/access-tokens') ? new Response(null, { status: 204 }) : n++ === 0 ? json(401) : json(200, { items: [ME] })));
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: again }).list(), { kind: 'ok', items: [ME] });
  const expired = fakeFetch((u) => (u.endsWith('/access-tokens') ? json(401) : json(401)));
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: expired }).list(), { kind: 'login' });
  // 갱신이 일시 장애(503)면 로그인 화면으로 보내지 않는다
  const down = fakeFetch((u) => (u.endsWith('/access-tokens') ? json(503) : json(401)));
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: down }).list(), { kind: 'error' });
  // 모양이 틀리거나 끊기면 오류다(otherSessions가 없거나 음수인 줄도)
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(200, { items: [{ sessionId: 1 }] })) }).list(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(200, { items: [{ ...ME, otherSessions: undefined }] })) }).list(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(200, { items: [{ ...ME, otherSessions: -1 }] })) }).list(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(500)) }).list(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: async () => { throw new TypeError('끊김'); } }).list(), { kind: 'error' });
});

test('I-T74_원격로그아웃은DELETE와X-Reauth-Token머리로보내고_204완료·404session-not-found·403reauth-required·그밖오류로가른다 [ASVS v5.0.0-7.5.2]', async () => {
  const done = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await createDevicesApi({ origin: 'https://api.test', fetch: done }).end(ROW.sessionId, 'tok-1'), { kind: 'done' });
  assert.equal(done.calls[0].url, `https://api.test/v1/identity/sessions/${ROW.sessionId}`);
  assert.equal(done.calls[0].method, 'DELETE');
  assert.equal(done.calls[0].headers['x-reauth-token'], 'tok-1');
  assert.equal(done.calls[0].credentials, 'include');
  const api = (r) => createDevicesApi({ origin: '', fetch: fakeFetch(() => r) });
  assert.deepEqual(await api(problem(404, 'session-not-found')).end('x', 't'), { kind: 'gone' });
  // 409는 더 오지 않는다(지금 기기 줄도 끈다, 새 맥락 리뷰 중간 1). 와도 오류다
  assert.deepEqual(await api(problem(409, 'current-session')).end('x', 't'), { kind: 'error' });
  assert.deepEqual(await api(problem(403, 'reauth-required')).end('x', 't'), { kind: 'reauth' });
  assert.deepEqual(await api(problem(404, 'not-found')).end('x', 't'), { kind: 'error' });
  assert.deepEqual(await api(json(500)).end('x', 't'), { kind: 'error' });
  // 경로 조각은 인코딩한다
  const odd = fakeFetch(() => new Response(null, { status: 204 }));
  await createDevicesApi({ origin: '', fetch: odd }).end('a/b?c', 't');
  assert.equal(odd.calls[0].url, '/v1/identity/sessions/a%2Fb%3Fc');
  // 401 뒤 갱신이 401이면 login, 일시 장애면 오류다(재인증 토큰은 부르는 쪽이 버린다)
  const expired = fakeFetch((u) => (u.endsWith('/access-tokens') ? json(401) : json(401)));
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: expired }).end('x', 't'), { kind: 'login' });
  const down = fakeFetch((u) => (u.endsWith('/access-tokens') ? json(502) : json(401)));
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: down }).end('x', 't'), { kind: 'error' });
});

/** 가짜 fetch가 내준 응답 가운데 본문이 있는 것을 모아, 흐름이 끝난 뒤 다 읽거나 버리지 않은 것을 돌려준다 */
function tracking(handler) {
  const handed = [];
  const f = fakeFetch(async (u, init, n) => {
    const r = await handler(u, init, n);
    if (r.body) handed.push({ what: `${init.method ?? 'GET'} ${u} ${r.status}`, r });
    return r;
  });
  f.unread = () => handed.filter((h) => !h.r.bodyUsed).map((h) => h.what);
  return f;
}
/** 신호가 끊길 때까지 답하지 않는 fetch(끊기면 그 까닭으로 거절한다). stallBody면 머리(200)는 바로 주고 본문을 끊길 때까지 미룬다 */
function hangingFetch({ stallBody = false } = {}) {
  return fakeFetch(
    (u, init) =>
      new Promise((resolve, reject) => {
        const signal = init.signal;
        if (!signal) return; // 신호가 없으면 영영 답하지 않는다
        if (!stallBody) return signal.addEventListener('abort', () => reject(signal.reason));
        const body = new ReadableStream({ start: (c) => signal.addEventListener('abort', () => c.error(signal.reason)) });
        resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
      }),
  );
}
/** 약속이 끝났으면 그 값, 아니면 'pending'(가짜 시계를 돌린 뒤 미세 작업을 비우고 본다) */
async function settled(p) {
  let out = 'pending';
  p.then((v) => (out = v));
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  return out;
}

test('I-T74_목록·원격로그아웃·그사이토큰갱신은받은응답본문을모두읽거나버린다_읽지않은본문은Chromium이요청을끝내지않는다(BOT-044뒤처리, CSP검사시간초과)', async () => {
  const refreshed = (rest) => (u, i, n) => (u.endsWith('/access-tokens') ? rest.refresh() : n === 1 ? problem(401, 'unauthorized') : rest.then());
  const cases = [
    ['목록 503', (f) => createDevicesApi({ origin: '', fetch: f }).list(), () => problem(503, 'service-unavailable'), { kind: 'error' }],
    ['목록 401 → 갱신 → 200', (f) => createDevicesApi({ origin: '', fetch: f }).list(), refreshed({ refresh: () => new Response(null, { status: 204 }), then: () => json(200, { items: [ME] }) }), { kind: 'ok', items: [ME] }],
    ['목록 401 → 갱신 401', (f) => createDevicesApi({ origin: '', fetch: f }).list(), refreshed({ refresh: () => problem(401, 'unauthorized') }), { kind: 'login' }],
    ['목록 401 → 갱신 503', (f) => createDevicesApi({ origin: '', fetch: f }).list(), refreshed({ refresh: () => problem(503, 'service-unavailable') }), { kind: 'error' }],
    ['목록 401 → 갱신 → 다시 401', (f) => createDevicesApi({ origin: '', fetch: f }).list(), (u) => (u.endsWith('/access-tokens') ? new Response(null, { status: 204 }) : problem(401, 'unauthorized')), { kind: 'login' }],
    ['원격 로그아웃 401 → 갱신 → 204', (f) => createDevicesApi({ origin: '', fetch: f }).end('x', 't'), refreshed({ refresh: () => new Response(null, { status: 204 }), then: () => new Response(null, { status: 204 }) }), { kind: 'done' }],
    ['원격 로그아웃 502(본문이 문제 상세가 아님)', (f) => createDevicesApi({ origin: '', fetch: f }).end('x', 't'), () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }), { kind: 'error' }],
  ];
  for (const [name, run, handler, expected] of cases) {
    const f = tracking(handler);
    assert.deepEqual(await run(f), expected, name);
    assert.deepEqual(f.unread(), [], `${name}: 읽지도 버리지도 않은 응답`);
  }
});

test('I-T74_목록은10초·원격로그아웃은15초가지나면오류로끝낸다_머리가온뒤본문이늦어도같다(docs/frontend.md §4.1 시간 초과, BOT-044뒤처리)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stallBody of [false, true]) {
    const list = createDevicesApi({ origin: '', fetch: hangingFetch({ stallBody }) }).list();
    assert.equal(await settled(list), 'pending');
    t.mock.timers.tick(9_999);
    assert.equal(await settled(list), 'pending', `목록 9.999초(본문 늦음 ${stallBody})`);
    t.mock.timers.tick(1);
    assert.deepEqual(await settled(list), { kind: 'error' }, `목록 10초(본문 늦음 ${stallBody})`);
  }
  const end = createDevicesApi({ origin: '', fetch: hangingFetch() }).end('x', 't');
  assert.equal(await settled(end), 'pending');
  t.mock.timers.tick(14_999);
  assert.equal(await settled(end), 'pending', '원격 로그아웃 14.999초');
  t.mock.timers.tick(1);
  assert.deepEqual(await settled(end), { kind: 'error' }, '원격 로그아웃 15초');
  // 401 뒤 토큰 갱신이 답하지 않으면 갱신의 쓰기 한도(15초) 뒤 일시 장애(오류)다. 잠금(peaket.refresh)을 쥔 채 멈추지 않는다
  const stuck = fakeFetch((u, init) => (u.endsWith('/access-tokens') ? hangingFetch()(u, init) : problem(401, 'unauthorized')));
  const viaRefresh = createDevicesApi({ origin: '', fetch: stuck }).list();
  assert.equal(await settled(viaRefresh), 'pending');
  t.mock.timers.tick(14_999);
  assert.equal(await settled(viaRefresh), 'pending', '갱신 14.999초');
  t.mock.timers.tick(1);
  assert.deepEqual(await settled(viaRefresh), { kind: 'error' }, '갱신 15초');
});

test('I-T74_줄을화면부품의기기로바꾼다_이름이없으면알수없는기기이고_지금이기기밖에는마지막활동날짜를단다', () => {
  assert.deepEqual(toDeviceSessions([ME, ROW, { sessionId: 's3', deviceName: null, lastActiveAt: '2026-10-31T16:00:00.000Z', current: false }, { sessionId: 's4', deviceName: 'Safari · iPad', lastActiveAt: 'x', current: false }]), [
    { id: ME.sessionId, name: 'Chrome · Windows', icon: 'monitor', current: true },
    { id: ROW.sessionId, name: 'Safari · iPhone', icon: 'phone', current: false, detail: '마지막 활동 2026.11.03' },
    // 한국 시각으로 날짜를 센다(UTC 10/31 16:00 = KST 11/01 01:00)
    { id: 's3', name: '알 수 없는 기기', icon: 'device', current: false, detail: '마지막 활동 2026.11.01' },
    { id: 's4', name: 'Safari · iPad', icon: 'tablet', current: false },
  ]);
  assert.equal(toDeviceSessions([{ ...ROW, deviceName: 'Samsung Internet · Android' }])[0].icon, 'phone');
});

test('I-T74_원격로그아웃결과의안내문구(d5 §5.17)_지금기기의다른로그인끝내기는문구가다르다', () => {
  assert.deepEqual(endResultText({ kind: 'done' }, { name: 'Safari · iPhone', scope: 'device' }), { text: 'Safari · iPhone에서 로그아웃했습니다', icon: 'ic-check' });
  assert.deepEqual(endResultText({ kind: 'gone' }, { name: 'x', scope: 'device' }), { text: '이미 로그아웃된 기기입니다', icon: 'ic-info' });
  assert.deepEqual(endResultText({ kind: 'done' }, { name: 'x', scope: 'others' }), { text: '이 기기의 다른 로그인을 끝냈습니다', icon: 'ic-check' });
  assert.deepEqual(endResultText({ kind: 'gone' }, { name: 'x', scope: 'others' }), { text: '끝낼 다른 로그인이 없습니다', icon: 'ic-info' });
  assert.deepEqual(endResultText({ kind: 'error' }, { name: 'x', scope: 'device' }), { text: '지금은 로그아웃할 수 없습니다. 잠시 뒤 다시 시도해 주세요', icon: 'ic-alert-circle' });
  // 재인증 만료·로그인 필요는 토스트가 아니라 재인증 창·로그인 화면이다
  assert.equal(endResultText({ kind: 'reauth' }, { name: 'x', scope: 'device' }), null);
  assert.equal(endResultText({ kind: 'login' }, { name: 'x', scope: 'device' }), null);
});

test('I-T74_지금이기기줄의다른로그인수(새맥락리뷰중간1)', () => {
  assert.equal(otherLoginsOf([ME, ROW]), 0);
  assert.equal(otherLoginsOf([{ ...ME, otherSessions: 2 }, { ...ROW, otherSessions: 3 }]), 2);
  assert.equal(otherLoginsOf([ROW]), 0);
});

test('I-T74_원격로그아웃재인증표시는_끝낼세션과기기이름·시각만두고(토큰없음)_10분안이고한번만믿는다', () => {
  const s = memoryStore();
  markPending(s, { sessionId: ROW.sessionId, name: 'Safari · iPhone', scope: 'device', at: 1000 });
  assert.deepEqual(JSON.parse(s.m.get(PENDING_KEY)), { sessionId: ROW.sessionId, name: 'Safari · iPhone', scope: 'device', at: 1000 });
  assert.deepEqual(takePending(s, 1000 + PENDING_TTL_MS), { sessionId: ROW.sessionId, name: 'Safari · iPhone', scope: 'device', at: 1000 });
  assert.equal(takePending(s, 2000), null, '한 번만');
  markPending(s, { sessionId: ROW.sessionId, name: 'x', scope: 'others', at: 1000 });
  assert.equal(takePending(s, 1001 + PENDING_TTL_MS), null, '10분이 지남');
  assert.equal(s.m.size, 0);
  for (const junk of ['nope', '{"sessionId":1,"name":"x","scope":"device","at":1}', '{"sessionId":"s","name":"x","scope":"device","at":9999}', '{"sessionId":"s","scope":"device","at":1}', '{"sessionId":"s","name":"x","scope":"all","at":1}']) {
    s.set(PENDING_KEY, junk);
    assert.equal(takePending(s, 2000), null, junk);
    assert.equal(s.m.size, 0);
  }
});

test('I-T74_탈퇴재인증표시와함께있으면나중에남긴쪽만잇는다', () => {
  assert.equal(chooseReturn(null, null), null);
  assert.equal(chooseReturn({ sessionId: 's', name: 'x', scope: 'device', at: 5 }, null), 'device');
  assert.equal(chooseReturn(null, 5), 'withdraw');
  assert.equal(chooseReturn({ sessionId: 's', name: 'x', scope: 'device', at: 5 }, 7), 'withdraw');
  assert.equal(chooseReturn({ sessionId: 's', name: 'x', scope: 'device', at: 9 }, 7), 'device');
});

test('I-T74_[로그아웃]의재인증으로떠나기는갱신뒤표시를남기고양식을보낸다_갱신401은login·일시장애는retry·그사이창을닫으면떠나지않는다', async () => {
  const run = async (refresh, o = {}) => {
    const s = memoryStore();
    const submitted = [];
    const out = await leaveForDeviceReauth({
      api: { refresh: async () => refresh },
      storage: s,
      now: () => 4242,
      provider: o.provider === undefined ? 'kakao' : o.provider,
      pickProvider: async () => 'naver',
      target: { sessionId: ROW.sessionId, name: 'Safari · iPhone', scope: 'device' },
      submit: (p) => submitted.push(p),
      cancelled: () => o.cancelled === true,
    });
    return { out, pending: s.m.get(PENDING_KEY), submitted };
  };
  assert.deepEqual(await run('ok'), { out: 'left', pending: JSON.stringify({ sessionId: ROW.sessionId, name: 'Safari · iPhone', scope: 'device', at: 4242 }), submitted: ['kakao'] });
  assert.deepEqual(await run('ok', { provider: null }), { out: 'left', pending: JSON.stringify({ sessionId: ROW.sessionId, name: 'Safari · iPhone', scope: 'device', at: 4242 }), submitted: ['naver'] });
  assert.deepEqual(await run('rejected'), { out: 'login', pending: undefined, submitted: [] });
  assert.deepEqual(await run('unavailable'), { out: 'retry', pending: undefined, submitted: [] });
  assert.deepEqual(await run('ok', { cancelled: true }), { out: 'cancelled', pending: undefined, submitted: [] });
});

// ---- I-T90 ②③: 현장 스캐너 세션 줄(BUILD_ORDER F-05-7 = GAT-230, d5 §5.17 '스태프 세션', ADR-0362 결정 7, 시험 담당) ----
// 응답 모양은 openapi ScannerSessionSelf, 탭 저장소 키·범위 값은 docs/frontend.md §3.12 `peaket.devices.reauth`(device·others·scanner)다.
const SCANNER = {
  sessionId: '0190f3a1-7c2e-7a00-8000-00000000c901',
  deviceName: '서문-14',
  eventId: '0190f3a1-7c2e-7a00-8000-00000000e901',
  role: 'gate_lead',
  proxy: false,
  approvedAt: '2026-12-04T05:00:00.000Z',
  expiresAt: '2026-12-04T13:00:00.000Z',
  lastSeenAt: '2026-12-04T06:10:00.000Z',
};

test('I-T90 ② 스캐너 줄의 재인증 표시는 범위 scanner·ID·이름·시각만 남긴다 [ASVS v5.0.0-14.3.3]', async () => {
  const s = memoryStore();
  const submitted = [];
  const out = await leaveForDeviceReauth({
    api: { refresh: async () => 'ok' },
    storage: s,
    now: () => 7777,
    provider: 'google',
    pickProvider: async () => null,
    target: { sessionId: SCANNER.sessionId, name: '현장 스캐너 서문-14', scope: 'scanner' },
    // 화면은 이 자리에서 범위의 purpose로 양식을 보낸다(SettingsFlows, account-withdraw I-T85 ⑤-1)
    submit: (p) => submitted.push([p, reauthPurposeFor('scanner')]),
    cancelled: () => false,
  });
  assert.equal(out, 'left');
  assert.deepEqual(submitted, [['google', 'scanner-session-end']]);
  // 키는 docs/frontend.md §3.12의 이름, 값은 넷뿐(토큰 없음)
  assert.equal(PENDING_KEY, 'peaket.devices.reauth');
  assert.deepEqual(JSON.parse(s.m.get('peaket.devices.reauth')), { sessionId: SCANNER.sessionId, name: '현장 스캐너 서문-14', scope: 'scanner', at: 7777 });
  // 한 번 읽으면 지워진다(새로고침 뒤 다시 보내지 않는다)
  assert.deepEqual(takePending(s, 7777), { sessionId: SCANNER.sessionId, name: '현장 스캐너 서문-14', scope: 'scanner', at: 7777 });
  assert.equal(s.m.size, 0);
  assert.equal(takePending(s, 7777), null);
});

test('I-T90 ② 재인증 purpose는 스캐너 범위만 scanner-session-end이고 기기·이 기기의 다른 로그인은 session-end다', () => {
  assert.equal(reauthPurposeFor('scanner'), 'scanner-session-end');
  assert.equal(reauthPurposeFor('device'), 'session-end');
  assert.equal(reauthPurposeFor('others'), 'session-end');
});

test('I-T90 ③ 스캐너 세션 목록은 GET /v1/identity/scanner-sessions를 쿠키와 no-store로 부르고 줄을 그대로 준다', async () => {
  const ok = fakeFetch(() => json(200, { items: [SCANNER] }));
  assert.deepEqual(await createDevicesApi({ origin: 'https://api.test', fetch: ok }).listScanner(), { kind: 'ok', items: [SCANNER] });
  assert.equal(ok.calls[0].url, 'https://api.test/v1/identity/scanner-sessions');
  assert.equal(ok.calls[0].method, 'GET');
  assert.equal(ok.calls[0].credentials, 'include');
  assert.equal(ok.calls[0].cache, 'no-store');
  // lastSeenAt이 없으면 null, proxy가 없으면 false
  const bare = { ...SCANNER, lastSeenAt: undefined, proxy: undefined };
  const r = await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(200, { items: [bare] })) }).listScanner();
  assert.deepEqual(r, { kind: 'ok', items: [{ ...SCANNER, lastSeenAt: null, proxy: false }] });
  // 모양이 틀리면·5xx·끊김은 error, 401 뒤 갱신도 401은 login
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(200, { items: [{ ...SCANNER, role: 'admin' }] })) }).listScanner(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(503)) }).listScanner(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: async () => { throw new TypeError('끊김'); } }).listScanner(), { kind: 'error' });
  assert.deepEqual(await createDevicesApi({ origin: '', fetch: fakeFetch(() => json(401)) }).listScanner(), { kind: 'login' });
});

test('I-T90 ③ 스캐너 세션 끝내기는 DELETE /v1/identity/scanner-sessions/{id}에 X-Reauth-Token을 싣고 204·404·403·그 밖으로 가른다 [ASVS v5.0.0-7.5.2]', async () => {
  const done = fakeFetch(() => new Response(null, { status: 204 }));
  assert.deepEqual(await createDevicesApi({ origin: 'https://api.test', fetch: done }).endScanner(SCANNER.sessionId, 'tok-sc'), { kind: 'done' });
  assert.equal(done.calls[0].url, `https://api.test/v1/identity/scanner-sessions/${SCANNER.sessionId}`);
  assert.equal(done.calls[0].method, 'DELETE');
  assert.equal(done.calls[0].headers['x-reauth-token'], 'tok-sc');
  const api = (r) => createDevicesApi({ origin: '', fetch: fakeFetch(() => r) });
  assert.deepEqual(await api(problem(404, 'session-not-found')).endScanner('x', 't'), { kind: 'gone' });
  assert.deepEqual(await api(problem(403, 'reauth-required')).endScanner('x', 't'), { kind: 'reauth' });
  assert.deepEqual(await api(json(500)).endScanner('x', 't'), { kind: 'error' });
  // 범위 device·others의 끝내기는 지금처럼 /v1/identity/sessions/로 간다
  const dev = fakeFetch(() => new Response(null, { status: 204 }));
  await createDevicesApi({ origin: '', fetch: dev }).end(ROW.sessionId, 't');
  assert.equal(dev.calls[0].url, `/v1/identity/sessions/${ROW.sessionId}`);
});

test('I-T90 ① 스캐너 줄은 현장 스캐너 {기기 이름}(이름이 없으면 현장 스캐너)이고 스태프 세션 꼬리표를 단다', () => {
  assert.equal(scannerRowName({ deviceName: '서문-14' }), '현장 스캐너 서문-14');
  assert.equal(scannerRowName({ deviceName: null }), '현장 스캐너');
  assert.deepEqual(toScannerSessions([SCANNER, { ...SCANNER, sessionId: 'b', deviceName: null }]), [
    { id: SCANNER.sessionId, name: '현장 스캐너 서문-14', icon: 'scan', tag: '스태프 세션' },
    { id: 'b', name: '현장 스캐너', icon: 'scan', tag: '스태프 세션' },
  ]);
});

test('I-T90 ③ 스캐너 끝내기 결과 토스트: 204 끝냄·404 이미 끝남·그 밖은 잠시 뒤 다시(d5 §5.17)', () => {
  const t = { name: '현장 스캐너 서문-14', scope: 'scanner' };
  assert.deepEqual(endResultText({ kind: 'done' }, t), { text: '현장 스캐너 서문-14의 스태프 세션을 끝냈습니다', icon: 'ic-check' });
  assert.deepEqual(endResultText({ kind: 'gone' }, t), { text: '이미 끝난 스캐너 세션입니다', icon: 'ic-info' });
  assert.equal(endResultText({ kind: 'error' }, t).text, '지금은 로그아웃할 수 없습니다. 잠시 뒤 다시 시도해 주세요');
  assert.equal(endResultText({ kind: 'reauth' }, t), null);
});
