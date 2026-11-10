// vuln-deadline.mjs 시험(docs/devops.md §4.4 '취약점 조치 기한'·'조치 기한 판정'·'라이선스', docs/security/asvs/delivery.md 15.1.1·16.5.3,
// ADR-0259 결정 10, BUILD_ORDER BAS-010 ①). 실행: node --test "tools/ci/*.test.mjs"
// 이 PC에서는 pnpm이 막혀 있어 pnpm audit --json·pnpm licenses list --json 출력 모양의 고정 자료로 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { tempDir } from './git-fixture.mjs';
import { POLICY, evaluate, fixVersionOf, judgeLicenses, licenseAllowed, parseAudit, parseExceptions, parseLicenses } from './vuln-deadline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'vuln-deadline.mjs');
const REPO = resolve(here, '..', '..');
const YAML = await import('yaml').catch(() => null);

const GHSA = 'GHSA-aaaa-bbbb-cccc';
function advisory(o = {}) {
  return {
    id: 1100001,
    github_advisory_id: GHSA,
    module_name: 'left-pad',
    severity: 'high',
    title: '시험용 취약점',
    url: `https://github.com/advisories/${o.github_advisory_id ?? GHSA}`,
    vulnerable_versions: '<1.3.10',
    patched_versions: '>=1.3.10',
    cwe: ['CWE-79'],
    findings: [{ version: '1.3.9', paths: ['apps__web>left-pad'] }],
    ...o,
  };
}
function auditText(advisories, counts) {
  let c = counts;
  if (!c) {
    c = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
    for (const a of advisories) c[a.severity] += a.findings.length;
  }
  return JSON.stringify({
    actions: [],
    advisories: Object.fromEntries(advisories.map((a) => [String(a.id), a])),
    muted: [],
    metadata: { vulnerabilities: c, dependencies: 40, devDependencies: 10, optionalDependencies: 0, totalDependencies: 50 },
  });
}
const exceptionsText = (list) => JSON.stringify({ exceptions: list });
const exception = (o = {}) => ({ package: 'left-pad@1.3.9', advisory: GHSA, reason: '쓰는 함수가 없다(영향 분석), 입력 길이를 막는다(완화)', issue: 412, createdOn: '2026-11-10', expiresOn: '2026-12-10', ...o });
const kst = (s) => new Date(`${s}+09:00`);
// 수정본 공개일: 한국 시각 2026-10-01 12:00(UTC 03:00)
const FIX = { 'left-pad@1.3.10': '2026-10-01T03:00:00.000Z' };

function judge({ advisories = [advisory()], exceptions = [], now, policy, fixDates = FIX } = {}) {
  const findings = parseAudit(auditText(advisories));
  const today = now ?? kst('2026-11-10T09:00:00');
  return evaluate({ findings, exceptions: parseExceptions(exceptionsText(exceptions), { now: today, policy }), now: today, fixDates, policy });
}

