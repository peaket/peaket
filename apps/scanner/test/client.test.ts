// F-05-4 스캐너 API 클라이언트의 기기 인증만 업로드와 401 가르기 시험(계획 docs/review/plans/F-05-4.md §4 api/client.ts(바꿈)·uploader.ts authErrorOf, O-T21 ③).
// 정본: docs/features/offline-gate.md §6.5 '업로드 첫 구현'(401은 WWW-Authenticate의 error로 가른다)·'무효·만료된 스태프 토큰이 붙은 업로드'(토큰 없이 기기 키 DPoP 증명만),
// RFC 9449(토큰이 없으면 증명에 ath 없음). fetch는 시험이 요청을 적는 대역이다(실제 서버 연결은 services/ticket-svc/test-int/scanner-f054.int.test.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ScannerApi as ScannerApiType, ScannerApiError as ScannerApiErrorType } from '../src/api/client.ts';
import { generateDpopKey } from '../src/api/dpop.ts';

const CLIENT = '../src/api/client.ts';
// client.ts는 동적으로 읽는다: Node 형식 벗기기로 읽지 못하는 문법(매개변수 속성·확장자 없는 가져오기)이면 각 시험이 이 단언에서 떨어진다
const client = (await import(CLIENT).catch(() => ({}))) as { ScannerApi?: typeof ScannerApiType; ScannerApiError?: typeof ScannerApiErrorType };
function api(): { ScannerApi: typeof ScannerApiType; ScannerApiError: typeof ScannerApiErrorType } {
  assert.equal(typeof client.ScannerApi, 'function', `${CLIENT}를 Node(node --test)가 읽지 못한다`);
  return client as { ScannerApi: typeof ScannerApiType; ScannerApiError: typeof ScannerApiErrorType };
}
type AuthErrorOf = (wwwAuthenticate: string | null) => 'invalid_token' | 'invalid_dpop_proof' | undefined;
const MODULE = '../src/sync/uploader.ts';
const loaded = (await import(MODULE).catch(() => ({}))) as { authErrorOf?: AuthErrorOf };
function authErrorOf(): AuthErrorOf {
  assert.equal(typeof loaded.authErrorOf, 'function', `${MODULE}의 authErrorOf가 없다`);
  return loaded.authErrorOf!;
}

const API = 'https://scanner-api.peaket.example';
const key = await generateDpopKey();
const payloadOf = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

function recording(status = 200, body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const calls: { url: string; init: RequestInit; headers: Headers }[] = [];
  const effective = body === undefined && status !== 204 ? { acceptedIds: [], resyncRequired: false, staleIds: [] } : body;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, headers: new Headers(init?.headers) });
    // 서버의 204는 본문이 없다(queue-reports). `recording(204, undefined)`도 빈 본문이어야 한다
    return new Response(effective === undefined ? null : JSON.stringify(effective), { status, headers });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** 토큰 칸을 빼고 만든다(계획 §4: ScannerApiOptions.token?) */
function apiWithout(fetchImpl: typeof fetch): ScannerApiType {
  return new (api().ScannerApi)({ origin: API, key, fetch: fetchImpl });
}

test('O-T21 ③ 토큰 없이 만든 ScannerApi의 업로드는 Authorization 머리가 없고, DPoP 증명에 ath가 없으며 자격 증명을 싣지 않는다', async () => {
  const r = recording();
  const scans = [{ id: 'a' }, { id: 'b' }];
  await apiWithout(r.fetch).uploadScans(scans);
  assert.equal(r.calls.length, 1);
  const c = r.calls[0]!;
  assert.equal(c.url, `${API}/v1/scanner/scans`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.headers.get('authorization'), null);
  const proof = c.headers.get('dpop');
  assert.ok(proof, 'DPoP 증명은 늘 싣는다');
  const p = payloadOf(proof);
  assert.equal(p.ath, undefined);
  assert.equal(p.htm, 'POST');
  assert.equal(p.htu, `${API}/v1/scanner/scans`);
  assert.equal(c.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(c.init.body)), scans);
});

