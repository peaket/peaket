// 배포 기록과 DORA 5종 산출 시험(D-T53 ①~④, 기능 F-01-6, OPS-120). 계획 docs/review/plans/F-01-6.md §3 'DORA 산출'·'GitHub에서 읽기'·§5·§6.
// 정본: docs/devops.md §13 표(:879~885)·'포트폴리오 기간의 정의'(:890)·'산출의 첫 구현'(:893~902), D-T53(:961), docs/devops.md §13 '데모 환경 기준'(:889).
// 기대값은 시험이 정의대로 손으로 센 수다(도구의 상수를 가져오지 않는다). 가짜는 GitHub API(이 프로세스의 node:http)뿐이고 실제 GitHub는 부르지 않는다.
// CLI는 자식 프로세스로 돌린다(가짜 API가 같은 프로세스에서 답하므로 비동기 spawn을 쓴다).
// 실행(저장소 뿌리): node --test tools/ci/dora.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';
import { tempDir } from './git-fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'dora.mjs');

// 도구 모듈은 시험마다 늦게 읽는다(없으면 그 시험만 실패한다)
const dora = () => import('./dora.mjs');

// ── 정본 값 ──
// 한 주는 월요일 00:00 KST부터 7일(devops.md:895). 2026-11-16은 월요일이다
const WEEK = '2026-11-16';
const WEEK_START = Date.parse('2026-11-16T00:00:00+09:00');
const WEEK_END = Date.parse('2026-11-23T00:00:00+09:00');
const DEMO_BASIS = '데모 환경 기준'; // devops.md:889·:902
const PROD_BASIS = '운영 기준'; // devops.md:889(운영 배포가 생기면 운영 기준), 계획 §5 DoraReport.basis
const NO_DATA = '자료 없음'; // devops.md:901

const iso = (kst) => new Date(Date.parse(kst)).toISOString();
const sha = (name) => createHash('sha1').update(name).digest('hex');

