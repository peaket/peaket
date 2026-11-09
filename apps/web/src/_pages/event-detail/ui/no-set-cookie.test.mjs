// 공연 상세는 CDN이 캐시하는 화면이라 사람마다 다른 쿠키를 싣지 않는다(Q-T39 ④, ADR-0065 결정 9).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

function sources(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.tsx?$/.test(n) ? [p] : [];
  });
}

test('[Q-T39] ④공연 상세 코드는 Set-Cookie를 쓰지 않는다', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const f of sources(root)) {
    const text = readFileSync(f, 'utf8');
    assert.doesNotMatch(text, /Set-Cookie|cookies\(\)\.set|response\.cookies/i, f);
  }
});