test('[ASVS v5.0.0-15.1.1] 등급별 기한과 예외 만료를 센다(높음 30일 경계 양쪽, 만료일 당일·다음 날)', () => {
  assert.deepEqual(POLICY.days, { critical: 7, high: 30, moderate: 90 });
  assert.equal(POLICY.exceptionMaxDays, 30);
  const one = (sev, now) => judge({ advisories: [advisory({ severity: sev })], now }).findings[0];
  // 기한은 수정본 공개일(한국 날짜 10-01)부터: 치명 7일, 높음 30일, 중간 90일, 낮음은 분기 정기 갱신(날짜 기한 없음)
  assert.equal(one('critical').deadline, '2026-10-08');
  assert.equal(one('high').deadline, '2026-10-31');
  assert.equal(one('moderate').deadline, '2026-12-30');
  assert.equal(one('low').deadline, null);
  assert.equal(one('low').schedule, 'quarterly');
  // 높음 30일 경계: 10-31 끝까지는 기한 안, 11-01부터 넘김
  assert.equal(one('high', kst('2026-10-31T23:59:59')).overdue, false);
  assert.equal(one('high', kst('2026-10-31T23:59:59')).daysLeft, 0);
  assert.equal(one('high', kst('2026-11-01T00:00:00')).overdue, true);
  assert.equal(one('high', kst('2026-11-01T00:00:00')).daysLeft, -1);
  // 수정본 공개 시각은 한국 날짜로 센다(UTC 09-30 20:00 = 한국 10-01 05:00)
  assert.equal(judge({ fixDates: { 'left-pad@1.3.10': '2026-09-30T20:00:00Z' } }).findings[0].fixPublishedOn, '2026-10-01');

  // 예외 만료: 만료일 당일 끝까지 유효하고 다음 날부터 만료다. 유효한 예외가 없는 높음은 막는다
  const onDay = judge({ exceptions: [exception()], now: kst('2026-12-10T23:59:59') });
  assert.equal(onDay.ok, true);
  assert.equal(onDay.findings[0].exceptionState, 'valid');
  assert.equal(onDay.excepted.length, 1);
  const nextDay = judge({ exceptions: [exception()], now: kst('2026-12-11T00:00:00') });
  assert.equal(nextDay.ok, false);
  assert.equal(nextDay.findings[0].exceptionState, 'expired');
  assert.equal(nextDay.blocking.length, 1);
  assert.equal(nextDay.expiredExceptions.length, 1);
  // 만료일은 만든 날부터 30일을 넘지 못한다(31일째는 형식 오류)
  assert.doesNotThrow(() => parseExceptions(exceptionsText([exception({ expiresOn: '2026-12-10' })]), { now: kst('2026-11-10T09:00:00') }));
  assert.throws(() => parseExceptions(exceptionsText([exception({ expiresOn: '2026-12-11' })]), { now: kst('2026-11-10T09:00:00') }), /30일/);
});

test('[ASVS v5.0.0-15.1.1] 기한·예외 최대 일수는 설정으로 바꿀 수 있다(코드 상수와 다른 값)', () => {
  const policy = { ...POLICY, days: { critical: 3, high: 12, moderate: 45 }, exceptionMaxDays: 9 };
  const f = (now) => judge({ policy, now }).findings[0];
  assert.equal(f().deadline, '2026-10-13');
  assert.equal(f(kst('2026-10-13T12:00:00')).overdue, false);
  assert.equal(f(kst('2026-10-14T00:00:00')).overdue, true);
  const now = kst('2026-11-10T09:00:00');
  assert.doesNotThrow(() => parseExceptions(exceptionsText([exception({ expiresOn: '2026-11-19' })]), { now, policy }));
  assert.throws(() => parseExceptions(exceptionsText([exception({ expiresOn: '2026-11-20' })]), { now, policy }), /9일/);
});

test('[ASVS v5.0.0-15.1.1] PR 게이트는 유효한 예외가 없는 치명·높음만 막고 중간 이하는 알림만 남긴다', () => {
  assert.equal(judge({ advisories: [advisory({ severity: 'critical' })] }).ok, false);
  assert.equal(judge({ advisories: [advisory({ severity: 'high' })] }).ok, false);
  const soft = judge({ advisories: [advisory({ severity: 'moderate' }), advisory({ id: 2, github_advisory_id: 'GHSA-dddd-eeee-ffff', severity: 'low' }), advisory({ id: 3, github_advisory_id: 'GHSA-gggg-hhhh-jjjj', severity: 'info' })] });
  assert.equal(soft.ok, true);
  assert.equal(soft.notices.length, 3);
  assert.equal(soft.blocking.length, 0);
  // 예외는 패키지 이름·판·취약점 ID가 모두 맞을 때만 쓴다. 다른 판(1.3.8)의 예외는 쓰지 않고 쓰이지 않은 예외로 알린다
  const other = judge({ exceptions: [exception({ package: 'left-pad@1.3.8' })] });
  assert.equal(other.ok, false);
  assert.equal(other.unusedExceptions.length, 1);
  assert.equal(judge({ exceptions: [exception({ advisory: 'GHSA-zzzz-zzzz-zzzz' })] }).ok, false);
  // 같은 취약점이 판 둘에 있으면 판마다 따로 센다
  const two = judge({ advisories: [advisory({ findings: [{ version: '1.3.9', paths: ['a>left-pad'] }, { version: '1.2.0', paths: ['b>left-pad'] }] })], exceptions: [exception()] });
  assert.equal(two.ok, false);
  assert.deepEqual(two.blocking.map((f) => f.package), ['left-pad@1.2.0']);
  // 수정본이 없으면(patched_versions null) 기한을 세지 않고 예외(영향 분석·완화)가 있어야 지나간다
  const nofix = judge({ advisories: [advisory({ patched_versions: null })] });
  assert.equal(nofix.findings[0].fixVersion, null);
  assert.equal(nofix.findings[0].deadline, null);
  assert.equal(nofix.ok, false);
  // 수정본 공개일을 모르면 기한은 '알 수 없음'이고 판정은 등급과 예외로만 한다
  const unknown = judge({ advisories: [advisory({ severity: 'moderate' })], fixDates: {} });
  assert.equal(unknown.findings[0].deadline, null);
  assert.equal(unknown.findings[0].deadlineUnknown, true);
  assert.equal(unknown.ok, true);
});

