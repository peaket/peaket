// 검사가 읽는 정본 값(docs/frontend.md §5.8 성능 예산 표의 첫 JS·CSS·체감 목표 열, docs/design/tokens.json의 의미 색).
// 숫자를 코드에 옮겨 적지 않고 정본에서 읽는다(docs/architecture.md §8.6 '정본이 이긴다').
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * §5.8 표의 행마다 칸 글을 읽는다.
 * @returns {Array<Record<string, string>>} 머리 칸 이름 → 그 행의 칸 글
 */
export function parseBudgetRows(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^### 5\.8 성능 예산 표/.test(l));
  if (start < 0) throw new Error('docs/frontend.md §5.8 성능 예산 표를 찾지 못했다');
  const out = [];
  let header = null;
  for (let i = start + 1; i < lines.length && !/^#{2,3} /.test(lines[i]); i++) {
    if (!lines[i].startsWith('|')) continue;
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    out.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  }
  if (out.length === 0) throw new Error('§5.8 표에 행이 없다');
  return out;
}

/** 칸 글의 첫 'NNKB'(kB, 1kB = 1,000바이트). '10KB 미만(정본), 목표 8KB [가정]' → 10, '200KB [가정] + Worker 60KB [가정]' → 200 */
function firstKB(row, column) {
  const m = /(\d+(?:\.\d+)?)\s*KB/.exec(row[column] ?? '');
  if (!m) throw new Error(`§5.8 ${row['경로 묶음']} 행의 ${column} 예산을 읽지 못했다: ${row[column]}`);
  return Number(m[1]);
}

/**
 * 경로 묶음마다 한 열의 예산(kB)
 * @returns {Map<string, number>} 경로 묶음 칸의 글 → 예산
 */
function budgetsOf(md, column) {
  return new Map(parseBudgetRows(md).map((row) => [row['경로 묶음'], firstKB(row, column)]));
}

/** §5.8 CSS 열(첫 화면 CSS 전체, gzip) */
export const parseCssBudgets = (md) => budgetsOf(md, 'CSS');
/** §5.8 첫 JS 열(첫 화면에 실리는 JS, gzip, 프레임워크 포함) */
export const parseJsBudgets = (md) => budgetsOf(md, '첫 JS');

/**
 * §5.8 체감 목표 열에서 Lighthouse가 재는 적재 지표(LCP 초, CLS)를 읽는다. 없으면 그 칸은 비운다(예: 좌석 화면은 '통과 뒤 첫 그림')
 * @returns {Map<string, { lcpMs?: number, cls?: number }>}
 */
export function parseLoadTargets(md) {
  const out = new Map();
  for (const row of parseBudgetRows(md)) {
    const t = row['체감 목표'] ?? '';
    const lcp = /LCP(?: p75)? (\d+(?:\.\d+)?)초/.exec(t);
    const cls = /CLS (\d+(?:\.\d+)?)/.exec(t);
    out.set(row['경로 묶음'], { ...(lcp ? { lcpMs: Number(lcp[1]) * 1000 } : {}), ...(cls ? { cls: Number(cls[1]) } : {}) });
  }
  return out;
}

/** §5.8 'Lighthouse CI' 항목의 총 차단 시간 한도(ms) */
export function parseTbtLimitMs(md) {
  const line = md.split(/\r?\n/).find((l) => l.startsWith('- **Lighthouse CI**'));
  const m = line && /총 차단 시간 (\d+)ms/.exec(line);
  if (!m) throw new Error("docs/frontend.md §5.8 'Lighthouse CI' 항목에서 총 차단 시간 한도(NNNms)를 찾지 못했다");
  return Number(m[1]);
}

const frontendMd = () => readFileSync(resolve(repoRoot, 'docs/frontend.md'), 'utf8');
export const loadTbtLimitMs = () => parseTbtLimitMs(frontendMd());
export const loadCssBudgets = () => parseCssBudgets(frontendMd());
export const loadJsBudgets = () => parseJsBudgets(frontendMd());
export const loadLoadTargets = () => parseLoadTargets(frontendMd());

/** tokens.json의 의미 색 하나를 별칭까지 풀어 #rrggbb로(예: lightColor('primary')) */
export function semanticColor(mode, name) {
  const raw = JSON.parse(readFileSync(resolve(repoRoot, 'docs/design/tokens.json'), 'utf8'));
  const get = (path) => path.split('.').reduce((o, k) => o?.[k], raw);
  let v = get(`color.semantic.${mode}.${name}`)?.$value;
  for (let n = 0; typeof v === 'string' && v.startsWith('{') && n < 20; n++) v = get(v.slice(1, -1))?.$value;
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`의미 색 ${mode}.${name}을 풀지 못했다: ${v}`);
  return v.toLowerCase();
}

/** '#rrggbb' → 'rgb(r, g, b)'(브라우저 계산 스타일 꼴) */
export function rgb(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