// ---- F-05-12 SCR-052 실제 API·큐 비움 보고 ----
interface LiveMethods {
  queueReport(eventId: string, pendingUploads: number): Promise<void>;
  devices(eventId: string): Promise<Record<string, unknown>>;
  resolveFlag(flagId: string, status: 'OK' | 'SUSPECT' | 'UNDETERMINED', note?: string): Promise<void>;
  boothAuthorization(boothCode: string): Promise<Record<string, unknown>>;
  overridePasses(eventId: string): Promise<{ items: Record<string, unknown>[] }>;
}
const liveApi = (fetchImpl: typeof fetch): LiveMethods => apiWithout(fetchImpl) as unknown as LiveMethods; // type-escape: 메서드는 구현 뒤 생긴다

test('O-T29 ⑤ 큐 비움 보고는 PUT /v1/scanner/queue-reports/{eventId}에 pendingUploads 0을 싣고, 서버의 204 빈 본문을 그대로 받는다', async () => {
  // 서버는 204(본문 없음)로 답한다(openapi putScannerEventQueueReport). 200·JSON 대역은 #json으로 읽는 구현도 통과시킨다(TR-13)
  const r = recording(204, undefined, {});
  await liveApi(r.fetch).queueReport('ev-1', 0);
  assert.equal(r.calls.length, 1);
  const c = r.calls[0]!;
  assert.equal(c.url, `${API}/v1/scanner/queue-reports/ev-1`);
  assert.equal(c.init.method, 'PUT');
  assert.equal(c.headers.get('content-type'), 'application/json');
  assert.equal(c.headers.get('authorization'), null);
  assert.equal(c.init.credentials, 'omit');
  assert.deepEqual(JSON.parse(String(c.init.body)), { pendingUploads: 0 });
  const p = payloadOf(c.headers.get('dpop')!);
  assert.equal(p.htm, 'PUT');
  assert.equal(p.htu, `${API}/v1/scanner/queue-reports/ev-1`);
  assert.equal(p.ath, undefined);
});

test('SCR-052 API 메서드는 기기·부스·이상 표시·내 예외 통과 경로를 바르게 부르고 DPoP 증명의 htm·htu를 맞춘다', async () => {
  const status = { devices: [], entriesByZone: {}, rejectsByReason: {}, openFlags: 0, boothCount: 0, overrideCount: 0 };
  const r = recording(200, status);
  await liveApi(r.fetch).devices('ev-1');
  assert.equal(r.calls[0]!.url, `${API}/v1/scanner/events/ev-1/devices`);
  assert.equal(r.calls[0]!.init.method, 'GET');
  assert.equal(r.calls[0]!.init.credentials, 'omit');
  {
    const p = payloadOf(r.calls[0]!.headers.get('dpop')!);
    assert.equal(p.htm, 'GET');
    assert.equal(p.htu, `${API}/v1/scanner/events/ev-1/devices`);
    assert.equal(p.ath, undefined);
  }

  const r2 = recording(200, { ticketId: 't-1', seatLabel: 'R구역 12열 7번', allowUntil: '2026-11-26T03:10:00Z' });
  const auth = await liveApi(r2.fetch).boothAuthorization('K7QD2M9X');
  assert.deepEqual(auth, { ticketId: 't-1', seatLabel: 'R구역 12열 7번', allowUntil: '2026-11-26T03:10:00Z' });
  assert.equal(r2.calls[0]!.url, `${API}/v1/scanner/booth-authorizations`);
  assert.equal(r2.calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(r2.calls[0]!.init.body)), { boothCode: 'K7QD2M9X' });
  {
    const p = payloadOf(r2.calls[0]!.headers.get('dpop')!);
    assert.equal(p.htm, 'POST');
    assert.equal(p.htu, `${API}/v1/scanner/booth-authorizations`);
    assert.equal(p.ath, undefined);
  }

  const r3 = recording(200, { flagId: 'f-1', status: 'OK' });
  await liveApi(r3.fetch).resolveFlag('f-1', 'OK', '좌석 확인');
  assert.equal(r3.calls[0]!.url, `${API}/v1/scanner/flags/f-1/resolution`);
  assert.equal(r3.calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(r3.calls[0]!.init.body)), { status: 'OK', note: '좌석 확인' });
  {
    const p = payloadOf(r3.calls[0]!.headers.get('dpop')!);
    assert.equal(p.htm, 'POST');
    assert.equal(p.htu, `${API}/v1/scanner/flags/f-1/resolution`);
    assert.equal(p.ath, undefined);
  }

  const r4 = recording(200, { items: [] });
  assert.deepEqual(await liveApi(r4.fetch).overridePasses('ev-1'), { items: [] });
  assert.equal(r4.calls[0]!.url, `${API}/v1/scanner/events/ev-1/override-passes`);
  assert.equal(r4.calls[0]!.init.method, 'GET');
  {
    const p = payloadOf(r4.calls[0]!.headers.get('dpop')!);
    assert.equal(p.htm, 'GET');
    assert.equal(p.htu, `${API}/v1/scanner/events/ev-1/override-passes`);
    assert.equal(p.ath, undefined);
  }
});

