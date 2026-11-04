// 검사가 읽는 정본 값(docs/frontend.md §5.8 성능 예산 표의 CSS 열, docs/design/tokens.json의 의미 색).
// 숫자를 코드에 옮겨 적지 않고 정본에서 읽는다(docs/architecture.md §8.6 '정본이 이긴다').
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * §5.8 표에서 경로 묶음마다 CSS 예산(kB, 1kB = 1,000바이트)을 읽는다. 칸의 첫 숫자를 쓴다('10KB 미만(정본), 목표 8KB [가정]' → 10).
 * @returns {Map<string, number>} 경로 묶음 칸의 글 → 예산
 */
export function parseCssBudgets(md) {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^### 5\.8 성능 예산 표/.test(l));
  if (start < 0) throw new Error('docs/frontend.md §5.8 성능 예산 표를 찾지 못했다');
  const out = new Map();
  let header = null;
  for (let i = start + 1; i < lines.length && !/^#{2,3} /.test(lines[i]); i++) {
    if (!lines[i].startsWith('|')) continue;
    const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim());
    if (header === null) {
      header = cells;
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    const css = cells[header.indexOf('CSS')];
    const m = /(\d+(?:\.\d+)?)\s*KB/.exec(css ?? '');
    if (!m) throw new Error(`§5.8 ${cells[0]} 행의 CSS 예산을 읽지 못했다: ${css}`);
    out.set(cells[0], Number(m[1]));
  }
  if (out.size === 0) throw new Error('§5.8 표에 행이 없다');
  return out;
}

export function loadCssBudgets() {
  return parseCssBudgets(readFileSync(resolve(repoRoot, 'docs/frontend.md'), 'utf8'));
}

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