// ── 한 주의 기록(D-T53 ①) ──
// 서비스 둘(purchase-svc·queue-svc). 시각은 KST로 적고 ISO(UTC)로 바꾼다.
// D0 purchase v1.3.0: 주 전 성공(비교 기준만)
// D7 queue v1.3.9: 주 시작 1밀리초 전 성공 → 세지 않는다
// D1 purchase v1.4.0: 성공 11-17 10:00, PR 셋(첫 커밋 11-15 10:00 / 11-16 09:00 / 11-17 04:00 → 48·25·6시간)
// D2 queue v1.4.0: 성공 11-18 08:00(그 뒤 성공 한 번 더 받음 — 한 번만 센다), PR 둘(11-17 20:00 / 22:00 → 12·10시간)
// D3 purchase v1.4.1: 실패 11-19 12:00 → 같은 서비스의 다음 성공 D8(11-23 00:00, 다음 주)까지 84시간. 회복이 다음 주여도 이 주에 센다
// D6 queue v1.4.0-hotfix.1(hotfix): 성공 11-20 10:00, PR 하나(11-19 20:00 → 14시간)
// D5 queue v1.4.1: 실패 11-21 15:00, 그 뒤 queue 성공 없음 → 미회복 1
// D8 purchase v1.4.2: 성공이 주 끝(11-23 00:00 KST) 바로 그 시각 → 세지 않는다
// D9 prod/purchase-svc: 운영 배포 → 데모 기준에서 세지 않는다
const DEPLOYS = [
  { key: 'D0', id: 5000, environment: 'demo/purchase-svc', tag: 'v1.3.0', hotfix: false, prs: [], statuses: [['success', '2026-11-10T10:00:00+09:00']], ref: 'p130', created: '2026-11-10T09:55:00+09:00' },
  { key: 'D7', id: 5001, environment: 'demo/queue-svc', tag: 'v1.3.9', hotfix: false, prs: [], statuses: [['success', '2026-11-15T23:59:59.999+09:00']], ref: 'p139', created: '2026-11-15T23:55:00+09:00' },
  {
    key: 'D1',
    id: 5002,
    environment: 'demo/purchase-svc',
    tag: 'v1.4.0',
    hotfix: false,
    prs: [
      [101, '2026-11-15T10:00:00+09:00'],
      [102, '2026-11-16T09:00:00+09:00'],
      [103, '2026-11-17T04:00:00+09:00'],
    ],
    // GitHub는 새것부터 준다. success·failure 밖의 상태는 무시한다
    statuses: [
      ['inactive', '2026-11-19T12:00:00+09:00'],
      ['success', '2026-11-17T10:00:00+09:00'],
      ['in_progress', '2026-11-17T09:50:00+09:00'],
    ],
    ref: 'p140',
    created: '2026-11-17T09:45:00+09:00',
  },
  {
    key: 'D2',
    id: 5003,
    environment: 'demo/queue-svc',
    tag: 'v1.4.0',
    hotfix: false,
    prs: [
      [104, '2026-11-17T20:00:00+09:00'],
      [108, '2026-11-17T22:00:00+09:00'],
    ],
    statuses: [
      ['success', '2026-11-18T09:00:00+09:00'],
      ['success', '2026-11-18T08:00:00+09:00'],
      ['pending', '2026-11-18T07:58:00+09:00'],
    ],
    ref: 'p140',
    created: '2026-11-18T07:55:00+09:00',
  },
  { key: 'D9', id: 5004, environment: 'prod/purchase-svc', tag: 'v1.4.0', hotfix: false, prs: [[101, '2026-11-15T10:00:00+09:00']], statuses: [['success', '2026-11-18T14:00:00+09:00']], ref: 'p140prod', created: '2026-11-18T13:55:00+09:00' },
  { key: 'D3', id: 5005, environment: 'demo/purchase-svc', tag: 'v1.4.1', hotfix: false, prs: [[105, '2026-11-18T09:00:00+09:00']], statuses: [['failure', '2026-11-19T12:00:00+09:00']], ref: 'p141', created: '2026-11-19T11:55:00+09:00' },
  { key: 'D6', id: 5006, environment: 'demo/queue-svc', tag: 'v1.4.0-hotfix.1', hotfix: true, prs: [[106, '2026-11-19T20:00:00+09:00']], statuses: [['success', '2026-11-20T10:00:00+09:00']], ref: 'p140h', created: '2026-11-20T09:55:00+09:00' },
  { key: 'D5', id: 5007, environment: 'demo/queue-svc', tag: 'v1.4.1', hotfix: false, prs: [[105, '2026-11-18T09:00:00+09:00']], statuses: [['failure', '2026-11-21T15:00:00+09:00']], ref: 'p141q', created: '2026-11-21T14:55:00+09:00' },
  { key: 'D8', id: 5008, environment: 'demo/purchase-svc', tag: 'v1.4.2', hotfix: false, prs: [[109, '2026-11-21T09:00:00+09:00']], statuses: [['success', '2026-11-23T00:00:00.000+09:00']], ref: 'p142', created: '2026-11-22T23:55:00+09:00' },
];

/** 계획 §5 DoraRecords 꼴 */
const records = (list = DEPLOYS) => ({
  deployments: list.map((d) => ({
    id: d.id,
    environment: d.environment,
    tag: d.tag,
    hotfix: d.hotfix,
    prs: d.prs.map(([number, at]) => ({ number, firstCommitAt: iso(at) })),
    statuses: d.statuses.map(([state, at]) => ({ state, createdAt: iso(at) })),
  })),
});

// 손으로 센 값(devops.md:896~901)
const EXPECTED = {
  'purchase-svc': { deploymentCount: 1, leadTimeHours: 25, changeFailureRate: 1 / 2, restoreHours: 84, unrecovered: 0, reworkRate: 0 },
  'queue-svc': { deploymentCount: 2, leadTimeHours: 12, changeFailureRate: 1 / 3, restoreHours: null, unrecovered: 1, reworkRate: 1 / 3 },
  // 전체: 배포 다섯(성공 셋·실패 둘), 리드타임 여섯 값 6·10·12·14·25·48의 가운데 둘 평균 13
  all: { deploymentCount: 3, leadTimeHours: 13, changeFailureRate: 2 / 5, restoreHours: 84, unrecovered: 1, reworkRate: 1 / 5 },
};
const EMPTY = { deploymentCount: 0, leadTimeHours: null, changeFailureRate: null, restoreHours: null, unrecovered: 0, reworkRate: null };

