// 직접 운영 시간 기록 도구(tools/perf-ledger/ops_hours.py)의 바깥 경계(명령줄) 시험(기능 F-01-1, OPS-030, 시험 V-T48 ①②).
// 정본: docs/perf-ledger.md §11.5(시간 단가, 운영 시간 기록의 열·값 범위·검사 명령), docs/verification.md V-T48, ADR-0067 결정 5 ③·R2.
// 시험 자료는 합성 기록이다(실제 운영 기록이 아니다). 열 이름·시간 단가는 시험도 §11.5 글귀에서 읽는다(도구의 상수를 가져오지 않는다).
// 실행: node --test "tools/perf-ledger/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const TOOL = join(here, 'ops_hours.py');
const DOC = join(REPO, 'docs', 'perf-ledger.md');
const REAL = join(REPO, 'docs', 'perf-ledger', 'ops-hours.csv');

function py(args) {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', TOOL, ...args], { encoding: 'utf8', cwd: REPO });
  return { code: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** §11.5에서 시간 단가(원)와 열 머리를 읽는다(시험 쪽 독립 읽기) */
function canon(docText = readFileSync(DOC, 'utf8')) {
  const rate = /시간 단가 ([\d,]+)원/.exec(docText);
  assert.ok(rate, '§11.5에 시간 단가 글귀가 있다');
  const cols = /열은 `(date,[a-z_,]+)`/.exec(docText);
  assert.ok(cols, '§11.5에 운영 시간 기록의 열 글귀가 있다');
  return { rate: Number(rate[1].replaceAll(',', '')), header: cols[1] };
}

const dirs = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'ops-hours-'));
  dirs.push(d);
  return d;
}
test.after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const writeIn = (dir, name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const csv = (header, rows) => `${[header, ...rows].join('\n')}\n`;

test('V-T48 ① 운영 시간 기록 검사는 틀린 줄을 모두 찾고 읽지 못하면 2다', async (t) => {
  const { rate, header } = canon();
  // 정본 값 자체(시험이 글귀를 잘못 읽지 않았는지)
  assert.equal(rate, 49538);
  assert.equal(header, 'date,component,activity,minutes,version_from,version_to,environment,ref,note');

  await t.test('실제 기록 파일은 0', () => {
    const r = py(['check']);
    assert.equal(r.code, 0, r.out);
    const r2 = py(['check', '--file', REAL, '--doc', DOC]);
    assert.equal(r2.code, 0, r2.out);
  });

  await t.test('머리 줄만 있는 파일은 0, 바른 줄만 있는 파일도 0', () => {
    const d = tmp();
    assert.equal(py(['check', '--file', writeIn(d, 'empty.csv', csv(header, [])), '--doc', DOC]).code, 0);
    const good = csv(header, [
      '2026-11-23,grafana,upgrade,30,12.3.0,12.4.0,local,abc1234,판 올림 합성 기록',
      '2026-11-24,loki,install,1440,,,ci,,설치 합성 기록',
      '2026-11-25,otel-collector,check,1,,,staging,R-786,점검',
    ]);
    const r = py(['check', '--file', writeIn(d, 'good.csv', good), '--doc', DOC]);
    assert.equal(r.code, 0, r.out);
  });

  await t.test('틀린 줄 일곱 가지를 한 파일에 넣으면 1이고 일곱 줄 번호를 모두 찍는다', () => {
    const d = tmp();
    // 1줄은 머리 줄, 2줄은 바른 줄. 3~9줄이 틀린 줄이다
    const rows = [
      '2026-11-23,grafana,install,45,,,local,,바른 줄',
      '2026-11-23,kibana,install,30,,,local,,모르는 부품',
      '2026-11-23,grafana,reboot,30,,,local,,모르는 활동',
      '2026-11-23,grafana,check,0,,,local,,0분',
      '2026-11-23,grafana,check,1441,,,local,,1440분 넘음',
      '2026-11-23,grafana,check,30.5,,,local,,소수 분',
      '2026-11-23,grafana,upgrade,30,12.3.0,,local,,판 올림인데 올린 판이 빔',
      '2026-13-01,grafana,check,30,,,local,,날짜 꼴이 틀림',
    ];
    const r = py(['check', '--file', writeIn(d, 'bad.csv', csv(header, rows)), '--doc', DOC]);
    assert.equal(r.code, 1, r.out);
    // 줄 번호는 `<파일>:<n>`·`<n>줄`·`줄 <n>`·`line <n>` 꼴 가운데 하나로 찍힌다고 본다(값 30.5·12.3.0 같은 숫자와 헷갈리지 않게)
    const mentions = (n) => new RegExp(`(:${n}(?![\\d.])|(?<![\\d.])${n}\\s*줄|줄\\s*${n}(?![\\d.])|line\\s*${n}(?![\\d.]))`);
    for (const n of [3, 4, 5, 6, 7, 8, 9]) assert.match(r.out, mentions(n), `${n}줄이 찍힌다: ${r.out}`);
    // 바른 2줄은 틀렸다고 찍지 않는다
    assert.doesNotMatch(r.out, mentions(2), `바른 2줄은 찍히지 않는다: ${r.out}`);
  });

  await t.test('머리 줄이 다르면 1', () => {
    const d = tmp();
    const wrong = header.replace('minutes', 'mins');
    const r = py(['check', '--file', writeIn(d, 'head.csv', csv(wrong, ['2026-11-23,grafana,install,45,,,local,,바른 줄'])), '--doc', DOC]);
    assert.equal(r.code, 1, r.out);
  });

  await t.test('부품 목록은 §11.5에서 읽는다(문서에서 loki를 빼면 loki 줄이 틀린다)', () => {
    const d = tmp();
    const docNoLoki = readFileSync(DOC, 'utf8').replace('`loki`·', '');
    assert.notEqual(docNoLoki, readFileSync(DOC, 'utf8'), '문서에서 loki를 뺐다');
    const file = writeIn(d, 'loki.csv', csv(header, ['2026-11-23,loki,install,45,,,local,,바른 줄']));
    assert.equal(py(['check', '--file', file, '--doc', DOC]).code, 0);
    const r = py(['check', '--file', file, '--doc', writeIn(d, 'perf-ledger.md', docNoLoki)]);
    assert.equal(r.code, 1, r.out);
  });

  await t.test('없는 파일은 2', () => {
    const d = tmp();
    const r = py(['check', '--file', join(d, 'none.csv'), '--doc', DOC]);
    assert.equal(r.code, 2, r.out);
  });

  await t.test('시간 단가를 읽지 못한 문서는 2', () => {
    const d = tmp();
    const docText = readFileSync(DOC, 'utf8');
    const noRate = docText.replace(/시간 단가 [\d,]+원/, '시간 단가는 정하지 않았다');
    assert.notEqual(noRate, docText);
    const file = writeIn(d, 'ok.csv', csv(header, ['2026-11-23,grafana,install,45,,,local,,바른 줄']));
    const r = py(['check', '--file', file, '--doc', writeIn(d, 'perf-ledger.md', noRate)]);
    assert.equal(r.code, 2, r.out);
    const s = py(['summary', '--file', file, '--doc', writeIn(d, 'perf-ledger2.md', noRate)]);
    assert.equal(s.code, 2, s.out);
  });
});

test('V-T48 ② 요약은 부품·활동별 1회 평균과 단가 곱을 0.5·1·1.5배로 내고 기록이 없으면 0원을 내지 않는다', async (t) => {
  const { rate, header } = canon();
  const rows = [
    '2026-11-20,grafana,upgrade,30,12.2.0,12.3.0,local,,합성',
    '2026-11-21,loki,install,90,,,local,,합성',
    '2026-11-22,grafana,upgrade,50,12.3.0,12.4.0,local,,합성',
  ];
  const totalMinutes = 30 + 90 + 50;
  const cost = (r, mult) => Math.floor((totalMinutes * r * mult) / 60);

  await t.test('섞인 기록의 요약', () => {
    const d = tmp();
    const r = py(['summary', '--file', writeIn(d, 'mixed.csv', csv(header, rows)), '--doc', DOC]);
    assert.equal(r.code, 0, r.out);
    const s = JSON.parse(r.stdout);
    assert.equal(s.rate_krw_per_hour, rate);
    assert.equal(s.samples.length, 2);
    const g = s.samples.find((x) => x.component === 'grafana' && x.activity === 'upgrade');
    const l = s.samples.find((x) => x.component === 'loki' && x.activity === 'install');
    assert.deepEqual({ count: g.count, total_minutes: g.total_minutes, mean_minutes: g.mean_minutes }, { count: 2, total_minutes: 80, mean_minutes: 40 });
    assert.deepEqual({ count: l.count, total_minutes: l.total_minutes, mean_minutes: l.mean_minutes }, { count: 1, total_minutes: 90, mean_minutes: 90 });
    assert.ok(Math.abs(s.total_hours - totalMinutes / 60) < 0.01, `total_hours ${s.total_hours}`);
    assert.deepEqual(s.cost_krw, { '0.5': cost(rate, 0.5), 1: cost(rate, 1), '1.5': cost(rate, 1.5) });
    // 정본 단가 49,538원에서 손으로 셈: 170분 = 2.8333…시간
    assert.deepEqual(s.cost_krw, { '0.5': 70178, 1: 140357, '1.5': 210536 });
  });

  await t.test('시간 단가는 문서에서 읽는다(문서 값을 바꾸면 요약이 따른다)', () => {
    const d = tmp();
    const docText = readFileSync(DOC, 'utf8');
    const other = docText.replace(/시간 단가 [\d,]+원/, '시간 단가 12,345원');
    assert.notEqual(other, docText);
    const r = py(['summary', '--file', writeIn(d, 'mixed.csv', csv(header, rows)), '--doc', writeIn(d, 'perf-ledger.md', other)]);
    assert.equal(r.code, 0, r.out);
    const s = JSON.parse(r.stdout);
    assert.equal(s.rate_krw_per_hour, 12345);
    assert.deepEqual(s.cost_krw, { '0.5': cost(12345, 0.5), 1: cost(12345, 1), '1.5': cost(12345, 1.5) });
  });

  await t.test('머리 줄만 있으면 기록 없음이고 비용을 내지 않는다', () => {
    const d = tmp();
    const r = py(['summary', '--file', writeIn(d, 'empty.csv', csv(header, [])), '--doc', DOC]);
    assert.equal(r.code, 0, r.out);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(s, { status: '기록 없음', rate_krw_per_hour: rate, samples: [] });
    assert.equal('cost_krw' in s, false);
  });
});
