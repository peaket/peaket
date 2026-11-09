// SEED CSS 층 검사기(FE-T36 ①②③와 크기, docs/frontend.md §5.17, docs/design/d2 §1 'SEED CSS 싣기'·'CSS 층 순서').
// 빌드한 화면이 싣는 CSS 파일(문서에 나오는 차례)을 받아 문제 목록(빈 배열이면 통과)을 돌려준다. 파일을 읽지 않는 순수 함수다.
import { gzipSync } from 'node:zlib';

/** 정한 층 차례(d2 §1). 앞 넷 가운데 theme·base·utilities와 components는 Tailwind 층, seed-*는 SEED 층 판의 층이다 */
export const LAYER_ORDER = ['theme', 'base', 'seed-base', 'seed-components', 'components', 'utilities'];
/** Tailwind v4가 @property를 못 쓰는 브라우저를 위해 맨 앞에 두는 층. 맨 앞(가장 약한 자리)일 때만 받는다 */
const TAILWIND_PROPERTIES = 'properties';
/** 안에 규칙을 담고 층은 바꾸지 않는 묶음 at-rule */
const GROUPING = new Set(['media', 'supports', 'container', 'scope', 'starting-style', 'document']);
const SEED_CLASS = /\.seed-[A-Za-z0-9_-]/;
/** SEED 전체 CSS(all*.css)에만 있는 당근 전용 부품 클래스(base에는 없다. 쓰지 않는 부품이라 recipe로도 실리지 않는다, d2 §1.1) */
const SEED_ALL_MARK = '.seed-manner-temp';

/** 주석을 지운다. 따옴표 안과 이스케이프된 글자는 건드리지 않는다 */
function stripComments(css) {
  let out = '';
  let quote = null;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < css.length) out += css[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < css.length) {
      out += ch + css[++i];
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/**
 * `@import` 머리말에서 층 이름을 읽는다. `layer(x)`면 x, 이름 없는 `layer`면 '(이름 없음)'(@layer {}와 같은 이름), 층이 없으면 null.
 * 따옴표 글과 url(…)은 먼저 비운다(파일 이름 안의 'layer('는 층이 아니다).
 */
function importLayer(prelude) {
  const rest = prelude
    .slice('@import'.length)
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""')
    .replace(/url\([^)]*\)/gi, 'url()');
  const m = /(?<![\w-])layer(?:\(\s*([^()]*?)\s*\)|(?![\w(-]))/i.exec(rest);
  if (!m) return null;
  return m[1] || '(이름 없음)';
}

/**
 * CSS 한 파일을 훑는다.
 * @returns {{ layers: string[], rules: { selector: string, layer: string | null }[] }} 층 이름(처음 나온 차례, 중첩은 a.b)과 규칙마다 든 층
 */
export function scanCss(input) {
  // 주석은 문자 단위로 건너뛰며 지운다(문자열 안의 '/*'는 주석이 아니다). 지운 자리는 공백 하나로 둔다
  const css = stripComments(input);
  const layers = [];
  const rules = [];
  const declare = (name) => {
    // 중첩 층 a.b는 부모 층 a를 먼저 만든다(CSS 층 규칙)
    const parts = name.split('.');
    for (let k = 1; k <= parts.length; k++) {
      const n = parts.slice(0, k).join('.');
      if (!layers.includes(n)) layers.push(n);
    }
  };
  const stack = [{ kind: 'root', layer: null }];
  let start = 0;
  // @import는 맨 앞(@charset·@layer 문 다음)에만 쓸 수 있다. 규칙·블록이 한 번 나온 뒤의 @import는 브라우저가 버린다
  let pastImports = false;
  let quote = null;
  let paren = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    // 따옴표 밖의 이스케이프(Tailwind 클래스 .content-\[\'\'\] 같은)는 다음 글자를 그 글자 그대로 쓴다
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') {
      paren++;
      continue;
    }
    if (ch === ')') {
      if (paren > 0) paren--;
      continue;
    }
    if (paren > 0) continue;
    const top = stack[stack.length - 1];
    if (ch === '{') {
      if (stack.length === 1) pastImports = true;
      const prelude = css.slice(start, i).trim();
      start = i + 1;
      if (top.kind === 'skip') {
        stack.push({ kind: 'skip', layer: top.layer });
      } else if (prelude.startsWith('@')) {
        const at = (/^@([\w-]+)/.exec(prelude)?.[1] ?? '').toLowerCase();
        if (at === 'layer') {
          const name = prelude.slice('@layer'.length).trim() || '(이름 없음)';
          const full = top.layer ? `${top.layer}.${name}` : name;
          declare(full);
          stack.push({ kind: 'layer', layer: full });
        } else if (GROUPING.has(at)) {
          stack.push({ kind: 'group', layer: top.layer });
        } else {
          stack.push({ kind: 'skip', layer: top.layer }); // @keyframes·@font-face·@property 등: 속은 규칙이 아니다
        }
      } else {
        rules.push({ selector: prelude, layer: top.layer });
        stack.push({ kind: 'rule', layer: top.layer });
      }
    } else if (ch === ';') {
      const prelude = css.slice(start, i).trim();
      start = i + 1;
      if (top.kind !== 'skip' && /^@layer\b/i.test(prelude)) {
        for (const n of prelude.slice('@layer'.length).split(',').map((s) => s.trim()).filter(Boolean)) {
          declare(top.layer ? `${top.layer}.${n}` : n);
        }
      } else if (top.kind === 'root' && /^@import\b/i.test(prelude)) {
        // @import … layer(x)·layer도 그 자리(문서 차례)에서 층을 선언한다. 블록 안의 @import와 규칙 뒤의 @import는 브라우저가 버리므로 세지 않는다
        const n = pastImports ? null : importLayer(prelude);
        if (n !== null) declare(n);
      } else if (top.kind === 'root' && prelude && !/^@charset\b/i.test(prelude)) {
        pastImports = true;
      }
    } else if (ch === '}') {
      if (stack.length > 1) stack.pop();
      start = i + 1;
    }
  }
  return { layers, rules };
}

