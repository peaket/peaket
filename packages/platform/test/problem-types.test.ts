// 서비스 코드가 내는 이름 붙은 오류가 계약의 오류 목록(openapi x-peaket-problem-types)과 맞는지 본다
// (docs/api/guidelines.md §2 '한 type은 언제나 같은 상태 코드와 같은 title', BUILD_ORDER BAS-040).
// 코드에서 `{ type: '<이름>', status: <코드>, title: '<제목>' }` 꼴(ProblemError 인자와 오류 표의 한 줄)을 모두 읽는다.
// v0-monolith는 v0 증명용으로 얼린 서비스라 보지 않는다(그 이름은 실제 서비스가 같은 일을 맡을 때 목록에 더한다).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FROZEN = new Set(['v0-monolith']);

/**
 * 목록과 제목이 다른 코드(서비스 갈래가 고친다). 새로 늘리지 않는다: 같은 뜻이면 목록의 제목을 쓰고, 뜻이 다르면 이름을 따로 짓는다.
 * - queue-svc: dependency-unavailable 둘(대기 상태 파일·대기열의 503), queue-not-found 하나(구간 대기 상태 없음)
 * - purchase-svc: seat-already-held(제목을 목록과 맞춘다)
 */
const KNOWN_TITLE_DIFFS = [
  "purchase-svc seat-already-held '이미 잡힌 좌석이 있습니다'",
  "queue-svc dependency-unavailable '대기 상태를 잠시 만들 수 없습니다'",
  "queue-svc dependency-unavailable '대기열을 잠시 쓸 수 없습니다'",
  "queue-svc queue-not-found '이 회차·구간의 대기 상태가 없습니다'",
];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

interface Found {
  where: string;
  type: string;
  status: number;
  title: string;
}

/** 따옴표·템플릿 글자의 끝 다음 위치(템플릿 안의 `${ … }`는 괄호 수로 건넌다) */
function skipString(text: string, i: number): number {
  const q = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') j += 2;
    else if (c === q) return j + 1;
    else if (q !== '`' && c === '\n') return j;
    else if (q === '`' && c === '$' && text[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
    } else j++;
  }
  return j;
}

/** 정규식 글자의 끝 다음 위치(문자 묶음 [...] 안의 /는 끝이 아니다) */
function skipRegex(text: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < text.length && text[j] !== '\n') {
    const c = text[j];
    if (c === '\\') j += 2;
    else {
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) return j + 1;
      j++;
    }
  }
  return j;
}

/**
 * `{ … }` 객체 글자마다 바로 그 층(안쪽 객체를 뺀 글자)에 type·status·title이 모두 글자 그대로 있는 것.
 * 괄호 짝은 문자열·템플릿·주석·정규식 글자 안의 괄호를 건너뛰고 센다(안쪽에 extensions: { … }가 있는 ProblemError 인자도 읽는다)
 */
export function problemLiterals(text: string, where: string): Found[] {
  const spans: [number, number][] = [];
  const stack: number[] = [];
  let prev = '';
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i);
      i = e < 0 ? text.length : e;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      prev = 'x';
      continue;
    }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev))) {
      i = skipRegex(text, i);
      prev = 'x';
      continue;
    }
    if (c === '{') stack.push(i);
    else if (c === '}') {
      const s = stack.pop();
      if (s !== undefined) spans.push([s, i]);
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out: Found[] = [];
  for (const [s, e] of spans) {
    // 바로 안쪽 객체(자식)를 빼고 이 층의 글자만 남긴다
    let top = '';
    let k = s + 1;
    for (const [cs, ce] of spans) {
      if (cs <= s || ce >= e || cs < k) continue;
      top += text.slice(k, cs);
      k = ce + 1;
    }
    top += text.slice(k, e);
    const type = /\btype: *'([a-z][a-z0-9-]*)'/.exec(top)?.[1];
    const status = /\bstatus: *(\d{3})\b/.exec(top)?.[1];
    const title = /\btitle: *'([^']*)'/.exec(top)?.[1];
    if (type && status && title !== undefined) out.push({ where, type, status: Number(status), title });
  }
  return out;
}

