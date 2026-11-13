#!/usr/bin/env node
// 바뀐 범위 고르기(docs/devops.md §3.1, 시험 D-T47, openspec 변경 add-ci-foundation).
// git diff --name-status <기준>...<머리>로 바뀐 파일을 읽어 범위마다 true/false를 낸다.
// 비교 기준이 없거나 git이 실패하면 모든 범위를 켠다(범위를 고르지 못하면 전체를 돈다).
// 쓰는 법: node tools/ci/changes.mjs --base <기준 커밋|가지> [--head HEAD]
//   GITHUB_OUTPUT이 있으면 범위마다 'name=true|false'를 쓰고, 없으면 JSON을 찍는다.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const SCOPES = ['docs', 'contracts', 'js', 'js_all', 'data', 'infra', 'deploy', 'loadtest', 'tools', 'ci', 'kind', 'image', 'specs', 'specs_full', 'web'];

// 경로 앞머리 → 범위. 한 파일이 여러 범위에 들 수 있다
const RULES = [
  [/^docs\/api\//, ['contracts', 'docs']],
  [/^(docs|\.claude|tools\/doc-check)\//, ['docs']],
  // 문서 점검(tools/doc-check)이 읽는 파일: tools/와 점으로 시작하는 폴더 밖의 .md·.yaml·.json·.csv
  [/^(?!tools\/)(?!(?:.*\/)?\.).*\.(md|yaml|json|csv)$/, ['docs']],
  [/^packages\/contracts\//, ['contracts', 'js']],
  // 서비스는 계약을 지키는 쪽이고(서비스 OpenAPI 차이 D-T38), 계약 깨짐 검사 도구와 그 워크플로가 바뀌면 실제 도구로 다시 돌린다.
  // 서비스 문서를 뽑는 서비스 템플릿(packages/platform)과 비교 본체(service-openapi.mjs)가 바뀌어도 다시 돌린다(add-service-template)
  [/^(services\/|packages\/platform\/|tools\/ci\/(contract-breaking|release-tags|service-openapi)\.mjs$|\.github\/workflows\/contract-check\.yml$)/, ['contracts']],
  // 서비스 템플릿 시험이 지연 칸 목록을 이 문서와 견주고(metrics.test.ts), 계약 전체 대조 시험이 비교 본체를 쓴다(contract-sweep.test.ts)
  [/^(docs\/observability\.md|tools\/ci\/service-openapi\.mjs)$/, ['js']],
  [/^(apps|services|packages)\//, ['js']],
  [/^data\//, ['data']],
  [/^infra\//, ['infra']],
  [/^deploy\//, ['deploy']],
  // 로컬 kind 클러스터 시험(ci-kind.yml): 클러스터 정의·공용 차트·클러스터 도구, 서비스 이미지에 드는 것 전부(플랫폼 패키지와 서비스 뼈대,
  // 공용 설정 패키지, 작업 공간 파일)(openspec 변경 add-local-cluster-and-relay-deployment). 무거운 잡이라 화면·문서 변경에는 돌지 않고,
  // develop 푸시에서는 늘 돈다
  [
    /^(deploy\/(local|charts)\/|tools\/local\/|\.dockerignore$|\.github\/workflows\/ci-kind\.yml$|packages\/(platform|config)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)/,
    ['kind'],
  ],
  // v0 배포(docs/infra.md §3 'v0 배포', BUILD_ORDER BSL-050): v0 이미지에 드는 배포 단위와 로컬 환경 값, 이미지 빌드 단계의 바인딩 대조
  [/^(services\/(v0-monolith|pg-simulator|payment-svc)\/|deploy\/envs\/local\/|tools\/ci\/verify-native-binding\.mjs$)/, ['kind']],
  // 이미지 빌드 시험(build-image.yml, docs/devops.md §3.2 '이미지 빌드 시험(푸시 없이)'): 이미지가 있는 배포 단위와 그 Dockerfile이 담는
  // 작업 공간 패키지, 작업 공간 파일, 빌드 맥락 규칙(.dockerignore)·Node 판, 이 워크플로와 그 스크립트(BSL-050). 빌드 잡의 이미지 비밀 검사가 쓰는
  // 고정 표·판정 도구·비밀 규칙 설정도 그 스크립트다(BAS-011 ②, ADR-0263 결정 7)
  [
    /^(services\/(v0-monolith|pg-simulator|payment-svc|bundle|queue-svc|admission-ctrl|purchase-svc|ops-svc)\/|services\/invariant-checker\/package\.json$|packages\/(platform|config|contracts|shuffle)\/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|\.dockerignore$|\.nvmrc$|\.github\/workflows\/build-image\.yml$|tools\/ci\/(image-build|image-smoke|verify-native-binding|scan-tools|scan-gate|vuln-deadline|entry)\.mjs$|tools\/ci\/(trivy-secret\.yaml|scan-exceptions\.json)$)/,
    ['image'],
  ],
  // 부하 시험 점검(loadtest-check.yml, docs/verification.md §3.9, BSL-060): 시나리오와 실행 도구, 그리고 그 시험이 견주는 것
  // (서버의 조회 간격·좌석 ID, 검사기 기록 형식, 장부 요약 파일, 토큰 서명·클러스터 도구, v1 무대 도구·구매 요청 서명 벡터)과 이 워크플로
  [
    /^(loadtest\/|services\/v0-monolith\/src\/modules\/queue\/domain\/polling\.ts$|services\/v0-monolith\/src\/modules\/inventory\/domain\/inventory\.ts$|services\/invariant-checker\/src\/records\.ts$|services\/v0-monolith\/src\/gateway\/token\.ts$|deploy\/envs\/local\/v0-gateway\.yaml$|tools\/perf-ledger\/(k6-summary\.js|collect\.py|ledgerlib\.py)$|tools\/local\/(cluster|tools|v0-token|v1-stage|v1-objects)\.mjs$|docs\/api\/vectors\/purchase-request-mac\.v1\.json$|\.github\/workflows\/loadtest-check\.yml$)/,
    ['loadtest'],
  ],
  // 규칙 모델 검사(spec-check.yml, wbs 0.9.1): 명세·검사 도구·그 워크플로가 바뀌면 형식 검사와 시뮬레이션(docs/verification.md §2.2).
  // 모델 기반 시험의 명령 이름 목록·재생 기록(services/*/test-int/*-model/, specs.json의 mbt)이 바뀌어도 이름 목록 검사를 돌린다(wbs 2.3.4, V-T40)
  [/^(specs\/|tools\/spec-check\/|\.github\/workflows\/spec-check\.yml$|services\/[^/]+\/test-int\/[a-z0-9-]+-model\/)/, ['specs']],
  // 화면 잡(ci-web.yml, docs/devops.md §3.1, BUILD_ORDER BAS-170): 화면 앱·화면용 패키지, 그 검사가 읽는 정본(토큰·d2 대비표·
  // frontend 예산 표), 화면 브라우저 검사 도구, 이 워크플로, 작업 공간 파일(잠금 파일이 바뀌면 화면 의존성도 바뀐다).
  // 좌석맵 패키지는 세 엔진 검사(seatmap-pkg 잡, BUILD_ORDER HOT-120)가 본다. 구매 세션 서명기 원본과 서버와 같은 시험 벡터는
  // 서명기 세 엔진 검사(purchase 잡, HOT-360 ①, ADR-0221 결정 7)가 본다
  [
    /^(apps\/|packages\/(ds|config|seatmap)\/|packages\/api-client\/src\/purchase\/|services\/core-svc\/test-int\/fixtures\/seatmap-editor\/|docs\/api\/vectors\/|docs\/design\/(tokens\.json|d2-design-system\.md)$|docs\/frontend\.md$|tools\/web-checks\/|tools\/storybook\/|\.github\/workflows\/ci-web\.yml$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|turbo\.json$|\.nvmrc$)/,
    ['web'],
  ],
  // 신뢰 정책 예외 검사(tools-check, check-trust-exceptions.mjs, ADR-0191)가 보는 작업 공간 파일과 그 예외 표가 바뀌어도 돌린다
  [/^tools\/|(^|\/)pnpm-workspace\.yaml$|^docs\/devops\.md$/, ['tools']],
  [/^\.github\//, ['ci']],
];
// 넓게 쓰이는 것: 기대는 배포 단위 전부를 돌린다(§3.1 2번)
// 자바스크립트 검사가 도는 방식(ci-node.yml, turbo.json, Node 판 .nvmrc)이 바뀌어도 전부를 돌린다(add-service-template).
// 뿌리 ESLint 설정과 공용 설정 패키지(@peaket/config)도 같다(add-service-structure-and-request-checks)
const WIDEN_JS = [
  /^packages\/platform\//, /^packages\/contracts\//, /^docs\/api\//, /^package\.json$/, /^pnpm-lock\.yaml$/, /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/, /^\.nvmrc$/, /^\.github\/workflows\/ci-node\.yml$/, /^eslint\.config\.mjs$/, /^packages\/config\//,
];
// 검사 절차 자체가 바뀌면 모든 범위를 돌린다
const WIDEN_ALL = [/^\.github\/workflows\/ci\.yml$/, /^tools\/ci\/changes\.mjs$/];

const all = () => Object.fromEntries(SCOPES.map((s) => [s, true]));

// 명세 목록(specs/specs.json)이 적은 관련 ADR. 이 ADR이 바뀌면 전수 검사를 돌린다(docs/verification.md §2.2). 목록이 없으면 빈 목록
function specAdrs() {
  try {
    return new Set(JSON.parse(readFileSync('specs/specs.json', 'utf8')).specs.flatMap((s) => s.adrs ?? []));
  } catch {
    return new Set();
  }
}

function scopesFor(files) {
  const out = Object.fromEntries(SCOPES.map((s) => [s, false]));
  const adrs = specAdrs();
  for (const { status, path: f } of files) {
    if (WIDEN_ALL.some((r) => r.test(f))) return all();
    // 지운 파일은 문서의 링크 대상이었을 수 있다. 링크 검사를 돌린다
    if (status === 'D') out.docs = true;
    for (const [re, scopes] of RULES) {
      if (re.test(f)) for (const s of scopes) out[s] = true;
    }
    const adr = f.match(/^docs\/adr\/(\d{4})-/);
    if (adr && adrs.has(adr[1])) out.specs_full = true;
    if (WIDEN_JS.some((r) => r.test(f))) {
      out.js = true;
      out.js_all = true;
    }
  }
  return out;
}

function changedFiles(base, head) {
  if (!base || /^0+$/.test(base)) return null; // 새 가지의 첫 푸시처럼 기준이 없다
  try {
    // --no-renames: 옮긴 파일은 옛 경로의 지움(D)과 새 경로의 더함(A)으로 센다
    const out = execFileSync('git', ['diff', '--name-status', '--no-renames', `${base}...${head}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.split('\n').filter(Boolean).map((l) => {
      const [status, path] = l.split('\t');
      return { status: status[0], path };
    });
  } catch {
    return null;
  }
}

const { values } = parseArgs({ options: { base: { type: 'string', default: '' }, head: { type: 'string', default: 'HEAD' } } });
const files = changedFiles(values.base, values.head);
const scopes = files === null ? all() : scopesFor(files);
const reason = files === null ? '비교 기준이 없거나 git diff가 실패해 전체를 고름' : `바뀐 파일 ${files.length}개`;
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, SCOPES.map((s) => `${s}=${scopes[s]}`).join('\n') + '\n');
  console.log(`${reason}: ${SCOPES.filter((s) => scopes[s]).join(', ') || '(없음)'}`);
} else {
  console.log(JSON.stringify({ reason, scopes }));
}
