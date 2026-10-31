#!/usr/bin/env node
// 바뀐 범위 고르기(docs/devops.md §3.1, 시험 D-T47, openspec 변경 add-ci-foundation).
// git diff --name-status <기준>...<머리>로 바뀐 파일을 읽어 범위마다 true/false를 낸다.
// 비교 기준이 없거나 git이 실패하면 모든 범위를 켠다(범위를 고르지 못하면 전체를 돈다).
// 쓰는 법: node tools/ci/changes.mjs --base <기준 커밋|가지> [--head HEAD]
//   GITHUB_OUTPUT이 있으면 범위마다 'name=true|false'를 쓰고, 없으면 JSON을 찍는다.
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const SCOPES = ['docs', 'contracts', 'js', 'js_all', 'data', 'infra', 'deploy', 'loadtest', 'tools', 'ci'];

// 경로 앞머리 → 범위. 한 파일이 여러 범위에 들 수 있다
const RULES = [
  [/^docs\/api\//, ['contracts', 'docs']],
  [/^(docs|openspec|\.claude|tools\/doc-check)\//, ['docs']],
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
  [/^loadtest\//, ['loadtest']],
  [/^tools\//, ['tools']],
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

function scopesFor(files) {
  const out = Object.fromEntries(SCOPES.map((s) => [s, false]));
  for (const { status, path: f } of files) {
    if (WIDEN_ALL.some((r) => r.test(f))) return all();
    // 지운 파일은 문서의 링크 대상이었을 수 있다. 링크 검사를 돌린다
    if (status === 'D') out.docs = true;
    for (const [re, scopes] of RULES) {
      if (re.test(f)) for (const s of scopes) out[s] = true;
    }
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