test('O-T21 ③ 토큰이 있으면 Authorization: DPoP <토큰>과 ath를 싣는다(지금과 같다)', async () => {
  const r = recording();
  await new (api().ScannerApi)({ origin: API, key, token: 'staff-token', fetch: r.fetch }).uploadScans([{ id: 'a' }]);
  const c = r.calls[0]!;
  assert.equal(c.headers.get('authorization'), 'DPoP staff-token');
  assert.match(String(payloadOf(c.headers.get('dpop')!).ath), /^[A-Za-z0-9_-]{43}$/);
});

test('O-T21 ③ 다시 보낼 때마다 새 증명(다른 jti)을 만든다', async () => {
  const r = recording();
  const api = apiWithout(r.fetch);
  await api.uploadScans([{ id: 'a' }]);
  await api.uploadScans([{ id: 'a' }]);
  const [j1, j2] = r.calls.map((c) => payloadOf(c.headers.get('dpop')!).jti);
  assert.equal(typeof j1, 'string');
  assert.notEqual(j1, j2);
});

test('O-T21 ③ 401의 WWW-Authenticate error 값을 ScannerApiError.authError로 싣는다(invalid_token·invalid_dpop_proof·없음)', async () => {
  for (const [header, want] of [
    ['DPoP error="invalid_token", error_description="scanner session ended"', 'invalid_token'],
    ['DPoP algs="ES256", error="invalid_dpop_proof"', 'invalid_dpop_proof'],
    [undefined, undefined],
  ] as const) {
    const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
    if (header) headers['www-authenticate'] = header;
    const r = recording(401, { type: 'https://peaket.example/problems/unauthorized', title: '인증 필요', status: 401 }, headers);
    const err = await new (api().ScannerApi)({ origin: API, key, token: 'staff-token', fetch: r.fetch }).uploadScans([{ id: 'a' }]).then(
      () => assert.fail('401이면 던진다'),
      (e: unknown) => e,
    );
    assert.ok(err instanceof api().ScannerApiError);
    assert.equal(err.status, 401);
    assert.equal((err as ScannerApiErrorType & { authError?: string }).authError, want, String(header));
  }
});

test('O-T21 ③ authErrorOf는 DPoP 머리의 error 값 둘만 고르고 나머지는 undefined다', () => {
  const f = authErrorOf();
  assert.equal(f('DPoP error="invalid_token"'), 'invalid_token');
  assert.equal(f('DPoP algs="ES256", error="invalid_dpop_proof", error_description="x"'), 'invalid_dpop_proof');
  assert.equal(f('DPoP error="insufficient_scope"'), undefined);
  assert.equal(f('DPoP algs="ES256"'), undefined);
  assert.equal(f(''), undefined);
  assert.equal(f(null), undefined);
});
