// 사람 쪽 측정 자료 도구의 바깥 경계(명령줄) 시험(BUILD_ORDER BAS-260, wbs 1.2.2 ②, ADR-0174·0245, docs/perf-ledger.md §10, docs/verification.md V-T25·V-T45).
// 공개 자료는 내려받지 않는다. 시험 자료는 그 꼴을 흉내 낸 합성 표본이고, 실제 사람의 기록이 아니다.
// 실행: node --test "tools/perf-ledger/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const COLLECT = join(here, 'collect.py');
const INDEX = join(here, 'index.py');
const HUMAN = join(here, 'human_data.py');
const LIB = join(here, 'ledgerlib.py');

function py(script, args, env) {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const tmp = (prefix = 'human-data-') => mkdtempSync(join(tmpdir(), prefix));

function newRoot() {
  const root = tmp();
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'perf-ledger.md'), '# 성능 장부\n\n<!-- ledger:begin -->\n<!-- ledger:end -->\n');
  return root;
}

const write = (dir, name, text) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};
const runDir = (root, id) => join(root, 'docs', 'perf-ledger', 'runs', id);
const manifestOf = (root, id) => JSON.parse(readFileSync(join(runDir(root, id), 'manifest.json'), 'utf8'));
const collect = (root, id, extra, env) =>
  py(COLLECT, ['--root', root, '--run-id', id, '--kpi', 'K6', '--version', 'v1', '--profile', 'local-bot', '--commit', 'abc123', ...extra], env);

function git(root, args, date = '2026-09-20T00:00:00Z') {
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

const toolHash = () => {
  const h = createHash('sha256');
  for (const f of [HUMAN, LIB]) h.update(readFileSync(f)).update(Buffer.from([0]));
  return h.digest('hex');
};
const peopleHash = (salt, people) => createHash('sha256').update([salt, ...[...people].sort()].join('\n')).digest('hex');
const codes = (n) => Array.from({ length: n }, (_, i) => `P${String(i + 1).padStart(4, '0')}`);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// 이 시험의 가짜 규칙 값. 다른 숫자와 겹치지 않게 고른다(manifest 전체에서 찾기 위해)
const RULE = { strength: '기본', sort_mode: 'shuffle', decision_threshold: 0.6137, weight: 0.4271, max_risk: 0.9173, public_max_risk: 0.9173 };
const CRITERION = '0.30685';
const MAX_CONTRIBUTION = String(round6(RULE.weight * RULE.max_risk));

/** 사전 등록 파일(비공개 쪽)의 예. 값은 시험용 가짜다 */
function registration(source, over = {}) {
  const salt = randomBytes(32).toString('hex');
  const judge = over.judgePeople ?? codes(947);
  const { judgePeople: _ignored, ...rest } = over;
  return {
    id: `reg-${source}-1`,
    source,
    registered_at: '2026-09-01T00:00:00Z',
    salt,
    plan: { n: 947, c: 1 },
    dataset: {
      name: source === 'public' ? 'Aalto 136M Keystrokes' : 'mock-human',
      version: 'fixture-1',
      sha256: 'a'.repeat(64),
      readme_sha256: source === 'public' ? 'b'.repeat(64) : null,
      attribution: source === 'public' ? 'Dhakal 외, CHI 2018' : '',
    },
    seeds: { split: 11, draw: 22 },
    conversion_rule: source === 'public' ? 'aalto-keystroke-v1' : 'mock-human-v1',
    tune_n: 2000,
    behavior_rule: RULE,
    max_missing_ratio: 0.01,
    judge_people_sha256: peopleHash(salt, judge),
    judge_records_sha256: 'd'.repeat(64),
    tune_people_sha256: peopleHash(salt, ['T1']),
    tool_commit: 'abc123',
    tool_sha256: toolHash(),
    ...rest,
  };
}
const inDir = () => tmp('human-data-input-');

/** 합성 human_sessions.csv: n명이 판정 기록 하나씩. fp명은 기준(0.30685)을 넘는다. opts로 한 칸씩 어긋나게 만든다 */
function humanCsv(source, n, { fp = 1, header, rowEdit, extraRows = [] } = {}) {
  const head = header ?? (source === 'mock' ? 'source,person,role,stratum,round,predicted,score,behavior_score' : 'source,person,role,stratum,round,predicted,score');
  const rows = [];
  for (let i = 1; i <= n; i++) {
    const bad = i <= fp;
    const score = bad ? 0.35 : (0.05 + (i % 20) / 100).toFixed(2);
    const base = [source, codes(i)[i - 1], 'judge', i % 10 === 0 ? 'age60' : '', 1, bad ? 'bot' : 'human', score];
    if (source === 'mock') base.push(score);
    rows.push(rowEdit ? rowEdit(base, i) : base);
  }
  return [head, ...rows.map((r) => r.join(',')), ...extraRows].join('\n') + '\n';
}
const confusionCsv = (n, fp = 1) => `tier,round,label,predicted,count,stratum\nvolume-L1,1,bot,bot,970,\nvolume-L1,1,bot,human,30,\n-,1,human,human,${n - fp},\n-,1,human,bot,${fp},\n`;

const START = ['--start', '2026-10-01T00:00:00Z', '--end', '2026-10-01T00:10:00Z'];

function k6Args(root, source, { n = 947, fp = 1, csv, confusion, reg, plan = '947:1', extra = [] } = {}) {
  const dir = inDir();
  return [
    '--k6-source', source, '--k6-plan', plan,
    '--confusion', write(dir, 'confusion.csv', confusion ?? confusionCsv(n, fp)),
    '--human-sessions', write(dir, 'human_sessions.csv', csv ?? humanCsv(source, n, { fp })),
    '--k6-registration', write(dir, 'registration.json', JSON.stringify(reg ?? registration(source))),
    ...START, ...extra,
  ];
}

const regPathOf = (args) => args[args.indexOf('--k6-registration') + 1];
const hsPathOf = (args) => args[args.indexOf('--human-sessions') + 1];

const publicRegPath = (root, id) => join(root, 'docs', 'perf-ledger', 'registrations', `${id}.json`);

/** verify를 돌린 결과 파일을 비공개 등록 파일 옆에 쓴다(합성 등록은 원본이 없어 내용만 맞춘다) */
function writeReceipt(root, regPath, over = {}) {
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  const hash = JSON.parse(readFileSync(publicRegPath(root, reg.id), 'utf8')).registration_hash;
  const receipt = { registration_hash: hash, result: 'ok', source_file_checked: true, verified_at: '2026-09-02T00:00:00Z', reason: null, ...over };
  writeFileSync(join(dirname(regPath), 'verify-result.json'), JSON.stringify(receipt));
}

/** 공개 등록 파일을 저장소에 쓰고 커밋한다(측정 시작보다 앞선 날짜로). verify 결과도 함께 둔다 */
function publishAndCommit(root, regPath, date = '2026-09-20T00:00:00Z') {
  const r = py(HUMAN, ['publish-registration', '--registration', regPath, '--root', root]);
  assert.equal(r.code, 0, r.out);
  if (!existsSync(join(root, '.git'))) git(root, ['init', '-q']);
  git(root, ['add', 'docs/perf-ledger/registrations']);
  git(root, ['commit', '-q', '-m', 'register'], date);
  writeReceipt(root, regPath);
}

const pinBody = (reg, over = {}) => JSON.stringify({ datasets: { [reg.dataset.name]: { sha256: reg.dataset.sha256, readme_sha256: reg.dataset.readme_sha256, ...over } } });

/** 기본 자료 고정 파일을 저장소에 커밋한다(HEAD에서 읽는 실제 경로) */
function commitPin(root, reg) {
  writeFileSync(join(root, 'docs', 'perf-ledger', 'datasets.json'), pinBody(reg));
  git(root, ['add', 'docs/perf-ledger/datasets.json']);
  if (git(root, ['status', '--porcelain', '--', 'docs/perf-ledger/datasets.json']).trim()) git(root, ['commit', '-q', '-m', 'pin']);
}

/** --dataset-pin으로 넘기는 임시 고정 파일(환경 변수 없이는 합격이 될 수 없다) */
const pinFile = (reg, over) => write(inDir(), 'datasets.json', pinBody(reg, over));
const TEST_PIN = { PEAKET_HUMAN_DATA_TEST_PIN: '1' };

/** public 합격 경로까지 준비한 인자 */
function passArgs(root, opts = {}) {
  const reg = opts.reg ?? registration('public');
  const args = k6Args(root, 'public', { ...opts, reg });
  publishAndCommit(root, regPathOf(args));
  commitPin(root, reg);
  return args;
}

function assertRefused(root, id, r, expect) {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, expect);
  assert.equal(existsSync(runDir(root, id)), false, '거부했는데 측정 폴더가 생겼다');
}

/** 측정 폴더의 모든 파일 내용 */
function runFiles(root, id) {
  const texts = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else texts.push([e, readFileSync(p, 'utf8')]);
    }
  };
  walk(runDir(root, id));
  return texts;
}

// --- V-T25: K6 사람 오탐의 사람 단위 확인과 원천 칸 ---

