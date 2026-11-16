// next.config.ts의 serverExternalPackages 소스 시험(BAT-170 웨이브 끝 재검증 V170-R11, 2bf0a549, docs/frontend.md §5.18 '앱 서버 실행').
// 공유 캐시 처리기가 쓰는 redis와 그 하위 패키지 다섯, 앱 서버 텔레메트리를 시작하는 @peaket/platform(HOT-400)은 서버 묶음 밖에 둔다.
// 운영 빌드가 필요한 test:build 시험(standalone-scm.build)보다 먼저 막는다.
// 시험 담당(l2w7-BAT170-test)이 썼고, W8-L1-ci-fix2 시험 담당이 CF2-01(키 하나)을 더하고 V170-R11을 CF2-02(일곱)로 고쳤다.
// 같은 키를 두 번 쓰면 자바스크립트 객체에서 뒤의 값이 앞을 조용히 덮는다(2026-11-16 develop CI에서 redis가 서버 묶음에 들어간 까닭).
// 단언 값은 정본(docs/frontend.md §5.18)과 계획 docs/review/plans/W8-L1-ci-fix2.md §2의 1에서 가져왔다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * 앞머리가 `//`인 줄(줄 주석)을 버린 next.config.ts 소스. 블록 주석은 지우지 않는다(리뷰 RV-1: 줄 주석 안의 `/_q/*` 같은 글자가
 * 뒤쪽의 별표·빗금과 짝지어져 그 사이 진짜 코드가 지워질 수 있다). 블록 주석 안에 키 글자가 생기면 더 세어 실패 쪽으로 기운다
 */
function configSource() {
  const src = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
  return src
    .split(/\r?\n/)
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

/** 따옴표를 붙인 꼴(`'serverExternalPackages':`, 검증 M-33)까지 센다. 자바스크립트는 둘을 같은 키로 보고 뒤의 것이 앞을 덮는다 */
const KEY = /['"]?\bserverExternalPackages['"]?\s*:/g;

test('CF2-01 HOT-390·HOT-400 next.config.ts의 설정 객체에 serverExternalPackages 키는 하나다', () => {
  const keys = configSource().match(KEY) ?? [];
  assert.equal(keys.length, 1, `serverExternalPackages 키가 ${keys.length}번 나온다(하나여야 한다. 둘이면 뒤의 것이 앞을 덮는다)`);
});

test('CF2-02 HOT-390 V170-R11·HOT-400 serverExternalPackages는 정본의 redis 여섯과 @peaket/platform이다', () => {
  const src = configSource();
  // 아래는 첫 배열만 읽으므로 키가 하나임을 먼저 본다(키가 둘이면 실제 값은 뒤의 것이다, 리뷰 RV-1·검증 M-33)
  assert.equal((src.match(KEY) ?? []).length, 1, 'serverExternalPackages 키가 하나가 아니라 첫 배열을 실제 값으로 볼 수 없다');
  const m = /['"]?\bserverExternalPackages['"]?\s*:\s*\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'next.config.ts에 serverExternalPackages 배열이 없다');
  const got = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).sort();
  // 정렬해 견준다. 하나가 빠지거나 같은 이름을 두 번 적어도 실패한다
  assert.deepEqual(got, ['@peaket/platform', '@redis/bloom', '@redis/client', '@redis/json', '@redis/search', '@redis/time-series', 'redis']);
});
