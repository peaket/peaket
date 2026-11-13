#!/usr/bin/env node
// 완성 장부(ADR-0256 결정 2, docs/architecture.md §8.6 2번). 정본이 정한 판정 항목마다 '실패할 수 있는 검증'이 있는지를 상태 하나로 적는다.
// 항목(정본에서 뽑는다. 정본 = docs/**/*.md에서 review·walkthrough·lanes·adr·wbs 폴더와 progress-archive·PROGRESS·BUILD_ORDER·00-summary를 뺀 것):
//   - 시험 시나리오: 표 행 '| X-T숫자 | …'(X는 영문 1~3자). 판정 칸은 표 머리 이름으로 찾는다(JUDGE_COLS 차례). 그 칸을 ①②③…으로 나눠
//     세부 항목(예 'S-T23 ⑥')을 만든다. 판정 칸에 번호가 없으면 시나리오·방법 칸의 번호(둘 이상일 때)로 나누고, 어디에도 없으면 세부 없는 항목 하나다.
//     ID 바로 뒤의 번호(POL-038 ⑪, V-T36 ①: 다른 행·정책의 세부)와 조문 번호(§23의5④)는 세부가 아니다. 제목 칸에 '(없앰'이 든 행은 '없앰' 항목 하나다
//   - 요구사항·정책: docs/planning/02-requirements.md의 FR·NFR, 03-policies-glossary.md의 POL 가운데 어떤 시나리오 행도 가리키지 않는 것(FR-005~011 같은 묶음도 센다)
//   - ASVS: docs/security/asvs/*.md 추적 표의 행. 항목 이름은 '<문서 이름>:v5.0.0-x.y.z'(예 payment:v5.0.0-1.2.4)
// 상태(항목마다 하나):
//   자동 시험  시험 파일(.test.·.spec. 또는 test/·test-int/·test-sim/·e2e/ 아래 js·ts·mjs)의 시험 이름에 ID와 그 세부 번호가 함께 있다.
//              세부 번호는 ID 바로 뒤에 붙은 묶음만 센다('S-T23 ①', 'S-T23 ①③', 'S-T23 ①~③', 'ST23_②'). ASVS는 이름의 '[ASVS v5.0.0-x.y.z]' 태그이고,
//              그 행의 코드 영역(codeArea: 구현 위치 칸이 가리키는 경로의 앞 두 마디·서비스·앱 이름, 없으면 ASVS_DEFAULT_AREA) 안 시험 파일의 것만 센다
//   ID만       세부 번호가 있는 항목인데 이름에 ID만 있고 그 번호가 없다(어느 세부를 검사하는지 모른다). ASVS는 같은 ID의 태그가 코드 영역 밖에만 있다.
//              완료로 세지 않는다
//   측정·사람 확인·미검증·다른 단계·없앰·해당 없음  손으로 적는 docs/review/ledger-notes.md 표에서. ASVS 미적용 행은 '해당 없음'(미적용 사유),
//              구현 위치가 '(운영 설계만)'인 행은 '다른 단계'(운영 확인 몫)로 스스로 정한다
//   빈칸       위 어느 것도 아니다
// notes 표 머리: | 항목 | 상태 | 등급 | 정할 곳 | 근거·사유 |
//   항목 칸: 'S-T23 ⑥'(세부 하나. '①~③'·'⑤⑥'처럼 여럿도), 'S-T23'(그 ID의 세부 전부), 'NFR-007', 'v5.0.0-1.2.4'(그 ID의 ASVS 행 모두), 'payment:v5.0.0-1.2.4'(한 문서의 행)
//   상태 칸을 비우면 등급만 바꾼다. 칸마다 세부 행이 ID 행보다 앞선다. 사유 없는 미검증, 모르는 상태·등급·항목, 같은 항목 두 번은 오류다. 자동 시험은 notes로 적지 못한다
// 등급: A(돈·좌석·대기 순번·권한·개인정보·법정 의무·장애 복구) / B(일반 기능·화면·운영) / C(문구·배치·문서). 원천 문서로 정하고(GRADE_BY_DOC) notes의 등급 칸으로 바꾼다
// 쓰는 법: node tools/ci/ledger.mjs [--check] [--scope "<토큰>, <토큰>" | --batch <묶음 ID>] [--require] [--root <저장소>]
//   (인자 없음) docs/review/ledger/README.md(분야 × 등급 × 상태 개수, 완성 판정, 한계)와 분야별 docs/review/ledger/<분야>.md를 다시 쓴다. 폴더의 다른 .md는 지운다
//   --check     고칠 것이 있으면 알리고 1로 끝난다(파일은 고치지 않는다)
//   --scope     범위 안 항목의 상태를 센다(파일은 쓰지 않는다). 토큰: 정본 문서 경로(그 문서의 항목 전부), 시험 ID(S-T23), 세부(S-T23 ⑥),
//               ID 머리(P-T), ID 묶음(P-T1~P-T20), 요구사항 ID(FR-042: 그것을 가리키는 시나리오 행 포함), ASVS 문서 경로·ID. 쉼표로 나눈다
//   --batch     docs/BUILD_ORDER.md '기능 묶음' 표(| 묶음 | 갈래 | 구간 | 등급 | 단계 | WBS 일 | 장부 범위 | 비고 |)에서 그 묶음 행의 '장부 범위' 칸을 범위로 쓴다
//   --require   범위(없으면 장부 전체)에 빈칸이나 ID만이 있으면 목록을 찍고 1로 끝난다. 미검증은 사유가 있으면 통과지만 따로 센다
// 끝 코드: 0 맞음(또는 고침, 범위 통과), 1 --check에서 고칠 것 있음·--require에서 빈칸이나 ID만 있음, 2 읽기·notes·범위·인자 오류(아무것도 고치지 않는다)
// 한계: 시험이 통과했는지는 보지 않는다(tools/ci/trace-check.mjs가 시험 보고서로 본다). 이름만 보므로 시험이 판정 기준을 실제로 검사하는지는 모른다
//   (ADR-0256 결정 3의 기준 대조와 틀린 구현 검사 몫). 이름은 원본의 글자로 읽는다: 변수로 만든 이름은 읽지 못하고, describe 이름도 따로 하나의 이름으로 센다
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cells } from './records.mjs';
import { tagsIn } from './asvs-report.mjs';

export const STATUSES = ['자동 시험', 'ID만', '측정', '사람 확인', '미검증', '다른 단계', '없앰', '해당 없음', '빈칸'];
const NOTE_STATUSES = new Set(['측정', '사람 확인', '미검증', '다른 단계', '없앰', '해당 없음']);
const GRADES = ['A', 'B', 'C'];
const FILES = {
  notes: 'docs/review/ledger-notes.md',
  out: 'docs/review/ledger',
  build: 'docs/BUILD_ORDER.md',
  req: 'docs/planning/02-requirements.md',
  pol: 'docs/planning/03-policies-glossary.md',
  asvs: 'docs/security/asvs',
};
/** 정본이 아닌 문서(검토·해설·진행 기록·ADR·WBS·요약) */
const NOT_CANON = /^docs\/(review|walkthrough|lanes|adr|wbs)\/|^docs\/(progress-archive|PROGRESS|BUILD_ORDER|00-summary)\.md$/;
/** 판정 칸의 머리 이름. 앞의 것이 먼저다 */
const JUDGE_COLS = ['합격 판정 기준', '통과 기준', '합격 기준', '판정 기준', '기대 결과', '확인할 것', '확인'];
/** 제목 칸의 머리 이름. 없으면 둘째 칸 */
const TITLE_COLS = ['테스트 시나리오', '시나리오', '무엇', '대상', '상황', '확인할 것'];
/** 세부 번호를 찾지 않는 칸(요구사항 연결, 시기) */
const LINK_COLS = new Set(['#', 'ID', '연결', '관련', '연결 요구사항', '관련 FR', '언제']);
/**
 * 원천 문서로 정하는 기본 등급. 앞의 것이 먼저다. 항목마다 notes의 등급 칸으로 바꾼다.
 * 2026-11-10 ADR-0256 결정 10: A는 돈·좌석·대기 순번의 핵심 로직과 그 데이터의 복구뿐이다(항목마다 실패 증명).
 * 권한·개인정보·법정 의무·입장·보안 통제는 B다(표본 20~30개로 증명하고, 그 항목은 표본에 꼭 넣는다)
 */