/**
 * ① 층을 가진 첫 CSS 파일이 정한 층 여섯을 정한 차례로 처음 선언하는가. 층 차례는 처음 나온 차례로 정해지므로(CSS 층 규칙)
 * 뒤 CSS가 새 층을 만들면 그 층이 가장 센 층이 된다. Tailwind의 properties 층은 맨 앞만 받는다.
 * @param {string[]} files 화면이 싣는 CSS(문서에 나오는 차례)
 */
export function checkLayerOrder(files) {
  const problems = [];
  let declared = null;
  for (const [n, css] of files.entries()) {
    const top = scanCss(css).layers.filter((l) => !l.includes('.'));
    if (top.length === 0) continue;
    if (declared === null) {
      declared = new Set(top);
      const pIdx = top.indexOf(TAILWIND_PROPERTIES);
      if (pIdx > 0) problems.push(`CSS ${n + 1}: ${TAILWIND_PROPERTIES} 층이 맨 앞이 아니다(${top.join(' → ')})`);
      const ours = top.filter((l) => l !== TAILWIND_PROPERTIES);
      const head = ours.slice(0, LAYER_ORDER.length);
      if (head.join(',') !== LAYER_ORDER.join(',')) {
        problems.push(`CSS ${n + 1}: 층 차례가 ${ours.join(' → ')}다(바람: ${LAYER_ORDER.join(' → ')})`);
      }
      for (const l of LAYER_ORDER) if (!top.includes(l)) problems.push(`CSS ${n + 1}: 첫 CSS가 ${l} 층을 선언하지 않는다`);
      for (const l of ours.slice(LAYER_ORDER.length)) problems.push(`CSS ${n + 1}: 모르는 층 ${l}이 있다`);
    } else {
      for (const l of top) if (!declared.has(l)) problems.push(`CSS ${n + 1}: 뒤 CSS가 새 층 ${l}을 만든다(가장 센 층이 된다)`);
    }
  }
  if (declared === null) problems.push('층 선언이 있는 CSS가 없다(층 순서 선언이 빠졌다)');
  return problems;
}

/**
 * ② SEED 클래스(.seed-*) 규칙이 seed-base·seed-components 층 안에만 있는가. recipe를 주면 그 recipe 규칙이 seed-components에 있는가.
 * @param {string[]} files
 * @param {{ recipe?: string }} [opts] 탐침이 쓴 recipe 이름(예: action-button)
 */
export function checkSeedRules(files, opts = {}) {
  const problems = [];
  const rules = files.flatMap((css) => scanCss(css).rules);
  const short = (s) => (s.length > 80 ? `${s.slice(0, 77)}…` : s);
  for (const r of rules) {
    if (!SEED_CLASS.test(r.selector)) continue;
    if (r.layer !== 'seed-base' && r.layer !== 'seed-components') problems.push(`SEED 규칙 ${short(r.selector)}이 ${r.layer ?? '층 밖'}에 있다`);
  }
  if (opts.recipe) {
    const cls = `.seed-${opts.recipe}`;
    const hits = rules.filter((r) => r.selector.includes(cls));
    if (hits.length === 0) problems.push(`recipe ${opts.recipe}의 규칙(${cls})이 없다(탐침이 SEED 부품 CSS를 싣지 못했다)`);
    else if (hits.some((r) => r.layer !== 'seed-components')) problems.push(`recipe ${opts.recipe}의 규칙이 seed-components 층 밖에 있다`);
  }
  return problems;
}

/** ③ SEED 전체 CSS(all*.css)를 싣지 않았는가 */
export function checkNoSeedAll(files) {
  const hit = files.some((css) => scanCss(css).rules.some((r) => r.selector.includes(SEED_ALL_MARK)));
  return hit ? [`SEED 전체 CSS(all*.css)의 표지 ${SEED_ALL_MARK}가 있다(전체 CSS는 싣지 않는다, d2 §1)`] : [];
}

/**
 * 화면이 싣는 CSS의 gzip 크기 합(kB = 1,000바이트, 소수 첫째 자리. §5.8 예산의 KB와 같은 단위).
 * 파일마다 따로 gzip한다(브라우저가 파일마다 받는다).
 */
export function gzipKB(files) {
  const bytes = files.reduce((n, css) => n + gzipSync(Buffer.from(css)).length, 0);
  return Math.round(bytes / 100) / 10;
}

/** 기준선이 예산을 넘은 경로가 더 커지지 않게 두는 여유(kB) [가정] */
export const OVER_BUDGET_MARGIN = 0.5;

/**
 * 크기 한도(kB). 예산(docs/frontend.md §5.8 CSS 열) 안이면 예산, 기준선(css-baseline.json, 잰 값)이 예산을 넘은 경로는
 * 기준선 + 여유다. 그런 경로는 예산을 다시 정하는 단계(wbs 7.5.2)까지 더 커지지만 않게 막는다(추천 적용 2026-11-04).
 */
export function sizeLimit(budget, baseline) {
  if (baseline === undefined || baseline <= budget) return budget;
  return Math.round((baseline + OVER_BUDGET_MARGIN) * 10) / 10;
}
