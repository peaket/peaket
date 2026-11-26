// F-04-16 콘솔 주소 아래 /forensics 페이지의 응답 헤더 시험. 정본: docs/frontend.md §5.14.1('2단계: 콘솔 묶음 C에 COEP require-corp를
// 이 경로에만 더한다'), docs/features/forensic-replay.md §6.8(헤더·배포), docs/security/asvs/forensic-replay.md v5.0.0-3.4.8·3.5.4.
// 헤더 생성기는 packages/config가 정본이고, 이 시험은 그 값이 콘솔 경로에서 실제로 쓰이는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const headers = await import('@peaket/config/headers/security-headers.mjs');

test('[ASVS v5.0.0-3.4.8] [ASVS v5.0.0-3.5.4] 콘솔 /forensics 경로는 묶음 C에 COEP require-corp를 더하고 COOP same-origin을 유지한다', () => {
  assert.equal(typeof headers.consoleForensicsHeaders, 'function', 'consoleForensicsHeaders가 없다');
  const h = headers.consoleForensicsHeaders();
  assert.equal(h['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(h['Referrer-Policy'], 'no-referrer');
  assert.match(h['Content-Security-Policy'], /connect-src[^;]*ops-api/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);

  // 시험·시연 빌드는 따로 연 공개 위치의 묶음 G다. connect-src가 'self'뿐이고 COEP는 있다
  const demo = headers.staticAppHeaders('forensics');
  assert.match(demo['Content-Security-Policy'], /connect-src 'self'/);
  assert.doesNotMatch(demo['Content-Security-Policy'], /ops-api/);
  assert.equal(demo['Cross-Origin-Embedder-Policy'], 'require-corp');
  assert.notEqual(h['Content-Security-Policy'], demo['Content-Security-Policy']);
});