export const GRADE_BY_DOC = [
  [/^docs\/features\/(payment|seat-hold|queue-admission|transfer-refund|settlement)\.md$/, 'A', '돈·좌석·대기 순번(결정 10)'],
  [/^docs\/security\//, 'B', '보안 통제(권한·개인정보, 표본으로 증명)'],
  [/^docs\/features\//, 'B', '권한·입장·봇 방어·관제·분석·알림·검색·사후 조사'],
  [/^docs\/(frontend|devops|streaming|verification)\.md$/, 'B', '화면·운영·검증 도구'],
  [/^docs\/planning\//, 'B', '요구사항·정책(대기 순번 정책은 notes로 A)'],
];
const DEFAULT_GRADE = 'B';
/** ASVS 문서 이름 → 분야(기능 문서 이름과 다른 것만) */
const ASVS_AREA = { auth: 'identity' };
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'test-results', 'playwright-report', '_apalache-out', 'docs']);
const TEST_EXT = /\.(m?[jt]sx?|c[jt]s)$/;
/** 이 표시가 첫 줄에 있는 tools/ci 아래 파일은 읽지 않는다(도구 자신의 시험 자료. asvs-report.mjs와 같은 표시) */
export const IGNORE = /^\/\/ asvs-report: ignore/;

const ROW = /^\| (?:\*\*)?([A-Z]{1,3}-T\d+)(?:\*\*)? \|/;
const SCEN_ID = /^[A-Z]{1,3}-T\d+$/;
const REQ_ID = /^(?:N?FR|POL)-\d{3}$/;
const ASVS_ID = /^v5\.0\.0-\d+\.\d+\.\d+$/;

class UsageError extends Error {}

// ---------- 동그라미 번호 ----------
const CIRCLE = /[①-⑳]/u;
export const circled = (n) => String.fromCodePoint(0x245f + n);
const circleNum = (ch) => ch.codePointAt(0) - 0x245f;
/** 번호 묶음: ①②③, ①~③, ①·③, ①, ③ */
const GROUP = /[①-⑳](?:[\s_]*[~∼–·,、/-]?[\s_]*[①-⑳])*/gu;
/** 이 글 바로 뒤의 번호는 다른 것의 세부다: ID(POL-038, V-T36, PRF-150) 뒤, 조문(§23의5) 뒤, WBS 번호(2.5.5) 뒤, 숫자 바로 뒤 */
const REF_BEFORE = /(?:[A-Za-z][A-Za-z0-9]*-[A-Z]*\d+\s?|§\s*[\d.]+(?:의\d+)?\s?|\d+(?:\.\d+)+\s?|\d)$/;

function groupNumbers(g) {
  const out = [];
  let range = false;
  for (const ch of g) {
    if (CIRCLE.test(ch)) {
      const n = circleNum(ch);
      if (range && out.length) for (let k = out[out.length - 1] + 1; k <= n; k++) out.push(k);
      else out.push(n);
      range = false;
    } else if (/[~∼–-]/.test(ch)) range = true;
  }
  return [...new Set(out)];
}

/** 판정 기준 글을 동그라미 번호로 나눈다: { preamble(첫 번호 앞 글), parts: 번호 → 글(번호 차례) } */
export function splitCriterion(text) {
  const groups = [];
  for (const m of text.matchAll(GROUP)) {
    if (REF_BEFORE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    groups.push({ start: m.index, end: m.index + m[0].length, nums: groupNumbers(m[0]) });
  }
  const parts = new Map();
  if (!groups.length) return { preamble: text.trim(), parts };
  groups.forEach((g, k) => {
    const seg = text.slice(g.end, k + 1 < groups.length ? groups[k + 1].start : text.length).trim();
    for (const n of g.nums) parts.set(n, parts.has(n) && seg ? `${parts.get(n)} … ${seg}` : parts.get(n) || seg);
  });
  return { preamble: text.slice(0, groups[0].start).trim(), parts: new Map([...parts].sort((a, b) => a[0] - b[0])) };
}

// ---------- 표 읽기 ----------
export const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '').trim();

/** 표 블록을 차례로 준다: { head(칸 이름), headLine, rows: [{ line, text, cells }] }. 코드 펜스 안은 건너뛴다 */
export function* tables(text) {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let fence = false;
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      if (cur) yield cur;
      cur = null;
      continue;
    }
    if (fence || !line.startsWith('|')) {
      if (cur) yield cur;
      cur = null;
      continue;
    }
    if (!cur) {
      cur = { head: cells(line).map(plain), headLine: i + 1, rows: [] };
      continue;
    }
    cur.rows.push({ line: i + 1, text: line, cells: cells(line) });
  }
  if (cur) yield cur;
}

const REQ_TOKEN = /(?<![A-Za-z])(N?FR|POL)-(\d{3})((?:\s*[~·,]\s*(?:\1-)?\d{3}(?!\d))*)/g;

/** 글이 가리키는 FR·NFR·POL. '~'는 범위, '·'와 ','는 낱개다(문서 점검의 FR 연결 셈과 같다) */
export function refsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(REQ_TOKEN)) {
    let prev = Number(m[2]);
    out.add(`${m[1]}-${m[2]}`);
    for (const [, s, num] of m[3].matchAll(/\s*([~·,])\s*(?:[A-Z]+-)?(\d{3})/g)) {
      const n = Number(num);
      if (s === '~') for (let k = prev + 1; k <= n; k++) out.add(`${m[1]}-${String(k).padStart(3, '0')}`);
      else out.add(`${m[1]}-${num}`);
      prev = n;
    }
  }
  return [...out].sort();
}