/** 비율·시간은 소수 둘째 자리 반올림을 허용해 견준다. null은 null이어야 한다 */
function assertMetrics(got, want, where) {
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${where}: 칸`);
  for (const [k, v] of Object.entries(want)) {
    if (v === null) assert.equal(got[k], null, `${where}.${k}는 자료 없음(null)`);
    else if (k === 'deploymentCount' || k === 'unrecovered') assert.equal(got[k], v, `${where}.${k}`);
    else {
      assert.equal(typeof got[k], 'number', `${where}.${k}는 수`);
      assert.ok(Math.abs(got[k] - v) <= 0.005, `${where}.${k}: ${got[k]} ≠ ${v}`);
    }
  }
}

test('D-T53 ① 한 주의 기록에서 다섯 값이 정의대로 나온다', async () => {
  const { computeDora } = await dora();
  const r = computeDora(records(), { week: WEEK });
  assert.equal(r.basis, DEMO_BASIS);
  assert.equal(Date.parse(r.week.start), WEEK_START);
  assert.equal(Date.parse(r.week.end), WEEK_END);
  assert.deepEqual(Object.keys(r.services).sort(), ['purchase-svc', 'queue-svc']);
  assertMetrics(r.services['purchase-svc'], EXPECTED['purchase-svc'], 'purchase-svc');
  assertMetrics(r.services['queue-svc'], EXPECTED['queue-svc'], 'queue-svc');
  assertMetrics(r.all, EXPECTED.all, 'all');

  // 기록 차례를 바꿔도 같다(상태·배포 차례에 기대지 않는다)
  const shuffled = records([...DEPLOYS].reverse().map((d) => ({ ...d, statuses: [...d.statuses].reverse() })));
  assert.deepEqual(computeDora(shuffled, { week: WEEK }), r);

  // 경계: 주 끝 1밀리초 전의 성공은 이 주에 센다(바로 그 시각은 세지 않았다)
  const edge = DEPLOYS.map((d) => (d.key === 'D8' ? { ...d, statuses: [['success', '2026-11-22T23:59:59.999+09:00']] } : d));
  const e = computeDora(records(edge), { week: WEEK });
  assert.equal(e.services['purchase-svc'].deploymentCount, 2);
  // 그때 D3의 회복은 주 안의 D8이다(84시간 − 1밀리초)
  assert.ok(Math.abs(e.services['purchase-svc'].restoreHours - 84) <= 0.005);

  // 월요일이 아닌 주는 받지 않는다
  assert.throws(() => computeDora(records(), { week: '2026-11-17' }));
  assert.throws(() => computeDora(records(), { week: '2026-11-15' }));
});

test('D-T53 ② 배포가 없으면 0이 아니라 자료 없음이고 운영 배포는 세지 않는다', async () => {
  const { computeDora, renderMarkdown } = await dora();
  const empty = computeDora({ deployments: [] }, { week: WEEK });
  assert.equal(empty.basis, DEMO_BASIS);
  assert.deepEqual(empty.services, {});
  assertMetrics(empty.all, EMPTY, 'all');
  const md = renderMarkdown(empty);
  assert.ok(md.includes(NO_DATA), '보고에 자료 없음');
  // 머리 줄에 기준을 적는다
  const head = md.split('\n').find((l) => l.trim() !== '');
  assert.ok(head.includes(DEMO_BASIS), `보고 머리에 ${DEMO_BASIS}: ${head}`);
  for (const bad of ['0%', 'NaN', 'null', 'undefined', 'Infinity']) assert.ok(!md.includes(bad), `보고에 ${bad}가 있다`);

  // 운영 배포만 있는 주: 기본(데모) 기준에서는 빈 주와 같다
  const prodOnly = records(DEPLOYS.filter((d) => d.key === 'D9'));
  const p = computeDora(prodOnly, { week: WEEK });
  assert.deepEqual(p.services, {});
  assertMetrics(p.all, EMPTY, 'all(운영만)');
  assert.ok(renderMarkdown(p).includes(NO_DATA));

  // 운영 기준으로 고르면 그 배포를 세고 머리가 운영 기준이다(두 기준을 섞지 않는다)
  const asProd = computeDora(prodOnly, { week: WEEK, environment: 'prod' });
  assert.equal(asProd.basis, PROD_BASIS);
  assert.equal(asProd.all.deploymentCount, 1);
  assert.ok(renderMarkdown(asProd).split('\n').find((l) => l.trim() !== '').includes(PROD_BASIS));

  // 값이 있는 보고에는 그 수가 나온다(빈 보고만 그리는 결함을 잡는다)
  const full = renderMarkdown(computeDora(records(), { week: WEEK }));
  assert.ok(full.includes(DEMO_BASIS));
  assert.ok(full.includes('purchase-svc') && full.includes('queue-svc'));
  assert.match(full, /\b84(\.0+)?\b/, '회복 시간 84');
  assert.match(full, /\b13(\.0+)?\b/, '전체 리드타임 13');
});

// ── 가짜 GitHub API(D-T53 ③). 계획 §5 fetchDoraRecords가 부르는 경로만 흉내 낸다 ──
const OWNER_REPO = 'peaket-test/peaket';
const API_TOKEN = 'dora-fake-token-51c3';
const pr = (number, title, head, base, merged = true) => ({ number, title, head: { ref: head }, base: { ref: base }, merged_at: merged ? '2026-11-14T00:00:00Z' : null, state: 'closed' });
const PROMOTE_PR = { p130: 900, p139: 901, p140: 902, p141: 903, p140h: 904, p141q: 905, p142: 906 };
const TAG_PR = {
  'v1.3.0': pr(910, 'release: v1.3.0', 'release/v1.3.0', 'main'),
  'v1.3.9': pr(911, 'release: v1.3.9', 'release/v1.3.9', 'main'),
  'v1.4.0': pr(912, 'release: v1.4.0', 'release/v1.4.0', 'main'),
  'v1.4.1': pr(913, 'release: v1.4.1', 'release/v1.4.1', 'main'),
  'v1.4.0-hotfix.1': pr(914, 'hotfix: v1.4.0-hotfix.1', 'hotfix/v1.4.0-hotfix.1', 'main'),
  'v1.4.2': pr(915, 'release: v1.4.2', 'release/v1.4.2', 'main'),
};
// 코드 커밋 → 그 커밋의 PR(develop에 병합된 코드 PR, 승격 PR, 병합 안 된 PR, main 쪽 PR이 섞인다)
const CODE_PR = {
  c101a: [pr(101, 'feat(purchase-svc): a', 'feature/a', 'develop')],
  c101b: [pr(101, 'feat(purchase-svc): a', 'feature/a', 'develop')],
  c102: [pr(102, 'feat(purchase-svc): b', 'feature/b', 'develop')],
  c103: [pr(103, 'fix(purchase-svc): c', 'fix/c', 'develop')],
  cPromote130: [pr(900, 'chore(promote): demo v1.3.0', 'promote/demo-v1.3.0', 'develop')],
  cAbandoned: [pr(960, 'feat: abandoned', 'feature/abandoned', 'develop', false)],
  cMainOnly: [pr(961, 'chore: main only', 'chore/main', 'main')],
  c104: [pr(104, 'feat(queue-svc): d', 'feature/d', 'develop')],
  c108: [pr(108, 'feat(queue-svc): e', 'feature/e', 'develop')],
  c105: [pr(105, 'feat: f', 'feature/f', 'develop')],
  c106: [pr(106, 'fix(queue-svc): 회복', 'fix/queue-recover', 'develop')],
  c109: [pr(109, 'feat(purchase-svc): g', 'feature/g', 'develop')],
};
const tagSha = (tag) => sha(`tag:${tag}`);
const COMPARE = {
  'v1.3.0...v1.4.0': ['c101a', 'c101b', 'c102', 'c103', 'cPromote130', 'cAbandoned', 'cMainOnly'],
  'v1.3.9...v1.4.0': ['c104', 'c108'],
  'v1.4.0...v1.4.1': ['c105'],
  'v1.4.0...v1.4.0-hotfix.1': ['c106'],
  'v1.4.0-hotfix.1...v1.4.1': ['c105'],
  'v1.4.1...v1.4.2': ['c109'],
};
const PR_COMMITS = {
  101: ['2026-11-15T10:00:00+09:00', '2026-11-15T14:00:00+09:00'],
  102: ['2026-11-16T09:00:00+09:00'],
  103: ['2026-11-17T04:00:00+09:00', '2026-11-17T05:00:00+09:00'],
  104: ['2026-11-17T20:00:00+09:00'],
  108: ['2026-11-17T22:00:00+09:00', '2026-11-17T22:30:00+09:00'],
  105: ['2026-11-18T09:00:00+09:00'],
  106: ['2026-11-19T20:00:00+09:00'],
  109: ['2026-11-21T09:00:00+09:00'],
};

/** 배포 목록: 데모 배포가 두 쪽에 걸치게 다른 환경 배포 100개를 사이에 넣는다(새것부터) */
function deploymentList() {
  const real = DEPLOYS.map((d) => ({ id: d.id, sha: sha(d.ref), ref: sha(d.ref), task: 'deploy', environment: d.environment, created_at: iso(d.created), payload: {} }));
  const fillers = Array.from({ length: 100 }, (_, i) => ({ id: 7000 + i, sha: sha(`f${i}`), ref: sha(`f${i}`), task: 'deploy', environment: `staging/filler-${i}`, created_at: new Date(Date.parse('2026-11-19T10:00:00+09:00') - i * 1000).toISOString(), payload: {} }));
  return [...real, ...fillers].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

async function fakeGitHub({ failStatuses = false } = {}) {
  const requests = [];
  const deployments = deploymentList();
  const byRefPulls = new Map();
  for (const d of DEPLOYS) {
    const prs = [pr(PROMOTE_PR[d.ref] ?? 999, `chore(promote): ${d.environment.split('/')[0]} ${d.tag}`, `promote/${d.ref}`, 'develop')];
    // 승격 커밋에 다른 PR이 함께 걸린 판(제목으로 승격 PR을 골라야 한다)
    if (d.ref === 'p140') prs.unshift(pr(950, 'feat: unrelated', 'feature/unrelated', 'develop'));
    byRefPulls.set(sha(d.ref), prs);
  }
  for (const [tag, p] of Object.entries(TAG_PR)) {
    byRefPulls.set(tagSha(tag), [p]);
    byRefPulls.set(tag, [p]);
  }
  for (const [c, prs] of Object.entries(CODE_PR)) byRefPulls.set(sha(c), prs);

  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://fake');
    requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), authorization: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${API_TOKEN}` && req.headers.authorization !== `token ${API_TOKEN}`) return send(401, { message: 'Bad credentials' });
    const base = `/repos/${OWNER_REPO}`;
    if (!u.pathname.startsWith(`${base}/`)) return send(404, { message: 'Not Found' });
    const rest = u.pathname.slice(base.length);
    const perPage = Math.min(Number(u.searchParams.get('per_page') ?? 30), 100);
    const page = Number(u.searchParams.get('page') ?? 1);
    const pageOf = (list) => list.slice((page - 1) * perPage, page * perPage);
    let m;
    if (rest === '/deployments') return send(200, pageOf(deployments));
    if ((m = /^\/deployments\/(\d+)\/statuses$/.exec(rest))) {
      if (failStatuses) return send(500, { message: 'fake failure' });
      const d = DEPLOYS.find((x) => x.id === Number(m[1]));
      if (!d) return send(404, { message: 'Not Found' });
      return send(200, pageOf(d.statuses.map(([state, at], i) => ({ id: d.id * 10 + i, state, created_at: iso(at), environment: d.environment }))));
    }
    if ((m = /^\/commits\/([^/]+)\/pulls$/.exec(rest))) {
      const prs = byRefPulls.get(decodeURIComponent(m[1]));
      return prs ? send(200, prs) : send(422, { message: 'No commit found for SHA' });
    }
    if ((m = /^\/compare\/(.+)$/.exec(rest))) {
      const key = decodeURIComponent(m[1]);
      const commits = COMPARE[key];
      if (!commits) return send(404, { message: 'Not Found' });
      const head = key.split('...')[1];
      return send(200, { status: 'ahead', total_commits: commits.length + 1, commits: [...commits.map((c) => ({ sha: sha(c), commit: { message: c } })), { sha: tagSha(head), commit: { message: `tag ${head}` } }] });
    }
    if ((m = /^\/pulls\/(\d+)\/commits$/.exec(rest))) {
      const dates = PR_COMMITS[Number(m[1])];
      if (!dates) return send(404, { message: 'Not Found' });
      return send(200, pageOf(dates.map((at, i) => ({ sha: sha(`pr${m[1]}-${i}`), commit: { author: { date: iso(at) }, committer: { date: iso(at) } } }))));
    }
    return send(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) };
}