test('V-T25 ①: public 947명이 판정 기록 하나씩이면 판정하고 원천·자료·씨앗값·혼자 기준 비율·위험 값 분포를 남기며 사람 파일은 복사하지 않는다', () => {
  const root = newRoot();
  const r = collect(root, 'k1', passArgs(root));
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'k1');
  assert.equal(m.k6_plan.source, 'public');
  assert.deepEqual(m.k6_plan.dataset, m.k6_eval.dataset);
  assert.equal(m.k6_plan.dataset.name, 'Aalto 136M Keystrokes');
  assert.equal(m.k6_plan.dataset.version, 'fixture-1');
  assert.equal(m.k6_plan.dataset.sha256, 'a'.repeat(64));
  assert.equal(m.k6_plan.dataset.attribution, 'Dhakal 외, CHI 2018');
  assert.deepEqual(m.k6_plan.split_seed, { split: 11, draw: 22 });
  assert.deepEqual(m.k6_eval.split_seed, { split: 11, draw: 22 });
  assert.equal(m.k6_plan.conversion_rule, 'aalto-keystroke-v1');
  assert.deepEqual(m.k6_plan.behavior_only_rule, { strength: '기본', sort_mode: 'shuffle', criterion_ratio: 0.5, unmeasurable: false });
  assert.match(m.k6_plan.registration_hash, /^[0-9a-f]{64}$/);
  assert.equal(m.k6_plan.tool_commit, 'abc123');
  const e = m.k6_eval;
  assert.equal(e.human_source, 'public');
  assert.equal(e.plan_verdict, 'PASS');
  assert.equal(e.humans.at(-1).n, 947);
  assert.deepEqual([e.human_units.people, e.human_units.judge_records], [947, 947]);
  assert.equal(e.behavior_only.false_pos, 1);
  assert.equal(e.behavior_only.judged, 947);
  assert.equal(e.behavior_only.missing, 0);
  assert.deepEqual(e.behavior_only.unmeasurable_reasons, []);
  // 기여 ÷ 가중치. 가장 가까운 순위 방식: 474번째 0.14, 853번째 0.23, 938번째 0.24
  assert.deepEqual(e.behavior_only.risk_percentiles, { p50: round6(0.14 / RULE.weight), p90: round6(0.23 / RULE.weight), p99: round6(0.24 / RULE.weight) });
  assert.match(e.behavior_only.pointer, /측정 못 함/);
  assert.equal(m.k6_plan.dataset_pin.status, 'matched');
  assert.equal(existsSync(join(runDir(root, 'k1'), 'human_sessions.csv')), false);
  for (const [name, text] of runFiles(root, 'k1')) assert.equal(text.includes('P0005'), false, `${name}에 사람 코드가 남았다`);
});

test('V-T25 ②: public에서 한 사람이 판정 기록 둘이면 측정 폴더 없이 거부한다', () => {
  const root = newRoot();
  const csv = humanCsv('public', 946, { extraRows: ['public,P0001,judge,,1,human,0.1'] });
  assertRefused(root, 'k2', collect(root, 'k2', k6Args(root, 'public', { csv })), /판정 기록이 둘 이상/);
});

test('V-T25 ③: public 판정 기록이 946개면(등록한 N은 947) 거부한다', () => {
  const root = newRoot();
  assertRefused(root, 'k3', collect(root, 'k3', k6Args(root, 'public', { n: 946 })), /N=947/);
});

test('V-T25 ④: mock 947명은 같은 계산을 하되 plan_verdict가 REHEARSAL이고 커밋 확인이 없으며 합격을 내지 않는다', () => {
  const root = newRoot();
  const r = collect(root, 'k4', k6Args(root, 'mock'));
  assert.equal(r.code, 0, r.out);
  const e = manifestOf(root, 'k4').k6_eval;
  assert.equal(e.human_source, 'mock');
  assert.equal(e.plan_verdict, 'REHEARSAL');
  assert.equal(e.humans.at(-1).meets_target, null);
  assert.equal(e.behavior_only.false_pos, 1, '같은 기록으로 BehaviorScore 혼자 기준도 계산한다');
  assertRefused(root, 'k4b', collect(root, 'k4b', [...k6Args(root, 'mock'), '--verdict', 'pass']), /--verdict pass/);
});

test('V-T25 ⑤: human_sessions.csv에 원천 칸이 없거나, --k6-source와 다르거나, live가 적혀 있으면 거부한다', () => {
  const root = newRoot();
  const noSource = humanCsv('public', 947).split('\n').map((l) => l.split(',').slice(1).join(',')).join('\n');
  const cases = [
    ['no-col', noSource, /source/],
    ['other', humanCsv('public', 947, { rowEdit: (b, i) => (i === 3 ? ['mock', ...b.slice(1)] : b) }), /원천/],
    ['live', humanCsv('public', 947, { rowEdit: (b, i) => (i === 3 ? ['live', ...b.slice(1)] : b) }), /원천/],
  ];
  for (const [name, csv, expect] of cases) assertRefused(root, `k5-${name}`, collect(root, `k5-${name}`, k6Args(root, 'public', { csv })), expect);
});

test('[ASVS v5.0.0-2.2.1] V-T25 ⑥: public 파일에 입력한 글자 칸(또는 모르는 칸)이 있거나 머리글보다 칸이 많은 행이 있으면 거부한다', () => {
  const root = newRoot();
  const csv = humanCsv('public', 947, { header: 'source,person,role,stratum,round,predicted,score,user_input', rowEdit: (b) => [...b, 'hello'] });
  assertRefused(root, 'k6', collect(root, 'k6', k6Args(root, 'public', { csv })), /글자/);
  const extraCell = humanCsv('public', 947, { rowEdit: (b, i) => (i === 2 ? [...b, 'typed text'] : b) });
  assertRefused(root, 'k6b', collect(root, 'k6b', k6Args(root, 'public', { csv: extraCell })), /머리글보다/);
});

const FP_OK = 'batch,sampled,human,bot,unsure,population\npass,200,190,8,2,100000\nshadow_challenge,200,10,185,5,400\n';
const LIVE = (fp) => ['--k6-source', 'live', '--fp-review', fp, '--r2-deadline', '2027-02-01'];

test('V-T25 ⑦: live 두 묶음 200건씩이면 N:C 판정 없이 live_fp(각 구간 단측 97.5%)를 적고 파일을 복사하지 않는다', () => {
  const root = newRoot();
  const r = collect(root, 'k7', LIVE(write(root, 'fp_review.csv', FP_OK)));
  assert.equal(r.code, 0, r.out);
  const e = manifestOf(root, 'k7').k6_eval;
  assert.equal(e.human_source, 'live');
  assert.equal(e.plan_verdict, null);
  const l = e.live_fp;
  assert.deepEqual([l.batches.pass.sampled, l.batches.pass.human, l.batches.pass.bot, l.batches.pass.unsure], [200, 190, 8, 2]);
  assert.deepEqual([l.batches.shadow_challenge.human, l.batches.shadow_challenge.unsure], [10, 5]);
  // 참값: 정확한 유리수 이항으로 따로 계산(판단 불가는 둘째 묶음에서 사람, 첫째 묶음에서 사람 아님으로 센다)
  assert.ok(Math.abs(l.numerator_upper - 48.2737) < 1e-2, String(l.numerator_upper));
  assert.ok(Math.abs(l.denominator_lower - 90997.25) < 1, String(l.denominator_lower));
  assert.ok(Math.abs(l.fp_upper95_one_sided - 0.0005305) < 1e-6, String(l.fp_upper95_one_sided));
  assert.equal(l.meets_target, true);
  assert.equal(l.r2_deadline, '2027-02-01');
  assert.equal(existsSync(join(runDir(root, 'k7'), 'fp_review.csv')), false);
});

test('V-T25 ⑦: 전체가 200건 이하인 묶음을 모두 검토한 전수 검토는 받고 그 묶음의 비율을 구간 없이 쓴다', () => {
  const root = newRoot();
  const fp = write(root, 'fp_review.csv', 'batch,sampled,human,bot,unsure,population\npass,200,190,8,2,100000\nshadow_challenge,150,10,135,5,150\n');
  const r = collect(root, 'k7b', LIVE(fp));
  assert.equal(r.code, 0, r.out);
  const l = manifestOf(root, 'k7b').k6_eval.live_fp;
  assert.equal(l.batches.shadow_challenge.census, true);
  assert.equal(l.numerator_upper, 15);
  assert.ok(Math.abs(l.fp_upper95_one_sided - 0.00016484) < 1e-6, String(l.fp_upper95_one_sided));
});

test('V-T25 ⑧: live에 --k6-plan을 주거나 fp_review.csv의 표본·합계가 규칙 밖이면 거부한다', () => {
  const root = newRoot();
  const live = (id, body, extra = []) => collect(root, id, [...LIVE(write(root, `${id}.csv`, body)), ...extra]);
  assertRefused(root, 'k8a', live('k8a', FP_OK, ['--k6-plan', '947:1']), /--k6-plan/);
  assertRefused(root, 'k8b', live('k8b', FP_OK.replace('pass,200,190,8,2', 'pass,199,189,8,2')), /200/);
  assertRefused(root, 'k8c', live('k8c', FP_OK.replace('pass,200,190,8,2', 'pass,200,190,8,1')), /sampled/);
  assertRefused(root, 'k8d', live('k8d', 'batch,sampled,human,bot,unsure,population\npass,200,190,8,2,100000\n'), /shadow_challenge/);
});

test('V-T25 ⑨: 최대 기여가 기준보다 작은 기본 강도는 오탐을 세지 않고 UNMEASURABLE이며 합격으로 적지 못한다', () => {
  const root = newRoot();
  const reg = registration('public', { behavior_rule: { ...RULE, weight: 0.2 } });
  const csv = humanCsv('public', 947, { fp: 0 });
  const args = passArgs(root, { fp: 0, csv, reg });
  const r = collect(root, 'k9', args);
  assert.equal(r.code, 0, r.out);
  const e = manifestOf(root, 'k9').k6_eval;
  assert.equal(e.plan_verdict, 'UNMEASURABLE');
  assert.deepEqual(e.humans, []);
  assert.equal(e.behavior_only.false_pos, null);
  assert.equal(e.behavior_only.unmeasurable, true);
  assert.deepEqual(e.behavior_only.unmeasurable_reasons, ['ceiling']);
  assert.equal(e.human_units.judge_false_pos, null, '측정 무의미면 오탐 수를 남기지 않는다');
  assertRefused(root, 'k9b', collect(root, 'k9b', [...args, '--verdict', 'pass', '--remeasure-reason', 'x']), /--verdict pass/);
});