/** 한 문서의 시나리오 항목: { items, warnings }. 항목: { key, id, sub, doc, kind, title, criterion, removed, refs, line } */
export function scenarioItems(path, text) {
  const items = [];
  const warnings = [];
  for (const t of tables(text)) {
    if (!t.rows.some((r) => ROW.test(r.text))) continue;
    const judgeCol = JUDGE_COLS.map((n) => t.head.indexOf(n)).find((x) => x >= 0) ?? -1;
    const titleCol = TITLE_COLS.map((n) => t.head.indexOf(n)).find((x) => x >= 0) ?? 1;
    const scenCols = t.head.map((n, k) => k).filter((k) => k > 0 && k !== judgeCol && !LINK_COLS.has(t.head[k]));
    if (judgeCol < 0) warnings.push(`${path}:${t.headLine}: 표 머리(${t.head.join(' | ')})에서 판정 칸(${JUDGE_COLS.join('·')})을 찾지 못해 행 전체를 판정 기준으로 본다`);
    for (const r of t.rows) {
      const m = ROW.exec(r.text);
      if (!m) continue;
      const id = m[1];
      const c = r.cells;
      const judgeText = judgeCol >= 0 ? c[judgeCol] ?? '' : c.slice(1).join(' ');
      const base = { id, doc: path, kind: 'scenario', title: c[titleCol] ?? '', refs: refsIn(r.text), line: r.line, removed: false };
      if ((c[titleCol] ?? '').includes('(없앰')) {
        items.push({ ...base, key: id, sub: null, criterion: judgeText, removed: true });
        continue;
      }
      const { preamble, parts } = splitCriterion(judgeText);
      let subs = [...parts].map(([n, seg]) => [n, seg || preamble]);
      if (subs.length) {
        // 시나리오 칸이 번호를 단 경우를 판정 칸이 다 적지 않았으면('모두 422다. ⑤도 …') 정본 표를 고칠 곳으로 알린다
        const scen = new Set(scenCols.flatMap((k) => [...splitCriterion(c[k] ?? '').parts.keys()]));
        const missing = [...scen].filter((k) => !parts.has(k)).sort((a, b) => a - b);
        if (missing.length) warnings.push(`${path}:${r.line}: ${id} 시나리오 칸의 ${missing.map(circled).join('')}이 판정 칸에 없어 세부로 세지 않는다`);
      } else if (judgeCol >= 0) {
        // 판정 칸에 번호가 없으면 시나리오·방법 칸의 번호로 나눈다(둘 이상일 때만. 하나는 다른 것을 가리키는 일이 많다)
        for (const k of scenCols) {
          const s = splitCriterion(c[k] ?? '');
          if (s.parts.size < 2) continue;
          subs = [...s.parts].map(([n, seg]) => [n, `${seg} → ${judgeText}`]);
          break;
        }
      }
      if (!subs.length) items.push({ ...base, key: id, sub: null, criterion: judgeText });
      for (const [n, seg] of subs) items.push({ ...base, key: `${id} ${circled(n)}`, sub: n, criterion: seg });
    }
  }
  return { items, warnings };
}

/** 시나리오 행이 가리키지 않는 FR·NFR·POL 항목 */
export function requirementItems(reqText, polText, referenced) {
  const out = [];
  const seen = new Set();
  for (const [doc, text] of [[FILES.req, reqText], [FILES.pol, polText]]) {
    for (const t of tables(text)) {
      const titleCol = ['정책', '분류', '요구사항'].map((n) => t.head.indexOf(n)).find((x) => x >= 0) ?? 1;
      const critCol = t.head.findIndex((n) => /^(인수 조건|목표치|규칙)/.test(n));
      for (const r of t.rows) {
        const id = /^\| ((?:N?FR|POL)-\d{3}) \|/.exec(r.text)?.[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        if (referenced.has(id)) continue;
        out.push({ key: id, id, sub: null, doc, kind: 'requirement', title: r.cells[titleCol] ?? '', criterion: r.cells[critCol >= 0 ? critCol : 2] ?? '', refs: [id], line: r.line, removed: false });
      }
    }
  }
  return out;
}

/** ASVS 추적 표의 행: { key '<문서>:<ID>', id, asvsDoc, applied, designOnly, reason, … } */
export function asvsItems(path, text) {
  const name = basename(path, '.md');
  const out = [];
  const seen = new Set();
  for (const t of tables(text)) {
    if (t.head[0] !== 'ASVS ID') continue;
    const col = (re) => t.head.findIndex((n) => re.test(n));
    const [level, summary, applied, where, why] = [/^레벨/, /^요구사항 요약/, /^적용 여부/, /^구현 위치/, /^(미적용 사유|채택 이유)/].map(col);
    for (const r of t.rows) {
      const id = /^\| (v5\.0\.0-\d+\.\d+\.\d+) \|/.exec(r.text)?.[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const a = r.cells[applied] ?? '';
      const reason = (r.cells[why] ?? '').replace(/^—$/, '');
      out.push({
        key: `${name}:${id}`, id, asvsDoc: name, sub: null, doc: path, kind: 'asvs', title: r.cells[level] ?? '', criterion: r.cells[summary] ?? '',
        applied: /^(부분 )?적용/.test(a), designOnly: (r.cells[where] ?? '').includes('(운영 설계만)'), reason, refs: [], line: r.line, removed: false,
        codeRefs: codeRefsIn(r.cells[where] ?? ''),
      });
    }
  }
  return out;
}

// ---------- ASVS 코드 영역 ----------
/**
 * ASVS 문서별 기본 코드 영역(구현 위치 칸에 경로·서비스 이름이 없는 행). 2026-11-10 저장소 폴더를 보고 정했다.
 * 아직 코드가 없는 기능(분석 ingest·ops-svc·notify·정산·문의·양도 환불)은 빈 목록이다. 공용 영역(packages/platform 등)은
 * 넣지 않는다(구현 위치 칸이 가리킬 때만 든다). 기능 문서·화면 공용 패키지처럼 그 기능만의 코드는 넣는다
 */
export const ASVS_DEFAULT_AREA = {
  analytics: [],
  auth: ['apps/console-host', 'apps/partner', 'apps/web', 'services/identity-svc'],
  'bot-defense': ['services/trust-svc'],
  'catalog-review': ['apps/partner', 'apps/web', 'services/core-svc'],
  'control-tower': ['apps/console-host', 'apps/widgets'],
  delivery: ['deploy', 'infra', 'tools/ci'],
  'forensic-replay': ['apps/forensics'],
  frontend: ['apps/console-host', 'apps/forensics', 'apps/partner', 'apps/scanner', 'apps/web', 'apps/widgets', 'packages/api-client', 'packages/ds', 'tools/web-checks'],
  notify: [],
  'offline-gate': ['apps/scanner'],
  payment: ['apps/web', 'services/payment-svc', 'services/pg-simulator', 'services/purchase-svc', 'services/ticket-svc'],
  'queue-admission': ['apps/web', 'packages/shuffle', 'services/admission-ctrl', 'services/queue-svc', 'tools/edge'],
  'seat-hold': ['apps/partner', 'apps/web', 'packages/seatmap', 'services/purchase-svc'],
  settlement: [],
  support: [],
  'transfer-refund': [],
  'v0-baseline': ['services/v0-monolith'],
  'verification-tools': ['loadtest', 'services/invariant-checker', 'services/pg-simulator', 'tools/perf-ledger'],
};
const CODE_TOPS = ['apps', 'services', 'packages', 'tools', 'loadtest', 'deploy', 'infra', 'data', 'specs'];
const CODE_PATH = new RegExp(`(?<![\\w./-])((?:${CODE_TOPS.join('|')})/[\\w.-]+)`, 'g');
/** 서비스 이름 꼴(아직 폴더가 없어도 그 서비스의 영역으로 본다): purchase-svc, admission-ctrl, analytics-ingest, ops-rt … */
const SERVICE_NAME = /(?<![\w/@.-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:svc|ctrl|checker|simulator|monolith|worker|ingest|rt))(?![\w-])/g;
/** 구현 위치 칸이 폴더 이름과 다르게 부르는 이름 */
const NAME_ALIAS = { identity: 'services/identity-svc', 'web bff': 'apps/web', console: 'apps/console-host', 'queue-room': 'apps/web' };
/** 다른 서비스의 같은 코드에서 다른 진입점으로 띄우는 작업(docs/architecture.md §3.1, ADR-0257 결정 5): 그 서비스 폴더의 시험을 센다 */
const ENTRYPOINT_OF = { 'seatmap-worker': 'services/core-svc', 'image-worker': 'services/core-svc' };

/** 구현 위치 칸이 가리키는 코드: 경로의 앞 두 마디(둘째가 파일이면 첫 마디), @peaket/x, 서비스 이름, 코드 표시 속 이름('name:…', 폴더를 보고 푼다) */
function codeRefsIn(cell) {
  const refs = new Set();
  for (const m of cell.matchAll(CODE_PATH)) {
    const [top, second] = m[1].split('/');
    refs.add(/\.[a-z]+$/i.test(second) ? top : `${top}/${second}`);
  }
  for (const m of cell.matchAll(/@peaket\/([\w-]+)/g)) refs.add(`packages/${m[1]}`);
  for (const m of cell.matchAll(SERVICE_NAME)) refs.add(ENTRYPOINT_OF[m[1]] ?? `services/${m[1]}`);
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const t = m[1].trim().toLowerCase();
    if (/^[a-z][a-z0-9 -]*$/.test(t)) refs.add(`name:${t}`);
  }
  return [...refs];
}

/**
 * ASVS 행의 코드 영역(이 안의 시험 파일 태그만 자동 시험으로 센다). (가) 구현 위치 칸이 가리키는 코드. 코드 표시 속 이름은
 * dirs(저장소의 apps/·services/ 폴더)의 이름이나 NAME_ALIAS로 푼다. (나) 가리키는 것이 없으면 ASVS_DEFAULT_AREA
 */
export function codeArea(item, dirs = []) {
  const names = new Map(dirs.filter((d) => /^(apps|services)\//.test(d)).map((d) => [d.slice(d.indexOf('/') + 1), d]));
  const out = new Set();
  for (const r of item.codeRefs ?? []) {
    if (!r.startsWith('name:')) out.add(r);
    else {
      const p = names.get(r.slice(5)) ?? NAME_ALIAS[r.slice(5)];
      if (p) out.add(p);
    }
  }
  const base = ASVS_DEFAULT_AREA[item.asvsDoc];
  // 아직 코드가 없는 기능(기본 영역이 빈 목록)은 구현 위치 칸이 다른 기능의 폴더를 가리켜도 세지 않는다.
  // 그 폴더 안 다른 기능 시험의 같은 ID 태그로 부풀지 않게 한다(2026-11-10, 양도 환불 v5.0.0-2.2.2가 좌석 시험으로 잡히던 것)
  if (Array.isArray(base) && base.length === 0) return [];
  return out.size ? [...out].sort() : [...(base ?? [])];
}

const inArea = (file, area) => area.some((r) => file.startsWith(`${r}/`));

// ---------- 시험 이름 ----------
const WORD = /[\w$]/;
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

function skipTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') j += 2;
    else if (ch === '`') return j + 1;
    else if (ch === '$' && src[j + 1] === '{') j = skipExpr(src, j + 2);
    else j++;
  }
  return j;
}

function skipString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== q && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** '${' 다음부터 짝이 맞는 '}' 뒤까지 */
function skipExpr(src, i) {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "'" || ch === '"') j = skipString(src, j);
    else if (ch === '`') j = skipTemplate(src, j);
    else {
      if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return j + 1;
      j++;
    }
  }
  return j;
}

