// 파일 편집 훅 규칙(ADR-0330 결정 4·5). 실행 파일은 guard-edit.mjs(편집 전)와 post-edit.mjs(편집 뒤)다.
// 편집 전: 생성 파일과 다른 잠금 파일을 손으로 고치지 못하게 막는다(CLAUDE.md 절대 규칙 '생성 파일은 생성기로만').
// 편집 뒤: 원천을 고쳤으면 돌릴 생성기·빌드·타입 검사를 알린다(세션마다 한 번).
import fs from 'node:fs';
import { deny, note, relPath, firstInSession } from './lib.mjs';

// 생성 폴더·파일과 그것을 만드는 명령. 머리줄 표시('생성 파일이다')가 없는 생성물(코드·JSON)은 여기 적는다
const GENERATED = [
  [/^packages\/contracts\/src\/gen\//, '원천 docs/api/(openapi·asyncapi·proto)를 고치고 `pnpm --filter @peaket/contracts gen`'],
  [/^packages\/api-client\/src\/gen\//, '원천 docs/api/openapi.yaml을 고치고 `pnpm --filter @peaket/api-client gen`'],
  [/^packages\/ds\/src\/gen\//, '원천 docs/design/tokens.json을 고치고 `pnpm --filter @peaket/ds tokens`'],
  // 대시보드는 주인 팀 폴더 아래에 있다(deploy/local/dashboards/<폴더>/<이름>.json, ADR-0356 결정 1)
  [/^deploy\/local\/dashboards\/.+\.json$/, '생성기 tools/local/dashboards.mjs를 고치고(대상은 docs/architecture.md §3.1, 폴더는 .github/CODEOWNERS) `node tools/local/dashboards.mjs`'],
];
// 머리줄(#! 줄 다음 첫 줄)이 이 꼴이면 생성 파일이다. 게이트웨이 라우트·메시 정책·Kyverno 정책이 이 표시를 단다
const MARKER = /^\s*(?:#|\/\/|\/\*)\s*생성 파일이다/;
const OTHER_LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']);

function headerLine(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const lines = buf.subarray(0, n).toString('utf8').split(/\r?\n/);
    return lines[0].startsWith('#!') ? (lines[1] ?? '') : lines[0];
  } catch {
    return '';
  }
}

const filePathOf = (input) => input?.tool_input?.file_path ?? input?.tool_input?.notebook_path ?? null;

export function preEdit(input) {
  const file = filePathOf(input);
  const rel = relPath(file);
  if (!rel || rel.includes('node_modules/')) return null;
  const base = rel.split('/').pop();
  if (OTHER_LOCKS.has(base)) {
    return deny(`${base}는 만들지 않는다. 이 저장소의 잠금 파일은 pnpm-lock.yaml뿐이다(docs/devops.md §4.4)`);
  }
  if (base === 'pnpm-lock.yaml') {
    return deny('pnpm-lock.yaml은 손으로 고치지 않는다. package.json을 고치고 그 작업 공간 뿌리에서 pnpm install을 돌린다(docs/devops.md §4.4)');
  }
  for (const [re, how] of GENERATED) {
    if (re.test(rel)) return deny(`${rel}은 생성 파일이다. 손으로 고치지 않는다(CLAUDE.md 절대 규칙): ${how}`);
  }
  const head = headerLine(file);
  if (MARKER.test(head)) {
    return deny(`${rel}은 생성 파일이다. 머리줄이 원천과 생성기를 알려 준다: ${head.trim().slice(0, 400)}`);
  }
  return null;
}

// 고친 원천 → 알림 열쇠와 할 일
const FOLLOW_UPS = [
  [/^docs\/api\/openapi\.yaml$/, 'openapi', 'docs/api/openapi.yaml을 고쳤다. 커밋 전에 생성물을 함께 만든다(CLAUDE.md): `pnpm --filter @peaket/contracts gen`, `pnpm --filter @peaket/api-client gen`, 게이트웨이 라우트 `node tools/ci/gateway-routes.mjs --write`, 그 뒤 `node tools/ci/mesh-policies.mjs --check`'],
  [/^docs\/api\/asyncapi\.yaml$/, 'asyncapi', 'docs/api/asyncapi.yaml을 고쳤다. 커밋 전에 `pnpm --filter @peaket/contracts gen`으로 생성물을 함께 만든다(CLAUDE.md)'],
  [/^docs\/api\/proto\//, 'proto', 'docs/api/proto를 고쳤다. 커밋 전에 `pnpm --filter @peaket/contracts gen`과 메시 정책 `node tools/ci/mesh-policies.mjs --write`를 돌린다(ADR-0285)'],
  [/^deploy\/gateways\/routes\//, 'gateway-routes', '게이트웨이 라우트 원천을 고쳤다. `node tools/ci/gateway-routes.mjs --write`로 deploy/gateways/*.routes.yaml을 다시 만들고 `node tools/ci/mesh-policies.mjs --check`를 본다'],
  [/^deploy\/platform\/mesh\/port-allow\.yaml$/, 'mesh', '메시 포트 허용 원천을 고쳤다. `node tools/ci/mesh-policies.mjs --write`로 생성 정책을 다시 만든다(ADR-0285)'],
  [/^deploy\/policies\/kyverno\/policy-values\.yaml$/, 'kyverno', 'Kyverno 정책 원천을 고쳤다. `node tools/ci/kyverno-policies.mjs --write`로 환경별 정책을 다시 만든다(ADR-0318)'],
  [/^docs\/design\/tokens\.json$/, 'tokens', '디자인 토큰 원천을 고쳤다. `pnpm --filter @peaket/ds tokens`로 packages/ds/src/gen을 다시 만든다(CLAUDE.md)'],
  [/^(?:docs\/architecture\.md|\.github\/CODEOWNERS)$/, 'dashboards-source', '대시보드 대상(§3.1 서비스 맵)이나 주인 팀(CODEOWNERS)이 바뀌었을 수 있다. `node tools/local/dashboards.mjs`로 다시 만들고 `node tools/ci/observability-config.mjs --check`를 본다(ADR-0356 결정 1)'],
  [/^packages\/platform\/src\/metrics\.ts$/, 'dashboards','서비스 지표 목록을 고쳤다. 로컬 대시보드는 `node tools/local/dashboards.mjs`로 다시 만든다(CLAUDE.md)'],
  [/^packages\/platform\/src\//, 'platform', 'packages/platform을 고쳤다. 서비스는 빌드된 dist/를 읽으므로 서비스 쪽 타입 검사·시험 전에 `pnpm exec turbo run build --filter=@peaket/platform`을 돌린다(CLAUDE.md)'],
  [/^packages\/seatmap\/src\//, 'seatmap', 'packages/seatmap/src를 고쳤다. core-svc 통합 시험이 이 원본을 상대 경로로 읽으므로(--affected가 못 잡는다) `pnpm exec turbo run typecheck --filter=@peaket/core-svc`도 돌린다(CLAUDE.md)'],
  [/^services\/(payment-svc|pg-simulator)\/src\//, 'purchase-imports', 'payment-svc·pg-simulator 원본을 고쳤다. purchase-svc 시험이 이 원본을 상대 경로로 읽으므로(--affected가 못 잡는다) `pnpm exec turbo run typecheck --filter=@peaket/purchase-svc`도 돌린다(CLAUDE.md)'],
];

export function postEdit(input) {
  const rel = relPath(filePathOf(input));
  if (!rel) return null;
  const notes = FOLLOW_UPS.filter(([re]) => re.test(rel))
    .filter(([, key]) => firstInSession(input?.session_id, `edit-${key}`))
    .map(([, , text]) => text);
  return notes.length ? note(notes.join('\n')) : null;
}