/** CLI를 자식 프로세스로 돌린다(같은 프로세스의 가짜 API가 답할 수 있게 비동기) */
function run(args, env = {}) {
  return new Promise((done) => {
    // 기본 API 주소는 닫힌 로컬 포트다: 인자 검사를 빠뜨린 도구가 실제 GitHub를 부르지 않게 한다
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: REPO, env: { ...process.env, GITHUB_API_URL: 'http://127.0.0.1:9', GITHUB_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('D-T53 ③ GitHub에서 읽은 기록이 손으로 만든 기록과 같은 값을 낸다', async () => {
  const { computeDora, fetchDoraRecords } = await dora();
  const gh = await fakeGitHub();
  try {
    const fetched = await fetchDoraRecords({ repo: OWNER_REPO, apiUrl: gh.url, token: API_TOKEN });
    // 데모 배포만 남긴다
    assert.deepEqual(fetched.deployments.map((d) => d.environment).filter((e) => !e.startsWith('demo/')), []);
    assert.deepEqual(fetched.deployments.map((d) => d.id).sort(), DEPLOYS.filter((d) => d.environment.startsWith('demo/')).map((d) => d.id).sort());
    // 배포마다 태그·hotfix·처음 든 코드 PR(승격 PR·병합 안 된 PR·main 쪽 PR 제외, 한 PR은 한 번)
    const byId = Object.fromEntries(fetched.deployments.map((d) => [d.id, d]));
    for (const d of DEPLOYS.filter((x) => x.environment.startsWith('demo/'))) {
      const f = byId[d.id];
      assert.equal(f.tag, d.tag, `${d.key} 태그`);
      assert.equal(f.hotfix, d.hotfix, `${d.key} hotfix`);
      assert.deepEqual(
        f.prs.map((p) => [p.number, Date.parse(p.firstCommitAt)]).sort((a, b) => a[0] - b[0]),
        d.prs.map(([n, at]) => [n, Date.parse(at)]).sort((a, b) => a[0] - b[0]),
        `${d.key} PR`,
      );
    }
    // 값이 손으로 만든 기록과 같다
    const fromGitHub = computeDora(fetched, { week: WEEK });
    assert.deepEqual(fromGitHub, computeDora(records(), { week: WEEK }));
    assertMetrics(fromGitHub.all, EXPECTED.all, 'all(GitHub)');
    // 배포 목록을 두 쪽 끝까지, 쪽 크기 100으로 읽었다
    const pages = gh.requests.filter((r) => r.path.endsWith('/deployments')).map((r) => [r.query.per_page, r.query.page ?? '1']);
    assert.deepEqual(pages.slice(0, 2), [
      ['100', '1'],
      ['100', '2'],
    ]);
    // 토큰을 실었다(가짜는 토큰 없는 요청을 401로 답한다)
    assert.ok(gh.requests.every((r) => r.authorization?.endsWith(API_TOKEN)));
    // 다른 환경 배포의 상태는 읽지 않는다
    assert.deepEqual(gh.requests.filter((r) => /\/deployments\/7\d{3}\/statuses$/.test(r.path)), []);

    // CLI: --from-github가 --out 폴더에 두 파일을 쓴다
    const out = tempDir('dora-out-');
    const ok = await run(['--from-github', '--repo', OWNER_REPO, '--week', WEEK, '--out', out], { GITHUB_API_URL: gh.url, GITHUB_TOKEN: API_TOKEN });
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(readdirSync(out).sort(), [`dora-${WEEK}.json`, `dora-${WEEK}.md`]);
    const json = JSON.parse(readFileSync(join(out, `dora-${WEEK}.json`), 'utf8'));
    assert.equal(json.basis, DEMO_BASIS);
    assert.deepEqual(json.all, fromGitHub.all);
    assert.deepEqual(json.services, fromGitHub.services);
    assert.ok(readFileSync(join(out, `dora-${WEEK}.md`), 'utf8').includes(DEMO_BASIS));
  } finally {
    await gh.close();
  }

  // API가 실패하면 끝 코드 2이고 보고 파일을 쓰지 않는다
  const broken = await fakeGitHub({ failStatuses: true });
  try {
    await assert.rejects(fetchDoraRecords({ repo: OWNER_REPO, apiUrl: broken.url, token: API_TOKEN }));
    const out = tempDir('dora-out-fail-');
    const r = await run(['--from-github', '--repo', OWNER_REPO, '--week', WEEK, '--out', out], { GITHUB_API_URL: broken.url, GITHUB_TOKEN: API_TOKEN });
    assert.equal(r.code, 2, r.stderr);
    assert.deepEqual(readdirSync(out), []);
    assert.ok(broken.requests.some((x) => /\/statuses$/.test(x.path)), '실패한 경로까지 읽었다');
  } finally {
    await broken.close();
  }
});

test('D-T53 ③ CLI는 기록 파일을 읽고 인자가 틀리면 2로 끝난다', async () => {
  const { computeDora, renderMarkdown } = await dora();
  const dir = tempDir('dora-input-');
  const input = join(dir, 'records.json');
  writeFileSync(input, JSON.stringify(records()));

  // --out이 없으면 표준 출력에 Markdown
  const md = await run(['--input', input, '--week', WEEK]);
  assert.equal(md.code, 0, md.stderr);
  assert.equal(md.stdout.trim(), renderMarkdown(computeDora(records(), { week: WEEK })).trim());

  // 인자 오류: 월요일이 아닌 주, 읽을 곳 없음, 없는 기록 파일 → 2, 파일 없음
  const out = join(dir, 'out');
  mkdirSync(out);
  for (const args of [
    ['--input', input, '--week', '2026-11-18', '--out', out],
    ['--week', WEEK, '--out', out],
    ['--input', join(dir, 'missing.json'), '--week', WEEK, '--out', out],
    ['--from-github', '--week', WEEK, '--out', out],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.deepEqual(readdirSync(out), []);
});

// ── 배포 기록 설정·워크플로(D-T53 ④) ──
const NOTIFICATIONS = join(REPO, 'deploy', 'platform', 'argocd', 'notifications.yaml');
const APPSETS = join(REPO, 'deploy', 'projects', 'applicationsets.yaml');
const WORKFLOW = join(REPO, '.github', 'workflows', 'dora-weekly.yml');
const SUBSCRIBE = ['on-deployed', 'on-sync-failed', 'on-health-degraded'].map((t) => `notifications.argoproj.io/subscribe.${t}.github`);

test('D-T53 ④ 배포 기록 설정은 GitHub 배포 상태만 쓰고 데모·운영 앱이 구독한다', async () => {
  // ArgoCD 알림 설정(계획 §5 'ArgoCD 알림')
  assert.ok(existsSync(NOTIFICATIONS), 'deploy/platform/argocd/notifications.yaml이 없다');
  const cms = parseAllDocuments(readFileSync(NOTIFICATIONS, 'utf8'))
    .map((d) => d.toJS())
    .filter(Boolean);
  assert.equal(cms.length, 1);
  const cm = cms[0];
  assert.equal(cm.kind, 'ConfigMap');
  assert.equal(cm.metadata?.name, 'argocd-notifications-cm');
  assert.equal(cm.metadata?.namespace, 'argocd');
  const data = cm.data ?? {};
  // 알림 서비스는 GitHub 하나뿐(Grafana 주석·Slack 등 없음, devops.md:892)
  assert.deepEqual(Object.keys(data).filter((k) => k.startsWith('service.')), ['service.github']);
  // GitHub 앱 값은 비밀 참조($)만(secrets-and-keys.md GitHub 앱 개인 키(배포))
  const svc = parse(data['service.github']);
  for (const k of ['appID', 'installationID', 'privateKey']) assert.match(String(svc[k]), /^\$[A-Za-z0-9_.-]+$/, `service.github ${k}는 비밀 참조`);

  // 템플릿 둘: GitHub 배포 상태(success·failure), 환경 이름은 <환경>/<서비스>, ref는 동기화한 커밋
  const tpl = (name) => {
    assert.equal(typeof data[`template.${name}`], 'string', `template.${name}`);
    return parse(data[`template.${name}`]);
  };
  for (const [name, state] of [
    ['peaket-deploy-success', 'success'],
    ['peaket-deploy-failure', 'failure'],
  ]) {
    const t = tpl(name);
    assert.deepEqual(Object.keys(t).filter((k) => k !== 'message'), ['github'], `${name}는 GitHub만 쓴다`);
    const dep = t.github?.deployment;
    assert.ok(dep, `${name}: github.deployment`);
    assert.equal(dep.state, state);
    assert.match(String(dep.environment), /^\{\{\s*index\s+\.app\.metadata\.labels\s+"peaket\.io\/environment"\s*\}\}\/\{\{\s*\.app\.metadata\.name\s*\}\}$/);
    assert.match(String(dep.reference), /\.app\.status\.operationState\.syncResult\.revision/);
  }
  // 트리거 셋: 동기화가 끝나 건강하면 success, 동기화 실패·건강 나빠짐은 failure(devops.md:894)
  const sends = (trigger) => {
    assert.equal(typeof data[`trigger.${trigger}`], 'string', `trigger.${trigger}`);
    return parse(data[`trigger.${trigger}`]).flatMap((c) => c.send ?? []);
  };
  assert.deepEqual(sends('on-deployed'), ['peaket-deploy-success']);
  assert.deepEqual(sends('on-sync-failed'), ['peaket-deploy-failure']);
  assert.deepEqual(sends('on-health-degraded'), ['peaket-deploy-failure']);

  // 데모·운영 ApplicationSet의 앱이 트리거 셋을 구독하고, 로컬·CI·스테이징은 구독하지 않는다(DORA는 데모·운영 배포만 센다)
  const sets = Object.fromEntries(
    parseAllDocuments(readFileSync(APPSETS, 'utf8'))
      .map((d) => d.toJS())
      .filter((d) => d?.kind === 'ApplicationSet')
      .map((d) => [d.metadata.name, d.spec.template.metadata.annotations ?? {}]),
  );
  assert.deepEqual(Object.keys(sets).sort(), ['peaket-ci', 'peaket-demo', 'peaket-local', 'peaket-prod', 'peaket-staging']);
  for (const n of ['peaket-demo', 'peaket-prod']) for (const k of SUBSCRIBE) assert.equal(sets[n][k], '', `${n} ${k}`);
  for (const n of ['peaket-local', 'peaket-ci', 'peaket-staging']) assert.deepEqual(Object.keys(sets[n]).filter((k) => k.startsWith('notifications.argoproj.io/')), [], `${n}는 구독하지 않는다`);

  // 주간 워크플로: 권한은 읽기뿐, 산출 도구를 GitHub 읽기로 돌리고 작업 요약과 산출물을 남긴다(devops.md:902)
  assert.ok(existsSync(WORKFLOW), '.github/workflows/dora-weekly.yml이 없다');
  const wfText = readFileSync(WORKFLOW, 'utf8');
  const wf = parse(wfText);
  const perms = [wf.permissions, ...Object.values(wf.jobs ?? {}).map((j) => j.permissions)].filter((p) => p !== undefined);
  assert.ok(wf.permissions && typeof wf.permissions === 'object', '맨 위 permissions');
  for (const p of perms) {
    assert.equal(typeof p, 'object', `권한은 항목별로 적는다: ${JSON.stringify(p)}`);
    for (const [k, v] of Object.entries(p)) assert.ok(v === 'read' || v === 'none', `권한 ${k}: ${v}`);
  }
  assert.doesNotMatch(wfText, /\bwrite\b/);
  const steps = Object.values(wf.jobs ?? {}).flatMap((j) => j.steps ?? []);
  assert.ok(steps.some((s) => /tools\/ci\/dora\.mjs/.test(s.run ?? '') && /--from-github/.test(s.run ?? '')), 'dora.mjs --from-github을 돌린다');
  assert.ok(steps.some((s) => /GITHUB_STEP_SUMMARY/.test(s.run ?? '')), '작업 요약에 Markdown');
  assert.ok(steps.some((s) => /^actions\/upload-artifact@/.test(s.uses ?? '')), '산출물(JSON)을 남긴다');

  // 워크플로 검사(tools/ci/check-workflows.mjs)를 실제 저장소에서 통과한다
  const chk = await new Promise((done) => {
    const c = spawn(process.execPath, [join(HERE, 'check-workflows.mjs'), '.github/workflows/dora-weekly.yml'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    c.stdout.on('data', (d) => (text += d));
    c.stderr.on('data', (d) => (text += d));
    c.on('close', (code) => done({ code, text }));
  });
  assert.equal(chk.code, 0, chk.text);
});