test('수정본 판은 설치된 판보다 큰 가장 작은 하한이다(판 번호는 두 자리까지 숫자로 견준다)', () => {
  assert.equal(fixVersionOf('1.3.9', '>=1.3.10'), '1.3.10');
  assert.equal(fixVersionOf('2.0.1', '>=1.2.5 <2.0.0 || >=2.0.3'), '2.0.3');
  assert.equal(fixVersionOf('1.2.0', '>=1.2.5 <2.0.0 || >=2.0.3'), '1.2.5');
  assert.equal(fixVersionOf('9.9.9', '>=10.0.0'), '10.0.0');
  assert.equal(fixVersionOf('1.0.0', '>=1.0.1-beta.2'), '1.0.1-beta.2');
  assert.equal(fixVersionOf('1.0.0', null), null);
  assert.equal(fixVersionOf('1.0.0', '<0.0.0'), null);
});

const LIC = (groups) => JSON.stringify(groups);
test('라이선스: 허용 목록(MIT·Apache-2.0·BSD·ISC 계열) 밖은 경고만 하고, 결과를 못 읽으면 형식 오류다', () => {
  for (const ok of ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'MIT-0', '(MIT OR GPL-3.0-only)', 'MIT AND ISC', 'Apache-2.0 WITH LLVM-exception']) assert.ok(licenseAllowed(ok), ok);
  for (const no of ['GPL-3.0-only', 'MIT AND GPL-3.0-only', 'Unknown', 'BSD', 'CC-BY-4.0', '(MIT OR GPL-3.0-only) AND LGPL-2.1-only', '']) assert.ok(!licenseAllowed(no), no);
  const pkgs = parseLicenses(LIC({ MIT: [{ name: 'a', versions: ['1.0.0'], paths: [], license: 'MIT' }], 'GPL-3.0-only': [{ name: 'b', versions: ['2.0.0', '2.1.0'], paths: [], license: 'GPL-3.0-only' }], 'CC-BY-4.0': [{ name: 'c', version: '1.0.30001', path: '', license: 'CC-BY-4.0' }] }));
  assert.deepEqual(judgeLicenses(pkgs).map((w) => w.package), ['b@2.0.0', 'b@2.1.0', 'c@1.0.30001']);
  for (const bad of ['', 'nope', '[]', '{"MIT": {}}', '{"MIT": [{"versions": ["1.0.0"]}]}', '{"error": {"code": "ERR_PNPM_X", "message": "x"}}']) assert.throws(() => parseLicenses(bad), /라이선스/, bad);
});