/** 주석을 지우고 문자열·템플릿·정규식의 속을 빈칸으로 바꾼 사본(길이와 줄은 그대로, 따옴표는 남긴다) */
function maskSource(src) {
  const out = src.split('');
  const blank = (a, b) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const regexAllowed = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(out[j])) j--;
    if (j < 0) return true;
    const c = out[j];
    if (WORD.test(c)) {
      let k = j;
      while (k >= 0 && WORD.test(out[k])) k--;
      return REGEX_AFTER_WORD.has(out.slice(k + 1, j + 1).join(''));
    }
    return !/[)\]}'"`]/.test(c);
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? src.length : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      const end = skipString(src, i);
      blank(i + 1, end - 1);
      i = end;
    } else if (c === '`') {
      const end = skipTemplate(src, i);
      blank(i + 1, end - 1);
      i = end;
    } else if (c === '/' && regexAllowed(i)) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') j++;
        else if (src[j] === '[') cls = true;
        else if (src[j] === ']') cls = false;
        else if (src[j] === '/' && !cls) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join('');
}

const skipWs = (s, i) => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

function skipBalanced(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if ('([{'.includes(s[j])) depth++;
    else if (')]}'.includes(s[j]) && --depth === 0) return j + 1;
  }
  return s.length;
}

function skipAngles(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '<') depth++;
    else if (s[j] === '>' && s[j - 1] !== '=' && --depth === 0) return j + 1;
  }
  return s.length;
}

const CALLEE = /(?<![\w$.])(?:test|it|describe|suite|bench)(?![\w$])/g;
/** 이름을 받는 사슬(test.skip(…), test.describe.serial(…), test.step(…)) */
const CHAIN = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'fail', 'failing', 'serial', 'parallel', 'fixme', 'slow', 'describe', 'step']);

/** 시험 원본에서 시험 이름(test·it·describe·suite·bench의 첫 인자 글자). 템플릿의 ${…}는 그대로 둔다 */
export function testTitles(source) {
  const src = source.replaceAll('\r\n', '\n');
  const mask = maskSource(src);
  const out = [];
  for (const m of mask.matchAll(CALLEE)) {
    let i = m.index + m[0].length;
    let ok = true;
    for (;;) {
      i = skipWs(mask, i);
      if (mask[i] !== '.') break;
      i = skipWs(mask, i + 1);
      const name = /^[A-Za-z_$][\w$]*/.exec(mask.slice(i, i + 40))?.[0];
      if (!name) {
        ok = false;
        break;
      }
      i = skipWs(mask, i + name.length);
      if (name === 'each' || name === 'for') {
        if (mask[i] === '<') i = skipWs(mask, skipAngles(mask, i));
        if (mask[i] === '(') i = skipBalanced(mask, i);
        else if (mask[i] === '`') i = mask.indexOf('`', i + 1) + 1;
        else ok = false;
      } else if (name === 'runIf' || name === 'skipIf') {
        if (mask[i] === '(') i = skipBalanced(mask, i);
        else ok = false;
      } else if (!CHAIN.has(name)) ok = false;
      if (!ok) break;
    }
    if (!ok) continue;
    if (mask[i] !== '(') continue;
    i = skipWs(mask, i + 1);
    const q = mask[i];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    const end = mask.indexOf(q, i + 1);
    if (end < 0) continue;
    const raw = src.slice(i + 1, end);
    out.push(q === '`' ? raw : raw.replace(/\\(.)/g, '$1'));
  }
  return out;
}

const NAME_ID = /(?<![A-Za-z0-9])(?:([A-Z]{1,3})(-?)T([1-9]\d*)(?![0-9])(?!\.[0-9])|(N?FR|POL)-?(\d{3})(?!\d))/g;
const NAME_SUBS = /^[\s_]*([①-⑳](?:[\s_]*[~∼–·,、/-]?[\s_]*[①-⑳])*)/u;

/** 이름 속 ID와 바로 뒤 세부 번호: [{ id, subs(번호 배열 또는 null), dashed }] */
function scanMarks(title) {
  const out = [];
  for (const m of title.matchAll(NAME_ID)) {
    if (m[1]) {
      const g = NAME_SUBS.exec(title.slice(m.index + m[0].length));
      out.push({ id: `${m[1]}-T${m[3]}`, subs: g ? groupNumbers(g[1]) : null, dashed: m[2] === '-' });
    } else out.push({ id: `${m[4]}-${m[5]}`, subs: null, dashed: true });
  }
  return out;
}

