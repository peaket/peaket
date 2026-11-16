// next.config.ts의 serverExternalPackages 소스 시험(BAT-170 웨이브 끝 재검증 V170-R11, 2bf0a549, docs/frontend.md §5.18 '앱 서버 실행').
// 공유 캐시 처리기가 쓰는 redis와 그 하위 패키지 다섯은 서버 묶음 밖에 둔다. 운영 빌드가 필요한 test:build 시험(standalone-scm.build)보다 먼저 막는다.
// 시험 담당(l2w7-BAT170-test)이 썼다. 단언 값은 정본의 여섯 패키지다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('HOT-390 V170-R11 next.config.ts serverExternalPackages는 정본의 redis 여섯 패키지와 같다', () => {
  const src = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
  const m = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'next.config.ts에 serverExternalPackages가 없다');
  const got = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort();
  assert.deepEqual(got, ['@redis/bloom', '@redis/client', '@redis/json', '@redis/search', '@redis/time-series', 'redis']);
});