// 명령줄로 돌린다(잡이 부르는 모양 그대로). 수정본 공개일은 시험 안의 가짜 레지스트리에서 받는다
async function run(args, { env = {} } = {}) {
  try {
    const r = await promisify(execFile)(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', ...env } });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    return { code: e.code, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
function files(map) {
  const dir = tempDir('vuln-deadline-');
  const paths = {};
  for (const [name, body] of Object.entries(map)) {
    paths[name] = join(dir, name);
    writeFileSync(paths[name], body);
  }
  return { dir, paths };
}
const NOW = ['--now', '2026-11-10T09:00:00+09:00'];

test('[ASVS v5.0.0-16.5.3] 검사 결과를 못 읽으면 막는다', async () => {
  const { dir, paths } = files({ 'ok.json': auditText([]), 'ex.json': exceptionsText([]) });
  const base = (audit) => [...(audit === undefined ? [] : ['--audit', audit]), '--exceptions', paths['ex.json'], ...NOW];
  assert.equal((await run(base(paths['ok.json']))).code, 0, '깨끗한 결과는 통과');
  // 결과 파일이 없음·인자 없음
  assert.equal((await run(base(join(dir, 'missing.json')))).code, 1);
  assert.equal((await run(base(undefined))).code, 1);
  const broken = {
    'empty.json': '',
    'text.json': 'ERR_PNPM_AUDIT_BAD_RESPONSE The audit endpoint responded with 503',
    'error.json': JSON.stringify({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE', message: '503' } }),
    'array.json': '[]',
    'noadv.json': JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }),
    'nometa.json': JSON.stringify({ advisories: {} }),
    'noname.json': auditText([advisory({ module_name: undefined })]),
    'badsev.json': auditText([advisory({ severity: 'severe' })], { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }),
    'nofind.json': auditText([advisory({ findings: undefined })], { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }),
    'noghsa.json': auditText([advisory({ github_advisory_id: undefined, url: 'https://example.test/x' })]),
    // 요약은 높음이 있다는데 목록에 없다(잘린 결과)
    'mismatch.json': auditText([], { info: 0, low: 0, moderate: 0, high: 2, critical: 0 }),
    'zero.json': JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, totalDependencies: 0 } }),
  };
  const b = files(broken);
  for (const name of Object.keys(broken)) {
    const r = await run(base(b.paths[name]));
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, /막음/, name);
  }
  // 예외 파일이 없거나 형식이 틀려도 막는다
  const badEx = {
    'nofile': null,
    'notjson.json': '{',
    'nolist.json': '{}',
    'unknownkey.json': exceptionsText([{ ...exception(), owner: 'x' }]),
    'badpkg.json': exceptionsText([exception({ package: 'left-pad@^1.3.9' })]),
    'badid.json': exceptionsText([exception({ advisory: 'CVE-2026-0001' })]),
    'noreason.json': exceptionsText([exception({ reason: '  ' })]),
    'noissue.json': exceptionsText([exception({ issue: 0 })]),
    'baddate.json': exceptionsText([exception({ expiresOn: '2026-02-30' })]),
    'reversed.json': exceptionsText([exception({ createdOn: '2026-11-10', expiresOn: '2026-11-09' })]),
    'future.json': exceptionsText([exception({ createdOn: '2026-11-11', expiresOn: '2026-11-20' })]),
    'dup.json': exceptionsText([exception(), exception()]),
  };
  const e = files(Object.fromEntries(Object.entries(badEx).filter(([, v]) => v !== null)));
  for (const name of Object.keys(badEx)) {
    const r = await run(['--audit', paths['ok.json'], '--exceptions', e.paths[name] ?? join(e.dir, name), ...NOW]);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
  }
  // 라이선스 결과를 주었는데 못 읽어도 막는다
  const l = files({ 'lic.json': 'not json' });
  assert.equal((await run([...base(paths['ok.json']), '--licenses', l.paths['lic.json']])).code, 1);
  assert.equal((await run([...base(paths['ok.json']), '--licenses', join(l.dir, 'missing.json')])).code, 1);
  // 모르는 인자·틀린 시각도 막는다
  assert.equal((await run([...base(paths['ok.json']), '--strict'])).code, 1);
  assert.equal((await run(['--audit', paths['ok.json'], '--exceptions', paths['ex.json'], '--now', 'yesterday'])).code, 1);
});

