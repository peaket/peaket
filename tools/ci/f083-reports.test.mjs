// F-08-3(MSR-030·MSR-080) 보고서·사실 대장 대조 시험.
//
// 이 기능은 새로 재지 않는다. F-08-2·F-08-8 보고서와 정본의 설계 목표를 사실 대장에 모으고,
// M6 초안·용량 산정서·비용 리포트·DORA 추세 보고서가 그 값만 쓰는지 본다.
// 시험 커밋(25534a862)과 산출물 기준(19b33ba85)에는 산출물이 없으므로 이 파일은 읽기 실패로 실패해야 한다.
// 실행(저장소 뿌리): node --test tools/ci/f083-reports.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const P = (...parts) => join(REPO, ...parts);

const FACTS = 'docs/review/measurements/F-08-3-facts.json';
const CAPACITY = 'docs/review/measurements/F-08-3-capacity.md';
const COST = 'docs/review/measurements/F-08-3-cost.md';
const DORA = 'docs/review/measurements/F-08-3-dora.md';
const BLOG_DIR = 'docs/blog';
const BLOG_README = 'docs/blog/README.md';
const F082 = 'docs/review/measurements/F-08-2-msr020.md';
const F088 = 'docs/review/measurements/F-08-8-after.md';

const LABELS = new Set(['실측(PC)', '외삽', '문서 인용', '설계 목표', '[추정]', '계산']);
const STATUSES = new Set(['무효', '판정 못 함', '자료 없음', '부분', '미달', '실패']);
const USED_IN = new Set(['m6', 'capacity', 'cost', 'dora']);
const FACT_ID = /^(F082|F088|NFR021|ARCH95|INFRA11|DORA)-[A-Z0-9-]+$/;

function read(rel, what) {
  const path = P(rel);
  assert.ok(existsSync(path), `${what}가 없다: ${rel} (구현 전 기준 실패면 이 실패가 맞다)`);
  return readFileSync(path, 'utf8');
}

function readJson(rel, what) {
  const text = read(rel, what);
  try {
    return JSON.parse(text);
  } catch (e) {
    assert.fail(`${what}가 JSON이 아니다: ${rel} (${e.message})`);
  }
}

function m6Path() {
  assert.ok(existsSync(P(BLOG_DIR)), `블로그 폴더가 없다: ${BLOG_DIR}`);
  const files = readdirSync(P(BLOG_DIR)).filter((f) => /^m6-.*\.md$/.test(f));
  assert.equal(files.length, 1, `M6 초안은 docs/blog/m6-*.md 하나여야 한다. 지금: ${files.join(', ') || '없음'}`);
  return join(BLOG_DIR, files[0]);
}

function readM6() {
  const rel = m6Path();
  return read(rel, 'M6 초안');
}

function section(text, title) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s/.test(line) && line.includes(title));
  assert.notEqual(start, -1, `절을 찾지 못했다: ${title}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function factById(facts, id) {
  const found = (facts.facts ?? []).find((f) => f.id === id);
  assert.ok(found, `사실 대장에 ${id}가 없다`);
  return found;
}

function sourceText(facts, fact) {
  const key = fact.source;
  assert.ok(key && facts.sources?.[key], `${fact.id}: source 키가 잘못됐다: ${key}`);
  return read(facts.sources[key], `${fact.id}의 원천`);
}

const ID_PATTERN = /\b(?:F082|F088|NFR021|ARCH95|INFRA11|DORA)-[A-Z0-9-]+\b/;

function hasForbiddenClaim(line) {
  const claim =
    /(30,?000|3만)\s*(건)?\s*\/\s*초/.test(line) ||
    /초당\s*(30,?000|3만)\s*건/.test(line) ||
    /(30,?000|3만)\s*RPS/.test(line) ||
    /100만[^\n]{0,60}(달성|가능|확인|통과|버틴|처리했)/.test(line) ||
    /K[127][^\n]{0,100}(통과|pass|달성)/i.test(line);
  if (!claim) return false;
  return !/확인하지 않|확인 못|미확인|재지 않|판정 못 함|미달|무효|부분|1\/3|3회 중 1회|1회 통과|일부|불가|동결|주장하지 않/.test(line);
}

function assertNoForbiddenClaims(text, where) {
  const lines = text.split(/\r?\n/);
  let inNonClaim = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) inNonClaim = line.includes('주장하지 않는');
    if (inNonClaim) continue;
    if (hasForbiddenClaim(line)) {
      assert.fail(`${where}: 금지된 수치 주장이 있다: ${line.trim()}`);
    }
  }
}

/** 표 행에 숫자가 있으면 같은 행에 사실 ID가 있어야 한다(머리·구분선 제외) */
function assertTableNumbersHaveIds(text, where) {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|') || /^\|\s*-/.test(line.trimStart())) continue;
    const stripped = line
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/20\d{2}년?/g, '')
      .replace(/\d년차/g, '')
      .replace(ID_PATTERN, '')
      .replace(/1~3년/g, '')
      .replace(/`[^`]*`/g, '');
    if (!/\d/.test(stripped)) continue;
    assert.match(line, ID_PATTERN, `${where}: 표 행에 숫자가 있는데 사실 ID가 없다: ${line.trim()}`);
  }
}