/** 이름 속 ID와 그 바로 뒤의 세부 번호 묶음: [{ id, subs }]. 가운데 '-'를 뺀 꼴(ST23_②, FR073_)도 읽는다 */
export function marksIn(title) {
  return scanMarks(title).map(({ id, subs }) => ({ id, subs }));
}

export function isTestFile(rel) {
  return TEST_EXT.test(rel) && (/\.(test|spec)\.[^/]+$/.test(rel) || /(^|\/)(test|test-int|test-sim|e2e)\//.test(rel));
}

function* walk(root, rel = '') {
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, p);
    } else yield p;
  }
}

/** 저장소의 시험 이름: [{ file, title }] */
export function scanTests(root) {
  const out = [];
  for (const file of [...walk(root)].filter(isTestFile).sort()) {
    const text = readFileSync(join(root, file), 'utf8');
    if (file.startsWith('tools/ci/') && IGNORE.test(text)) continue;
    for (const title of testTitles(text)) out.push({ file, title });
  }
  return out;
}

// ---------- notes ----------
/** notes 항목 칸: { kind, id, subs | asvsDoc } */
function parseKey(raw) {
  let m = /^([A-Z]{1,3}-T\d+)\s*([①-⑳][①-⑳~∼–·,、\s]*)?$/u.exec(raw);
  if (m) return { kind: 'scenario', id: m[1], subs: m[2] ? groupNumbers(m[2]) : null };
  if (REQ_ID.test(raw)) return { kind: 'requirement', id: raw, subs: null };
  m = /^(?:([\w-]+):)?(v5\.0\.0-\d+\.\d+\.\d+)$/.exec(raw);
  if (m) return { kind: 'asvs', id: m[2], asvsDoc: m[1] ?? null, subs: null };
  return null;
}

/** docs/review/ledger-notes.md의 표: { rows, errors }. 머리 첫 칸이 '항목'이고 '상태' 칸이 있는 표만 읽는다 */
export function readNotes(text, file = FILES.notes) {
  const rows = [];
  const errors = [];
  for (const t of tables(text)) {
    if (t.head[0] !== '항목' || !t.head.includes('상태')) continue;
    const col = (re) => t.head.findIndex((n) => re.test(n));
    const [st, gr, wh, why] = [/^상태$/, /^등급$/, /^정할 곳/, /^근거/].map(col);
    for (const r of t.rows) {
      const c = r.cells;
      if (/^:?-+:?$/.test(c[0] ?? '')) continue;
      const raw = plain(c[0] ?? '');
      const at = `${file}:${r.line}: ${raw}`;
      const key = parseKey(raw);
      const status = plain(c[st] ?? '');
      const grade = gr >= 0 ? plain(c[gr] ?? '') : '';
      const where = wh >= 0 ? (c[wh] ?? '').trim() : '';
      const reason = why >= 0 ? (c[why] ?? '').trim() : '';
      if (!key) errors.push(`${at}: 항목 칸의 꼴을 모른다('S-T23 ⑥', 'S-T23', 'NFR-007', 'payment:v5.0.0-1.2.4' 꼴)`);
      else if (status === '자동 시험') errors.push(`${at}: notes로 자동 시험을 적을 수 없다(시험 이름으로만 정한다)`);
      else if (status && !NOTE_STATUSES.has(status)) errors.push(`${at}: 모르는 상태 '${status}'(${[...NOTE_STATUSES].join('·')})`);
      else if (grade && !GRADES.includes(grade)) errors.push(`${at}: 모르는 등급 '${grade}'(A·B·C)`);
      else if (!status && !grade) errors.push(`${at}: 상태도 등급도 비었다`);
      else if (status === '미검증' && !reason) errors.push(`${at}: 미검증에 사유가 없다(근거·사유 칸)`);
      else rows.push({ ...key, raw, status, grade, where, reason, line: r.line, at });
    }
  }
  return { rows, errors };
}

// ---------- 상태 판정 ----------
export function gradeOf(doc) {
  return GRADE_BY_DOC.find(([re]) => re.test(doc))?.[1] ?? DEFAULT_GRADE;
}

const push = (map, k, v) => {
  const a = map.get(k);
  if (a) a.push(v);
  else map.set(k, [v]);
};
const filesOf = (marks) => [...new Set(marks.map((x) => x.file))].sort();

/**
 * 항목마다 상태·등급·근거를 정한다.
 * 돌려줌: { items(+ status, grade, where, reason, evidence, auto, noted), errors, conflicts(notes는 다른 단계·미검증인데 이름을 단 시험이 있다), unknownMarks }
 */
export function judge({ items, titles = [], notes = { rows: [], errors: [] }, dirs = [] }) {
  const errors = [...notes.errors];
  const known = new Map();
  for (const it of items) push(known, it.id, it);
  const byId = new Map();
  const tags = new Map();
  const unknown = new Map();
  for (const { file, title } of titles) {
    for (const mk of scanMarks(title)) {
      const own = known.get(mk.id);
      if (!own) {
        if (mk.dashed && SCEN_ID.test(mk.id)) push(unknown, mk.id, file);
        continue;
      }
      push(byId, mk.id, { file, subs: mk.subs });
      const defined = new Set(own.map((x) => x.sub));
      if (!defined.has(null)) for (const n of mk.subs ?? []) if (!defined.has(n)) push(unknown, `${mk.id} ${circled(n)}`, file);
    }
    for (const t of tagsIn(title)) push(tags, t.id, { file });
  }
  // notes: 항목 키 → 세부 행·ID 행
  const keyed = new Map(items.map((it) => [it.key, it]));
  const subNote = new Map();
  const idNote = new Map();
  for (const row of notes.rows) {
    let targets;
    let specific = false;
    if (row.kind === 'scenario' && row.subs) {
      targets = row.subs.map((n) => keyed.get(`${row.id} ${circled(n)}`));
      specific = true;
    } else if (row.kind === 'asvs') {
      targets = row.asvsDoc ? [keyed.get(`${row.asvsDoc}:${row.id}`)] : (known.get(row.id) ?? []).filter((x) => x.kind === 'asvs');
      specific = Boolean(row.asvsDoc);
    } else targets = (known.get(row.id) ?? []).filter((x) => x.kind === row.kind);
    if (!targets.length || targets.some((x) => !x)) {
      errors.push(`${row.at}: 정본에 없는 항목이다`);
      continue;
    }
    const map = specific ? subNote : idNote;
    if (targets.some((x) => map.has(x.key))) {
      errors.push(`${row.at}: 같은 항목을 두 번 적었다`);
      continue;
    }
    for (const x of targets) map.set(x.key, row);
  }
  const auto = (it) => {
    if (it.kind === 'asvs') {
      if (!it.applied) return { status: '해당 없음', reason: it.reason };
      if (it.designOnly) return { status: '다른 단계', where: '운영 확인', reason: "구현 위치가 '(운영 설계만)'이다" };
      // 그 행의 코드 영역 안 시험 파일의 태그만 센다. 같은 ID의 태그가 영역 밖에만 있으면 ID만이다(다른 기능의 시험이 대신하지 않는다)
      const area = codeArea(it, dirs);
      const hit = tags.get(it.id) ?? [];
      const own = hit.filter((x) => inArea(x.file, area));
      if (own.length) return { status: '자동 시험', evidence: filesOf(own), area };
      return hit.length ? { status: 'ID만', evidence: filesOf(hit), area } : { status: '빈칸', area };
    }
    if (it.removed) return { status: '없앰' };
    const marks = byId.get(it.id) ?? [];
    if (it.sub === null) return marks.length ? { status: '자동 시험', evidence: filesOf(marks) } : { status: '빈칸' };
    const hit = marks.filter((x) => x.subs?.includes(it.sub));
    if (hit.length) return { status: '자동 시험', evidence: filesOf(hit) };
    return marks.length ? { status: 'ID만', evidence: filesOf(marks) } : { status: '빈칸' };
  };
  const conflicts = [];
  const out = items.map((it) => {
    const a = auto(it);
    const s = subNote.get(it.key);
    const d = idNote.get(it.key);
    const by = s?.status ? s : d?.status ? d : null;
    const r = {
      ...it,
      status: by?.status ?? a.status,
      grade: s?.grade || d?.grade || gradeOf(it.doc),
      where: by ? by.where : a.where ?? '',
      reason: by ? by.reason : a.reason ?? '',
      evidence: a.evidence ?? [],
      ...(a.area ? { area: a.area } : {}),
      auto: a.status,
      noted: Boolean(by),
    };
    if (by && (by.status === '다른 단계' || by.status === '미검증') && a.status === '자동 시험') conflicts.push(r);
    return r;
  });
  const unknownMarks = [...unknown].map(([id, files]) => ({ id, files: [...new Set(files)].sort() })).sort((x, y) => x.id.localeCompare(y.id));
  return { items: out, errors, conflicts, unknownMarks };
}

