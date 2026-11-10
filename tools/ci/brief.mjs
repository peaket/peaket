#!/usr/bin/env node
// 묶음 지시서(ADR-0256 결정 9 '읽는 양 줄이기', docs/architecture.md §8.6). 기능 묶음 하나를 맡는 담당(구현·리뷰·틀린 구현 검사)에게 줄
// 읽을 범위를 정본에서 바로 뽑아 마크다운 한 장으로 낸다. 정본을 요약해 다시 쓰지 않는다: 정본의 위치(문서:줄)와 원문 조각만 보인다.
// 차례: 1 묶음(docs/BUILD_ORDER.md '기능 묶음' 표의 행) 2 단계 줄(원문 전체) 3 판정 항목(완성 장부 범위. ledger.mjs --batch와 같은 셈)
//   4 정본 자리 5 코드 자리 6 닿을 CI 잡 7 자주 놓친 결함(docs/architecture.md의 목록. 실행할 때마다 읽는다) 8 읽기 규칙
// ID: 묶음의 단계 ID, 범위 안 항목의 시험·요구사항 ID와 범위 칸의 시험·FR·NFR·POL, 단계 줄에 적힌 시험·FR·NFR·POL·SCR·ADR 번호,
//   단계 줄의 낱말 가운데 docs/api/openapi.yaml의 operationId나 docs/api/proto의 rpc 이름과 같은 것(계약 작업).
//   단계 줄의 'docs/…md §N'은 그 절의 시작·끝 줄로 적는다. 단계와 범위 칸·단계 줄에 이름이 적힌 ID는 4·5에서 앞에 둔다
//   (자리는 ID의 원천 문서, 묶음 범위의 문서, 나머지 문서 차례로 고른다)
// 정본 문서: ledger.mjs의 정본(docs/**/*.md에서 review·walkthrough·lanes·adr·wbs 폴더와 progress-archive·PROGRESS·BUILD_ORDER·00-summary를
//   뺀 것)에 docs/api/openapi.yaml·asyncapi.yaml·proto/**와 단계 줄이 가리킨 번호의 docs/adr 파일을 더한다. ID 하나에 30곳까지 적는다
// 코드: git grep -n -F로 apps/ services/ packages/ tools/ loadtest/ specs/를 찾는다(node_modules·dist·.next·생성물 gen/ 뺌). -F는 글자로 찾으므로
//   ID 경계를 다시 본다(P-T2는 P-T20에, FR-001은 NFR-001에 걸리지 않는다). tools/ci 아래에서 첫 줄에 '// asvs-report: ignore' 표시가 있는
//   파일(도구 시험 자료)은 뺀다(ledger.mjs와 같다). 파일 40개까지 적는다
// CI 잡 표(JOBS·CI_AREAS)의 근거(2026-11-10): .github/workflows/ci.yml(범위 잡 changes와 범위마다 부르는 워크플로), tools/ci/changes.mjs의
//   RULES(경로 → 범위)·WIDEN_JS(node 전체), ci-node.yml(node: typecheck·test·build·lint와 통합 시험 단계), ci-web.yml(tokens·visual·queue-room·
//   purchase·rich-text·ds·seed-css·budgets·seatmap-pkg. 잡마다 빌드·검사하는 앱과 패키지), contract-check.yml(contracts), docs-check.yml(docs),
//   tools-check.yml(tools), loadtest-check.yml(loadtest), spec-check.yml(spec), ci-kind.yml(kind), build-image.yml(build).
//   영역 → 잡은 그 영역을 직접 빌드·검사하는 잡이다. web 범위가 켜지면 ci-web.yml의 잡 아홉이 모두 도는 것은 따로 알린다.
//   brief.test.mjs가 잡 이름과 통합 시험 패키지가 실제 워크플로에 있는지 본다
// 크기: MAX_CHARS(6만 자)를 넘으면 LEVELS 차례로 3·4·5를 줄이고 끝 '줄임'에 줄인 것을 적는다(항목 이름, 정본 자리의 문서 경로·줄 번호는 남긴다)
// 쓰는 법: node tools/ci/brief.mjs --batch <묶음 ID> [--out <파일>] [--root <저장소>]
//   --out이 없으면 표준 출력에 쓴다. 있으면 그 파일에 쓰고 요약 한 줄(글자 수, 판정 항목·정본 자리·코드 파일 수)을 찍는다
// 끝 코드: 0 만듦, 2 오류(없는 묶음·단계 줄, 범위 토큰·notes 오류, 자주 놓친 결함 목록 없음, git grep 실패, 인자)
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, judge, selectScope, tables, plain, refsIn, isTestFile, IGNORE, STATUSES } from './ledger.mjs';

export const MAX_CHARS = 60000;
const FILES = {
  build: 'docs/BUILD_ORDER.md',
  arch: 'docs/architecture.md',
  openapi: 'docs/api/openapi.yaml',
  api: ['docs/api/openapi.yaml', 'docs/api/asyncapi.yaml'],
  proto: 'docs/api/proto',
  adr: 'docs/adr',
  req: 'docs/planning/02-requirements.md',
  pol: 'docs/planning/03-policies-glossary.md',
};
const CODE_ROOTS = ['apps', 'services', 'packages', 'tools', 'loadtest', 'specs'];
const CODE_SKIP = ['node_modules', 'dist', '.next', 'gen'];
const GRADES = ['A', 'B', 'C'];
/** 남은 항목(이 묶음이 채울 것): 이 상태이거나 notes의 정할 곳이 이 묶음의 단계다 */
const OPEN = new Set(['빈칸', 'ID만', '미검증']);
const REQ_ID = /^(?:N?FR|POL)-\d{3}$/;
const SCEN_ID = /^[A-Z]{1,3}-T\d+$/;

/**
 * 줄이는 차례(앞의 것부터 겹쳐 쓴다). crit: 남은 항목의 판정 기준 글자 수(0이면 칸을 뺀다), restCrit: 나머지 항목의 것,
 * heads: 정본 자리에 제목을 단다, idCap: ID마다 적는 정본 자리 수, fileCap: 코드 파일 수, restRows: 나머지 항목을 행으로 적는다
 */