test('[ASVS v5.0.0-2.2.1] V-T25: 사전 등록 파일이 빠졌거나 모르는 칸·계획 불일치·측정 뒤 등록·같은 씨앗·기준과 어긋난 predicted면 거부한다', () => {
  const root = newRoot();
  const missing = k6Args(root, 'public').filter((v, i, all) => v !== '--k6-registration' && all[i - 1] !== '--k6-registration');
  assertRefused(root, 'r1', collect(root, 'r1', missing), /--k6-registration/);
  const cases = [
    ['unknown', registration('public', { surprise: 1 }), /surprise/],
    ['plan', registration('public', { plan: { n: 1549, c: 3 } }), /계획/],
    ['late', registration('public', { registered_at: '2026-12-02T00:00:00Z' }), /측정 시작/],
    ['seed', registration('public', { seeds: { split: 11 } }), /seeds/],
    ['sameseed', registration('public', { seeds: { split: 7, draw: 7 } }), /seeds/],
    ['nanreg', registration('public', { registered_at: 'nan' }), /registered_at/],
    ['infreg', registration('public', { registered_at: 'inf' }), /registered_at/],
    ['nullreg', registration('public', { registered_at: null }), /registered_at/],
    ['ratio', registration('public', { max_missing_ratio: 0.06 }), /0\.05/],
    ['source', registration('mock'), /원천/],
    ['tool', registration('public', { tool_sha256: '0'.repeat(64) }), /도구/],
    ['rule', registration('public', { behavior_rule: { ...RULE, public_max_risk: 2 } }), /public_max_risk/],
  ];
  for (const [name, reg, expect] of cases) assertRefused(root, `r-${name}`, collect(root, `r-${name}`, k6Args(root, 'public', { reg })), expect);
  const wrong = humanCsv('public', 947, { rowEdit: (b, i) => (i === 2 ? [...b.slice(0, 5), 'human', 0.5] : b) });
  assertRefused(root, 'r-rule2', collect(root, 'r-rule2', k6Args(root, 'public', { csv: wrong })), /기준과 어긋/);
});

test('V-T25 (H4): 사람 행이 있는데 --k6-source가 없으면 거부하고, --verdict pass는 plan_verdict가 PASS일 때와 live가 목표를 만족할 때만 받는다', () => {
  const root = newRoot();
  const conf = write(root, 'c.csv', confusionCsv(947));
  assertRefused(root, 'h4a', collect(root, 'h4a', ['--confusion', conf]), /--k6-source/);
  const bots = write(root, 'b.csv', 'tier,round,label,predicted,count,stratum\nvolume-L1,1,bot,bot,970,\nvolume-L1,1,bot,human,30,\n');
  assert.equal(collect(root, 'h4b', ['--confusion', bots]).code, 0);
  assertRefused(root, 'h4c', collect(root, 'h4c', ['--confusion', bots, '--verdict', 'pass']), /--verdict pass/);
  // FAIL인데 pass를 주면 거부한다
  const args = passArgs(root, { fp: 2, confusion: confusionCsv(947, 2), csv: humanCsv('public', 947, { fp: 2 }) });
  assertRefused(root, 'h4d', collect(root, 'h4d', [...args, '--verdict', 'pass']), /--verdict pass/);
  const bad = write(root, 'fp.csv', 'batch,sampled,human,bot,unsure,population\npass,200,100,98,2,1000\nshadow_challenge,200,190,5,5,4000\n');
  assertRefused(root, 'h4e', collect(root, 'h4e', [...LIVE(bad), '--verdict', 'pass']), /--verdict pass/);
  assert.equal(collect(root, 'h4f', [...LIVE(write(root, 'ok.csv', FP_OK)), '--verdict', 'pass']).code, 0);
  const ok = newRoot();
  assert.equal(collect(ok, 'h4g', [...passArgs(ok), '--verdict', 'pass']).code, 0);
});

test('V-T25 (H2): public은 --start가 필수이고, 공개 등록 파일이 커밋돼 있고 그 첫 커밋이 측정 시작보다 앞서며 바뀐 적이 없어야 한다', () => {
  const noStart = newRoot();
  const a = passArgs(noStart).filter((v, i, all) => v !== '--start' && all[i - 1] !== '--start');
  assertRefused(noStart, 's1', collect(noStart, 's1', a), /--start/);

  const notPublished = newRoot();
  assertRefused(notPublished, 's2', collect(notPublished, 's2', k6Args(notPublished, 'public')), /공개 등록 파일/);

  const notCommitted = newRoot();
  const args3 = k6Args(notCommitted, 'public');
  assert.equal(py(HUMAN, ['publish-registration', '--registration', regPathOf(args3), '--root', notCommitted]).code, 0);
  git(notCommitted, ['init', '-q']);
  assertRefused(notCommitted, 's3', collect(notCommitted, 's3', args3), /커밋/);

  const late = newRoot();
  const args4 = k6Args(late, 'public');
  publishAndCommit(late, regPathOf(args4), '2026-10-05T00:00:00Z');
  assertRefused(late, 's4', collect(late, 's4', args4), /측정 시작/);

  const edited = newRoot();
  const args5 = k6Args(edited, 'public');
  publishAndCommit(edited, regPathOf(args5));
  const pub = join(edited, 'docs', 'perf-ledger', 'registrations', 'reg-public-1.json');
  writeFileSync(pub, readFileSync(pub, 'utf8') + ' \n');
  git(edited, ['add', 'docs/perf-ledger/registrations']);
  git(edited, ['commit', '-q', '-m', 'edit'], '2026-09-21T00:00:00Z');
  assertRefused(edited, 's5', collect(edited, 's5', args5), /바뀌/);

  const swapped = newRoot();
  const reg = registration('public');
  const args6 = k6Args(swapped, 'public', { reg });
  publishAndCommit(swapped, regPathOf(args6));
  // 가중치만 바꾼다: 기준이 그대로라 입력 검사를 지나고, 등록 해시 대조에서 걸린다
  writeFileSync(regPathOf(args6), JSON.stringify({ ...reg, behavior_rule: { ...RULE, weight: 0.5 } }));
  assertRefused(swapped, 's6', collect(swapped, 's6', args6), /등록 해시/);
});

test('V-T25 (재검토 ⑤): 다시 재기는 자료 해시로 판단한다: 씨앗을 바꿔도 사유 없이 거부하고, 사유가 있어도 표에 재측정·이전 측정의 씨앗과 강도가 보이며, 등록 파일 덮어쓰기는 거부한다', () => {
  const root = newRoot();
  const reg = registration('public');
  const args = passArgs(root, { reg });
  assert.equal(collect(root, 'first', args).code, 0);
  const noReason = registration('public', { id: 'reg-2', seeds: { split: 31, draw: 32 } });
  const args2 = passArgs(root, { reg: noReason });
  assertRefused(root, 'second', collect(root, 'second', args2), /--remeasure-reason/);
  const r = collect(root, 'second', [...args2, '--remeasure-reason', '도구 고침 뒤 다시 잼']);
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'second');
  assert.equal(m.k6_plan.remeasure, true);
  assert.equal(m.k6_plan.remeasure_reason, '도구 고침 뒤 다시 잼');
  assert.deepEqual(m.k6_plan.prior_runs, [{ run_id: 'first', split_seed: { split: 11, draw: 22 }, strength: '기본', sort_mode: 'shuffle', plan_verdict: 'PASS' }]);
  assert.match(m.notes, /도구 고침 뒤 다시 잼/);
  assert.equal(py(INDEX, ['--root', root]).code, 0);
  const row = readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8').split('\n').find((l) => l.includes('| second |'));
  assert.match(row, /재측정/);
  assert.match(row, /first\(기본·shuffle·씨앗 11\/22\)/);
  const again = py(HUMAN, ['publish-registration', '--registration', regPathOf(args), '--root', root]);
  assert.equal(again.code, 1, again.out);
  assert.match(again.out, /이미 있다/);
  // 정렬 방식을 바꿔도 같은 자료면 다시 재기다
  const fcfs = registration('public', { id: 'reg-3', behavior_rule: { ...RULE, sort_mode: 'fcfs' } });
  assertRefused(root, 'third', collect(root, 'third', passArgs(root, { reg: fcfs })), /--remeasure-reason/);
});

test('V-T25 (재검토 ⑤): 민감도 실행은 사유 없이 돌지만 이전 측정으로 남고, 민감도 뒤의 기본 판정에는 그 사실이 표에 보인다', () => {
  const root = newRoot();
  const loose = registration('public', { id: 'reg-loose', behavior_rule: { ...RULE, strength: '완화' } });
  assert.equal(collect(root, 'loose', passArgs(root, { reg: loose })).code, 0);
  const strict = registration('public', { id: 'reg-strict', behavior_rule: { ...RULE, strength: '강화' } });
  const r2 = collect(root, 'strict', passArgs(root, { reg: strict }));
  assert.equal(r2.code, 0, r2.out);
  assert.deepEqual(manifestOf(root, 'strict').k6_plan.prior_runs.map((p) => p.run_id), ['loose']);
  const r3 = collect(root, 'main', passArgs(root));
  assert.equal(r3.code, 0, r3.out);
  const m = manifestOf(root, 'main');
  assert.equal(m.k6_plan.sensitivity_before, true);
  assert.equal(m.k6_plan.remeasure, false);
  assert.deepEqual(m.k6_plan.prior_runs.map((p) => p.run_id), ['loose', 'strict']);
  assert.equal(py(INDEX, ['--root', root]).code, 0);
  const row = readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8').split('\n').find((l) => l.includes('| main |'));
  assert.match(row, /민감도 선행/);
  assert.equal(row.includes('재측정'), false);
});

test('V-T25 (재검토 낮음): --force로 덮는 같은 run id는 이전 측정에서 빼고, 이전 측정이 없을 때 준 사유는 남기지 않는다', () => {
  const root = newRoot();
  const args = passArgs(root);
  const r = collect(root, 'same', [...args, '--remeasure-reason', '이전 측정 없음']);
  assert.equal(r.code, 0, r.out);
  const first = manifestOf(root, 'same').k6_plan;
  assert.equal('remeasure_reason' in first, false);
  assert.deepEqual(first.prior_runs, []);
  const again = collect(root, 'same', [...args, '--force']);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual(manifestOf(root, 'same').k6_plan.prior_runs, []);
});

