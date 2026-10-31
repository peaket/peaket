// 서비스 안 구조의 층 의존 방향 규칙(docs/architecture.md §3.1 '서비스 안 구조의 기본값', 기술 검토 낮음-008,
// openspec 변경 add-service-structure-and-request-checks 결정 1). 공용 ESLint 설정(no-restricted-imports)이다.
// - 모듈(바운디드 컨텍스트) 하나: <컨텍스트>.module.ts(조립) 아래 inbound(받는 층) → application(유스케이스) → domain(업무 규칙·포트),
//   adapters(포트 구현). 의존은 안쪽으로만 향한다.
// - import 문자열로 본다(형만 가져오는 import와 다시 내보내기도 같다). 동적 import()는 보지 않는다.
// - 파서는 @typescript-eslint/parser(형 정보 없이 구문만). typescript-eslint 8.72가 TypeScript 6.1 미만만 지원해 이 패키지에 typescript 6.0.3을 둔다.
import tsParser from '@typescript-eslint/parser';

const layer = (names) => `(^|/)(${names.join('|')})(/|$)`;
// 다른 컨텍스트의 층 폴더를 직접 가져오기(../../<다른 컨텍스트>/<층>/…, ../../../modules/<컨텍스트>/<층>/…처럼 돌아가는 경로도).
// 위로 올라간 뒤 이름 하나 이상을 지나 층 폴더로 들어가면 막는다. 그 모듈의 공개 파일(index.ts)로만 가져온다
const OTHER_CONTEXT_LAYER = '(^|/)\\.\\.(/\\.\\.)*/([^/.][^/]*/)+(domain|application|inbound|adapters)(/|$)';
// 층 파일이 모듈 조립 파일(<컨텍스트>.module.ts)을 가져오기. 조립 파일은 모든 층을 가져오므로 돌아서 거꾸로 부르게 된다
const MODULE_FILE = { regex: '(^|/)[^/]+\\.module(\\.[cm]?js)?$', message: '층 파일은 모듈 조립 파일(<컨텍스트>.module.ts)을 가져오지 않는다(architecture §3.1)' };

const pkgs = (...names) => names.flatMap((n) => [n, `${n}/*`]);
const WEB_AND_STORE = pkgs('fastify', 'drizzle-orm', 'pg', '@peaket/contracts');
const FRAMEWORK = [...pkgs('@nestjs/common', '@nestjs/core', '@nestjs/platform-fastify', '@nestjs/swagger', '@peaket/platform'), '@nestjs/*', ...WEB_AND_STORE];

const rule = (patterns) => ['error', { patterns }];
const otherContext = { regex: OTHER_CONTEXT_LAYER, message: '다른 바운디드 컨텍스트의 층 폴더를 직접 가져오지 않는다. 그 모듈의 공개 파일(index.ts)로 가져온다(architecture §3.1)' };

/**
 * @param {string[]} moduleRoots 모듈 폴더들의 뿌리(예: 'services/*\/src/modules')
 * @returns {import('eslint').Linter.Config[]}
 */
export function serviceLayerConfigs(moduleRoots) {
  const under = (sub) => moduleRoots.map((r) => `${r}/*/${sub}/**/*.ts`);
  const base = { languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' } };
  return [
    { ...base, files: moduleRoots.map((r) => `${r}/**/*.ts`), rules: { 'no-restricted-imports': rule([otherContext]) } },
    {
      ...base,
      files: under('domain'),
      rules: {
        'no-restricted-imports': rule([
          otherContext,
          MODULE_FILE,
          { regex: layer(['application', 'inbound', 'adapters']), message: '도메인 층은 유스케이스·받는 층·어댑터를 가져오지 않는다(의존은 안쪽으로만, architecture §3.1)' },
          { group: FRAMEWORK, message: '도메인 층은 프레임워크와 저장소를 모른다. 바깥 의존은 도메인이 정한 포트(인터페이스) 뒤 어댑터로 붙인다(architecture §3.1)' },
        ]),
      },
    },
    {
      ...base,
      files: under('application'),
      rules: {
        'no-restricted-imports': rule([
          otherContext,
          MODULE_FILE,
          { regex: layer(['inbound', 'adapters']), message: '유스케이스 층은 받는 층과 어댑터를 가져오지 않는다. 어댑터는 포트로만 쓴다(architecture §3.1)' },
          { group: WEB_AND_STORE, message: '유스케이스 층은 웹 서버·저장소·계약 생성물을 직접 쓰지 않는다(포트 뒤 어댑터와 받는 층이 쓴다)' },
        ]),
      },
    },
    {
      ...base,
      files: under('inbound'),
      rules: {
        'no-restricted-imports': rule([
          otherContext,
          MODULE_FILE,
          { regex: layer(['adapters']), message: '받는 층은 어댑터를 가져오지 않는다. 유스케이스를 부른다(architecture §3.1)' },
        ]),
      },
    },
    {
      ...base,
      files: under('adapters'),
      rules: {
        'no-restricted-imports': rule([
          otherContext,
          MODULE_FILE,
          { regex: layer(['inbound', 'application']), message: '어댑터는 도메인의 포트를 구현할 뿐 받는 층과 유스케이스를 가져오지 않는다(architecture §3.1)' },
        ]),
      },
    },
  ];
}
