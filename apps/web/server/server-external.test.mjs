// next.config.ts의 serverExternalPackages 소스 시험(BAT-170 웨이브 끝 재검증 V170-R11, 2bf0a549, docs/frontend.md §5.18 '앱 서버 실행').
// 공유 캐시 처리기가 쓰는 redis와 그 하위 패키지 다섯, 앱 서버 텔레메트리를 시작하는 @peaket/platform(HOT-400)과 그것이 가져오는 OTel SDK 여섯은 서버 묶음 밖에 둔다.
// 운영 빌드가 필요한 test:build 시험(standalone-scm.build)보다 먼저 막는다.
// 시험 담당(l2w7-BAT170-test)이 썼고, W8-L1-ci-fix2 시험 담당이 CF2-01(키 하나)을 더하고 V170-R11을 CF2-02(일곱)로 고쳤다.
// W8-L1-ci-fix4 시험 담당이 CF2-02를 CF4-01(열셋)로 고치고 CF4-02(OTel 여섯의 직접 의존성 판)를 더했다(계획 docs/review/plans/W8-L1-ci-fix4.md §5).
// 같은 키를 두 번 쓰면 자바스크립트 객체에서 뒤의 값이 앞을 조용히 덮는다(2026-11-16 develop CI에서 redis가 서버 묶음에 들어간 까닭).
// 단언 값은 정본(docs/frontend.md §5.18)과 계획 docs/review/plans/W8-L1-ci-fix2.md §2의 1·W8-L1-ci-fix4.md §2의 1에서 가져왔다.
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

/** serverExternalPackages 배열의 이름들(소스 차례). 키가 하나임을 먼저 본다(키가 둘이면 실제 값은 뒤의 것이다, 리뷰 RV-1·검증 M-33) */
function externalNames() {
  const src = configSource();
  assert.equal((src.match(KEY) ?? []).length, 1, 'serverExternalPackages 키가 하나가 아니라 첫 배열을 실제 값으로 볼 수 없다');
  const m = /['"]?\bserverExternalPackages['"]?\s*:\s*\[([^\]]*)\]/.exec(src);
  assert.ok(m, 'next.config.ts에 serverExternalPackages 배열이 없다');
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

/** 정본 docs/frontend.md §5.18 '앱 서버 실행'의 OTel SDK 여섯(W8-L1-ci-fix4 계획 §2의 1) */
const OTEL_SIX = [
  '@opentelemetry/api',
  '@opentelemetry/core',
  '@opentelemetry/exporter-trace-otlp-proto',
  '@opentelemetry/resources',
  '@opentelemetry/sdk-node',
  '@opentelemetry/sdk-trace',
];

// W8-L1-ci-fix4 시험 담당이 CF2-02(일곱)를 CF4-01(열셋)로 고쳤다. 정본이 OTel SDK 여섯을 같은 배열에 넣도록 바뀌었다(계획 §2의 2)
test('CF4-01 HOT-390·HOT-400 serverExternalPackages는 정본의 redis 여섯, @peaket/platform, OTel SDK 여섯이다', () => {
  const got = externalNames().sort();
  // 정렬해 견준다. 하나가 빠지거나 같은 이름을 두 번 적어도 실패한다
  const want = ['redis', '@redis/client', '@redis/bloom', '@redis/json', '@redis/search', '@redis/time-series', '@peaket/platform', ...OTEL_SIX].sort();
  assert.deepEqual(got, want);
});

/** package.json의 dependencies(devDependencies는 보지 않는다: 운영 설치·SBOM --prod에서 빠진다, 계획 M-07) */
const depsOf = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).dependencies ?? {};

test('CF4-02 HOT-400 밖에 두는 OTel 패키지는 web의 직접 의존성이고 판 적기가 platform과 글자까지 같다', () => {
  const otel = externalNames().filter((n) => n.startsWith('@opentelemetry/'));
  // 빈 통과 막기: 밖에 두는 OTel 이름이 하나도 없으면 실패한다
  assert.ok(otel.length > 0, 'serverExternalPackages에 @opentelemetry/ 이름이 하나도 없다');
  const web = depsOf('../package.json');
  const platform = depsOf('../../../packages/platform/package.json');
  for (const name of otel) {
    // 판 글자는 시험에 적지 않고 packages/platform/package.json에서 읽어 견준다(계획 §5)
    assert.equal(typeof platform[name], 'string', `${name}이 packages/platform/package.json dependencies에 없다(platform이 가져오는 SDK가 아니다)`);
    assert.equal(typeof web[name], 'string', `${name}이 apps/web/package.json dependencies에 없다(직접 의존성이어야 Turbopack이 앱 폴더에서 찾아 밖에 둔다)`);
    assert.equal(web[name], platform[name], `${name} 판 적기가 다르다: web ${web[name]}, platform ${platform[name]}`);
  }
});