test('V-T25 (재검토 ①): --checks로 정해지는 최종 판정 pass에도 사람 평가 게이트가 걸린다', () => {
  const root = newRoot();
  const checks = write(inDir(), 'checks.json', JSON.stringify({ checks: [{ name: 'c', allowed: 0.01, trials: 1000, violations: 0 }] }));
  const failing = passArgs(root, { fp: 2, confusion: confusionCsv(947, 2), csv: humanCsv('public', 947, { fp: 2 }) });
  assertRefused(root, 'c1', collect(root, 'c1', [...failing, '--checks', checks]), /판정 pass/);
  const loose = registration('public', { id: 'reg-loose', behavior_rule: { ...RULE, strength: '완화' } });
  assertRefused(root, 'c2', collect(root, 'c2', [...passArgs(root, { reg: loose }), '--checks', checks]), /판정 pass/);
  const unmeasurable = newRoot();
  const noPin = k6Args(unmeasurable, 'public');
  publishAndCommit(unmeasurable, regPathOf(noPin));
  assertRefused(unmeasurable, 'c3', collect(unmeasurable, 'c3', [...noPin, '--checks', checks]), /판정 pass/);
  const live = newRoot();
  const bad = write(live, 'fp.csv', 'batch,sampled,human,bot,unsure,population\npass,200,100,98,2,1000\nshadow_challenge,200,190,5,5,4000\n');
  assertRefused(live, 'c4', collect(live, 'c4', [...LIVE(bad), '--checks', checks]), /판정 pass/);
  const ok = newRoot();
  const r = collect(ok, 'c5', [...passArgs(ok), '--checks', checks]);
  assert.equal(r.code, 0, r.out);
  assert.equal(manifestOf(ok, 'c5').verdict, 'pass');
});