const LEVELS = [
  { crit: 300, restCrit: 300, heads: true, idCap: 30, fileCap: 40, restRows: true },
  { restCrit: 0, note: '나머지 항목(남은 항목이 아닌 것)의 판정 기준 글을 뺐다(원천 문서:줄은 남김)' },
  { heads: false, note: '정본 자리의 제목을 빼고 ID마다 한 줄로 적었다(문서 경로·줄 번호는 남김)' },
  { crit: 120, note: '남은 항목의 판정 기준을 앞 120자로 줄였다' },
  { fileCap: 20, note: '코드 자리를 앞 20개 파일로 줄였다' },
  { crit: 0, note: '남은 항목의 판정 기준 글도 뺐다(원천 문서:줄은 남김)' },
  { restRows: false, note: '나머지 항목은 상태별 항목 이름 목록으로 적었다' },
  { idCap: 10, note: '정본 자리를 ID마다 앞 10곳으로 줄였다(나머지는 문서별 곳 수)' },
];

export class BriefError extends Error {}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const split = (text) => text.replaceAll('\r\n', '\n').split('\n');
/** 글자 수(코드 포인트) */
const len = (s) => [...s].length;
const num = (n) => n.toLocaleString('en-US');
const uniq = (xs) => [...new Set(xs)];
/** 이웃한 같은 키끼리 묶는다 */
function runs(xs, key) {
  const out = [];
  for (const x of xs) {
    const last = out.at(-1);
    if (last && key(last[0]) === key(x)) last.push(x);
    else out.push([x]);
  }
  return out;
}
/** 표 칸에 넣을 글: 원문 그대로 두되 줄바꿈은 빈칸으로, 이스케이프하지 않은 '|'는 '\|'로 */
const cellSafe = (s) => String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/(?<!\\)\|/g, '\\|');

// ---------- 묶음 표·단계 줄 ----------
/** '기능 묶음' 표의 행: { line, text, head, cells(칸 이름 → 원문), steps, scope }. 없으면 BriefError */
export function batchRow(buildText, batchId) {
  let found = false;
  for (const t of tables(buildText)) {
    if (t.head[0] !== '묶음' || !t.head.includes('장부 범위')) continue;
    found = true;
    const row = t.rows.find((r) => plain(r.cells[0] ?? '') === batchId);
    if (!row) continue;
    const cells = Object.fromEntries(t.head.map((h, k) => [h, row.cells[k] ?? '']));
    const steps = plain(cells['단계'] ?? '').split(/[·,\s]+/).filter(Boolean);
    return { line: row.line, text: row.text, head: t.head, cells, steps, scope: cells['장부 범위'] ?? '' };
  }
  throw new BriefError(found ? `${FILES.build} 기능 묶음 표에 ${batchId} 행이 없다` : `${FILES.build}에 기능 묶음 표(머리 '| 묶음 | … | 장부 범위 | … |')가 없다`);
}

/** 단계 줄(체크 칸이 있는 목록 줄. 들여 쓴 줄도): [{ id, line, text }]. 줄이 없는 단계는 BriefError */
export function stepLines(buildText, steps) {
  const ls = split(buildText);
  const out = [];
  for (const id of steps) {
    const re = new RegExp(`^\\s*- \\[[ xX]\\] ${esc(id)}(?![\\w-])`);
    const hits = ls.flatMap((l, i) => (re.test(l) ? [{ id, line: i + 1, text: l }] : []));
    if (!hits.length) throw new BriefError(`${FILES.build}에 ${id}의 단계 줄('- [ ] ${id} …')이 없다`);
    out.push(...hits);
  }
  return out;
}

// ---------- ID ----------
/** 낱말: ID 꼴(P-T2, FE-T44, HOT-070, NFR-001, SCR-012, ADR-0184)이나 이름(extendHold). 앞이 영문·숫자·_·$가 아닐 때만 */
const TOKEN = /(?<![\w$])(?:[A-Z]{1,4}-T?\d+|[A-Za-z_$][\w$]*)/g;
const tokens = (text) => uniq([...text.matchAll(TOKEN)].map((m) => m[0]));

/** 줄에 나오는 ID: 낱말 경계로 자른 낱말이 ids에 있는 것과, FR·NFR·POL 범위('FR-005~011')를 펼친 것 */
export function idsInLine(line, ids) {
  const out = new Set();
  for (const m of line.matchAll(TOKEN)) if (ids.has(m[0])) out.add(m[0]);
  if (/(?:FR|POL)-\d/.test(line)) for (const r of refsIn(line)) if (ids.has(r)) out.add(r);
  return out;
}