/** M6 카드 밖 숫자(200만·250만·300만·합산 입장 1.25만/1.5만·250대·800/s·500대·2배)를 막는다 */
function assertNoCardOutsideNumbers(m6) {
  let inNonClaim = false;
  let inCode = false;
  for (const line of m6.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if (/^##\s/.test(line)) inNonClaim = line.includes('주장하지 않는');
    if (inNonClaim || /^#{1,6}\s/.test(line)) continue;
    const bad =
      /200만|250만|300만|1\.25만|1\.5만|500대/.test(line) ||
      /(합산|동시 입장)[^\n]{0,40}1만/.test(line) ||
      /250대|800\/s|800\/초|2배|×2/.test(line);
    if (!bad) continue;
    assert.match(line, ID_PATTERN, `M6: 카드 밖 숫자에 사실 ID가 없다: ${line.trim()}`);
  }
}

function loadFacts() {
  const facts = readJson(FACTS, '사실 대장');
  assert.equal(facts.schema, 1, '사실 대장 schema는 1이다');
  assert.match(String(facts.asOf ?? ''), /^\d{4}-\d{2}-\d{2}$/, '사실 대장 asOf는 YYYY-MM-DD다');
  assert.ok(facts.sources && typeof facts.sources === 'object', '사실 대장 sources가 없다');
  assert.ok(Array.isArray(facts.facts) && facts.facts.length > 0, '사실 대장 facts가 비었다');
  return facts;
}

function parseF082() {
  const text = read(F082, 'F-08-2 측정 보고서');
  const x1 =
    text.match(/X₁\(1 vCPU\) = \*\*([\d,]+)\*\*/) ??
    text.match(/X₁\(1 vCPU\) = ([\d,]+)/);
  assert.ok(x1, 'F-08-2 보고서에서 1 vCPU X₁을 찾지 못했다');
  const row250 = text.split(/\r?\n/).find((line) => line.includes('| 250 |') && line.includes('31.25'));
  assert.ok(row250, 'F-08-2 보고서에서 필요한 대수 250·외삽 배수 31.25 행을 찾지 못했다');
  const c = row250.split('|').map((s) => s.trim()).filter(Boolean);
  const e8 = text.split(/\r?\n/).find((line) => /^\|\s*8\s*\|/.test(line) && line.includes('0.250'));
  assert.ok(e8, 'F-08-2 보고서에서 N=8 E(8) 행을 찾지 못했다');
  const e = e8.split('|').map((s) => s.trim()).filter(Boolean);
  const r = text.match(/R\s*=\s*([\d,]+)/);
  assert.ok(r, 'F-08-2 보고서에서 R 값을 찾지 못했다');
  return {
    x1: Number(x1[1].replace(/,/g, '')),
    needed: Number(c[3].replace(/,/g, '')),
    measuredMax: Number(c[4].replace(/,/g, '')),
    factor: Number(c[5]),
    target: Number(c[2].replace(/,/g, '')),
    e8: Number(e[2]),
    r: Number(r[1].replace(/,/g, '')),
  };
}

function cellsOf(line) {
  return line.split('|').map((s) => s.trim()).filter(Boolean);
}

function pctOf(cell) {
  const pct = cell.match(/\(([\d.]+)%\)/);
  if (pct) return Number(pct[1]);
  const n = Number(cell.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseF088() {
  const text = read(F088, 'F-08-8 측정 보고서');
  const lines = text.split(/\r?\n/);
  const k1_1k = lines.filter((line) => /^\|\s*1,000\s*\|/.test(line));
  const k1_10k = lines.filter((line) => /^\|\s*10,000\s*\|/.test(line));
  const k1_100k = lines.filter((line) => /^\|\s*100,000\s*\|/.test(line));
  const k2r2 = lines.find((line) => line.includes('k2-hot-tls-r2'));
  const k2r3 = lines.find((line) => line.includes('k2-hot-tls-r3'));
  const k7b = lines.filter((line) => line.includes('k7b-r'));
  const pass = text.match(/PASS (\d+)/);
  const k1_1k_pass = k1_1k.find((line) => /pass/i.test(line));
  const k1_10k_row = k1_10k[0];
  assert.ok(k1_1k_pass, 'F-08-8 K1 1,000 pass 행을 찾지 못했다');
  assert.ok(k1_10k_row, 'F-08-8 K1 10,000 행을 찾지 못했다');
  assert.ok(k2r2 && k2r3, 'F-08-8 K2 r2·r3 행을 찾지 못했다');
  assert.ok(pass, 'F-08-8 K7 ② PASS 수를 찾지 못했다');
  const c1 = cellsOf(k1_1k_pass);
  const c10 = cellsOf(k1_10k_row);
  const c2 = cellsOf(k2r2);
  const c3 = cellsOf(k2r3);
  return {
    text,
    k1_1k,
    k1_1k_p99: Number(String(c1[5]).replace(/[^\d.]/g, '')),
    k1_1k_err: pctOf(c1[4]),
    k1_10k,
    k1_10k_p99: Number(String(c10[5]).replace(/[^\d.]/g, '')),
    k1_10k_err: pctOf(c10[4]),
    k1_100k,
    k2r2,
    k2r2_p99: Number(String(c2[3]).replace(/[^\d.]/g, '')),
    k2r2_err: pctOf(c2[5]),
    k2r3,
    k2r3_p99: Number(String(c3[3]).replace(/[^\d.]/g, '')),
    k2r3_err: pctOf(c3[5]),
    k7b,
    pass: Number(pass[1]),
  };
}

test('MSR-030 ① M6 초안이 F-08-7 목차의 M6 자리를 채우고 상태가 게시 전이다', () => {
  const m6 = readM6();
  assert.match(m6, /^# M6[:：]/m, 'M6 제목이 없다');
  assert.match(m6, /100만/, 'M6 제목에 100만이 없다');
  assert.match(m6, /- \*\*상태\*\*: 초안\(2026-11-26\), 게시 전/, 'M6 상태 줄이 초안·게시 전이 아니다');
  for (const [n, kw] of [
    [1, '왜'],
    [2, '나눠'],
    [3, '잰'],
    [4, '외삽'],
    [5, '주장하지'],
    [6, '읽는'],
    [7, '근거'],
  ]) {
    const heading = m6.split(/\r?\n/).find((line) => new RegExp(`^## ${n}\\.`).test(line));
    assert.ok(heading && heading.includes(kw), `M6 ${n}절 제목에 '${kw}'가 없다: ${heading ?? '없음'}`);
  }
  const cardRows = m6
    .split(/\r?\n/)
    .filter((line) => /^\|\s*[1-5]\s*\|/.test(line) && ID_PATTERN.test(line));
  const cardIds = {
    1: ['F082-VT4'],
    2: ['F082-X1', 'F082-N250'],
    3: ['F088-K1-1K-P99', 'F088-K1-1K-ERR', 'F088-K1-10K-P99', 'F088-K1-10K-ERR', 'F088-K1-100K'],
    4: ['F088-K2-R2-P99', 'F088-K2-R2-ERR', 'F088-K2-R3-P99', 'F088-K2-R3-ERR'],
    5: ['F088-K7B', 'F088-K7B-ZERO'],
  };
  for (const n of [1, 2, 3, 4, 5]) {
    const row = cardRows.find((line) => new RegExp(`^\\|\\s*${n}\\s*\\|`).test(line));
    assert.ok(row, `M6 숫자 카드 ${n} 행이 없다`);
    for (const id of cardIds[n]) assert.ok(row.includes(id), `M6 숫자 카드 ${n}에 ${id}가 없다`);
  }
  assert.match(cardRows.find((line) => /^\|\s*1\s*\|/.test(line)), /판정 못 함/, 'M6 카드 1이 100만 외삽 판정 못 함이 아니다');
  const readme = read(BLOG_README, '블로그 README');
  const m6row = readme.split(/\r?\n/).find((line) => line.startsWith('| M6 |'));
  assert.ok(m6row, '블로그 README에 M6 행이 없다');
  assert.match(m6row, /초안\(2026-11-26\)/, '블로그 README M6 행이 초안 상태가 아니다');
  assert.match(m6row, /게시 전/, '블로그 README M6 행이 게시 전이 아니다');
  assert.doesNotMatch(m6row, /아직 쓰지 않음/, '블로그 README M6 행이 아직 쓰지 않음으로 남았다');
});

test('MSR-030 ② M6가 30,000건/초·100만·K1/K2/K7을 새로 주장하지 않고 카드 밖 숫자를 쓰지 않는다', () => {
  const m6 = readM6();
  const nonClaim = section(m6, '주장하지');
  for (const word of ['30,000', '100만', 'K1', 'K2', 'K7']) {
    assert.ok(nonClaim.includes(word), `M6 '주장하지 않는 것'에 ${word}가 없다`);
  }
  assert.equal(hasForbiddenClaim('100만을 확인하지 않았다'), false, '부정 문장을 오탐했다');
  assert.equal(hasForbiddenClaim('K1 1천은 3회 중 1회 통과했다'), false, '부분 통과 문장을 오탐했다');
  assert.equal(hasForbiddenClaim('초당 30,000건을 처리했다'), true, '초당 30,000건을 놓쳤다');
  assert.equal(hasForbiddenClaim('30,000 RPS를 달성했다'), true, '30,000 RPS를 놓쳤다');
  assertNoForbiddenClaims(m6, 'M6');
  assertNoCardOutsideNumbers(m6);
  assertTableNumbersHaveIds(m6, 'M6');
});

test('MSR-080 ① 사실 대장이 label·source·anchor·usedIn을 지킨다', () => {
  const facts = loadFacts();
  const sourceCache = new Map();
  for (const fact of facts.facts) {
    assert.match(fact.id ?? '', FACT_ID, `사실 ID 꼴이 틀렸다: ${fact.id}`);
    assert.ok(LABELS.has(fact.label), `${fact.id}: label이 허용 목록 밖이다: ${fact.label}`);
    assert.ok(Array.isArray(fact.usedIn) && fact.usedIn.length > 0, `${fact.id}: usedIn이 비었다`);
    for (const use of fact.usedIn) assert.ok(USED_IN.has(use), `${fact.id}: usedIn 값이 틀렸다: ${use}`);
    if (fact.value === null) {
      assert.ok(STATUSES.has(fact.status), `${fact.id}: 값이 없으면 status가 필요하다`);
    } else {
      assert.equal(typeof fact.value, 'number', `${fact.id}: value는 수여야 한다`);
      assert.ok(fact.unit, `${fact.id}: unit이 없다`);
    }
    if (fact.label === '외삽') {
      const e = fact.extrapolation;
      assert.ok(e && Number.isFinite(e.target) && Number.isFinite(e.x1) && Number.isFinite(e.measuredMax) && Number.isFinite(e.factor), `${fact.id}: 외삽에는 target·x1·measuredMax·factor가 필요하다`);
    }
    if (fact.label === '실측(PC)') assert.ok(fact.detail, `${fact.id}: 실측에는 반복·편차 detail이 필요하다`);
    if (fact.label === '[추정]') assert.ok(fact.asOf || fact.priceAsOf, `${fact.id}: [추정]에는 기준일이 필요하다`);
    const key = fact.source;
    assert.ok(facts.sources?.[key], `${fact.id}: source 키가 sources에 없다: ${key}`);
    if (!sourceCache.has(key)) sourceCache.set(key, read(facts.sources[key], `${fact.id}의 원천`));
    assert.ok(sourceCache.get(key).includes(fact.anchor), `${fact.id}: anchor가 원천 파일에 없다: ${fact.anchor}`);
  }
});

test('MSR-080 ② 사실 대장의 값이 F-08-2·F-08-8 보고서와 같다', () => {
  const facts = loadFacts();
  const f82 = parseF082();
  assert.equal(factById(facts, 'F082-X1').value, f82.x1, 'F082-X1이 F-08-2의 X₁과 다르다');
  const n250 = factById(facts, 'F082-N250');
  assert.equal(n250.value, f82.needed, 'F082-N250이 F-08-2의 필요한 대수와 다르다');
  assert.equal(n250.extrapolation.target, f82.target, 'F082-N250의 목표가 다르다');
  assert.equal(n250.extrapolation.x1, f82.x1, 'F082-N250의 X₁이 다르다');
  assert.equal(n250.extrapolation.measuredMax, f82.measuredMax, 'F082-N250의 측정 최대가 다르다');
  assert.equal(n250.extrapolation.factor, f82.factor, 'F082-N250의 외삽 배수가 다르다');
  assert.equal(factById(facts, 'F082-E8').value, f82.e8, 'F082-E8이 F-08-2의 E(8)과 다르다');
  assert.equal(factById(facts, 'F082-R').value, f82.r, 'F082-R이 F-08-2의 R과 다르다');
  const vt4 = factById(facts, 'F082-VT4');
  assert.equal(vt4.value, null, 'F082-VT4는 값이 없어야 한다');
  assert.equal(vt4.status, '판정 못 함', 'F082-VT4 상태는 판정 못 함이다');

  const f88 = parseF088();
  assert.equal(f88.k1_10k.length, 3, 'F-08-8 K1 10,000행이 셋이 아니다');
  for (const line of f88.k1_10k) assert.match(line, /fail|미달/, `K1 10,000행이 미달이 아니다: ${line}`);
  assert.ok(f88.k1_100k.length >= 2, 'F-08-8 K1 100,000행이 둘 미만이다');
  assert.ok(f88.k1_100k.every((line) => line.includes('무효')), 'K1 100,000행에 무효가 아닌 행이 있다');
  assert.ok(f88.k7b.length >= 2 && f88.k7b.every((line) => line.includes('무효')), 'K7 ② 행이 무효가 아니다');

  const k1_10k = factById(facts, 'F088-K1-10K');
  assert.ok(['미달', '무효', '부분'].includes(k1_10k.status), `F088-K1-10K 상태가 틀렸다: ${k1_10k.status}`);
  assert.equal(factById(facts, 'F088-K1-1K-P99').value, f88.k1_1k_p99, 'F088-K1-1K-P99 값이 다르다');
  assert.equal(factById(facts, 'F088-K1-1K-ERR').value, f88.k1_1k_err, 'F088-K1-1K-ERR 값이 다르다');
  assert.equal(factById(facts, 'F088-K1-10K-P99').value, f88.k1_10k_p99, 'F088-K1-10K-P99 값이 다르다');
  assert.equal(factById(facts, 'F088-K1-10K-ERR').value, f88.k1_10k_err, 'F088-K1-10K-ERR 값이 다르다');
  assert.equal(factById(facts, 'F088-K1-100K').status, '무효', 'F088-K1-100K 상태는 무효다');
  assert.equal(factById(facts, 'F088-K2-R2-P99').value, f88.k2r2_p99, 'F088-K2-R2-P99 값이 다르다');
  assert.equal(factById(facts, 'F088-K2-R2-ERR').value, f88.k2r2_err, 'F088-K2-R2-ERR 값이 다르다');
  assert.equal(factById(facts, 'F088-K2-R3-P99').value, f88.k2r3_p99, 'F088-K2-R3-P99 값이 다르다');
  assert.equal(factById(facts, 'F088-K2-R3-ERR').value, f88.k2r3_err, 'F088-K2-R3-ERR 값이 다르다');
  assert.equal(factById(facts, 'F088-K7B-ZERO').value, 0, 'F088-K7B-ZERO 값은 0이다');
  const k7b = factById(facts, 'F088-K7B');
  assert.equal(k7b.status, '부분', 'F088-K7B 상태는 부분이다');
  assert.match(String(k7b.detail ?? ''), new RegExp(`PASS ${f88.pass}`), `F088-K7B detail에 PASS ${f88.pass}가 없다`);
});

test('MSR-080 ③ 용량 산정서가 100만 판정 못 함과 200,000 RPS 외삽을 구분하고 200만·1~3년을 설계 목표로 둔다', () => {
  const cap = read(CAPACITY, '용량 산정서');
  assert.match(cap, /^# .*용량 산정서/m, '용량 산정서 제목이 없다');
  for (const kw of ['입력', '100만', '200만', '1~3년', '병목', '한계', '사실 대장']) {
    section(cap, kw);
  }
  assert.match(cap, /F-08-2-msr020\.md/, '용량 산정서가 F-08-2 보고서를 가리키지 않는다');
  assert.match(cap, /NFR-021/, '용량 산정서가 NFR-021을 가리키지 않는다');
  assert.match(cap, /9\.5|§9\.5/, '용량 산정서가 architecture §9.5를 가리키지 않는다');
  assert.match(cap, /외삽\(측정 범위의 4배 초과\)/, '용량 산정서에 외삽 표시가 없다');
  assert.match(cap, /비례 전제 확인 못 함/, '용량 산정서에 비례 미확인 표시가 없다');
  const s1 = section(cap, '100만');
  assert.match(s1, /F082-VT4/, '용량 산정서 100만 절에 F082-VT4가 없다');
  assert.match(s1, /판정 못 함/, '용량 산정서 100만 절이 판정 못 함을 적지 않는다');
  assert.match(s1, /F082-N250/, '용량 산정서 100만 절에 F082-N250이 없다');
  assert.doesNotMatch(s1, /250대[^\n]{0,30}100만|100만[^\n]{0,30}250대/, '250대를 100만 값으로 섞었다');
  const s2 = section(cap, '200만');
  assert.match(s2, /NFR-021/, '200만 절이 NFR-021을 인용하지 않는다');
  assert.match(s2, /9\.5|§9\.5/, '200만 절이 architecture §9.5를 인용하지 않는다');
  assert.match(s2, /설계 목표/, '200만 절이 설계 목표가 아니다');
  for (const line of s2.split(/\r?\n/)) {
    if (/(2배|×2|500대)/.test(line) && !/아니|않|금지|만들지/.test(line)) {
      assert.fail(`200만 절이 2배 외삽을 주장한다: ${line.trim()}`);
    }
  }
  assert.match(section(cap, '1~3년'), /설계 목표/, '1~3년 절이 설계 목표가 아니다');
  assert.match(section(cap, '사실 대장'), /F082-VT4/, '용량 산정서 사실 대장에 F082-VT4가 없다');
  assert.match(section(cap, '사실 대장'), /F082-X1/, '용량 산정서 사실 대장에 F082-X1이 없다');
  assert.match(section(cap, '사실 대장'), /F082-N250/, '용량 산정서 사실 대장에 F082-N250이 없다');
  assertNoForbiddenClaims(cap, '용량 산정서');
  assertTableNumbersHaveIds(cap, '용량 산정서');
});

test('MSR-080 ④ 비용 리포트가 모든 금액을 [추정]으로 두고 단가 기준일을 적는다', () => {
  const cost = read(COST, '비용 리포트');
  assert.match(cost, /^# .*비용/m, '비용 리포트 제목이 없다');
  for (const kw of ['입력', '상시', '온세일', '1~3년', '줄일', '한계', '사실 대장']) {
    section(cost, kw);
  }
  assert.match(cost, /2026-10-28/, '비용 리포트에 단가 기준일 2026-10-28이 없다');
  assert.match(cost, /docs\/infra\.md/, '비용 리포트가 docs/infra.md를 가리키지 않는다');
  assert.match(cost, /§11/, '비용 리포트가 infra §11을 가리키지 않는다');
  for (const line of cost.split(/\r?\n/)) {
    if (!line.includes('|') || /^\|\s*-/.test(line) || line.includes('금액')) continue;
    if (!line.includes('달러') && !line.includes('$')) continue;
    assert.match(line, /\[추정\]|문서 인용|단가 없음|미계산/, `비용 줄에 표시가 없다: ${line.trim()}`);
  }
  assert.match(cost, /실측이 아니다|실측 아님/, '비용 리포트가 실측이 아님을 밝히지 않는다');
  assert.match(cost, /CloudFront/, '비용 리포트에 CloudFront가 없다');
  assert.match(cost, /단가 없음|미계산/, '비용 리포트가 없는 단가를 밝히지 않는다');
  const waf = section(cost, '온세일');
  assert.match(waf, /WAF/, '비용 리포트 온세일 절에 WAF가 없다');
  assert.match(waf, /문서 인용|§11/, 'WAF 1회 비용이 §11 문서 인용이 아니다');
  assert.match(section(cost, '1~3년'), /미계산/, '1~3년 비용이 미계산 기본이 아니다');
  assert.doesNotMatch(cost, /비용[^\n]{0,40}실측\(PC\)/, '비용을 실측(PC)으로 주장한다');
  assert.match(section(cost, '사실 대장'), /INFRA11-/, '비용 리포트 사실 대장에 INFRA11- ID가 없다');
  assertNoForbiddenClaims(cost, '비용 리포트');
});

test('MSR-080 ⑤ DORA는 배포 기록이 없어 자료 없음·추세 판단 불가다', () => {
  const dora = read(DORA, 'DORA 보고서');
  assert.match(dora, /^# .*DORA/m, 'DORA 보고서 제목이 없다');
  for (const kw of ['데이터 원천', '주별', '추세', '한계']) section(dora, kw);
  assert.match(dora, /데모 환경 기준/, 'DORA 기준이 데모 환경 기준이 아니다');
  assert.match(dora, /자료 없음/, 'DORA 보고서에 자료 없음이 없다');
  assert.match(dora, /추세 판단 불가/, 'DORA 보고서에 추세 판단 불가가 없다');
  assert.match(dora, /0으로|0이 아니라|0을 쓰지/, 'DORA 보고서가 0을 쓰지 않는다고 밝히지 않는다');
  for (const week of ['2026-11-16', '2026-11-23']) {
    const row = dora.split(/\r?\n/).find((line) => line.includes(week) && line.includes('|'));
    assert.ok(row, `DORA 주별 표에 ${week} 행이 없다`);
    const noData = (row.match(/자료 없음/g) ?? []).length;
    assert.ok(noData >= 4, `DORA ${week} 행의 네 지표가 모두 자료 없음이 아니다: ${row.trim()}`);
    assert.doesNotMatch(row, /0\s*%|0\s*시간|0\.00/, `DORA ${week} 행에 0 비율·기간이 있다: ${row.trim()}`);
    if (week === '2026-11-23') assert.match(row, /진행 중/, 'DORA 2026-11-23 행이 진행 중이 아니다');
    const md = read(`docs/review/measurements/F-08-3-dora-${week}.md`, `DORA ${week} 산출물`);
    assert.match(md, /자료 없음/, `DORA ${week} 산출물에 자료 없음이 없다`);
    const json = readJson(`docs/review/measurements/F-08-3-dora-${week}.json`, `DORA ${week} JSON`);
    assert.equal(json.basis, '데모 환경 기준', `DORA ${week} JSON 기준이 다르다`);
    assert.equal(json.all.deploymentCount, 0, `DORA ${week} 배포 수가 0이 아니다`);
    assert.equal(json.all.leadTimeHours, null, `DORA ${week} 리드타임이 null이 아니다`);
    assert.equal(json.all.changeFailureRate, null, `DORA ${week} 변경 실패율이 null이 아니다`);
    assert.equal(json.all.restoreHours, null, `DORA ${week} 복구 시간이 null이 아니다`);
    assert.equal(json.all.reworkRate, null, `DORA ${week} 재작업률이 null이 아니다`);
  }
  const tmp = mkdtempSync(join(tmpdir(), 'f083-dora-'));
  try {
    const input = join(tmp, 'records.json');
    writeFileSync(input, '{"deployments":[]}\n');
    for (const week of ['2026-11-16', '2026-11-23']) {
      execFileSync(process.execPath, [join(HERE, 'dora.mjs'), '--input', input, '--week', week, '--out', tmp], {
        cwd: REPO,
        stdio: 'pipe',
      });
      const fresh = JSON.parse(readFileSync(join(tmp, `dora-${week}.json`), 'utf8'));
      const committed = readJson(`docs/review/measurements/F-08-3-dora-${week}.json`, `DORA ${week} JSON`);
      assert.deepEqual(fresh.basis, committed.basis, `DORA ${week} basis가 dora.mjs 출력과 다르다`);
      assert.deepEqual(fresh.services, committed.services, `DORA ${week} services가 dora.mjs 출력과 다르다`);
      assert.deepEqual(fresh.all, committed.all, `DORA ${week} all이 dora.mjs 출력과 다르다`);
      assert.deepEqual(fresh.week, committed.week, `DORA ${week} week가 dora.mjs 출력과 다르다`);
    }
    const out = readFileSync(join(tmp, 'dora-2026-11-16.md'), 'utf8');
    assert.match(out, /자료 없음/, 'dora.mjs 빈 기록 산출물에 자료 없음이 없다');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  assertNoForbiddenClaims(dora, 'DORA 보고서');
});

test('MSR-080 ⑥ 보고서의 사실 ID가 대장에 있고 릴리스 범위·동결 상태가 그대로다', () => {
  const facts = loadFacts();
  const reports = {
    m6: readM6(),
    capacity: read(CAPACITY, '용량 산정서'),
    cost: read(COST, '비용 리포트'),
    dora: read(DORA, 'DORA 보고서'),
  };
  const known = new Set(facts.facts.map((f) => f.id));
  const used = new Set();
  for (const [name, text] of Object.entries(reports)) {
    for (const m of text.matchAll(/\b(F082|F088|NFR021|ARCH95|INFRA11|DORA)-[A-Z0-9-]+\b/g)) used.add(m[0]);
    assert.ok(text.length > 0, `${name} 보고서가 비었다`);
  }
  for (const id of used) assert.ok(known.has(id), `보고서에 사실 대장에 없는 ID가 있다: ${id}`);
  for (const fact of facts.facts) {
    for (const use of fact.usedIn) {
      assert.ok(reports[use].includes(fact.id), `${fact.id}: usedIn=${use} 보고서에 ID가 없다`);
    }
  }

  const scope = readJson('docs/release/v1-scope.json', 'v1 릴리스 범위');
  assert.equal(scope.features?.['F-08-3']?.class, 'frozen-local', 'v1-scope.json의 F-08-3이 frozen-local이 아니다');
  const buildOrder = read('docs/BUILD_ORDER.md', 'BUILD_ORDER');
  const row = buildOrder.split(/\r?\n/).find((line) => line.startsWith('| F-08-3 |'));
  assert.ok(row, 'BUILD_ORDER에 F-08-3 행이 없다');
  assert.match(row, /동결/, 'BUILD_ORDER F-08-3 상태가 동결이 아니다');
  const check = spawnSync(process.execPath, [join(HERE, 'release-scope.mjs'), '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(check.status, 0, `release-scope --check가 실패했다: ${check.stderr || check.stdout}`);

  const all = Object.values(reports).join('\n');
  const runRoot = P('docs/perf-ledger/runs');
  const runIds = new Set(readdirSync(runRoot));
  for (const m of all.matchAll(/docs\/perf-ledger\/runs\/([0-9A-Za-z._-]+)/g)) {
    const token = m[1].replace(/\/$/, '');
    assert.ok(
      runIds.has(token) || [...runIds].some((id) => id.startsWith(token)),
      `보고서가 없는 장부 실행을 가리킨다: ${token}`,
    );
  }

  const canon = [
    'docs/infra.md',
    'docs/verification.md',
    'docs/planning/02-requirements.md',
    'docs/architecture.md',
    'docs/release/v1-scope.json',
    'docs/release/v1-scope.md',
    'docs/BUILD_ORDER.md',
  ];
  const diff = spawnSync('git', ['diff', '--name-only', '19b33ba85..HEAD', '--', ...canon], { cwd: REPO, encoding: 'utf8' });
  assert.equal(diff.status, 0, `정본 diff를 읽지 못했다: ${diff.stderr}`);
  assert.equal(diff.stdout.trim(), '', `정본·릴리스 노트·manifest가 바뀌었다: ${diff.stdout.trim()}`);
});