test('[ASVS v5.0.0-15.1.1] 명령줄: 레지스트리에서 수정본 공개일을 받아 기한을 적고, 막음·알림·보고서를 낸다', async () => {
  const asked = [];
  const server = createServer((req, res) => {
    asked.push(req.url);
    if (req.url === '/left-pad') return res.end(JSON.stringify({ name: 'left-pad', time: { '1.3.10': '2026-10-01T03:00:00.000Z' } }));
    if (req.url === '/@scope%2Fmid') return res.end(JSON.stringify({ name: '@scope/mid', time: { '4.0.0': '2026-08-01T00:00:00.000Z' } }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const registry = `http://127.0.0.1:${server.address().port}`;
  try {
    const advisories = [advisory(), advisory({ id: 2, github_advisory_id: 'GHSA-dddd-eeee-ffff', module_name: '@scope/mid', severity: 'moderate', patched_versions: '>=4.0.0', findings: [{ version: '3.9.0', paths: ['x>@scope/mid'] }] }), advisory({ id: 3, github_advisory_id: 'GHSA-gggg-hhhh-jjjj', module_name: 'gone', severity: 'moderate', patched_versions: '>=2.0.0', findings: [{ version: '1.0.0', paths: ['y>gone'] }] })];
    const { dir, paths } = files({ 'audit.json': auditText(advisories), 'ex.json': exceptionsText([]), 'ex-ok.json': exceptionsText([exception()]) });
    const report = join(dir, 'report.json');
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const r = await run(['--audit', paths['audit.json'], '--exceptions', paths['ex.json'], '--registry', registry, '--report', report, ...NOW], { env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /::error::.*left-pad@1\.3\.9.*GHSA-aaaa-bbbb-cccc/);
    assert.match(r.out, /::warning::.*@scope\/mid@3\.9\.0/);
    const rep = JSON.parse(readFileSync(report, 'utf8'));
    assert.equal(rep.ok, false);
    const by = Object.fromEntries(rep.findings.map((f) => [f.package, f]));
    assert.equal(by['left-pad@1.3.9'].deadline, '2026-10-31');
    assert.equal(by['left-pad@1.3.9'].overdue, true);
    assert.equal(by['@scope/mid@3.9.0'].deadline, '2026-10-30');
    // 레지스트리가 모르는 패키지는 기한을 모른다고 적고 판정은 바꾸지 않는다
    assert.equal(by['gone@1.0.0'].deadlineUnknown, true);
    assert.ok(asked.includes('/@scope%2Fmid'), asked.join(','));
    assert.match(readFileSync(summary, 'utf8'), /left-pad@1\.3\.9/);
    // 유효한 예외가 있으면 같은 결과가 통과하고 중간·낮음은 알림만 남는다
    const ok = await run(['--audit', paths['audit.json'], '--exceptions', paths['ex-ok.json'], '--registry', registry, ...NOW]);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /예외/);
  } finally {
    server.close();
  }
});

test('저장소의 예외 파일은 형식이 맞고, security-scan 워크플로가 검사 결과를 판정 도구에 넘기며 필수 검사가 기다린다', { skip: !YAML && 'yaml이 설치되지 않음(pnpm install 전)' }, () => {
  parseExceptions(readFileSync(join(REPO, 'tools/ci/vuln-exceptions.json'), 'utf8'), { now: new Date() });
  const wf = YAML.parse(readFileSync(join(REPO, '.github/workflows/security-scan.yml'), 'utf8'));
  assert.ok(wf.on.workflow_call, '재사용 워크플로');
  assert.deepEqual(wf.permissions, { contents: 'read' });
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
  const runs = steps.map((s) => s.run ?? '').join('\n');
  assert.match(runs, /pnpm audit --json/);
  assert.match(runs, /pnpm licenses list --json/);
  assert.match(runs, /node tools\/ci\/vuln-deadline\.mjs[^\n]*--audit/);
  // 판정 단계가 실패를 통과로 바꾸지 않는다
  for (const s of steps.filter((x) => /vuln-deadline\.mjs/.test(x.run ?? ''))) assert.notEqual(s['continue-on-error'], true);
  const ci = YAML.parse(readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8'));
  assert.equal(ci.jobs['security-scan'].uses, './.github/workflows/security-scan.yml');
  assert.ok([ci.jobs['ci-summary'].needs].flat().includes('security-scan'), 'ci-summary.needs에 security-scan');
});

// ---------- 리뷰 R10(2026-11-10) 재현 시험: 예외를 예외 파일 밖(pnpm auditConfig)에 두는 길 ----------
test('[ASVS v5.0.0-15.1.1] pnpm auditConfig 무시 설정(ignoreGhsas·ignoreCves·auditLevel)이 작업 공간 설정에 있으면 막고 무엇을 찾았는지 알린다', async () => {
  const mod = await import('./vuln-deadline.mjs');
  assert.equal(typeof mod.findAuditIgnores, 'function', 'findAuditIgnores가 없다');
  // 지금 저장소에는 없다
  assert.deepEqual(mod.findAuditIgnores(REPO), []);
  const { paths } = files({ 'ok.json': auditText([]), 'ex.json': exceptionsText([]) });
  const runAt = (root) => run(['--audit', paths['ok.json'], '--exceptions', paths['ex.json'], '--root', root, ...NOW]);
  const rootWith = (map) => files(map).dir;
  const blockedRoots = {
    'auditConfig.ignoreGhsas': { 'pnpm-workspace.yaml': 'packages:\n  - apps/*\nauditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n' },
    'auditConfig.ignoreCves': { 'pnpm-workspace.yaml': 'auditConfig: { ignoreCves: [CVE-2026-0001] }\n' },
    'audit.ignoreGhsas': { 'pnpm-workspace.yaml': 'audit:\n  ignorePrune: true\n  ignoreGhsas: [GHSA-aaaa-bbbb-cccc]\n' },
    'audit.ignore': { 'pnpm-workspace.yaml': "'audit':\n  ignore:\n    - GHSA-aaaa-bbbb-cccc\n" },
    auditLevel: { 'pnpm-workspace.yaml': 'auditLevel: high\n' },
    'audit.level': { 'pnpm-workspace.yaml': 'audit:\n  level: critical\n' },
    'package.json pnpm.auditConfig.ignoreCves': { 'package.json': JSON.stringify({ name: 'x', pnpm: { auditConfig: { ignoreCves: ['CVE-2026-0001'] } } }) },
    'package.json pnpm.audit.ignoreGhsas': { 'package.json': JSON.stringify({ name: 'x', pnpm: { audit: { ignoreGhsas: ['GHSA-aaaa-bbbb-cccc'] } } }) },
    '.npmrc audit-level': { '.npmrc': 'registry=https://registry.npmjs.org/\naudit-level=high\n' },
  };
  for (const [what, map] of Object.entries(blockedRoots)) {
    const r = await runAt(rootWith(map));
    assert.equal(r.code, 1, `${what}: ${r.out}`);
    assert.match(r.out, /auditConfig|audit|무시 설정/, what);
    assert.ok(r.out.includes(what.replace(/^package\.json |^\.npmrc /, '')), `${what}를 알려야 한다: ${r.out}`);
  }
  // 무시가 아닌 설정·주석·다른 이름은 막지 않는다
  const fine = rootWith({
    'pnpm-workspace.yaml': 'packages:\n  - apps/*\n# auditConfig:\n#   ignoreGhsas: [GHSA-aaaa-bbbb-cccc]\naudit:\n  ignorePrune: true\nminimumReleaseAge: 4320\n',
    'package.json': JSON.stringify({ name: 'x', scripts: { audit: 'pnpm audit' } }),
  });
  const ok = await runAt(fine);
  assert.equal(ok.code, 0, ok.out);
  // 설정 파일을 읽지 못하면 막는다
  assert.equal((await runAt(rootWith({ 'package.json': '{' }))).code, 1);
});