// ---------- 범위 ----------
function idRange(tok) {
  const m = /^([A-Z]{1,3}-T)(\d+)\s*[~∼]\s*(?:\1)?(\d+)$/.exec(tok) ?? /^((?:N?FR|POL)-)(\d{3})\s*[~∼]\s*(?:\1)?(\d{3})$/.exec(tok);
  if (!m) return null;
  const ids = new Set();
  for (let n = Number(m[2]); n <= Number(m[3]); n++) ids.add(`${m[1]}${m[1].endsWith('T') ? n : String(n).padStart(3, '0')}`);
  return ids;
}

function matcher(tok) {
  if (/^docs\/.+\.md$/.test(tok)) return (i) => i.doc === tok;
  let m = /^([A-Z]{1,3}-T\d+)\s*([①-⑳][①-⑳~∼–·、\s]*)$/u.exec(tok);
  if (m) {
    const subs = groupNumbers(m[2]);
    return (i) => i.id === m[1] && subs.includes(i.sub);
  }
  if (SCEN_ID.test(tok)) return (i) => i.id === tok;
  if (/^[A-Z]{1,3}-T$/.test(tok)) return (i) => i.kind === 'scenario' && i.id.startsWith(tok) && /^\d+$/.test(i.id.slice(tok.length));
  if (REQ_ID.test(tok)) return (i) => i.id === tok || (i.kind === 'scenario' && i.refs.includes(tok));
  const range = idRange(tok);
  if (range) return (i) => range.has(i.id) || (i.kind === 'scenario' && i.refs.some((x) => range.has(x)));
  if (ASVS_ID.test(tok)) return (i) => i.kind === 'asvs' && i.id === tok;
  m = /^([\w-]+):(v5\.0\.0-\d+\.\d+\.\d+)$/.exec(tok);
  if (m) return (i) => i.key === tok;
  return () => false;
}

/**
 * 범위 글(쉼표로 나눈 토큰)에 드는 항목: { items, errors, warnings }. '-'만 적은 칸은 빈 범위다.
 * docs(정본 문서 경로 집합)에 있는 문서인데 항목이 없으면(시험 표가 없는 문서) 오류가 아니라 경고다
 */
export function selectScope(items, text, { docs = new Set() } = {}) {
  const errors = [];
  const warnings = [];
  const chosen = new Set();
  for (const raw of text.split(/[,;·]/)) {
    const tok = raw.replace(/`/g, '').trim();
    if (!tok || /^[-—–]$/.test(tok)) continue;
    const hit = items.filter(matcher(tok));
    if (!hit.length) {
      if (docs.has(tok)) warnings.push(`범위 토큰 '${tok}': 정본 문서이지만 장부 항목(시험 표·ASVS 표의 행)이 없다`);
      else errors.push(`범위 토큰 '${tok}'에 맞는 항목이 없다`);
    }
    for (const h of hit) chosen.add(h.key);
  }
  return { items: items.filter((i) => chosen.has(i.key)), errors, warnings };
}

function batchRow(buildOrderText, batchId) {
  let found = false;
  for (const t of tables(buildOrderText)) {
    if (t.head[0] !== '묶음' || !t.head.includes('장부 범위')) continue;
    found = true;
    const row = t.rows.find((r) => plain(r.cells[0] ?? '') === batchId);
    if (row) return { scope: row.cells[t.head.indexOf('장부 범위')] ?? '', grade: plain(row.cells[t.head.indexOf('등급')] ?? '') };
  }
  throw new UsageError(found ? `${FILES.build} 기능 묶음 표에 ${batchId} 행이 없다` : `${FILES.build}에 기능 묶음 표(머리 '| 묶음 | … | 장부 범위 | … |')가 없다`);
}

/** docs/BUILD_ORDER.md '기능 묶음' 표에서 그 묶음 행의 '장부 범위' 칸 */
export function batchScope(buildOrderText, batchId) {
  return batchRow(buildOrderText, batchId).scope;
}

// ---------- 저장소 읽기 ----------
/** 분야: docs/features/x·docs/security/asvs/x → x, docs/security/* → security, docs/planning/* → requirements, docs/x.md → x, docs/d/… → d */
export function areaOf(doc) {
  let m = /^docs\/features\/([\w-]+)\.md$/.exec(doc);
  if (m) return m[1];
  m = /^docs\/security\/asvs\/([\w-]+)\.md$/.exec(doc);
  if (m) return ASVS_AREA[m[1]] ?? m[1];
  if (doc.startsWith('docs/security/')) return 'security';
  if (doc.startsWith('docs/planning/')) return 'requirements';
  m = /^docs\/([\w-]+)\.md$/.exec(doc);
  if (m) return m[1];
  return /^docs\/([\w-]+)\//.exec(doc)?.[1] ?? 'other';
}

/** 정본과 시험 원본과 notes를 읽는다: { items, titles, notes, warnings, docs(정본 문서 경로), dirs(apps/·services/ 아래 폴더) } */
export function collect(root) {
  const read = (p) => readFileSync(join(root, p), 'utf8').replaceAll('\r\n', '\n');
  const warnings = [];
  const docs = [...walk(join(root, 'docs'))].filter((p) => p.endsWith('.md')).map((p) => `docs/${p}`).filter((p) => !NOT_CANON.test(p)).sort();
  const scenario = [];
  const keys = new Map();
  for (const doc of docs) {
    const r = scenarioItems(doc, read(doc));
    warnings.push(...r.warnings);
    for (const it of r.items) {
      if (keys.has(it.key)) {
        warnings.push(`${doc}:${it.line}: ${it.key}가 ${keys.get(it.key)}에도 있어 뒤의 것은 뺀다`);
        continue;
      }
      keys.set(it.key, `${it.doc}:${it.line}`);
      scenario.push(it);
    }
  }
  const refs = new Set(scenario.flatMap((i) => i.refs));
  const requirement = requirementItems(read(FILES.req), read(FILES.pol), refs);
  const asvsDir = join(root, FILES.asvs);
  const asvs = existsSync(asvsDir)
    ? readdirSync(asvsDir).filter((f) => f.endsWith('.md')).sort().flatMap((f) => asvsItems(`${FILES.asvs}/${f}`, read(`${FILES.asvs}/${f}`)))
    : [];
  const notesText = existsSync(join(root, FILES.notes)) ? read(FILES.notes) : '';
  // 코드 표시 속 이름(`purchase-svc`, `web`)을 풀 폴더: apps/·services/ 아래 폴더
  const dirs = ['apps', 'services'].flatMap((top) =>
    existsSync(join(root, top)) ? readdirSync(join(root, top), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${top}/${e.name}`) : [],
  );
  return { items: [...scenario, ...requirement, ...asvs], titles: scanTests(root), notes: readNotes(notesText), warnings, docs: new Set(docs), dirs };
}