test('V-T25 (재검토 ②): --dataset-pin은 환경 변수 없이는 합격을 낼 수 없고, 기본 고정 파일은 HEAD에서 읽어 작업 트리와 다르면 거부한다', () => {
  const root = newRoot();
  const reg = registration('public');
  const base = k6Args(root, 'public', { reg });
  publishAndCommit(root, regPathOf(base));
  const pinned = [...base, '--dataset-pin', pinFile(reg)];
  assert.equal(collect(root, 'noenv', pinned).code, 0);
  const e = manifestOf(root, 'noenv').k6_eval;
  assert.equal(e.plan_verdict, 'UNMEASURABLE');
  assert.deepEqual(e.behavior_only.unmeasurable_reasons, ['dataset_pin_overridden']);
  const withEnv = collect(root, 'env', [...pinned, '--remeasure-reason', 'x'], TEST_PIN);
  assert.equal(withEnv.code, 0, withEnv.out);
  const m = manifestOf(root, 'env');
  assert.equal(m.k6_eval.plan_verdict, 'PASS');
  assert.equal(m.k6_plan.dataset_pin.test_env, true);
  assert.equal(m.k6_plan.dataset_pin.overridden, true);
  assert.equal(py(INDEX, ['--root', root]).code, 0);
  assert.match(readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8').split('\n').find((l) => l.includes('| env |')), /시험용 자료 고정/);

  const head = newRoot();
  const args = passArgs(head);
  const pinPath = join(head, 'docs', 'perf-ledger', 'datasets.json');
  const original = readFileSync(pinPath, 'utf8');
  writeFileSync(pinPath, pinBody(registration('public'), { sha256: 'e'.repeat(64) }));
  assertRefused(head, 'dirty', collect(head, 'dirty', args), /HEAD/);
  writeFileSync(pinPath, original);
  const clean = collect(head, 'clean', args);
  assert.equal(clean.code, 0, clean.out);
  assert.equal(manifestOf(head, 'clean').k6_eval.plan_verdict, 'PASS');
  assert.equal(manifestOf(head, 'clean').k6_plan.dataset_pin.overridden, false);

  const uncommitted = newRoot();
  const reg3 = registration('public');
  const args3 = k6Args(uncommitted, 'public', { reg: reg3 });
  publishAndCommit(uncommitted, regPathOf(args3));
  writeFileSync(join(uncommitted, 'docs', 'perf-ledger', 'datasets.json'), pinBody(reg3));
  assertRefused(uncommitted, 'u', collect(uncommitted, 'u', args3), /HEAD/);
});

test('V-T25 (재검토 ③): --start의 nan·inf와 지금보다 뒤인 시작 시각을 거부한다', () => {
  const root = newRoot();
  const args = passArgs(root);
  const withStart = (value) => args.map((v, i) => (args[i - 1] === '--start' ? value : v));
  for (const bad of ['nan', 'inf', '-inf']) {
    const r = collect(root, `t-${bad}`, withStart(bad));
    assert.notEqual(r.code, 0, r.out);
    assert.equal(r.out.includes('Traceback'), false, r.out);
    assert.equal(existsSync(runDir(root, `t-${bad}`)), false);
  }
  assertRefused(root, 'future', collect(root, 'future', withStart('2099-01-01T00:00:00Z')), /지금/);
});

test('V-T25 (재검토 ⑥): public은 verify 결과가 있어야 하고 그 결과를 manifest에 적는다. mock은 없어도 돌고 안 돌렸다고 적는다', () => {
  const root = newRoot();
  const args = passArgs(root);
  const dir = dirname(regPathOf(args));
  const hash = JSON.parse(readFileSync(publicRegPath(root, 'reg-public-1'), 'utf8')).registration_hash;
  const receipt = (over) => writeFileSync(join(dir, 'verify-result.json'), JSON.stringify({ registration_hash: hash, result: 'ok', source_file_checked: true, verified_at: '2026-09-02T00:00:00Z', reason: null, ...over }));
  rmSync(join(dir, 'verify-result.json'));
  assertRefused(root, 'v1', collect(root, 'v1', args), /verify/);
  receipt({ result: 'fail', reason: 'x' });
  assertRefused(root, 'v2', collect(root, 'v2', args), /verify/);
  receipt({ source_file_checked: false });
  assertRefused(root, 'v3', collect(root, 'v3', args), /원본/);
  receipt({ registration_hash: 'f'.repeat(64) });
  assertRefused(root, 'v4', collect(root, 'v4', args), /verify/);
  receipt();
  assert.equal(collect(root, 'v5', args).code, 0);
  const v = manifestOf(root, 'v5').k6_plan.verify;
  assert.deepEqual([v.ran, v.result, v.source_file_checked], [true, 'ok', true]);
  const mock = newRoot();
  assert.equal(collect(mock, 'm', k6Args(mock, 'mock')).code, 0);
  assert.equal(manifestOf(mock, 'm').k6_plan.verify.ran, false);
});

test('V-T25 (H3): 공개 쪽에는 기준값·기여·가중치·최대 위험 값과 소금이 나타나지 않고, 소금이 다르면 등록 해시가 달라진다', () => {
  const root = newRoot();
  const reg = registration('public');
  const args = passArgs(root, { reg });
  assert.equal(collect(root, 'h3', args).code, 0);
  const secrets = [String(RULE.decision_threshold), String(RULE.weight), String(RULE.max_risk), CRITERION, MAX_CONTRIBUTION, reg.salt];
  const pub = readFileSync(join(root, 'docs', 'perf-ledger', 'registrations', 'reg-public-1.json'), 'utf8');
  for (const s of secrets) {
    for (const [name, text] of [...runFiles(root, 'h3'), ['공개 등록 파일', pub]]) assert.equal(text.includes(s), false, `${name}에 비공개 값 ${s}이 있다`);
  }
  const b = manifestOf(root, 'h3').k6_plan.behavior_only_rule;
  assert.deepEqual(Object.keys(b).sort(), ['criterion_ratio', 'sort_mode', 'strength', 'unmeasurable']);
  const other = newRoot();
  const reg2 = { ...reg, salt: randomBytes(32).toString('hex') };
  reg2.judge_people_sha256 = peopleHash(reg2.salt, codes(947));
  reg2.tune_people_sha256 = peopleHash(reg2.salt, ['T1']);
  const args2 = passArgs(other, { reg: reg2 });
  assert.equal(collect(other, 'h3', args2).code, 0);
  assert.notEqual(manifestOf(other, 'h3').k6_plan.registration_hash, manifestOf(root, 'h3').k6_plan.registration_hash);
});

test('V-T25 (M1): 강도가 기본이 아니면 민감도로만 적고 합격으로 적지 않으며, 표에 강도와 정렬 방식이 보인다', () => {
  const root = newRoot();
  const reg = registration('public', { id: 'reg-loose', behavior_rule: { ...RULE, strength: '완화', sort_mode: 'fcfs' } });
  const args = passArgs(root, { reg });
  assert.equal(collect(root, 'loose', args).code, 0);
  const e = manifestOf(root, 'loose').k6_eval;
  assert.equal(e.plan_verdict, 'SENSITIVITY');
  assert.equal(e.sensitivity_result, 'PASS');
  assert.equal(e.humans.at(-1).meets_target, null);
  assertRefused(root, 'loose2', collect(root, 'loose2', [...args, '--verdict', 'pass', '--remeasure-reason', 'x']), /--verdict pass/);
  assert.equal(py(INDEX, ['--root', root]).code, 0);
  const row = readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8').split('\n').find((l) => l.includes('| loose |'));
  assert.match(row, /민감도/);
  assert.match(row, /강도 완화/);
  assert.match(row, /정렬 fcfs/);
});

test('V-T25 (M2): human_sessions의 판정 사람이 등록한 목록과 다르면 거부한다', () => {
  const root = newRoot();
  const swapped = humanCsv('public', 947, { rowEdit: (b, i) => (i === 100 ? [b[0], 'T9999', ...b.slice(2)] : b) });
  assertRefused(root, 'm2', collect(root, 'm2', k6Args(root, 'public', { csv: swapped })), /사람 목록/);
});

test('V-T25 (M3): public은 사람 행을 한 라운드만 받는다', () => {
  const root = newRoot();
  const conf = 'tier,round,label,predicted,count,stratum\n-,1,human,human,847,\n-,1,human,bot,100,\n-,3,human,human,946,\n-,3,human,bot,1,\n';
  const csv = humanCsv('public', 947, { rowEdit: (b) => [...b.slice(0, 4), 3, ...b.slice(5)] });
  assertRefused(root, 'm3', collect(root, 'm3', k6Args(root, 'public', { confusion: conf, csv })), /한 라운드/);
  const rounds = humanCsv('public', 947, { rowEdit: (b, i) => (i === 2 ? [...b.slice(0, 4), 2, ...b.slice(5)] : b) });
  assertRefused(root, 'm3b', collect(root, 'm3b', k6Args(root, 'public', { csv: rounds })), /한 라운드/);
});

test('V-T25 (M4): 자료 고정값이 없거나 다르면 public은 합격 없이 UNMEASURABLE로 끝난다', () => {
  const none = newRoot();
  const a1 = k6Args(none, 'public');
  publishAndCommit(none, regPathOf(a1));
  assert.equal(collect(none, 'p', a1).code, 0);
  const e1 = manifestOf(none, 'p').k6_eval;
  assert.equal(e1.plan_verdict, 'UNMEASURABLE');
  assert.deepEqual(e1.behavior_only.unmeasurable_reasons, ['dataset_not_pinned']);
  const diff = newRoot();
  const reg = registration('public');
  const a2 = k6Args(diff, 'public', { reg, extra: ['--dataset-pin', pinFile(reg, { sha256: 'c'.repeat(64) })] });
  publishAndCommit(diff, regPathOf(a2));
  assert.equal(collect(diff, 'p', a2, TEST_PIN).code, 0);
  const m = manifestOf(diff, 'p');
  assert.deepEqual(m.k6_eval.behavior_only.unmeasurable_reasons, ['dataset_pin_mismatch']);
  assert.equal(m.k6_plan.dataset_pin.overridden, true);
});

test('V-T25 (낮음): NaN 점수를 거부하고, --k6-registration·--human-sessions가 Git 저장소 안이면 거부한다', () => {
  const root = newRoot();
  const nan = humanCsv('public', 947, { rowEdit: (b, i) => (i === 3 ? [...b.slice(0, 6), 'nan'] : b) });
  assertRefused(root, 'n1', collect(root, 'n1', k6Args(root, 'public', { csv: nan })), /숫자가 아니/);
  const inRepo = newRoot();
  const args = k6Args(inRepo, 'public');
  git(inRepo, ['init', '-q']);
  const inside = regPathOf(args).replace(dirname(regPathOf(args)), inRepo);
  writeFileSync(inside, readFileSync(regPathOf(args)));
  const c1 = args.map((v) => (v === regPathOf(args) ? inside : v));
  assertRefused(inRepo, 'n2', collect(inRepo, 'n2', c1), /Git 저장소 안/);
  const insideHs = join(inRepo, 'hs.csv');
  writeFileSync(insideHs, readFileSync(hsPathOf(args)));
  const c2 = args.map((v) => (v === hsPathOf(args) ? insideHs : v));
  assertRefused(inRepo, 'n3', collect(inRepo, 'n3', c2), /Git 저장소 안/);
  const colon = args.map((v) => (v === hsPathOf(args) ? `${v}:stream` : v));
  assertRefused(root, 'n4', collect(root, 'n4', colon), /콜론/);
});

test('V-T25: 장부 표의 사람 오탐에 원천 꼬리표와 강도가 붙는다', () => {
  const root = newRoot();
  assert.equal(collect(root, 'p', passArgs(root)).code, 0);
  assert.equal(collect(root, 'm', k6Args(root, 'mock')).code, 0);
  assert.equal(collect(root, 'l', LIVE(write(root, 'fp.csv', FP_OK))).code, 0);
  const idx = py(INDEX, ['--root', root]);
  assert.equal(idx.code, 0, idx.out);
  const doc = readFileSync(join(root, 'docs', 'perf-ledger.md'), 'utf8');
  const row = (id) => doc.split('\n').find((l) => l.includes(`| ${id} |`)) ?? '';
  assert.match(row('p'), /공개 자료 기준 오탐 1\/947.*계획 통과.*강도 기본/);
  assert.match(row('m'), /모의 사람\(리허설\) 오탐 1\/947.*계획 리허설/);
  assert.match(row('l'), /실제 사람 기준\(출시 뒤\) 오탐 상한 0\.05%/);
  const u = newRoot();
  const reg = registration('public', { behavior_rule: { ...RULE, weight: 0.2 } });
  assert.equal(collect(u, 'u', passArgs(u, { fp: 0, csv: humanCsv('public', 947, { fp: 0 }), reg })).code, 0);
  assert.equal(py(INDEX, ['--root', u]).code, 0);
  assert.match(readFileSync(join(u, 'docs', 'perf-ledger.md'), 'utf8'), /측정 무의미/);
});

// --- V-T45: 공개 기록 변환, 사람 단위 나누기, 사전 등록, 출시 첫 판 탐지율 ---

const HEADER = 'PARTICIPANT_ID\tTEST_SECTION_ID\tSENTENCE\tUSER_INPUT\tKEYSTROKE_ID\tPRESS_TIME\tRELEASE_TIME\tLETTER\tKEYCODE';
const SECRET = 'SECRET-SENTENCE-TEXT';
const fileRow = (p, section, k, press, user = `${SECRET}-input`) => [p, section, SECRET, user, k, press, press + 60, SECRET[k % SECRET.length], 65 + (k % 26)].join('\t');

/** 합성 참가자 파일(자료의 꼴을 흉내 냈다). 둘째 문장이 시간은 먼저다: 나중 문장(s+2)을 파일에서 먼저 쓴다 */
function participantFile(p, t0 = 1000000, firstOffsets = [0, 100, 300, 600]) {
  const firstSection = p * 10 + 1;
  const laterSection = p * 10 + 2;
  const first = firstOffsets.map((d, i) => fileRow(p, firstSection, i + 1, t0 + d));
  const later = [0, 150, 300].map((d, i) => fileRow(p, laterSection, 10 + i, t0 + 100000 + d));
  return [HEADER, ...later, ...first].join('\n') + '\n';
}

/** 합성 zip. files는 [이름, 내용] 목록이고 그 순서대로 넣는다 */
function makeZip(dir, name, files) {
  const spec = write(dir, `${name}.json`, JSON.stringify(files));
  const zipPath = join(dir, name);
  const code = 'import json,sys,zipfile\nf=json.load(open(sys.argv[1],encoding="utf-8"))\nz=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED)\nfor n,c in f: z.writestr(n,c)\nz.close()\n';
  const script = write(dir, `${name}.py`, code);
  const r = spawnSync(PY, ['-I', '-X', 'utf8', script, spec, zipPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return zipPath;
}

const README = ['readme.txt', 'readme: research and non-commercial use with attribution\n'];
const META = ['metadata_participants.txt', ['PARTICIPANT_ID\tAGE', '101\t67', '102\t25'].join('\n') + '\n'];

/** 641명(그중 1명은 쓸 수 없는 파일)의 합성 자료 목록. makeFile로 참가자 파일을 바꿀 수 있다 */
function fixtureFiles(makeFile = participantFile) {
  const files = [README, META];
  for (let p = 101; p < 741; p++) files.push([`files/${p}_keystrokes.txt`, makeFile(p)]);
  // 시각 칸이 숫자가 아닌 사람: 쓸 수 없어 같은 순서의 다음 사람으로 갈음된다
  files.push(['files/999_keystrokes.txt', `${HEADER}\n999\t9991\t${SECRET}\t${SECRET}\t1\tnot-a-number\t2\ta\t65\n`]);
  return files;
}

const fixture = (() => {
  let made;
  return () => {
    if (!made) {
      const dir = tmp('human-data-zip-');
      made = { dir, zip: makeZip(dir, 'Keystrokes.zip', fixtureFiles()) };
    }
    return made;
  };
})();

const ruleFile = (dir, rule = RULE) => write(dir, 'behavior-rule.json', JSON.stringify(rule));
const convertArgs = (zip, out, dir, over = []) => [
  'convert-aalto', '--zip', zip, '--out-dir', out, '--plan', '600:0', '--tune-n', '40', '--split-seed', '11', '--draw-seed', '22',
  '--registration-id', 'reg-e2e', '--behavior-rule', ruleFile(dir), '--registered-at', '2026-09-01T00:00:00Z', ...over,
];
const jsonl = (p) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const scoresFor = (out, risk) => ['person,session,behavior_risk', ...jsonl(join(out, 'judge.jsonl')).map((r, i) => [r.person, r.session, risk(r, i)].join(','))].join('\n') + '\n';
const sessionArgs = (out, scores, more = {}) => ['sessions', '--records', more.records ?? join(out, 'judge.jsonl'), '--registration', join(out, 'registration.json'), '--scores', scores, '--out-dir', more.outDir ?? out];

const zipOf = new Map();
function converted(zip = fixture().zip, over = []) {
  const { dir } = fixture();
  const out = tmp('human-data-out-');
  const r = py(HUMAN, convertArgs(zip, out, dir, over));
  assert.equal(r.code, 0, r.out);
  zipOf.set(out, zip);
  return { dir, zip, out };
}

/** 변환 결과를 장부에 넣는다: 공개 등록 파일 커밋, 자료 고정 커밋, 원본에서 다시 계산(verify), collect */
function ledgerRun(root, out, id, extra = []) {
  const regPath = join(out, 'registration.json');
  const reg = JSON.parse(readFileSync(regPath, 'utf8'));
  if (!existsSync(publicRegPath(root, reg.id))) publishAndCommit(root, regPath);
  commitPin(root, reg);
  const v = py(HUMAN, ['verify', '--registration', regPath, '--judge', join(out, 'judge.jsonl'), '--tune', join(out, 'tune.jsonl'), '--source-file', zipOf.get(out), '--root', root]);
  assert.equal(v.code, 0, v.out);
  return collect(root, id, [
    '--k6-source', 'public', '--k6-plan', `${reg.plan.n}:${reg.plan.c}`, '--confusion', join(out, 'confusion-human.csv'),
    '--human-sessions', join(out, 'human_sessions.csv'), '--k6-registration', regPath, ...START, ...extra,
  ]);
}

test('V-T45 ①: 변환은 문장 안 키 간격만 화면 계산과 같은 값으로 옮기고, 한 사람의 첫 문장이 판정 기록이며, 글자 내용은 어디에도 없다', () => {
  const { out } = converted();
  const judge = jsonl(join(out, 'judge.jsonl'));
  const byPerson = Map.groupBy(judge, (r) => r.person);
  assert.equal(byPerson.size, 600);
  for (const rows of byPerson.values()) assert.equal(rows.filter((x) => x.role === 'judge').length, 1);
  const r101 = judge.find((r) => r.role === 'judge');
  const p = Number(r101.person);
  assert.equal(r101.session, String(p * 10 + 1), '시간이 먼저인 문장이 판정 기록이다(파일 순서가 아니다)');
  // 간격 100·200·300: 평균 200, 모표준편차 81.6(apps/web의 createBehaviorTracker와 같은 식)
  assert.deepEqual(r101.summary, { v: 1, windowMs: 600, inputIntervalMeanMs: 200, inputIntervalStdMs: 81.6 });
  assert.equal(r101.source, 'public');
  const ref = judge.find((r) => r.person === r101.person && r.role === 'ref');
  assert.deepEqual(ref.summary, { v: 1, windowMs: 300, inputIntervalMeanMs: 150, inputIntervalStdMs: 0 });
  for (const f of readdirSync(out)) {
    const text = readFileSync(join(out, f), 'utf8');
    assert.equal(text.includes(SECRET), false, `${f}에 글자 내용이 남았다`);
  }
});

test('V-T45 ②: 조정용·판정용은 사람 단위로 겹치지 않고, 같은 씨앗이면 파일 순서와 상관없이 같은 사람이 뽑히며, 씨앗이 다르면 달라진다', () => {
  const { dir, out } = converted();
  const people = (d, f) => new Set(jsonl(join(d, f)).map((r) => r.person));
  const tune = people(out, 'tune.jsonl');
  const judge = people(out, 'judge.jsonl');
  assert.equal(tune.size, 40);
  assert.equal(judge.size, 600);
  assert.deepEqual([...tune].filter((p) => judge.has(p)), []);
  assert.equal(judge.has('999'), false);
  assert.equal(tune.has('999'), false);
  const rev = makeZip(dir, 'rev.zip', fixtureFiles().reverse());
  const out2 = tmp('human-data-out-');
  assert.equal(py(HUMAN, convertArgs(rev, out2, dir)).code, 0);
  assert.deepEqual(readFileSync(join(out2, 'judge.jsonl')), readFileSync(join(out, 'judge.jsonl')));
  assert.deepEqual(readFileSync(join(out2, 'tune.jsonl')), readFileSync(join(out, 'tune.jsonl')));
  const out3 = tmp('human-data-out-');
  assert.equal(py(HUMAN, convertArgs(fixture().zip, out3, dir, ['--split-seed', '12'])).code, 0);
  assert.notDeepEqual(people(out3, 'tune.jsonl'), tune);
});

test('V-T45 ③: 사전 등록 파일에 자료 해시·출처·씨앗값·변환 규칙·소금·사람 목록 해시·도구 커밋이 있고, 보고서에는 사람 코드 없이 집계와 출처만 있으며, 메타데이터의 층만 붙는다', () => {
  const { zip, out } = converted();
  const reg = JSON.parse(readFileSync(join(out, 'registration.json'), 'utf8'));
  assert.equal(reg.source, 'public');
  assert.equal(reg.id, 'reg-e2e');
  assert.equal(reg.dataset.name, 'Aalto 136M Keystrokes');
  assert.equal(reg.dataset.sha256, createHash('sha256').update(readFileSync(zip)).digest('hex'));
  assert.match(reg.dataset.attribution, /Dhakal/);
  assert.match(reg.dataset.attribution, /10\.1145\/3173574\.3174220/);
  assert.match(reg.dataset.attribution, /비상업/);
  assert.equal(reg.dataset.readme_sha256.length, 64);
  assert.deepEqual(reg.plan, { n: 600, c: 0 });
  assert.deepEqual(reg.seeds, { split: 11, draw: 22 });
  assert.equal(reg.conversion_rule, 'aalto-keystroke-v1');
  assert.match(reg.salt, /^[0-9a-f]{64}$/);
  assert.equal(reg.max_missing_ratio, 0.01);
  assert.equal(reg.judge_records_sha256, createHash('sha256').update(Buffer.concat([Buffer.from(`${reg.salt}\n`), readFileSync(join(out, 'judge.jsonl'))])).digest('hex'));
  assert.equal(reg.tool_sha256, toolHash());
  assert.match(reg.tool_commit, /^[0-9a-f]{40}$/);
  const judge = new Set(jsonl(join(out, 'judge.jsonl')).map((r) => r.person));
  assert.equal(reg.judge_people_sha256, peopleHash(reg.salt, judge));
  const rep = JSON.parse(readFileSync(join(out, 'conversion-report.json'), 'utf8'));
  assert.equal(rep.people_total, 641);
  assert.equal(rep.people_unusable, 1);
  assert.deepEqual([rep.judge_people, rep.tune_people], [600, 40]);
  assert.equal(rep.dropped_rows, 1);
  assert.match(rep.attribution, /Dhakal/);
  assert.equal(JSON.stringify(rep).includes('"101"'), false);
  const all = [...jsonl(join(out, 'judge.jsonl')), ...jsonl(join(out, 'tune.jsonl'))];
  assert.equal(all.find((r) => r.person === '101').stratum, 'age60');
  assert.equal(all.find((r) => r.person === '102').stratum, '');
});

test('[ASVS v5.0.0-2.2.1] V-T45 ④: 출력 폴더가 저장소 안이거나, readme·필요한 열이 없거나, 파일 이름과 안쪽 ID가 다르거나, 사람이 모자라거나, tune-n 0·같은 씨앗이면 아무것도 쓰지 않고 멈춘다', () => {
  const { dir, zip } = fixture();
  const inRepo = join(here, 'out-must-not-exist');
  const r = py(HUMAN, convertArgs(zip, inRepo, dir));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Git 저장소 안/);
  assert.equal(existsSync(inRepo), false);
  const cases = [
    ['noreadme', fixtureFiles().filter((f) => f[0] !== 'readme.txt'), /readme/],
    ['badcol', [README, META, ...Array.from({ length: 700 }, (_, i) => [`files/${i + 1}_keystrokes.txt`, 'PARTICIPANT_ID\tNOPE\n1\t2\n'])], /PRESS_TIME/],
    ['badid', [README, META, ...Array.from({ length: 700 }, (_, i) => [`files/${i + 1}_keystrokes.txt`, `${HEADER}\n77777\t1\tx\ty\t1\t10\t20\ta\t65\n`])], /파일 이름/],
    ['few', fixtureFiles().slice(0, 300), /모자란다/],
  ];
  for (const [name, files, expect] of cases) {
    const z = makeZip(dir, `${name}.zip`, files);
    const out = tmp('human-data-out-');
    const res = py(HUMAN, convertArgs(z, out, dir));
    assert.equal(res.code, 1, `${name}: ${res.out}`);
    assert.match(res.out, expect);
    assert.deepEqual(readdirSync(out), [], `${name}: 멈췄는데 파일이 생겼다`);
  }
  assert.match(py(HUMAN, convertArgs(zip, tmp('x-'), dir, ['--plan', '100:1'])).out, /상한/);
  const zeroOut = tmp('x-');
  assert.notEqual(py(HUMAN, convertArgs(zip, zeroOut, dir, ['--tune-n', '0'])).code, 0);
  assert.deepEqual(readdirSync(zeroOut), []);
  const ratioOut = tmp('x-');
  const ratio = py(HUMAN, convertArgs(zip, ratioOut, dir, ['--max-missing-ratio', '0.06']));
  assert.equal(ratio.code, 1, ratio.out);
  assert.match(ratio.out, /0\.05/);
  assert.deepEqual(readdirSync(ratioOut), []);
  const colonOut = `${tmp('x-')}/a:b`;
  assert.match(py(HUMAN, convertArgs(zip, colonOut, dir)).out, /콜론/);
  const sameOut = tmp('x-');
  const same = py(HUMAN, convertArgs(zip, sameOut, dir, ['--split-seed', '7', '--draw-seed', '7']));
  assert.equal(same.code, 1);
  assert.match(same.out, /씨앗/);
  assert.deepEqual(readdirSync(sameOut), []);
});

test('V-T45 ⑤: sessions는 사전 등록 기준으로 predicted를 정해 집계하고, 변환부터 장부까지 끝까지 돈다(public, 커밋·자료 고정 뒤 PASS)', () => {
  const { out } = converted();
  // 판정 기록은 0.2로 두고 참고 기록만 달리해, 점수가 모두 같으면 계산할 수 없는 사람 안 상관을 잰다
  const scores = write(out, 'scores.csv', scoresFor(out, (rec, i) => (rec.role === 'judge' ? '0.2' : String(0.1 + (i % 5) / 50))));
  const r = py(HUMAN, sessionArgs(out, scores));
  assert.equal(r.code, 0, r.out);
  const lines = readFileSync(join(out, 'human_sessions.csv'), 'utf8').trim().split('\n');
  assert.equal(lines[0], 'source,person,role,stratum,round,predicted,score');
  assert.deepEqual(lines.find((l) => l.includes(',judge,')).split(',').slice(-2), ['human', String(round6(0.2 * RULE.weight))]);
  assert.match(readFileSync(join(out, 'confusion-human.csv'), 'utf8'), /-,1,human,human,600,/);
  const root = newRoot();
  const m = ledgerRun(root, out, 'e2e');
  assert.equal(m.code, 0, m.out);
  const man = manifestOf(root, 'e2e');
  assert.equal(man.k6_eval.plan_verdict, 'PASS');
  assert.deepEqual(man.k6_eval.human_units.people, 600);
  assert.ok(man.k6_eval.human_icc, '같은 사람의 나머지 문장으로 사람 안 상관을 잰다');
  assert.equal(man.k6_plan.dataset.sha256, JSON.parse(readFileSync(join(out, 'registration.json'), 'utf8')).dataset.sha256);
  const text = JSON.stringify(man);
  for (const key of ['decision_threshold', '"weight"', 'max_risk', '"criterion"', 'max_contribution', '"salt"']) assert.equal(text.includes(key), false, `장부에 ${key}가 있다`);
  const bad = write(out, 'scores2.csv', scoresFor(out, (_, i) => (i === 0 ? '0.9' : '0.1')));
  assert.equal(py(HUMAN, sessionArgs(out, bad)).code, 0);
  assert.match(readFileSync(join(out, 'confusion-human.csv'), 'utf8'), /-,1,human,bot,1,/);
});

test('[ASVS v5.0.0-2.2.1] V-T45 ⑥: sessions는 점수 칸이 빠졌거나 범위 밖이거나 공개 기록에 없는 칸이 있으면 거부하고 저장소 안에는 쓰지 않는다', () => {
  const { out } = converted();
  const fresh = () => ({ outDir: tmp('x-') });
  const miss = write(out, 'miss.csv', scoresFor(out, () => '0.1').split('\n').slice(0, -2).join('\n') + '\n');
  assert.match(py(HUMAN, sessionArgs(out, miss, fresh())).out, /점수가 없다/);
  const range = write(out, 'range.csv', scoresFor(out, (_, i) => (i === 3 ? '2' : '0.1')));
  assert.match(py(HUMAN, sessionArgs(out, range, fresh())).out, /범위/);
  const recs = jsonl(join(out, 'judge.jsonl'));
  recs[0].summary.pointerMoves = 3;
  const records = write(out, 'bad.jsonl', recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.match(py(HUMAN, sessionArgs(out, write(out, 's.csv', scoresFor(out, () => '0.1')), { records, outDir: tmp('x-') })).out, /pointerMoves/);
  const inRepo = join(here, 'out-must-not-exist');
  assert.match(py(HUMAN, sessionArgs(out, write(out, 's.csv', scoresFor(out, () => '0.1')), { outDir: inRepo })).out, /Git 저장소 안/);
  assert.equal(existsSync(inRepo), false);
});

test('V-T45 ⑦: 모의 사람 기록을 사람 단위로 나눠 등록하고 mock 원천으로 장부까지 돌면 리허설로만 적힌다', () => {
  const dir = tmp('human-data-mock-');
  const rows = [];
  for (let p = 1; p <= 700; p++) {
    for (let s = 1; s <= 2; s++) {
      rows.push({ source: 'mock', person: `M${p}`, session: String(s), stratum: 'device-ios', summary: { v: 1, windowMs: 5000, pointerMoves: 3, pointerEntropy: 1.5, inputIntervalMeanMs: 180, inputIntervalStdMs: 90, scrollEvents: 1, scrollDistancePx: 90 } });
    }
  }
  const records = write(dir, 'mock.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = tmp('human-data-out-');
  const reg = py(HUMAN, ['register-mock', '--records', records, '--out-dir', out, '--plan', '600:0', '--tune-n', '40', '--split-seed', '5', '--draw-seed', '6', '--registration-id', 'reg-mock', '--behavior-rule', ruleFile(dir), '--dataset-version', 'fixture', '--registered-at', '2026-09-01T00:00:00Z']);
  assert.equal(reg.code, 0, reg.out);
  const judged = jsonl(join(out, 'judge.jsonl'));
  assert.equal(new Set(judged.map((r) => r.person)).size, 600);
  assert.equal(judged.filter((r) => r.role === 'judge').every((r) => r.session === '1'), true);
  const scores = write(out, 'scores.csv', ['person,session,behavior_risk,verdict,risk_total', ...judged.map((r) => [r.person, r.session, '0.25', 'human', '0.2'].join(','))].join('\n') + '\n');
  const made = py(HUMAN, sessionArgs(out, scores));
  assert.equal(made.code, 0, made.out);
  assert.match(readFileSync(join(out, 'human_sessions.csv'), 'utf8').split('\n')[0], /,behavior_score$/);
  const root = newRoot();
  const r = collect(root, 'mock', ['--k6-source', 'mock', '--k6-plan', '600:0', '--confusion', join(out, 'confusion-human.csv'), '--human-sessions', join(out, 'human_sessions.csv'), '--k6-registration', join(out, 'registration.json')]);
  assert.equal(r.code, 0, r.out);
  const e = manifestOf(root, 'mock').k6_eval;
  assert.equal(e.plan_verdict, 'REHEARSAL');
  assert.equal(e.behavior_only.pointer, null);
  assert.deepEqual(e.behavior_only.risk_percentiles, { p50: 0.25, p90: 0.25, p99: 0.25 });
  assert.equal(py(HUMAN, ['verify', '--registration', join(out, 'registration.json'), '--judge', join(out, 'judge.jsonl'), '--tune', join(out, 'tune.jsonl'), '--source-file', records]).code, 0);
});

test('V-T45 ⑧: 출시 첫 판 혼동 행렬을 launch_detection으로 함께 적고, 합격 칸은 두지 않으며, 봇 세션 수가 다르면 거부한다', () => {
  const root = newRoot();
  const launch = write(root, 'launch.csv', 'tier,round,label,predicted,count,stratum\nvolume-L1,1,bot,bot,900,\nvolume-L1,1,bot,human,100,\n');
  const args = passArgs(root);
  const r = collect(root, 'ld', [...args, '--confusion-launch', launch]);
  assert.equal(r.code, 0, r.out);
  const m = manifestOf(root, 'ld');
  const row = m.k6_eval.launch_detection[0];
  assert.deepEqual([row.tier, row.round, row.n, row.detected, row.rate], ['volume-L1', 1, 1000, 900, 0.9]);
  assert.equal('meets_target' in row, false);
  assert.ok(row.wilson95[0] < 0.9 && row.wilson95[1] > 0.9);
  assert.equal(m.attachments.confusion_launch, 'confusion-launch.csv');
  assert.equal(m.k6_eval.bots[0].rate, 0.97, '합격 판정 탐지율은 그대로다');
  const short = write(root, 'launch2.csv', 'tier,round,label,predicted,count,stratum\nvolume-L1,1,bot,bot,900,\n');
  assertRefused(root, 'ld2', collect(root, 'ld2', [...args, '--confusion-launch', short, '--remeasure-reason', 'x']), /세션 수/);
});

test('V-T45 ⑨ (H1): 위험 값이 비면 0으로 바꾸지 않고 값 없음으로 세며, 등록한 비율(1%)을 넘으면 UNMEASURABLE이다', () => {
  const { out } = converted();
  const limited = (n) => write(out, `blank${n}.csv`, scoresFor(out, (rec, i) => (i < 2 * n && rec.role === 'judge' ? '' : '0.1')));
  // 판정·참고 번갈아 있으므로 앞 2n행의 판정 기록이 n개다. 600명의 1%는 6명
  assert.equal(py(HUMAN, sessionArgs(out, limited(6))).code, 0);
  assert.equal(readFileSync(join(out, 'human_sessions.csv'), 'utf8').split('\n').filter((l) => l.endsWith(',judge,,1,human,')).length, 6, '빈 값은 빈 칸으로 남긴다');
  const root = newRoot();
  assert.equal(ledgerRun(root, out, 'six').code, 0);
  const e = manifestOf(root, 'six').k6_eval;
  assert.equal(e.behavior_only.missing, 6);
  assert.equal(e.plan_verdict, 'PASS');
  assert.equal(py(HUMAN, sessionArgs(out, limited(7))).code, 0);
  assert.equal(ledgerRun(root, out, 'seven', ['--remeasure-reason', 'x']).code, 0);
  const e7 = manifestOf(root, 'seven').k6_eval;
  assert.equal(e7.plan_verdict, 'UNMEASURABLE');
  assert.deepEqual(e7.behavior_only.unmeasurable_reasons, ['missing_values']);
  assert.equal(e7.behavior_only.missing, 7);
  assert.deepEqual(e7.humans, []);
});

test('V-T45 ⑩ (H1): 키가 하나뿐인 첫 문장은 점수가 있어도 값 없음으로 세고, 전부 그러면 UNMEASURABLE이다', () => {
  const { dir } = fixture();
  const z = makeZip(dir, 'onekey.zip', fixtureFiles((p) => participantFile(p, 1000000, [0])));
  const { out } = converted(z);
  const first = jsonl(join(out, 'judge.jsonl')).find((r) => r.role === 'judge');
  assert.deepEqual(first.summary, { v: 1, windowMs: 0 });
  assert.equal(py(HUMAN, sessionArgs(out, write(out, 's.csv', scoresFor(out, () => '0.1')))).code, 0);
  const root = newRoot();
  assert.equal(ledgerRun(root, out, 'k').code, 0);
  const e = manifestOf(root, 'k').k6_eval;
  assert.equal(e.behavior_only.missing, 600);
  assert.equal(e.plan_verdict, 'UNMEASURABLE');
  assert.deepEqual(e.behavior_only.unmeasurable_reasons, ['missing_values', 'no_values']);
});

test('V-T45 ⑪ (H2): 같은 출력 폴더에 다시 변환하면 거부하고 먼저 쓴 등록 파일을 그대로 둔다', () => {
  const { dir, zip, out } = converted();
  const before = readFileSync(join(out, 'registration.json'));
  const r = py(HUMAN, convertArgs(zip, out, dir, ['--behavior-rule', ruleFile(dir, { ...RULE, decision_threshold: 1.5 })]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /이미 있다/);
  assert.deepEqual(readFileSync(join(out, 'registration.json')), before);
});

test('V-T45 ⑫ (M2): sessions는 판정 사람이 등록과 다르면 거부하고, verify는 원본에서 다시 계산해 맞는지·바꿔치기를 찾는다', () => {
  const { zip, out } = converted();
  const js = jsonl(join(out, 'judge.jsonl'));
  const tn = jsonl(join(out, 'tune.jsonl'));
  const victim = js[0].person;
  const donor = tn[0].person;
  const edited = [...js.filter((r) => r.person !== victim), ...tn.filter((r) => r.person === donor).map((r, i) => ({ ...r, role: i === 0 ? 'judge' : 'ref' }))];
  const records = write(out, 'edited.jsonl', edited.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const scores = write(out, 'e.csv', ['person,session,behavior_risk', ...edited.map((r) => [r.person, r.session, '0.1'].join(','))].join('\n') + '\n');
  const r = py(HUMAN, sessionArgs(out, scores, { records, outDir: tmp('x-') }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /사람 목록/);
  const verifyArgs = (judge) => ['verify', '--registration', join(out, 'registration.json'), '--judge', judge, '--tune', join(out, 'tune.jsonl'), '--source-file', zip];
  const ok = py(HUMAN, verifyArgs(join(out, 'judge.jsonl')));
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /verify OK/);
  const bad = py(HUMAN, verifyArgs(records));
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /사람 목록/);
  // 요약 값을 고치면 사람 목록이 같아도 원본 대조에서 걸린다
  const tampered = js.map((x, i) => (i === 0 ? { ...x, summary: { ...x.summary, windowMs: x.summary.windowMs + 1 } } : x));
  const t = write(out, 'tampered.jsonl', tampered.map((x) => JSON.stringify(x)).join('\n') + '\n');
  const res = py(HUMAN, verifyArgs(t));
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /원본/);
  assert.equal(JSON.parse(readFileSync(join(out, 'verify-result.json'), 'utf8')).result, 'fail', '실패도 결과 파일에 남는다');
  // sessions도 내용 해시로 같은 고침을 찾는다(사람 목록은 같다)
  const sc = write(out, 't.csv', ['person,session,behavior_risk', ...tampered.map((x) => [x.person, x.session, '0.1'].join(','))].join('\n') + '\n');
  const changed = py(HUMAN, sessionArgs(out, sc, { records: t, outDir: tmp('x-') }));
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /내용/);
  const noSource = py(HUMAN, ['verify', '--registration', join(out, 'registration.json'), '--judge', join(out, 'judge.jsonl'), '--tune', join(out, 'tune.jsonl')]);
  assert.equal(noSource.code, 0, noSource.out);
  assert.equal(JSON.parse(readFileSync(join(out, 'verify-result.json'), 'utf8')).source_file_checked, false);
});

test('V-T45 ⑬ (M5): 저장소 밖 검사는 대상의 모든 상위 폴더에서 .git을 찾는다', () => {
  const { dir, zip } = fixture();
  const other = tmp('other-repo-');
  git(other, ['init', '-q']);
  const deep = join(other, 'a', 'b', 'not-yet');
  const r = py(HUMAN, convertArgs(zip, deep, dir));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Git 저장소 안/);
  assert.equal(existsSync(deep), false);
});

test('V-T45 ⑭ (M6): 칸 수가 머리글과 다른 행은 버리고 그 수를 보고서에 적는다', () => {
  const { dir } = fixture();
  const shifted = (p) => {
    const lines = participantFile(p).trimEnd().split('\n');
    lines.push(fileRow(p, p * 10 + 1, 99, 1000000 + 50, 'has\ttab'));
    return lines.join('\n') + '\n';
  };
  const z = makeZip(dir, 'tabbed.zip', fixtureFiles(shifted));
  const { out } = converted(z);
  const first = jsonl(join(out, 'judge.jsonl')).find((r) => r.role === 'judge');
  assert.deepEqual(first.summary, { v: 1, windowMs: 600, inputIntervalMeanMs: 200, inputIntervalStdMs: 81.6 }, '탭이 낀 행의 시각은 쓰지 않는다');
  const rep = JSON.parse(readFileSync(join(out, 'conversion-report.json'), 'utf8'));
  assert.equal(rep.dropped_rows, 641, '640명의 탭 행과 쓸 수 없는 사람의 행 하나');
});

test('V-T45 ⑮ (M7): 공개 자료에 채워지는 칸만의 최대 위험 값으로 측정 무의미를 판단하고, 그 값 위의 점수는 범위 밖이다', () => {
  const { dir, zip } = fixture();
  const out = tmp('human-data-out-');
  const low = ruleFile(tmp('rule-'), { ...RULE, public_max_risk: 0.5 });
  const r = py(HUMAN, convertArgs(zip, out, dir, ['--behavior-rule', low]));
  assert.equal(r.code, 0, r.out);
  zipOf.set(out, zip);
  assert.match(py(HUMAN, sessionArgs(out, write(out, 'high.csv', scoresFor(out, () => '0.7')), { outDir: tmp('x-') })).out, /범위/);
  assert.equal(py(HUMAN, sessionArgs(out, write(out, 's.csv', scoresFor(out, () => '0.1')))).code, 0);
  const root = newRoot();
  assert.equal(ledgerRun(root, out, 'k').code, 0);
  const e = manifestOf(root, 'k').k6_eval;
  assert.equal(e.plan_verdict, 'UNMEASURABLE', '0.4271 × 0.5 = 0.2136 < 기준 0.30685');
  assert.deepEqual(e.behavior_only.unmeasurable_reasons, ['ceiling']);
});

test('[ASVS v5.0.0-5.2.3] V-T45 ⑯ (M8): 압축을 풀기 전에 풀린 크기·파일 수·행 수 상한을 확인하고 넘으면 아무것도 쓰지 않는다', () => {
  const { dir, zip } = fixture();
  const check = (args, expect) => {
    const out = tmp('x-');
    const r = py(HUMAN, convertArgs(args.zip ?? zip, out, dir, args.over ?? []));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, expect);
    assert.deepEqual(readdirSync(out), []);
  };
  check({ over: ['--max-zip-files', '5'] }, /파일 수/);
  check({ over: ['--max-zip-bytes', '1000'] }, /풀린 크기/);
  check({ zip: makeZip(dir, 'hugereadme.zip', [['readme.txt', 'x'.repeat(2 * 1024 * 1024)], ...fixtureFiles().slice(1)]) }, /readme/);
  check({ over: ['--max-rows', '3'] }, /행 수/);
  // 행 길이 상한을 넘는 행은 읽지 않고 버린다
  const long = (p) => participantFile(p).trimEnd() + `\n${fileRow(p, p * 10 + 1, 98, 1000000 + 50, 'y'.repeat(70000))}\n`;
  const lz = makeZip(dir, 'longline.zip', fixtureFiles(long));
  const { out } = converted(lz);
  assert.equal(JSON.parse(readFileSync(join(out, 'conversion-report.json'), 'utf8')).dropped_rows, 641);
  // 메타데이터에도 행 길이·행 수 상한을 둔다
  const longMeta = ['metadata_participants.txt', `PARTICIPANT_ID\tAGE\n101\t67${'0'.repeat(70000)}\n102\t25\n`];
  const mz = makeZip(dir, 'longmeta.zip', fixtureFiles().map((f) => (f[0] === META[0] ? longMeta : f)));
  const m = converted(mz);
  assert.equal([...jsonl(join(m.out, 'judge.jsonl')), ...jsonl(join(m.out, 'tune.jsonl'))].find((r) => r.person === '101').stratum, '', '길이 상한을 넘는 메타데이터 행은 쓰지 않는다');
  check({ over: ['--max-metadata-rows', '1'] }, /메타데이터의 행 수/);
});

test('V-T45 ⑰ (낮음): 손상된 zip은 추적 출력 없이 거부하고 아무것도 쓰지 않는다', () => {
  const { dir, zip } = fixture();
  const raw = readFileSync(zip);
  const name = 'files/101_keystrokes.txt';
  const at = raw.indexOf(Buffer.from(name));
  for (let i = 8; i < 200; i += 3) raw[at + name.length + i] ^= 0xff;
  // 중앙 목록의 같은 이름이 아니라 앞쪽 지역 머리글 뒤의 압축 본문을 망가뜨린다
  const bad = write(dir, 'bad.zip', raw);
  const out = tmp('x-');
  const r = py(HUMAN, ['convert-aalto', '--zip', bad, '--out-dir', out, '--plan', '600:0', '--tune-n', '40', '--split-seed', '11', '--draw-seed', '22', '--registration-id', 'x', '--behavior-rule', ruleFile(dir)]);
  assert.equal(r.code, 1, r.out);
  assert.equal(r.out.includes('Traceback'), false, r.out);
  assert.deepEqual(readdirSync(out), []);
});

test('V-T45 ⑱ (재검토 낮음): 암호 걸린 zip과 지원하지 않는 압축 방식은 추적 출력 없이 거부한다', () => {
  const { dir, zip } = fixture();
  const CENTRAL = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const patched = (edit) => {
    const raw = readFileSync(zip);
    for (let at = raw.indexOf(CENTRAL); at >= 0; at = raw.indexOf(CENTRAL, at + 4)) edit(raw, at);
    return raw;
  };
  const encrypted = write(dir, 'encrypted.zip', patched((raw, at) => { raw[at + 8] |= 1; }));
  const unsupported = write(dir, 'method.zip', patched((raw, at) => { raw[at + 10] = 99; raw[at + 11] = 0; }));
  for (const bad of [encrypted, unsupported]) {
    const out = tmp('x-');
    const r = py(HUMAN, convertArgs(bad, out, dir));
    assert.equal(r.code, 1, r.out);
    assert.equal(r.out.includes('Traceback'), false, r.out);
    assert.deepEqual(readdirSync(out), []);
  }
});