function codeProblems(): Found[] {
  const found: Found[] = [];
  const services = join(ROOT, 'services');
  for (const svc of readdirSync(services, { withFileTypes: true })) {
    if (!svc.isDirectory() || FROZEN.has(svc.name)) continue;
    const src = join(services, svc.name, 'src');
    let files: string[] = [];
    try {
      files = tsFiles(src);
    } catch {
      continue;
    }
    for (const f of files) found.push(...problemLiterals(readFileSync(f, 'utf8'), svc.name));
  }
  for (const f of tsFiles(join(ROOT, 'packages', 'platform', 'src'))) found.push(...problemLiterals(readFileSync(f, 'utf8'), 'platform'));
  return found;
}

async function contractTypes(): Promise<Record<string, { status: number; title: string }>> {
  const { readContract } = await import(`${ROOT.replace(/\\/g, '/')}tools/ci/service-openapi.mjs`);
  const doc = readContract(ROOT) as { 'x-peaket-problem-types'?: { types?: Record<string, { status: number; title: string }> } };
  return doc['x-peaket-problem-types']?.types ?? {};
}

test('problemLiterals는 ProblemError 인자와 오류 표 줄을 읽고, 세 칸이 다 있지 않은 덩어리는 건너뛴다', () => {
  const text = [
    "throw new ProblemError({ type: 'hold-expired', status: 409, title: '홀드가 끝났습니다' });",
    "const T = { A: { status: 409, type: 'already-verified', title: '이미 본인확인을 마친 계정입니다' } };",
    "const x = { type: 'object', properties: {} };",
    // 안쪽 객체가 있어도 그 층의 세 칸을 읽고, 안쪽 객체의 칸은 바깥 것으로 보지 않는다
    "throw new ProblemError({ type: 'withdrawal-confirmation-required', status: 409, title: '탈퇴 전에 확인해 주세요', extensions: { fraudHold: { state: s, until: new Date(u).toISOString() } } });",
    "const y = { status: 200, data: { type: 'not-a-problem', status: 404, title: '안쪽' }.data };",
    // 정규식·문자열·주석 안의 괄호는 짝 세기에 들지 않는다
    "const SEAT = /^[A-Za-z0-9_-]{1,64}$/; const s2 = '{'; const t = `a${'}'}b`; // }",
    "/* { */ const z = { type: 'sold-out', status: 410, title: '매진되었습니다' };",
  ].join('\n');
  expect(problemLiterals(text, 's').map((f) => `${f.type} ${f.status}`)).toEqual([
    'hold-expired 409',
    'already-verified 409',
    'withdrawal-confirmation-required 409',
    'not-a-problem 404',
    'sold-out 410',
  ]);
});

test('서비스 코드의 이름 붙은 오류는 모두 목록에 있고 상태 코드가 같으며, 제목은 알려진 차이 밖에서 같다', async () => {
  const types = await contractTypes();
  expect(Object.keys(types).length).toBeGreaterThan(100);
  const found = codeProblems();
  expect(found.length).toBeGreaterThan(40);
  const missing = found.filter((f) => !types[f.type]).map((f) => `${f.where} ${f.type}`);
  const status = found.filter((f) => types[f.type] && types[f.type].status !== f.status).map((f) => `${f.where} ${f.type} ${f.status}≠${types[f.type].status}`);
  const titles = [...new Set(found.filter((f) => types[f.type] && types[f.type].title !== f.title).map((f) => `${f.where} ${f.type} '${f.title}'`))].sort();
  expect(missing).toEqual([]);
  expect(status).toEqual([]);
  expect(titles).toEqual(KNOWN_TITLE_DIFFS);
  // 정본 openapi와 서비스 코드 전체를 읽어 몰리는 러너에서 기본 5초를 넘긴다(CI 42529879827)
}, 30_000);