// ---------- 쓰기 ----------
/** 표 칸에 넣는 글: 링크·굵게를 풀고, 낱말 경계에서 자르고, 짝 없는 백틱을 빼고, '|'를 '\|'로 */
function cellText(s, max = 0) {
  let t = String(s ?? '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\\\|/g, '|')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = [...t];
  if (max && chars.length > max) {
    let cut = chars.slice(0, max).join('');
    const sp = cut.lastIndexOf(' ');
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    t = `${cut.replace(/[\s,.(·]+$/, '')}…`;
  }
  if ((t.match(/`/g) ?? []).length % 2) {
    const k = t.lastIndexOf('`');
    t = t.slice(0, k) + t.slice(k + 1);
  }
  // 역슬래시를 먼저 이스케이프해야 | 앞의 역슬래시가 원문의 것과 섞이지 않는다(CodeQL js/incomplete-sanitization)
  return t.replace(/\\/g, '\\\\').replace(/\|/g, '\\|') || '—';
}

const countBy = (items, f) => {
  const m = new Map();
  for (const i of items) m.set(f(i), (m.get(f(i)) ?? 0) + 1);
  return m;
};
const n = (items, status) => items.filter((i) => i.status === status).length;
const areaText = (it) => (it.area?.length ? `영역: ${it.area.join(', ')}` : '영역: 아직 코드가 없다');
const where = (it) => {
  if (it.status === '자동 시험' || it.status === 'ID만') {
    const ev = it.evidence;
    const files = `${ev.slice(0, 2).join(', ')}${ev.length > 2 ? ` 외 ${ev.length - 2}곳` : ''}`;
    if (it.noted) return `${it.where} ${it.reason}`.trim();
    return it.kind === 'asvs' && it.status === 'ID만' ? `다른 곳 시험: ${files} (${areaText(it)})` : `시험: ${files}`;
  }
  if (it.kind === 'asvs' && it.status === '빈칸') return areaText(it);
  const s = [it.where, it.reason].filter(Boolean).join(' · ');
  return it.noted && it.auto === '자동 시험' ? `${s} (이름을 단 시험도 있다)` : s;
};

function statusTable(items, rowsOf, label) {
  const lines = [`| ${label.join(' | ')} | ${STATUSES.join(' | ')} | 합계 |`, `| ${[...label, ...STATUSES, '합계'].map(() => '---').join(' | ')} |`];
  for (const [cellsOf, group] of rowsOf) lines.push(`| ${cellsOf.join(' | ')} | ${STATUSES.map((s) => n(group, s)).join(' | ')} | ${group.length} |`);
  lines.push(`| ${label.map((_, k) => (k ? '' : '합계')).join(' | ')} | ${STATUSES.map((s) => n(items, s)).join(' | ')} | ${items.length} |`);
  return lines;
}

const LIMITS = [
  '시험이 통과했는지는 보지 않는다. 통과는 `tools/ci/trace-check.mjs`가 시험 보고서로 본다(docs/architecture.md §8.6의 대조).',
  '이름만 본다. 이름에 ID와 세부 번호를 단 시험이 그 판정 기준을 실제로 검사하는지는 모른다. 그것은 ADR-0256 결정 3의 판정 기준 대조와 틀린 구현 검사의 몫이다.',
  '이름은 원본의 글자로 읽는다(test·it·describe·suite·bench의 첫 인자, 템플릿의 `${…}`는 그대로). 변수로 만든 이름(`test(name, …)`)은 읽지 못한다. describe 이름도 하나의 이름으로 세므로, describe에 단 ID·세부 번호는 그 안 시험 모두의 것이 된다.',
  "세부 번호는 ID 바로 뒤에 붙은 묶음만 센다('S-T23 ① … ③ …'의 ③은 세지 않는다). js·ts·mjs 시험만 읽는다(파이썬·Lua·k6 스크립트는 읽지 않는다).",
  'ASVS 태그는 그 행의 코드 영역 안 시험 파일의 것만 센다. 영역은 구현 위치 칸이 가리키는 코드(경로의 앞 두 마디, 서비스·앱 이름)이고, 가리키는 것이 없으면 ASVS 문서별 기본 영역(`tools/ci/ledger.mjs`의 `ASVS_DEFAULT_AREA`, 아직 코드가 없는 기능은 빈 목록)이다. 영역은 폴더 단위라, 같은 서비스 안의 다른 기능 시험이 같은 ID 태그를 달면 그것도 센다. `tools/ci/asvs-report.mjs`는 영역 없이 ID 단위로 센다.',
  '판정 기준은 동그라미 번호로만 나눈다. 번호 없는 판정 기준 안의 여러 조건은 항목 하나로 센다.',
  "notes가 적은 상태가 시험 이름보다 앞선다. notes가 다른 단계·미검증인데 이름을 단 시험이 이미 있으면 위 '다시 볼 notes'에 보인다.",
];

/** 장부 파일들: 경로 → 글 */
export function render(ledger, warnings = []) {
  const items = ledger.items;
  const out = new Map();
  const areas = [...new Set(items.map((i) => areaOf(i.doc)))].sort();
  const kinds = countBy(items, (i) => i.kind);
  const lines = [
    '# 완성 장부',
    '',
    '`tools/ci/ledger.mjs`가 정본에서 다시 쓴다(ADR-0256 결정 2, docs/architecture.md §8.6). 손으로 고치지 않는다. 손으로 정하는 상태·등급·사유는 `docs/review/ledger-notes.md`에 쓴다. 분야마다 항목 목록은 이 폴더의 `<분야>.md`에 있다.',
    '',
    '## 완성 판정',
    '',
    `- 항목 ${items.length}개: 시험 시나리오(세부 단위) ${kinds.get('scenario') ?? 0}, 시나리오가 가리키지 않는 요구사항·정책 ${kinds.get('requirement') ?? 0}, ASVS 추적 표의 행 ${kinds.get('asvs') ?? 0}`,
    `- 빈칸 ${n(items, '빈칸')}, ID만 ${n(items, 'ID만')}: 완성본은 둘 다 0이다(묶음은 \`node tools/ci/ledger.mjs --batch <묶음> --require\`로 그 범위만 본다)`,
    '- ID만의 뜻: 시나리오는 이름에 ID만 있고 그 세부 번호가 없는 시험만 있다. ASVS는 다른 곳 시험만 있는 경우도 ID만이다(같은 ID의 태그가 그 행의 코드 영역 밖 시험 파일에만 있다)',
    `- 미검증 ${n(items, '미검증')}(모두 사유가 있다): 완료로 세지 않고 따로 센다`,
    `- 다시 볼 notes ${ledger.conflicts.length}: notes는 다른 단계·미검증인데 이름을 단 시험이 이미 있다`,
    '',
    '## 등급별 상태',
    '',
    ...statusTable(items, GRADES.map((g) => [[g], items.filter((i) => i.grade === g)]), ['등급']),
    '',
    '## 분야별 상태',
    '',
    ...statusTable(
      items,
      areas.flatMap((a) => GRADES.map((g) => [[a, g], items.filter((i) => areaOf(i.doc) === a && i.grade === g)])).filter(([, g]) => g.length),
      ['분야', '등급'],
    ),
    '',
    '## 다시 볼 notes',
    '',
  ];
  if (ledger.conflicts.length) {
    lines.push('| 항목 | notes 상태 | 이름을 단 시험 |', '| --- | --- | --- |');
    for (const c of ledger.conflicts) lines.push(`| ${c.key} | ${c.status} | ${cellText(c.evidence.join(', '), 120)} |`);
  } else lines.push('없음');
  lines.push('', '## 정본에 없는 ID·세부 번호를 단 시험 이름', '');
  if (ledger.unknownMarks.length) for (const u of ledger.unknownMarks) lines.push(`- ${u.id}: ${u.files.slice(0, 3).join(', ')}${u.files.length > 3 ? ` 외 ${u.files.length - 3}곳` : ''}`);
  else lines.push('없음');
  lines.push('', '## 표 읽기 경고', '');
  if (warnings.length) for (const w of warnings) lines.push(`- ${cellText(w)}`);
  else lines.push('없음');
  lines.push('', '## 이 도구의 한계', '', ...LIMITS.map((l) => `- ${l}`), '');
  out.set(`${FILES.out}/README.md`, lines.join('\n'));

  for (const a of areas) {
    const mine = items.filter((i) => areaOf(i.doc) === a);
    const docs = [...new Set(mine.map((i) => i.doc))];
    const body = [
      `# 완성 장부: ${a}`,
      '',
      `\`tools/ci/ledger.mjs\`가 정본에서 다시 쓴다. 손으로 고치지 않는다(상태·등급·사유는 \`docs/review/ledger-notes.md\`). 원천: ${docs.map((d) => `\`${d}\``).join(', ')}. 전체 개수와 이 도구의 한계는 \`docs/review/ledger/README.md\`에 있다.`,
      '',
      ...statusTable(mine, GRADES.map((g) => [[g], mine.filter((i) => i.grade === g)]).filter(([, g]) => g.length), ['등급']),
    ];
    for (const d of docs) {
      body.push('', `## ${d}`, '', '| 항목 | 세부 | 제목 | 판정 기준 앞부분 | 상태 | 등급 | 근거 |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const i of mine.filter((x) => x.doc === d)) {
        // 세부의 판정 글은 번호를 앞에 붙여 읽는다('①은 공격마다 …'. 조사로 시작하면 띄우지 않는다)
        const crit = i.sub ? `${circled(i.sub)}${/^[은는이가도의과와을를에로만]/.test(i.criterion) ? '' : ' '}${i.criterion}` : i.criterion;
        body.push(`| ${i.id} | ${i.sub ? circled(i.sub) : '—'} | ${cellText(i.title, 40)} | ${cellText(crit, 90)} | ${i.status} | ${i.grade} | ${cellText(where(i), 120)} |`);
      }
    }
    out.set(`${FILES.out}/${a}.md`, `${body.join('\n')}\n`);
  }
  return out;
}

// ---------- 명령줄 ----------
function scopeReport(sel, label, grade) {
  const items = sel.items;
  const lines = [`범위: ${label} (항목 ${items.length}개${grade ? `, 묶음 등급 ${grade}` : ''})`, `상태: ${STATUSES.map((s) => `${s} ${n(items, s)}`).join(', ')}`];
  const grades = countBy(items, (i) => i.grade);
  lines.push(`등급: ${GRADES.map((g) => `${g} ${grades.get(g) ?? 0}`).join(', ')}`);
  for (const i of items.filter((x) => ['빈칸', 'ID만', '미검증'].includes(x.status))) {
    lines.push(`${i.status} ${i.key} [${i.grade}] ${cellText(i.title, 40).replace(/\\\|/g, '|')} (${i.doc}${i.status === '빈칸' ? '' : `, ${cellText(where(i), 100).replace(/\\\|/g, '|')}`})`);
  }
  return lines;
}

function main(argv) {
  const opt = { check: false, require: false, scope: null, batch: null, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') opt.check = true;
    else if (a === '--require') opt.require = true;
    else if (a === '--scope' || a === '--batch' || a === '--root') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a}에 값이 없다`);
      opt[a.slice(2)] = v;
    } else throw new UsageError(`모르는 인자: ${a}`);
  }
  if (opt.scope !== null && opt.batch !== null) throw new UsageError('--scope와 --batch는 함께 쓰지 않는다');
  const data = collect(opt.root);
  const ledger = judge(data);
  if (ledger.errors.length) {
    process.stderr.write(`${ledger.errors.join('\n')}\nnotes 오류 ${ledger.errors.length}개: 아무것도 고치지 않았다\n`);
    return 2;
  }
  const outputs = render(ledger, data.warnings);
  const outDir = join(opt.root, FILES.out);
  const stale = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith('.md') && !outputs.has(`${FILES.out}/${f}`)).map((f) => `${FILES.out}/${f}`) : [];
  const changed = [...outputs].filter(([p, t]) => !existsSync(join(opt.root, p)) || readFileSync(join(opt.root, p), 'utf8').replaceAll('\r\n', '\n') !== t);
  const fileReport = [...changed.map(([p]) => `${p}: 다시 쓴다`), ...stale.map((p) => `${p}: 지운다`)];
  const total = `항목 ${ledger.items.length}개, 빈칸 ${n(ledger.items, '빈칸')}, ID만 ${n(ledger.items, 'ID만')}, 미검증 ${n(ledger.items, '미검증')}`;

  if (opt.scope !== null || opt.batch !== null || opt.require) {
    let label = '장부 전체';
    let grade = '';
    let sel = { items: ledger.items, errors: [], warnings: [] };
    if (opt.scope !== null || opt.batch !== null) {
      let text = opt.scope;
      if (opt.batch !== null) {
        const row = batchRow(readFileSync(join(opt.root, FILES.build), 'utf8').replaceAll('\r\n', '\n'), opt.batch);
        ({ grade } = row);
        text = row.scope;
        label = `${opt.batch} '${text.replace(/`/g, '')}'`;
      } else label = text;
      sel = selectScope(ledger.items, text, { docs: data.docs });
      if (sel.errors.length) {
        process.stderr.write(`${sel.errors.join('\n')}\n`);
        return 2;
      }
      for (const w of sel.warnings) process.stderr.write(`경고: ${w}\n`);
    }
    process.stdout.write(`${scopeReport(sel, label, grade).join('\n')}\n`);
    let code = 0;
    if (opt.check && fileReport.length) {
      process.stdout.write(`${fileReport.join('\n')}\n`);
      code = 1;
    }
    if (opt.require) {
      const bad = sel.items.filter((i) => i.status === '빈칸' || i.status === 'ID만').length;
      process.stdout.write(bad ? `장부 확인 실패: 빈칸 ${n(sel.items, '빈칸')}, ID만 ${n(sel.items, 'ID만')}\n` : `장부 확인 통과(미검증 ${n(sel.items, '미검증')}은 따로 센다)\n`);
      if (bad) code = 1;
    }
    return code;
  }

  for (const w of data.warnings) process.stderr.write(`경고: ${w}\n`);
  if (!fileReport.length) {
    process.stdout.write(`장부가 맞다(${total})\n`);
    return 0;
  }
  process.stdout.write(`${fileReport.join('\n')}\n${total}\n`);
  if (opt.check) return 1;
  mkdirSync(outDir, { recursive: true });
  for (const [p, t] of changed) writeFileSync(join(opt.root, p), t);
  for (const p of stale) rmSync(join(opt.root, p));
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
    process.stderr.write(`ledger: ${e.message}\n`);
    process.exitCode = 2;
  }
}
