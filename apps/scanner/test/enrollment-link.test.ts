// F-05-5 스캐너 앱: 관제 콘솔 SCR-053 등록 QR(/enroll#code=…)을 받는 함수와 스캐너 API의 자격 증명·DPoP 증명 시험.
// 정본: docs/features/offline-gate.md §6.1 'GAT-170 마감 규칙'(조각 code·주소창에서 지움·저장하지 않음)·O-T37 ①⑧,
// 계획 docs/review/plans/F-05-5.md §5(enrollmentCodeFromHash·stripEnrollmentFragment의 모양). 실행: node --test(이 작업 공간 폴더 기준).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrollmentCodeFromHash, stripEnrollmentFragment } from '../src/api/enrollment-link.ts';
import { enrollDevice } from '../src/api/device-login.ts';
import { dpopProof, generateDpopKey, jktOf } from '../src/api/dpop.ts';

const API = 'https://scanner-api.peaket.example';

function recordingFetch(status: number, body: unknown): { fetch: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const partOf = (jwt: string, i: 0 | 1): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[i]!, 'base64url').toString('utf8')) as Record<string, unknown>;

test('O-T37 ① 등록 QR 조각 #code=에서 등록 코드를 꺼낸다(URL 인코딩은 푼다)', () => {
  assert.equal(enrollmentCodeFromHash('#code=KDTW-BMQX-HLRP'), 'KDTW-BMQX-HLRP');
  assert.equal(enrollmentCodeFromHash('#code=KDTW%2DBMQX%2DHLRP'), 'KDTW-BMQX-HLRP');
  assert.equal(enrollmentCodeFromHash('#code=kdtw%20bmqx%20hlrp'), 'kdtw bmqx hlrp');
});

test('O-T37 ① 조각에 code가 없거나 비었거나 64자를 넘으면 undefined다(64자는 받는다)', () => {
  assert.equal(enrollmentCodeFromHash(''), undefined);
  assert.equal(enrollmentCodeFromHash('#'), undefined);
  assert.equal(enrollmentCodeFromHash('#code='), undefined);
  assert.equal(enrollmentCodeFromHash('#x=1'), undefined);
  assert.equal(enrollmentCodeFromHash(`#code=${'B'.repeat(64)}`), 'B'.repeat(64));
  assert.equal(enrollmentCodeFromHash(`#code=${'B'.repeat(65)}`), undefined);
});

test('O-T37 ① 조각에 code가 있으면 주소창을 경로+검색어로 한 번 바꿔 조각을 지운다', () => {
  const calls: string[] = [];
  stripEnrollmentFragment({ pathname: '/enroll', search: '', hash: '#code=KDTW-BMQX-HLRP' }, (u) => void calls.push(u));
  assert.deepEqual(calls, ['/enroll']);
  const withQuery: string[] = [];
  stripEnrollmentFragment({ pathname: '/enroll', search: '?lang=ko', hash: '#code=KDTW-BMQX-HLRP' }, (u) => void withQuery.push(u));
  assert.deepEqual(withQuery, ['/enroll?lang=ko']);
});

test('O-T37 ① 조각에 code가 없으면 주소창을 건드리지 않는다', () => {
  const calls: string[] = [];
  stripEnrollmentFragment({ pathname: '/enroll', search: '', hash: '' }, (u) => void calls.push(u));
  stripEnrollmentFragment({ pathname: '/enroll', search: '?live=1', hash: '#x=1' }, (u) => void calls.push(u));
  assert.deepEqual(calls, []);
});

test('O-T37 ① 기기 등록 요청은 자격 증명 없이(credentials omit) JSON 본문과 DPoP 증명만 보낸다', async () => {
  const key = await generateDpopKey();
  const f = recordingFetch(201, { deviceId: 'dev-1' });
  assert.deepEqual(await enrollDevice({ origin: API, key, code: 'KDTW-BMQX-HLRP', fetch: f.fetch }), { deviceId: 'dev-1' });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0]!;
  assert.equal(c.url, `${API}/v1/scanner/device-enrollments`);
  assert.equal(c.init.credentials, 'omit');
  const headers = c.init.headers as Record<string, string>;
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.cookie, undefined);
  assert.deepEqual(JSON.parse(String(c.init.body)), { code: 'KDTW-BMQX-HLRP' });
  assert.equal(partOf(headers.dpop!, 1).htu, `${API}/v1/scanner/device-enrollments`);
});

// ScannerApi(client.ts)는 node --test의 형식 지우기만으로 읽히지 않아(매개변수 속성) 같은 증명 함수 dpopProof로 본다.
// 업로드 경로의 실제 서버 통과(같은 키의 새 증명 셋이 모두 200)는 services/ticket-svc/test-int/scanner-f055.int.test.ts가 본다.
test('O-T37 ⑧ 같은 기기 키로 만든 업로드 증명 두 개는 jti가 서로 다르고 헤더 jwk 지문이 그 기기 키다', async () => {
  const key = await generateDpopKey();
  const url = `${API}/v1/scanner/scans`;
  const proofs = [
    await dpopProof({ key, method: 'POST', url, token: 'staff-token', nowMs: Date.parse('2026-11-23T03:00:00.000Z') }),
    await dpopProof({ key, method: 'POST', url, nowMs: Date.parse('2026-11-23T03:00:00.000Z') }),
  ];
  const [a, b] = proofs.map((p) => ({ header: partOf(p, 0), payload: partOf(p, 1) }));
  assert.notEqual(a!.payload.jti, b!.payload.jti);
  assert.equal(await jktOf(a!.header.jwk as JsonWebKey), key.jkt);
  assert.equal(await jktOf(b!.header.jwk as JsonWebKey), key.jkt);
  for (const x of [a!, b!]) {
    assert.equal(x.payload.htm, 'POST');
    assert.equal(x.payload.htu, url);
  }
});