/** openapi.yaml의 operationId 집합 */
export function operationIds(yamlText) {
  return new Set([...yamlText.matchAll(/^\s*operationId:\s*['"]?([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
}

/** proto의 rpc 이름 집합(gRPC 계약 작업. operationId처럼 단계 줄의 낱말과 견준다) */
export function rpcNames(protoText) {
  return new Set([...protoText.matchAll(/^\s*rpc\s+(\w+)\s*\(/gm)].map((m) => m[1]));
}

const SECTION_REF = /(?<![\w/.-])(docs\/[\w./-]+\.md) §(\d+(?:\.\d+)*)((?:·§\d+(?:\.\d+)*)*)/g;

/** 단계 줄이 가리키는 것: { tests, reqs, screens, adrs, operations(opIds에 있는 낱말), sections: [{ doc, num }] } (나온 차례) */
export function stepRefs(texts, opIds = new Set()) {
  const all = texts.join('\n');
  const words = tokens(all);
  const sections = [];
  for (const m of all.matchAll(SECTION_REF)) {
    for (const n of [m[2], ...[...m[3].matchAll(/§(\d+(?:\.\d+)*)/g)].map((x) => x[1])]) {
      if (!sections.some((s) => s.doc === m[1] && s.num === n)) sections.push({ doc: m[1], num: n });
    }
  }
  return {
    tests: words.filter((w) => SCEN_ID.test(w)),
    reqs: uniq(texts.flatMap((t) => refsIn(t))),
    screens: words.filter((w) => /^SCR-\d{3}$/.test(w)),
    adrs: words.filter((w) => /^ADR-\d{4}$/.test(w)),
    operations: words.filter((w) => opIds.has(w)),
    sections,
  };
}

// ---------- 제목 ----------
const cleanTitle = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').trim();

/** md 제목: [{ line, level, title }]. 코드 펜스 안은 건너뛴다 */
function headings(text) {
  const out = [];
  let fence = false;
  split(text).forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) out.push({ line: i + 1, level: m[1].length, title: cleanTitle(m[2]) });
  });
  return out;
}

/** 줄 번호 → 가장 가까운 제목. md: 그 줄이나 위의 '#' 제목(펜스 밖), YAML: 들여쓰기 4칸까지의 부모 키 경로, proto: 위의 service·message·enum·rpc */
export function headingIndex(path, text) {
  const ls = split(text);
  const at = new Array(ls.length + 1).fill('');
  if (path.endsWith('.md')) {
    const hs = headings(text);
    let k = -1;
    for (let i = 1; i <= ls.length; i++) {
      while (k + 1 < hs.length && hs[k + 1].line <= i) k++;
      at[i] = k >= 0 ? hs[k].title : '';
    }
  } else if (/\.ya?ml$/.test(path)) {
    const keys = new Map();
    let block = -1;
    ls.forEach((l, i) => {
      const indent = /^ */.exec(l)[0].length;
      if (block >= 0 && (!l.trim() || indent > block)) {
        at[i + 1] = title(keys);
        return;
      }
      block = -1;
      const m = /^( {0,4})((?:'[^']*'|"[^"]*"|[^\s#'"-][^:#]*?)):(?:\s+(.*))?$/.exec(l);
      if (m) {
        for (const k of [...keys.keys()]) if (k >= indent) keys.delete(k);
        const value = (m[3] ?? '').trim();
        if (!value || value.startsWith('#')) keys.set(indent, m[2].replace(/^['"]|['"]$/g, ''));
        else if (/^[|>][-+0-9]*\s*(#.*)?$/.test(value)) {
          keys.set(indent, m[2].replace(/^['"]|['"]$/g, ''));
          block = indent;
        }
      }
      at[i + 1] = title(keys);
    });
  } else if (path.endsWith('.proto')) {
    let cur = '';
    ls.forEach((l, i) => {
      const m = /^\s*(service|message|enum|rpc)\s+(\w+)/.exec(l);
      if (m) cur = `${m[1]} ${m[2]}`;
      at[i + 1] = cur;
    });
  }
  return (line) => at[line] ?? '';
}
const title = (keys) => [...keys].sort((a, b) => a[0] - b[0]).map(([, k]) => k).join(' › ');

/** md 문서의 '§N' 절: { start, end, title, level } | null. 제목이 'N.'·'N '·'§N'으로 시작하는 첫 제목부터 같거나 높은 단계의 다음 제목 앞까지(끝 빈 줄 뺌) */
export function sectionRange(text, n) {
  const hs = headings(text);
  const re = new RegExp(`^§?\\s*${esc(n)}(?:\\.(?!\\d)|\\s|$)`);
  const k = hs.findIndex((h) => re.test(h.title));
  if (k < 0) return null;
  const h = hs[k];
  const ls = split(text);
  const next = hs.slice(k + 1).find((x) => x.level <= h.level);
  let end = next ? next.line - 1 : ls.length;
  while (end > h.line && !ls[end - 1].trim()) end--;
  return { start: h.line, end, title: h.title, level: h.level };
}

// ---------- 자리 ----------
/** 정본 자리: id → [{ doc, line, heading }] (docs 차례, 줄 차례) */
export function canonSpots(docs, ids) {
  const out = new Map([...ids].map((id) => [id, []]));
  for (const { path, text } of docs) {
    const hits = [];
    split(text).forEach((l, i) => {
      for (const id of idsInLine(l, ids)) hits.push([id, i + 1]);
    });
    if (!hits.length) continue;
    const head = headingIndex(path, text);
    for (const [id, line] of hits) out.get(id).push({ doc: path, line, heading: head(line) });
  }
  return out;
}

/** 코드 자리: [{ file, test, lines: [{ line, ids }] }]. git grep -n -F로 찾고 ID 경계는 idsInLine으로 다시 본다 */
export function codeSpots(root, ids) {
  if (!ids.size) return [];
  const args = ['-c', 'core.quotepath=false', 'grep', '-n', '-I', '--no-color', '-F', ...[...ids].flatMap((id) => ['-e', id]), '--', ...CODE_ROOTS, ...CODE_SKIP.map((d) => `:(exclude,glob)**/${d}/**`)];
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.error || (r.status !== 0 && r.status !== 1)) throw new BriefError(`git grep 실패: ${(r.stderr || r.error?.message || '').trim()}`);
  const files = new Map();
  for (const l of r.stdout.split('\n')) {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (!m) continue;
    const found = idsInLine(m[3], ids);
    if (!found.size) continue;
    if (!files.has(m[1])) files.set(m[1], { file: m[1], test: isTestFile(m[1]), lines: [] });
    files.get(m[1]).lines.push({ line: Number(m[2]), ids: [...found] });
  }
  // 도구 시험 자료(첫 줄의 '// asvs-report: ignore')는 뺀다. ledger.mjs가 시험 이름을 읽을 때와 같다
  const fixture = (f) => f.startsWith('tools/ci/') && IGNORE.test(readFileSync(join(root, f), 'utf8'));
  return [...files.values()].filter((f) => !fixture(f.file));
}

// ---------- CI 잡 ----------
/** 잡: 'ci.yml의 부르는 잡 / 불리는 워크플로의 잡'(GitHub 검사 목록의 이름) → 워크플로 파일과 하는 일 */
export const JOBS = {
  'node / node': { file: 'ci-node.yml', what: 'typecheck·test·build(바뀐 패키지와 그것에 기대는 패키지)·lint, 서비스 통합 시험' },
  'contract-check / contracts': { file: 'contract-check.yml', what: '계약 생성물 대조(contracts gen:check·test, api-client test)·계약 깨짐·서비스 OpenAPI 차이(D-T38)' },
  'docs-check / docs': { file: 'docs-check.yml', what: '문서 점검(tools/doc-check/check_all.py)과 그 도구 시험' },
  'tools-check / tools': { file: 'tools-check.yml', what: 'node --test tools/ci·edge·pg-smoke·perf-ledger, 워크플로·CODEOWNERS·작업 공간 규칙 검사' },
  'loadtest-check / loadtest': { file: 'loadtest-check.yml', what: 'loadtest/test 시험과 k6 형식 검사' },
  'spec-check / spec': { file: 'spec-check.yml', what: '명세 형식 검사·시뮬레이션과 모델 기반 시험의 명세 이름·재생 기록 대조' },
  'kind / kind': { file: 'ci-kind.yml', what: '로컬 kind 클러스터 시험(무겁다. develop 푸시에서는 늘 돈다)' },
  'image / build': { file: 'build-image.yml', what: '이미지 빌드와 네트워크 없는 스모크(v0-monolith·pg-simulator·example-svc)' },
  'web / tokens': { file: 'ci-web.yml', what: '토큰 생성물 차이·형식 FE-T45·대비표 FE-T44(@peaket/ds test)' },
  'web / visual': { file: 'ci-web.yml', what: '시각 비교 FE-T40(대기실 셸·ds Storybook)과 tools/web-checks 시험' },
  'web / queue-room': { file: 'ci-web.yml', what: '대기실 T=0 세 엔진(FE-T3·FE-T15·FE-T4·FE-T6)' },
  'web / purchase': { file: 'ci-web.yml', what: '구매 세션 서명기 세 엔진(FE-T7)' },
  'web / rich-text': { file: 'ci-web.yml', what: '공연 설명 편집기(FE-T41, 파트너 콘솔 빌드)' },
  'web / ds': { file: 'ci-web.yml', what: 'ds 부품 axe·동작(FE-T18)' },
  'web / seed-css': { file: 'ci-web.yml', what: 'SEED CSS 층(FE-T36, 앱 다섯 PoC 빌드)' },
  'web / budgets': { file: 'ci-web.yml', what: '운영 빌드의 경로별 첫 JS 예산·Lighthouse·대기실 FE-T1·CSP(FE-T35·FE-T30)·정적 자산, @peaket/config 정본 대조' },
  'web / seatmap-pkg': { file: 'ci-web.yml', what: '좌석맵 패키지 세 엔진' },
};

/** ci-node.yml이 통합 시험(pnpm --filter @peaket/<이름> test:integration)을 따로 도는 패키지 */
export const INT_PACKAGES = ['platform', 'identity-svc', 'core-svc', 'payment-svc', 'queue-svc', 'trust-svc', 'admission-ctrl', 'purchase-svc'];

/** 영역 이름: 경로의 앞 두 마디(둘째 마디가 파일이면 첫 마디. services/README.md → services) */
const top2 = (p) => {
  const s = p.split('/');
  return s.length > 2 ? `${s[0]}/${s[1]}` : s[0];
};
/**
 * 영역 → 잡: [경로, 영역 이름(경로 → 이름), 잡]. 앞의 것이 먼저다. 그 영역을 직접 빌드·검사하는 잡만 적는다
 * (changes.mjs의 RULES가 켜는 범위와 그 범위가 부르는 워크플로의 잡 가운데, 잡 단계가 그 영역을 빌드하거나 시험하는 것)
 */
export const CI_AREAS = [
  [/^apps\/web\/queue-room\//, () => 'apps/web/queue-room', ['web / queue-room', 'web / visual', 'web / budgets', 'node / node']],
  [/^apps\/web\//, top2, ['web / budgets', 'web / seed-css', 'node / node']],
  [/^apps\/partner\//, top2, ['web / rich-text', 'web / budgets', 'web / seed-css', 'node / node']],
  [/^apps\/(console-host|scanner|forensics)\//, top2, ['web / budgets', 'web / seed-css', 'node / node']],
  [/^apps\//, top2, ['node / node']],
  [/^packages\/ds\//, top2, ['web / tokens', 'web / visual', 'web / ds', 'node / node']],
  [/^packages\/seatmap\//, top2, ['web / seatmap-pkg', 'node / node']],
  [/^packages\/api-client\/src\/purchase\//, () => 'packages/api-client/src/purchase', ['web / purchase', 'contract-check / contracts', 'node / node']],
  [/^packages\/(api-client|contracts)\//, top2, ['contract-check / contracts', 'node / node']],
  [/^packages\/platform\//, top2, ['node / node', 'contract-check / contracts', 'kind / kind', 'image / build']],
  [/^packages\/config\//, top2, ['node / node', 'web / budgets', 'kind / kind', 'image / build']],
  [/^packages\//, top2, ['node / node']],
  [/^services\/[^/]+\/test-int\/[a-z0-9-]+-model\//, top2, ['spec-check / spec', 'node / node', 'contract-check / contracts']],
  [/^services\/(v0-monolith|pg-simulator|payment-svc)\//, top2, ['node / node', 'contract-check / contracts', 'kind / kind', 'image / build']],
  [/^services\//, top2, ['node / node', 'contract-check / contracts']],
  [/^(specs|tools\/spec-check)\//, (p) => /^(specs|tools\/spec-check)/.exec(p)[1], ['spec-check / spec']],
  [/^tools\/local\//, top2, ['kind / kind', 'tools-check / tools']],
  [/^tools\/doc-check\//, top2, ['docs-check / docs']],
  [/^tools\/(web-checks|storybook)\//, top2, ['web / visual']],
  [/^tools\//, top2, ['tools-check / tools']],
  [/^loadtest\//, () => 'loadtest', ['loadtest-check / loadtest']],
  [/^docs\/api\//, () => 'docs/api', ['contract-check / contracts', 'docs-check / docs', 'node / node']],
  [/^docs\/(frontend\.md|design\/(tokens\.json|d2-design-system\.md))$/, (p) => p, ['web / budgets', 'docs-check / docs']],
  [/^docs\/observability\.md$/, (p) => p, ['node / node', 'docs-check / docs']],
  [/^docs\/devops\.md$/, (p) => p, ['tools-check / tools', 'docs-check / docs']],
  [/^docs\//, () => 'docs', ['docs-check / docs']],
];
/** changes.mjs의 web 규칙 가운데 찾는 범위에 드는 것: 이 경로가 바뀌면 ci-web.yml의 잡 아홉이 모두 돈다 */
const WEB_SCOPE = /^(apps\/|packages\/(ds|config|seatmap)\/|packages\/api-client\/src\/purchase\/|docs\/api\/vectors\/|docs\/design\/(tokens\.json|d2-design-system\.md)$|docs\/frontend\.md$|tools\/web-checks\/|tools\/storybook\/)/;
/** changes.mjs의 문서 점검 규칙: tools/와 점으로 시작하는 폴더 밖의 .md·.yaml·.json·.csv는 docs-check가 읽는다 */
const DOC_CHECKED = /^(?!tools\/)(?!(?:.*\/)?\.).*\.(md|yaml|json|csv)$/;
/** changes.mjs의 WIDEN_JS 가운데 찾는 범위에 드는 것: 이 경로가 바뀌면 node 잡이 전체를 돈다 */
const WIDEN_JS = /^(packages\/(platform|contracts|config)\/|docs\/api\/)/;

/**
 * 닿을 CI 잡. paths: [{ path, kind: 'code'|'doc', count(코드는 줄 수, 정본은 곳 수) }], specAdrs: specs/specs.json이 적은 ADR 번호.
 * 돌려줌: { rows: [{ area, code, files, docs, jobs, extra }], notes, legend }
 */
export function ciJobs(paths, specAdrs = new Set()) {
  const rows = new Map();
  for (const p of [...paths].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rule = CI_AREAS.find(([re]) => re.test(p.path));
    if (!rule) continue;
    const area = rule[1](p.path);
    const jobs = [...rule[2]];
    if (p.kind === 'code' && DOC_CHECKED.test(p.path)) jobs.push('docs-check / docs');
    const adr = /^docs\/adr\/(\d{4})-/.exec(p.path);
    if (adr && specAdrs.has(adr[1])) jobs.unshift('spec-check / spec');
    if (!rows.has(area)) rows.set(area, { area, code: 0, files: 0, docs: 0, jobs: [], extra: new Set(), kind: p.kind });
    const row = rows.get(area);
    if (p.kind === 'code') {
      row.code += p.count;
      row.files++;
    } else row.docs += p.count;
    for (const j of jobs) if (!row.jobs.includes(j)) row.jobs.push(j);
    const pkg = /^(?:services|packages)\/([^/]+)\//.exec(p.path)?.[1];
    if (pkg && INT_PACKAGES.includes(pkg)) row.extra.add(`통합 시험 \`pnpm --filter @peaket/${pkg} test:integration\``);
    if (adr && specAdrs.has(adr[1])) row.extra.add(`ADR-${adr[1]}은 명세 목록(specs/specs.json)이 적은 ADR이라 spec-check가 전수 검사(full)를 돈다`);
  }
  const order = (r) => (r.kind === 'code' ? 0 : 1);
  const out = [...rows.values()]
    .sort((a, b) => order(a) - order(b) || (a.area < b.area ? -1 : a.area > b.area ? 1 : 0))
    .map((r) => ({ area: r.area, code: r.code, files: r.files, docs: r.docs, jobs: r.jobs, extra: [...r.extra].join('; ') }));
  const notes = [];
  if (paths.some((p) => WEB_SCOPE.test(p.path))) {
    notes.push('web 범위(tools/ci/changes.mjs의 web 규칙)에 드는 곳이 있어 그곳을 고치면 ci-web.yml의 잡 아홉(tokens·visual·queue-room·purchase·rich-text·ds·seed-css·budgets·seatmap-pkg)이 모두 돈다. 표의 web 잡은 그 영역을 직접 빌드·검사하는 잡이다');
  }
  if (paths.some((p) => WIDEN_JS.test(p.path))) notes.push('node / node는 넓게 쓰이는 것(packages/platform·contracts·config, docs/api)을 고치면 바뀐 패키지만이 아니라 전체를 돈다(changes.mjs의 WIDEN_JS)');
  const used = new Set(out.flatMap((r) => r.jobs));
  const legend = Object.entries(JOBS).filter(([k]) => used.has(k)).map(([k, v]) => `- ${k} (${v.file}): ${v.what}`);
  return { rows: out, notes, legend };
}

// ---------- 자주 놓친 결함 ----------
/** docs/architecture.md의 '자주 놓친 결함' 목록: { start, end, text } | null. '- **자주 놓친 결함' 목록 줄과 그보다 깊이 들여 쓴 줄(들여쓰기만 덜어 낸다) */
export function missedDefects(text) {
  const ls = split(text);
  const k = ls.findIndex((l) => /^\s*[-*] \*\*자주 놓친 결함/.test(l));
  if (k < 0) return null;
  const ind = (l) => /^\s*/.exec(l)[0].length;
  const base = ind(ls[k]);
  let end = k;
  for (let i = k + 1; i < ls.length; i++) {
    if (!ls[i].trim()) {
      const next = ls.slice(i + 1).find((l) => l.trim());
      if (next !== undefined && ind(next) > base) continue;
      break;
    }
    if (ind(ls[i]) <= base) break;
    end = i;
  }
  return { start: k + 1, end: end + 1, text: ls.slice(k, end + 1).map((l) => l.slice(Math.min(base, ind(l)))).join('\n') };
}

// ---------- 모으기 ----------
const KIND_ORDER = ['단계', '시험', '요구사항', '시험(단계 줄)', '화면', 'ADR', '계약 작업'];

function* walkFiles(root, rel) {
  if (!existsSync(join(root, rel))) return;
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) yield* walkFiles(root, p);
    else yield p;
  }
}

/** 지시서 자료를 모은다(저장소를 고치지 않는다) */
export function collectBrief(root, batchId) {
  const read = (p) => readFileSync(join(root, p), 'utf8').replaceAll('\r\n', '\n');
  if (!existsSync(join(root, FILES.build))) throw new BriefError(`${FILES.build}가 없다`);
  const build = read(FILES.build);
  const batch = batchRow(build, batchId);
  const steps = stepLines(build, batch.steps);
  const warnings = [];

  // 3. 판정 항목: ledger.mjs --batch와 같은 셈(정본 → 상태 판정 → 범위)
  const data = collect(root);
  const ledger = judge(data);
  if (ledger.errors.length) throw new BriefError(`장부 notes 오류(ledger.mjs와 같다):\n${ledger.errors.join('\n')}`);
  const sel = selectScope(ledger.items, batch.scope, { docs: data.docs });
  if (sel.errors.length) throw new BriefError(sel.errors.join('\n'));
  warnings.push(...sel.warnings);
  const mineRe = batch.steps.length ? new RegExp(`(?<![\\w-])(?:${batch.steps.map(esc).join('|')})(?![\\w-])`) : null;
  const items = sel.items.map((it) => ({ ...it, mine: Boolean(mineRe && it.where && mineRe.test(it.where)) }));

  // 계약 작업: openapi operationId와 proto rpc 이름 → 정의한 파일
  const ops = new Map();
  if (existsSync(join(root, FILES.openapi))) for (const n of operationIds(read(FILES.openapi))) ops.set(n, FILES.openapi);
  const proto = [...walkFiles(root, FILES.proto)].filter((p) => !p.endsWith('.md'));
  for (const p of proto.filter((x) => x.endsWith('.proto'))) for (const n of rpcNames(read(p))) if (!ops.has(n)) ops.set(n, p);
  const refs = stepRefs(steps.map((s) => s.text), ops);
  const adrFiles = new Map();
  const adrNames = existsSync(join(root, FILES.adr)) ? readdirSync(join(root, FILES.adr)) : [];
  for (const id of refs.adrs) {
    const f = adrNames.find((n) => n.startsWith(`${id.slice(4)}-`) && n.endsWith('.md'));
    if (f) adrFiles.set(id, `${FILES.adr}/${f}`);
    else warnings.push(`${id}: ${FILES.adr}에 그 번호의 파일이 없다`);
  }
  // ID: 단계, 범위 칸과 단계 줄에 이름이 적힌 것(focus. 4·5에서 앞에 둔다), 범위 문서에서 온 것 차례
  const homeOf = new Map(ledger.items.map((i) => [i.id, i.doc]));
  const inScope = new Set(items.filter((i) => i.kind === 'scenario').map((i) => i.id));
  const reqHome = (id) => homeOf.get(id) ?? (id.startsWith('POL') ? FILES.pol : FILES.req);
  const testKind = (id) => (inScope.has(id) ? '시험' : '시험(단계 줄)');
  const ids = new Map();
  const add = (id, kind, home, focus = false) => {
    if (!ids.has(id)) ids.set(id, { kind, home: new Set(), focus: false });
    const v = ids.get(id);
    if (home) v.home.add(home);
    if (focus) v.focus = true;
  };
  for (const s of batch.steps) add(s, '단계', null, true);
  for (const raw of batch.scope.split(/[,;·]/)) {
    const tok = raw.replace(/`/g, '').trim();
    const sid = /^([A-Z]{1,3}-T\d+)(?:\s*[①-⑳].*)?$/u.exec(tok)?.[1];
    if (sid) add(sid, testKind(sid), homeOf.get(sid), true);
    else if (REQ_ID.test(tok)) add(tok, '요구사항', reqHome(tok), true);
  }
  for (const id of refs.tests) add(id, testKind(id), homeOf.get(id), true);
  for (const id of refs.reqs) add(id, '요구사항', reqHome(id), true);
  for (const id of refs.screens) add(id, '화면', null, true);
  for (const id of refs.adrs) add(id, 'ADR', adrFiles.get(id), true);
  for (const id of refs.operations) add(id, '계약 작업', ops.get(id), true);
  for (const it of items) if (it.kind === 'scenario') add(it.id, '시험', it.doc);
  for (const it of items) if (it.kind === 'requirement') add(it.id, '요구사항', it.doc);

  // 4. 정본 자리
  const docPaths = uniq([...data.docs, ...FILES.api.filter((p) => existsSync(join(root, p))), ...proto, ...adrFiles.values()]).sort();
  const spots = canonSpots(
    docPaths.map((p) => ({ path: p, text: read(p) })),
    new Set(ids.keys()),
  );
  const sections = [];
  for (const { doc, num: n } of refs.sections) {
    const r = existsSync(join(root, doc)) ? sectionRange(read(doc), n) : null;
    if (r) sections.push({ doc, num: n, ...r });
    else warnings.push(`${doc} §${n}: 절을 찾지 못했다(단계 줄이 가리킨 절)`);
  }

  // 5. 코드 자리, 6. CI 잡
  const code = codeSpots(root, new Set(ids.keys()));
  const perDoc = new Map();
  for (const list of spots.values()) for (const s of list) perDoc.set(s.doc, (perDoc.get(s.doc) ?? 0) + 1);
  let specAdrs = new Set();
  try {
    specAdrs = new Set(JSON.parse(read('specs/specs.json')).specs.flatMap((s) => s.adrs ?? []));
  } catch {
    // 명세 목록이 없으면 명세 ADR도 없다
  }
  const ci = ciJobs(
    [...code.map((f) => ({ path: f.file, kind: 'code', count: f.lines.length })), ...[...perDoc].map(([path, count]) => ({ path, kind: 'doc', count }))],
    specAdrs,
  );

  // 7. 자주 놓친 결함
  const defects = existsSync(join(root, FILES.arch)) ? missedDefects(read(FILES.arch)) : null;
  if (!defects) throw new BriefError(`${FILES.arch}에 '자주 놓친 결함' 목록('- **자주 놓친 결함…' 줄)이 없다`);
  defects.heading = headingIndex(FILES.arch, read(FILES.arch))(defects.start);

  const head = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return {
    batchId,
    batch,
    steps,
    items,
    ids,
    spots,
    sections,
    code,
    ci,
    defects,
    warnings,
    scopeDocs: uniq(items.map((i) => i.doc)),
    docCount: docPaths.length,
    adrCount: adrFiles.size,
    commit: head.status === 0 ? head.stdout.trim() : '',
  };
}

// ---------- 쓰기 ----------
function critCell(it, max) {
  const t = cellSafe(it.criterion).trim();
  if (!t) return '—';
  const chars = [...t];
  if (chars.length <= max) return t;
  let cut = chars.slice(0, max).join('').replace(/\\$/, '');
  if ((cut.match(/`/g) ?? []).length % 2) cut += '`';
  return `${cut}…(${it.doc}:${it.line})`;
}

function statusCell(it) {
  return cellSafe(`${it.status}${it.where ? `(${it.where})` : ''}${it.mine ? ' — 이 묶음' : ''}`);
}

function itemTable(items, crit) {
  const head = ['항목', '상태', '등급', '원천', ...(crit ? ['판정 기준'] : [])];
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...items.map((it) => `| ${[it.key, statusCell(it), it.grade, `${it.doc}:${it.line}`, ...(crit ? [critCell(it, crit)] : [])].join(' | ')} |`),
  ];
}

function secItems(d, o) {
  const items = d.items;
  const scope = d.batch.scope.replace(/`/g, '').trim();
  const out = ['## 3. 판정 항목', ''];
  if (!items.length) {
    out.push(`장부 범위가 \`${scope || '-'}\`라 판정 항목이 없다(\`node tools/ci/ledger.mjs --batch ${d.batchId}\`과 같다).`);
    return out;
  }
  const count = (s) => items.filter((i) => i.status === s).length;
  const grades = GRADES.map((g) => `${g} ${items.filter((i) => i.grade === g).length}`).join(', ');
  out.push(
    `장부 범위 \`${scope}\`의 항목 ${items.length}개(\`node tools/ci/ledger.mjs --batch ${d.batchId}\`과 같은 셈). 상태: ${STATUSES.map((s) => `${s} ${count(s)}`).join(', ')}. 등급: ${grades}.`,
    '판정 기준은 정본 표 칸의 원문이다(①②③으로 나뉜 것은 그 번호의 글). 긴 것은 앞부분만 적고 원천 문서:줄을 단다.',
    '',
  );
  const open = items.filter((i) => OPEN.has(i.status) || i.mine);
  const rest = items.filter((i) => !(OPEN.has(i.status) || i.mine));
  out.push(`### 남은 항목 ${open.length}개(빈칸·ID만·미검증과 정할 곳이 이 묶음인 것)`, '');
  out.push(...(open.length ? itemTable(open, o.crit) : ['없다.']), '');
  if (o.restRows || !rest.length) {
    out.push(`### 나머지 ${rest.length}개`, '');
    out.push(...(rest.length ? itemTable(rest, o.restCrit) : ['없다.']));
  } else {
    out.push(`### 나머지 ${rest.length}개(상태별 항목 이름)`, '');
    for (const s of STATUSES) {
      const g = rest.filter((i) => i.status === s);
      if (g.length) out.push(`- ${s} ${g.length}개: ${g.map((i) => i.key).join(', ')}`);
    }
  }
  return out;
}

/** 앞 N곳을 고르는 차례: ID의 원천 문서, 묶음 범위의 문서, 나머지 문서(경로 차례). 문서 안은 줄 차례 */
function orderSpots(list, home, scopeDocs) {
  const first = [...home, ...scopeDocs];
  const rank = (doc) => {
    const k = first.indexOf(doc);
    return k < 0 ? first.length : k;
  };
  return list.map((s, k) => [s, k]).sort((a, b) => rank(a[0].doc) - rank(b[0].doc) || a[1] - b[1]).map(([s]) => s);
}

/** 적지 않은 곳: 문서별 곳 수(많은 차례로 10개까지) */
function restNote(rest) {
  if (!rest.length) return '';
  const count = new Map();
  for (const s of rest) count.set(s.doc, (count.get(s.doc) ?? 0) + 1);
  const docs = [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = docs.slice(0, 10).map(([doc, n]) => `${doc} ${n}곳`);
  if (docs.length > 10) shown.push(`외 문서 ${docs.length - 10}개`);
  return `외 ${rest.length}곳(${shown.join(', ')})`;
}

function spotLines(id, info, list, o, scopeDocs) {
  const ordered = orderSpots(list, [...info.home], scopeDocs);
  const shown = ordered.slice(0, o.idCap);
  const rest = restNote(ordered.slice(o.idCap));
  if (o.heads) {
    const out = [`### ${id} — ${info.kind} · ${list.length}곳`];
    for (const g of runs(shown, (s) => `${s.doc}\u0000${s.heading}`)) out.push(`- ${g[0].doc}:${g.map((s) => s.line).join(', ')}${g[0].heading ? ` — ${g[0].heading}` : ''}`);
    if (rest) out.push(`- ${rest}`);
    return [...out, ''];
  }
  const docs = runs(shown, (s) => s.doc).map((g) => `${g[0].doc}:${g.map((s) => s.line).join(',')}`);
  return [`- **${id}** ${info.kind} ${list.length}곳: ${[...docs, ...(rest ? [rest] : [])].join('; ')}`];
}

function secCanon(d, o) {
  const ids = [...d.ids];
  const total = ids.reduce((n, [id]) => n + d.spots.get(id).length, 0);
  const kinds = KIND_ORDER.map((k) => [k, ids.filter(([, v]) => v.kind === k).length]).filter(([, n]) => n);
  const out = [
    '## 4. 정본 자리',
    '',
    `ID ${ids.length}개(${kinds.map(([k, n]) => `${k} ${n}`).join(' · ')})의 자리 ${num(total)}곳. 정본 문서 ${d.docCount}개(ledger.mjs의 정본에 docs/api의 openapi·asyncapi·proto와 단계 줄이 가리킨 ADR ${d.adrCount}개를 더함)에서 찾았다.`,
    `단계와 범위 칸·단계 줄에 이름이 적힌 ID를 앞에 둔다. 자리는 ID의 원천 문서, 묶음 범위의 문서, 나머지 문서(경로 차례) 순으로 줄 차례대로 ID마다 ${o.idCap}곳까지 적는다.${o.heads ? ' 같은 문서·같은 제목의 이웃한 줄은 한 줄로 적는다.' : ''}`,
    '',
  ];
  if (d.sections.length) {
    out.push('### 단계 줄이 가리킨 절', '');
    for (const s of d.sections) out.push(`- ${s.doc}:${s.start}–${s.end} — ${s.title}`);
    out.push('');
  }
  const empty = ids.filter(([id]) => !d.spots.get(id).length).map(([id]) => id);
  const full = ids.filter(([id]) => d.spots.get(id).length);
  if (!o.heads && full.length) out.push('### ID별 자리', '');
  for (const [id, info] of full) out.push(...spotLines(id, info, d.spots.get(id), o, d.scopeDocs));
  if (!o.heads && full.length) out.push('');
  if (empty.length) out.push(`자리가 없는 ID: ${empty.join(', ')}`, '');
  while (out.at(-1) === '') out.pop();
  return out;
}

function secCode(d, o) {
  const focus = new Set([...d.ids].filter(([, v]) => v.focus).map(([id]) => id));
  const near = (f) => (f.lines.some((l) => l.ids.some((id) => focus.has(id))) ? 0 : 1);
  const files = [...d.code].sort((a, b) => near(a) - near(b) || b.lines.length - a.lines.length || (a.file < b.file ? -1 : 1));
  const lineCount = files.reduce((n, f) => n + f.lines.length, 0);
  const out = [
    '## 5. 코드 자리',
    '',
    `\`git grep -n -F\`로 찾은 파일 ${files.length}개·줄 ${lineCount}개(${CODE_ROOTS.map((r) => `${r}/`).join(' ')}. node_modules·dist·.next·생성물 gen/과 tools/ci의 시험 자료는 뺐다). 단계·범위 칸·단계 줄의 ID가 있는 파일을 앞에, 그 안에서 줄이 많은 파일부터 ${o.fileCap}개까지 적는다.`,
    '',
  ];
  if (!files.length) return [...out, '코드에 자리가 없다.'];
  const idOrder = [...d.ids.keys()];
  for (const f of files.slice(0, o.fileCap)) {
    const fileIds = idOrder.filter((id) => f.lines.some((l) => l.ids.includes(id)));
    const nums = f.lines.map((l) => l.line);
    out.push(`- ${f.file}${f.test ? '(시험)' : ''} — ${f.lines.length}줄: ${fileIds.join(', ')} (${nums.slice(0, 8).join(', ')}${nums.length > 8 ? ', …' : ''})`);
  }
  const rest = files.slice(o.fileCap);
  if (rest.length) out.push(`- 외 ${rest.length}개 파일(${rest.reduce((n, f) => n + f.lines.length, 0)}줄)`);
  return out;
}

function secCi(d) {
  const { rows, notes, legend } = d.ci;
  const out = ['## 6. 닿을 CI 잡', '', '4·5의 자리가 있는 영역을 고치면 닿는 잡이다(GitHub 검사 이름 `부르는 잡 / 잡`). 게이트(docs/architecture.md §8.6 묶음 절차 8)에서 로컬로 미리 돌린다.', ''];
  if (!rows.length) return [...out, '닿는 영역이 없다.'];
  out.push('| 영역 | 자리 | 잡 | 더 도는 것 |', '| --- | --- | --- | --- |');
  for (const r of rows) {
    const where = [r.files ? `코드 ${r.code}줄(파일 ${r.files}개)` : '', r.docs ? `정본 ${r.docs}곳` : ''].filter(Boolean).join(', ');
    out.push(`| ${r.area} | ${where} | ${r.jobs.join(' · ')} | ${r.extra} |`);
  }
  out.push('');
  for (const n of notes) out.push(`- ${n}`);
  if (notes.length) out.push('');
  out.push('잡이 하는 일(워크플로 파일):', '', ...legend);
  return out;
}

function secDefects(d) {
  const x = d.defects;
  return ['## 7. 자주 놓친 결함', '', `${FILES.arch}:${x.start}–${x.end}${x.heading ? ` — ${x.heading}` : ''}(실행할 때마다 정본에서 읽는다)`, '', x.text];
}

const RULES = [
  '- 정본은 위 줄 범위만 읽는다(`grep -n`으로 찾고 `sed -n \'A,Bp\'`나 Read의 offset·limit).',
  '- 큰 문서(features·architecture·data·frontend·verification·openapi)·BUILD_ORDER·`docs/review/ledger/`는 통째로 읽지 않는다.',
  '- 리뷰는 `git diff`와 이 지시서를 먼저 보고 주변 코드는 필요할 때만 읽는다.',
];

function compose(d, o) {
  const b = d.batch;
  const out = [
    `# 묶음 지시서 ${d.batchId}`,
    '',
    `정본에서 뽑은 읽을 범위다(\`node tools/ci/brief.mjs --batch ${d.batchId}\`${d.commit ? `, 만든 때 커밋 ${d.commit}` : ''}). 정본을 요약하지 않고 위치(문서:줄)와 원문 조각만 적는다. 정본과 다르면 정본이 이긴다.`,
    '',
    '## 1. 묶음',
    '',
    `${FILES.build}:${b.line}`,
    '',
    `| ${b.head.join(' | ')} |`,
    `| ${b.head.map(() => '---').join(' | ')} |`,
    b.text,
    '',
    '## 2. 단계 줄',
    '',
    ...d.steps.flatMap((s) => [`${FILES.build}:${s.line}`, s.text.trimStart(), '']),
    ...secItems(d, o),
    '',
    ...secCanon(d, o),
    '',
    ...secCode(d, o),
    '',
    ...secCi(d),
    '',
    ...secDefects(d),
    '',
    '## 8. 읽기 규칙',
    '',
    ...RULES,
  ];
  if (d.warnings.length) out.push('', '## 알림', '', ...d.warnings.map((w) => `- ${w}`));
  if (o.notes.length) out.push('', '## 줄임', '', ...o.notes);
  return `${out.join('\n')}\n`;
}

const limitText = (max) => (max % 10000 === 0 ? `${max / 10000}만 자` : `${num(max)}자`);

/** 지시서 글: { text, level(줄인 단계, 0은 줄이지 않음), full(줄이기 전 글자 수) } */
export function renderBrief(d, { maxChars = MAX_CHARS } = {}) {
  const full = len(compose(d, { ...LEVELS[0], notes: [] }));
  for (let k = 0; k < LEVELS.length; k++) {
    const o = Object.assign({}, ...LEVELS.slice(0, k + 1));
    const notes = k ? [`지시서가 ${limitText(maxChars)}를 넘어(줄이기 전 ${num(full)}자) 다음을 차례로 줄였다. 빠진 글은 적힌 문서:줄에서 읽는다.`, '', ...LEVELS.slice(1, k + 1).map((l) => `- ${l.note}`)] : [];
    let text = compose(d, { ...o, notes });
    if (len(text) <= maxChars) return { text, level: k, full };
    if (k === LEVELS.length - 1) {
      text = compose(d, { ...o, notes: [...notes, `- 가장 줄인 꼴도 ${num(len(text))}자로 ${limitText(maxChars)}를 넘는다`] });
      return { text, level: k, full };
    }
  }
  throw new Error('닿지 않는다');
}

// ---------- 명령줄 ----------
class UsageError extends BriefError {}

function main(argv) {
  const opt = { batch: null, out: null, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--batch' || a === '--out' || a === '--root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a}에 값이 없다`);
      opt[a.slice(2)] = v;
    } else throw new UsageError(`모르는 인자: ${a}`);
  }
  if (!opt.batch) throw new UsageError('쓰는 법: node tools/ci/brief.mjs --batch <묶음 ID> [--out <파일>] [--root <저장소>]');
  const d = collectBrief(opt.root, opt.batch);
  const r = renderBrief(d);
  if (!opt.out) {
    process.stdout.write(r.text);
    return 0;
  }
  const out = resolve(opt.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.text);
  const spots = [...d.spots.values()].reduce((n, l) => n + l.length, 0);
  process.stdout.write(
    `${opt.batch}: ${out} — ${num(len(r.text))}자, 판정 항목 ${d.items.length}개, 정본 자리 ${num(spots)}곳(ID ${d.ids.size}개), 코드 파일 ${d.code.length}개${r.level ? `, 줄임 ${r.level}단계(줄이기 전 ${num(r.full)}자)` : ''}\n`,
  );
  return 0;
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`brief: ${e.message}\n`);
    process.exitCode = 2;
  }
}
