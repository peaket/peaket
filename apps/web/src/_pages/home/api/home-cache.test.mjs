// 홈 ISR 태그를 비우는 내부 처리기(HOT-305, ADR-0199 결정 3, docs/features/search.md §2.4).
// core-svc가 홈 구성 저장·판매 승인 뒤 부른다. 토큰이 맞을 때만 revalidateTag('home')을 한 번 부르고 204·no-store다.
// 기준 트리에서는 이 모듈이 없어 시험이 실패한다(새 동작이 아직 없다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHomeCacheHandler } from './home-cache.ts';

const url = 'http://localhost/internal/v1/home-cache';
const request = (method = 'POST', token) =>
  new Request(url, { method, ...(token === undefined ? {} : { headers: { 'x-peaket-internal-token': token } }) });

test('HOT-305 홈 캐시 처리기는 토큰이 맞을 때만 revalidateTag("home")을 한 번 부르고 204·no-store다', async () => {
  const calls = [];
  const handler = createHomeCacheHandler({ revalidate: (tag) => calls.push(tag), token: 'secret' });

  const ok = await handler(request('POST', 'secret'));
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, ['home']);

  const again = await handler(request('POST', 'secret'));
  assert.equal(again.status, 204);
  assert.deepEqual(calls, ['home', 'home']);

  // Fetch Headers는 앞뒤 공백을 지운다. 헤더 값이 'secret '이어도 실제로는 'secret'이라 204다(TR-01).
  const trimmed = await handler(request('POST', 'secret '));
  assert.equal(trimmed.status, 204);
  assert.deepEqual(calls, ['home', 'home', 'home']);
});

test('HOT-305 홈 캐시 처리기는 토큰이 없거나 틀리면 401·no-store이고 revalidateTag를 부르지 않는다 [ASVS v5.0.0-8.1.1]', async () => {
  const calls = [];
  const handler = createHomeCacheHandler({ revalidate: (tag) => calls.push(tag), token: 'secret' });

  for (const token of [undefined, '', 'wrong', 'secret2', 'Secret']) {
    const r = await handler(request('POST', token));
    assert.equal(r.status, 401, String(token));
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, []);
});

test('HOT-305 홈 캐시 처리기는 토큰 설정이 비었거나 다른 메서드면 거절하고 no-store다 [ASVS v5.0.0-14.2.5]', async () => {
  const calls = [];
  const unconfigured = createHomeCacheHandler({ revalidate: (tag) => calls.push(tag), token: undefined });
  const noToken = await unconfigured(request('POST', 'secret'));
  assert.equal(noToken.status, 401);
  assert.equal(noToken.headers.get('cache-control'), 'no-store');

  const handler = createHomeCacheHandler({ revalidate: (tag) => calls.push(tag), token: 'secret' });
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const r = await handler(request(method, 'secret'));
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, []);
});

test('HOT-305 app/internal/v1/home-cache/route.ts가 revalidateTag("home")과 내부 토큰을 실제 인자로 처리기에 넘긴다', () => {
  // 계획 I-04의 배선을 소스로 고정한다(TR-08·TR-20). 처리기만 만들고 경로를 만들거나,
  // POST가 직접 revalidateTag를 부르고 처리기에 no-op을 넘기는 구현을 잡는다.
  const route = readFileSync(new URL('../../../../app/internal/v1/home-cache/route.ts', import.meta.url), 'utf8');
  assert.match(route, /import\s*\{\s*revalidateTag\s*\}\s*from\s*['"]next\/cache['"]/);
  assert.match(route, /createHomeCacheHandler\s*\(\s*\{[\s\S]*?revalidate\s*:\s*revalidateTag\b[\s\S]*?token\s*:\s*process\.env\.PEAKET_INTERNAL_TOKEN\b[\s\S]*?\}\s*\)/);
  assert.match(route, /export\s+(?:const\s+POST\s*=\s*[A-Za-z_$][\w$]*|(?:async\s+)?function\s+POST)/);
  // 토큰 확인 전에 매 POST마다 홈 캐시를 비우는 직접 호출이 없어야 한다.
  assert.doesNotMatch(route, /(?:^|\n)\s*revalidateTag\s*\(/);
});
