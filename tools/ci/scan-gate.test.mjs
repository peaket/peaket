// 외부 보안 검사 판정 도구(tools/ci/scan-gate.mjs) 시험(docs/devops.md §4.4 '외부 보안 검사 게이트', ADR-0263 결정 4·5,
// ASVS 13.3.1·15.3.6·16.5.3, BUILD_ORDER BAS-011 ②). 실행: node --test "tools/ci/*.test.mjs"
// 단언 값(등급 문턱 7.0, 프로토타입 오염 쿼리 셋, 누출 종료 코드 99, 한국 날짜)은 코드의 상수를 가져오지 않고 정본의 값을 적는다.
// 시험 자료에 비밀 꼴 글자를 쓰지 않는다(이 저장소의 gitleaks가 시험 파일도 본다). 가린 조각·메시지 자리에는 표시 글만 둔다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { judge, main, markdownCell, parseScanExceptions, readFindings } from './scan-gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'scan-gate.mjs');
const PROTO = ['js/prototype-polluting-assignment', 'js/prototype-pollution', 'js/prototype-pollution-utility'];
const NOW = new Date('2026-11-10T03:00:00Z'); // 한국 2026-11-10 12:00

const rule = (id, sev) => ({ id, properties: sev === undefined ? { tags: ['security'] } : { tags: ['security'], 'security-severity': String(sev) } });
const result = (ruleId, uri, line = 3, extra = {}) => ({
  ruleId,
  level: 'error',
  message: { text: '표시-메시지-원문' },
  locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: '%SRCROOT%' }, region: { startLine: line, snippet: { text: '표시-조각' } } } }],
  ...extra,
});
const run = ({ name, rules = [], extensions, results = [], base } = {}) => ({
  tool: { driver: { name, rules }, ...(extensions ? { extensions } : {}) },
  results,
  ...(base ? { originalUriBaseIds: base } : {}),
});
const sarif = (...runs) => JSON.stringify({ version: '2.1.0', runs });
const codeqlRules = (extra = []) => [...PROTO.map((id) => rule(id, 6.1)), rule('js/xss', 7.8), rule('js/missing-rate-limiting', 7.5), rule('js/log-injection', 6.1), ...extra];
const codeql = (results, rules = codeqlRules()) => sarif(run({ name: 'CodeQL', rules: [], extensions: [{ name: 'codeql/javascript-queries', rules }], results }));
const gitleaksResult = (file, line, commit) => ({
  ruleId: 'generic-api-key',
  message: { text: `generic-api-key has detected secret for file ${file} 표시-메시지-원문` },
  locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line, snippet: { text: '표시-조각' } } } }],
  partialFingerprints: { commitSha: commit, email: '표시-메일', author: '표시-작성자', date: '2026-11-01T00:00:00Z', commitMessage: '표시-커밋-메시지' },
});
const gitleaks = (results) => sarif(run({ name: 'gitleaks', rules: [rule('generic-api-key'), rule('github-pat')], results }));

/** 임시 폴더에 SARIF·예외 파일을 쓰고 main을 돌린다. 로그·잡 요약·보고서를 돌려준다 */
async function gate({ tool, files = {}, sarifPath, exitCode, exceptions = { exceptions: [] }, now = NOW.toISOString(), extra = [], env = {} }) {
  const dir = tempDir('scan-gate-');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const exFile = join(dir, 'scan-exceptions.json');
  writeFileSync(exFile, typeof exceptions === 'string' ? exceptions : JSON.stringify(exceptions));
  const summaryFile = join(dir, 'summary.md');
  const reportFile = join(dir, 'report.json');
  const logs = [];
  const argv = ['--tool', tool, '--sarif', join(dir, sarifPath ?? Object.keys(files)[0] ?? 'missing.sarif'), '--exceptions', exFile, '--now', now, '--report', reportFile, ...extra];
  if (exitCode !== undefined) argv.push('--exit-code', String(exitCode));
  const code = await main(argv, { env: { GITHUB_STEP_SUMMARY: summaryFile, ...env }, log: (l) => logs.push(l) });
  const read = (f) => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const reportText = read(reportFile);
  return { code, logs: logs.join('\n'), summary: read(summaryFile), report: reportText ? JSON.parse(reportText) : null, reportText };
}

const exception = (o = {}) => ({ tool: 'codeql', rule: 'js/xss', path: 'apps/web/src/a.ts', reason: '화면 밖에서만 부르는 관리 도구 경로라 영향이 없다(완화: 출력 인코딩)', issue: 42, count: 1, createdOn: '2026-11-01', expiresOn: '2026-11-11', ...o });

// ---------- 13.3.1 비밀 ----------

test('[ASVS v5.0.0-13.3.1] gitleaks가 누출 아닌 까닭으로 끝나거나 SARIF가 없으면 막는다', async () => {
  const clean = gitleaks([]);
  // 맞춤: 종료 코드 0이고 결과가 없으면 통과한다
  const ok = await gate({ tool: 'gitleaks', files: { 'g.sarif': clean }, exitCode: 0 });
  assert.equal(ok.code, 0, ok.logs);
  assert.equal(ok.report.ok, true);
  // 오류 종료(1·2)는 결과가 비어도 막는다(SARIF만 보는 판정이 놓치는 것)
  for (const exitCode of [1, 2, 126]) {
    const r = await gate({ tool: 'gitleaks', files: { 'g.sarif': clean }, exitCode });
    assert.equal(r.code, 1, `종료 코드 ${exitCode}`);
    assert.equal(r.report.ok, false);
    assert.match(r.report.errors.join('\n'), new RegExp(`종료 코드 ${exitCode}`));
  }
  // 종료 코드를 주지 않았거나 숫자가 아니면 막는다(앞 단계가 돌지 않았다)
  assert.equal((await gate({ tool: 'gitleaks', files: { 'g.sarif': clean } })).code, 1);
  assert.equal((await gate({ tool: 'gitleaks', files: { 'g.sarif': clean }, exitCode: '' })).code, 1);
  // 보고서가 없으면 막는다
  const missing = await gate({ tool: 'gitleaks', sarifPath: 'none.sarif', exitCode: 0 });
  assert.equal(missing.code, 1);
  assert.match(missing.report.errors.join('\n'), /읽지 못했다/);
  // 누출 종료 코드(99)인데 보고서에 결과가 없으면 어긋나 막는다(종료 코드만 보는 판정과 SARIF만 보는 판정을 함께 지킨다)
  const odd = await gate({ tool: 'gitleaks', files: { 'g.sarif': clean }, exitCode: 99 });
  assert.equal(odd.code, 1);
  assert.match(odd.report.errors.join('\n'), /결과가 없다/);
});

test('[ASVS v5.0.0-13.3.1] 비밀 결과는 등급과 상관없이 하나라도 있으면 막고, 판정 보고서와 잡 요약에는 규칙·파일·줄·커밋만 있고 조각·메시지 원문이 없다', async () => {
  const commit = 'c'.repeat(40);
  // 종료 코드 0이어도 결과가 있으면 막는다(종료 코드만 믿는 판정이 놓치는 것)
  for (const exitCode of [0, 99]) {
    const r = await gate({ tool: 'gitleaks', files: { 'g.sarif': gitleaks([gitleaksResult('services/a/src/x.ts', 12, commit)]) }, exitCode });
    assert.equal(r.code, 1, `종료 코드 ${exitCode}`);
    assert.equal(r.report.blocking.length, 1);
    assert.deepEqual(r.report.blocking[0], { tool: 'gitleaks', rule: 'generic-api-key', path: 'services/a/src/x.ts', line: 12, commit });
    for (const text of [r.reportText, r.summary, r.logs]) {
      for (const marker of ['표시-조각', '표시-메시지-원문', '표시-메일', '표시-작성자', '표시-커밋-메시지']) assert.equal(text.includes(marker), false, `${marker}가 새었다`);
    }
    assert.match(r.summary, /generic-api-key/);
    assert.match(r.summary, /services\/a\/src\/x\.ts/);
  }
  // 이미지 비밀(Trivy)은 낮음(2.0)이어도 막는다. 이미지 안 절대 경로를 그대로 적는다
  const trivySecret = sarif(run({ name: 'Trivy', rules: [rule('aws-access-key-id', 2.0)], results: [{ ...result('aws-access-key-id', '/app/app.env', 1), locations: [{ physicalLocation: { artifactLocation: { uri: '/app/app.env' }, region: { startLine: 1 } } }] }] }));
  const t = await gate({ tool: 'trivy-secret', files: { 't.sarif': trivySecret } });
  assert.equal(t.code, 1);
  assert.deepEqual(t.report.blocking, [{ tool: 'trivy-secret', rule: 'aws-access-key-id', path: '/app/app.env', line: 1, severity: 2 }]);
  assert.equal(t.reportText.includes('표시-메시지-원문'), false);
  // 결과 없는 이미지는 통과한다
  assert.equal((await gate({ tool: 'trivy-secret', files: { 't.sarif': sarif(run({ name: 'Trivy', results: [] })) } })).code, 0);
  // 비밀 검사 결과는 예외 파일로 풀지 못한다(오탐은 도구 설정의 허용 목록에 둔다)
  const ex = await gate({
    tool: 'gitleaks',
    files: { 'g.sarif': gitleaks([gitleaksResult('services/a/src/x.ts', 12, commit)]) },
    exitCode: 99,
    exceptions: { exceptions: [exception({ tool: 'gitleaks', rule: 'generic-api-key', path: 'services/a/src/x.ts' })] },
  });
  assert.equal(ex.code, 1);
  assert.match(ex.report.errors.join('\n'), /예외 파일/);
});

// ---------- 15.3.6 프로토타입 오염 ----------

test('[ASVS v5.0.0-15.3.6] 프로토타입 오염 쿼리 셋의 결과는 등급 6.1이어도 막는다', async () => {
  for (const id of PROTO) {
    const r = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([result(id, 'packages/platform/src/merge.ts', 8)]) }, sarifPath: 'c' });
    assert.equal(r.code, 1, id);
    assert.deepEqual(r.report.blocking, [{ tool: 'codeql', rule: id, path: 'packages/platform/src/merge.ts', line: 8, severity: 6.1 }]);
  }
  // 같은 등급(6.1)의 다른 쿼리는 알림만이다
  const other = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([result('js/log-injection', 'services/a/src/log.ts', 4)]) }, sarifPath: 'c' });
  assert.equal(other.code, 0, other.logs);
  assert.deepEqual(other.report.blocking, []);
  assert.deepEqual(other.report.notices, [{ tool: 'codeql', rule: 'js/log-injection', path: 'services/a/src/log.ts', line: 4, severity: 6.1 }]);
});

test('[ASVS v5.0.0-15.3.6] CodeQL 결과의 규칙 목록에 세 쿼리가 하나라도 없으면 막는다', async () => {
  // 셋이 다 있으면 결과가 없어도 통과한다(규칙 목록은 묶음 확장에 있어도 된다)
  const full = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([]) }, sarifPath: 'c' });
  assert.equal(full.code, 0, full.logs);
  // 도구 본체(driver)의 규칙 목록에 있어도 센다
  const inDriver = sarif(run({ name: 'CodeQL', rules: codeqlRules(), results: [] }));
  assert.equal((await gate({ tool: 'codeql', files: { 'c/javascript.sarif': inDriver }, sarifPath: 'c' })).code, 0);
  for (const id of PROTO) {
    const rules = codeqlRules().filter((r) => r.id !== id);
    const r = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([], rules) }, sarifPath: 'c' });
    assert.equal(r.code, 1, id);
    assert.ok(r.report.errors.some((e) => e.includes(id)), JSON.stringify(r.report.errors));
  }
  // 규칙 목록이 통째로 비면 막는다
  assert.equal((await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([], []) }, sarifPath: 'c' })).code, 1);
});

test('[ASVS v5.0.0-15.3.6] 소스 안 억제 주석(SARIF suppressions)이 달린 결과도 막는다', async () => {
  const suppressed = [
    result('js/prototype-pollution-utility', 'packages/a/src/u.ts', 2, { suppressions: [{ kind: 'inSource' }] }),
    result('js/xss', 'apps/web/src/b.ts', 9, { suppressions: [{ kind: 'external', status: 'accepted' }] }),
  ];
  const r = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql(suppressed) }, sarifPath: 'c' });
  assert.equal(r.code, 1);
  assert.deepEqual(
    r.report.blocking.map((f) => [f.rule, f.path, f.suppressed]),
    [
      ['js/prototype-pollution-utility', 'packages/a/src/u.ts', true],
      ['js/xss', 'apps/web/src/b.ts', true],
    ],
  );
});

// ---------- 장부 밖: 닫힘 실패·등급 문턱·예외 ----------

test('[ASVS v5.0.0-16.5.3] SARIF가 없거나 JSON이 아니거나 도구 이름이 기대와 다르면 막는다', async () => {
  const cases = [
    ['빈 파일', ''],
    ['JSON이 아님', '{ runs: '],
    ['runs 없음', '{}'],
    ['runs 빔', JSON.stringify({ version: '2.1.0', runs: [] })],
    ['도구 이름 다름', sarif(run({ name: 'Trivy', rules: codeqlRules(), results: [] }))],
    ['results 없음', JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'CodeQL', rules: codeqlRules() } } }] })],
    ['결과에 위치 없음', codeql([{ ruleId: 'js/xss', message: { text: 'x' } }])],
  ];
  for (const [what, text] of cases) {
    const r = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': text }, sarifPath: 'c' });
    assert.equal(r.code, 1, what);
    assert.equal(r.report.ok, false, what);
    assert.ok(r.report.errors.length > 0, what);
  }
  // 폴더에 .sarif가 하나도 없으면 막는다
  const empty = await gate({ tool: 'codeql', files: { 'c/readme.txt': 'x' }, sarifPath: 'c' });
  assert.equal(empty.code, 1);
  assert.match(empty.report.errors.join('\n'), /\.sarif/);
  // 모르는 도구와 빠진 인자도 막는다
  assert.equal((await gate({ tool: 'semgrep', files: { 'x.sarif': codeql([]) } })).code, 1);
  const noTool = [];
  assert.equal(await main(['--sarif', 'x.sarif'], { env: {}, log: (l) => noTool.push(l) }), 1);
  // 예외 파일이 틀려도 막는다
  assert.equal((await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([]) }, sarifPath: 'c', exceptions: '{' })).code, 1);
});

test('[ASVS v5.0.0-16.5.3] 보안 등급 7.0은 막고 6.9는 알림만이다', async () => {
  const rules = codeqlRules([rule('js/edge-high', 7.0), rule('js/edge-below', 6.9)]);
  const r = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([result('js/edge-high', 'services/a/src/h.ts', 1), result('js/edge-below', 'services/a/src/l.ts', 2)], rules) }, sarifPath: 'c' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.report.blocking.map((f) => [f.rule, f.severity]), [['js/edge-high', 7]]);
  assert.deepEqual(r.report.notices.map((f) => [f.rule, f.severity]), [['js/edge-below', 6.9]]);
  // 6.9 하나뿐이면 통과다
  const below = await gate({ tool: 'codeql', files: { 'c/javascript.sarif': codeql([result('js/edge-below', 'services/a/src/l.ts', 2)], rules) }, sarifPath: 'c' });
  assert.equal(below.code, 0, below.logs);
});

test('Trivy 설정 결과의 높음 이상은 막고 중간 이하는 알림만이다', async () => {
  const trivyRun = (dir, results) =>
    sarif(
      run({
        name: 'Trivy',
        rules: [rule('GIT-0001', 9.5), rule('KSV-0014', 8.0), rule('DS-0013', 5.5), rule('DS-0026', 2.0), rule('KSV-0118', 7.0), rule('KSV-0119', 6.9)],
        results: results.map(([id, uri, line]) => ({ ...result(id, uri, line), locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: 'ROOTPATH' }, region: { startLine: line } } }] })),
        base: { ROOTPATH: { uri: `file:///src/${dir}/` } },
      }),
    );
  const r = await gate({
    tool: 'trivy-config',
    sarifPath: 'out',
    files: {
      'out/infra.sarif': trivyRun('infra', [['GIT-0001', 'stacks/global/github/repositories.tf', 36]]),
      'out/deploy.sarif': trivyRun('deploy', [['KSV-0014', 'charts/peaket-service/templates/deployment.yaml', 35], ['KSV-0118', 'charts/peaket-service/templates/deployment.yaml', 40], ['KSV-0119', 'charts/peaket-service/templates/deployment.yaml', 41]]),
      'out/services-dockerfile.sarif': trivyRun('services', [['DS-0013', 'pg-simulator/Dockerfile', 14], ['DS-0026', 'pg-simulator/Dockerfile', 1]]),
    },
  });
  assert.equal(r.code, 1);
  // 경로는 컨테이너 안 뿌리(/src)를 뗀 저장소 기준이다
  assert.deepEqual(
    r.report.blocking.map((f) => [f.rule, f.path, f.line, f.severity]).sort(),
    [
      ['GIT-0001', 'infra/stacks/global/github/repositories.tf', 36, 9.5],
      ['KSV-0014', 'deploy/charts/peaket-service/templates/deployment.yaml', 35, 8],
      ['KSV-0118', 'deploy/charts/peaket-service/templates/deployment.yaml', 40, 7],
    ],
  );
  assert.deepEqual(r.report.notices.map((f) => [f.rule, f.path]).sort(), [
    ['DS-0013', 'services/pg-simulator/Dockerfile'],
    ['DS-0026', 'services/pg-simulator/Dockerfile'],
    ['KSV-0119', 'deploy/charts/peaket-service/templates/deployment.yaml'],
  ]);
  // 등급이 없는 설정 결과는 판정하지 못해 막는다
  const noSev = sarif(run({ name: 'Trivy', rules: [{ id: 'X-1', properties: {} }], results: [result('X-1', 'a.tf', 1)] }));
  assert.equal((await gate({ tool: 'trivy-config', files: { 'n.sarif': noSev } })).code, 1);
});

test('[ASVS v5.0.0-16.5.3] 예외는 도구·규칙·경로가 모두 맞고 만료 전일 때만 받고, 만료일 다음 날 다시 막는다(만료 한도는 인자로 다른 값을 넣어 본다)', () => {
  const policy = { exceptionMaxDays: 12, utcOffsetMinutes: 540, blockSeverity: 7 };
  const f = { tool: 'codeql', rule: 'js/xss', path: 'apps/web/src/a.ts', line: 5, severity: 7.8 };
  const list = (o, now) => parseScanExceptions(JSON.stringify({ exceptions: [exception(o)] }), { now, policy });
  const at = (iso) => new Date(iso);
  // 만든 날 11-01, 만료일 11-11(한도 12일 안). 한국 11-11 23:59:59.999(= 14:59:59.999Z)까지 받는다
  const lastMoment = at('2026-11-11T14:59:59.999Z');
  const ok = judge({ tool: 'codeql', findings: [f], exceptions: list({}, lastMoment), now: lastMoment, policy });
  assert.equal(ok.ok, true);
  assert.equal(ok.excepted.length, 1);
  assert.deepEqual(ok.unusedExceptions, []);
  // 한국 11-12 00:00(= 11-11 15:00Z)부터 다시 막고 만료된 예외로 적는다
  const nextDay = at('2026-11-11T15:00:00.000Z');
  const expired = judge({ tool: 'codeql', findings: [f], exceptions: list({}, nextDay), now: nextDay, policy });
  assert.equal(expired.ok, false);
  assert.equal(expired.blocking.length, 1);
  assert.equal(expired.expiredExceptions.length, 1);
  // 규칙·경로·도구 가운데 하나라도 다르면 받지 않는다(그 예외는 쓰이지 않은 예외로도 막힌다)
  for (const [what, o] of [
    ['경로', { path: 'apps/web/src/b.ts' }],
    ['규칙', { rule: 'js/sql-injection' }],
    ['도구', { tool: 'trivy-config' }],
  ]) {
    const r = judge({ tool: 'codeql', findings: [f], exceptions: list(o, NOW), now: NOW, policy });
    assert.equal(r.ok, false, what);
    assert.equal(r.blocking.length, 1, what);
    assert.equal(r.excepted.length, 0, what);
  }
});

test('[ASVS v5.0.0-16.5.3] 만든 날부터 한도를 넘는 만료일·까닭이나 이슈 없는 줄·쓰이지 않는 예외는 막는다', () => {
  const policy = { exceptionMaxDays: 12, utcOffsetMinutes: 540, blockSeverity: 7 };
  const parse = (o) => parseScanExceptions(JSON.stringify({ exceptions: [exception(o)] }), { now: NOW, policy });
  // 만든 날 + 12일은 받고 + 13일은 막는다
  assert.equal(parse({ createdOn: '2026-11-01', expiresOn: '2026-11-13' }).length, 1);
  assert.throws(() => parse({ createdOn: '2026-11-01', expiresOn: '2026-11-14' }), /12일/);
  // 기본 한도 30일(인자를 주지 않으면): 11-01 + 30 = 12-01까지
  assert.equal(parseScanExceptions(JSON.stringify({ exceptions: [exception({ expiresOn: '2026-12-01' })] }), { now: NOW }).length, 1);
  assert.throws(() => parseScanExceptions(JSON.stringify({ exceptions: [exception({ expiresOn: '2026-12-02' })] }), { now: NOW }), /30일/);
  for (const [what, o, re] of [
    ['까닭 없음', { reason: '' }, /사유/],
    ['까닭 짧음', { reason: '오탐' }, /사유/],
    ['이슈 없음', { issue: undefined }, /issue/],
    ['이슈 0', { issue: 0 }, /issue/],
    ['만든 날이 오늘 뒤', { createdOn: '2026-11-11', expiresOn: '2026-11-12' }, /오늘/],
    ['만료가 만든 날 앞', { createdOn: '2026-11-05', expiresOn: '2026-11-04' }, /앞/],
    ['날짜 꼴', { expiresOn: '2026-11-31' }, /YYYY-MM-DD/],
    ['경로 글롭', { path: 'apps/web/src/*.ts' }, /경로/],
    ['절대 경로', { path: '/apps/web/src/a.ts' }, /경로/],
    ['위로 가는 경로', { path: 'apps/../x.ts' }, /경로/],
    ['비밀 검사 도구', { tool: 'gitleaks' }, /예외 파일/],
    ['모르는 도구', { tool: 'semgrep' }, /tool/],
    ['모르는 칸', { owner: 'x' }, /모르는 칸/],
  ]) {
    assert.throws(() => parse(o), re, what);
  }
  assert.throws(() => parseScanExceptions(JSON.stringify({ exceptions: [exception(), exception()] }), { now: NOW, policy }), /겹친다/);
  // 어느 결과에도 쓰이지 않는 예외는 막는다(그 도구의 판정에서만 센다)
  const unused = judge({ tool: 'codeql', findings: [], exceptions: parse({}), now: NOW, policy });
  assert.equal(unused.ok, false);
  assert.equal(unused.unusedExceptions.length, 1);
  assert.equal(judge({ tool: 'trivy-config', findings: [], exceptions: parse({}), now: NOW, policy }).ok, true);
  // 알림만인 결과(7.0 미만)에 건 예외도 쓰이지 않은 예외다
  const notice = judge({ tool: 'codeql', findings: [{ tool: 'codeql', rule: 'js/xss', path: 'apps/web/src/a.ts', line: 1, severity: 6.9 }], exceptions: parse({}), now: NOW, policy });
  assert.equal(notice.ok, false);
  assert.equal(notice.unusedExceptions.length, 1);
  // 저장소의 예외 파일은 규칙에 맞는다
  const real = readFileSync(join(HERE, 'scan-exceptions.json'), 'utf8');
  assert.ok(Array.isArray(parseScanExceptions(real, { now: new Date() })));
});

test('CodeQL 결과 경로는 저장소 기준 상대 경로로 읽고 결과가 가리키는 규칙을 ruleIndex로도 찾는다', () => {
  const rules = codeqlRules();
  const idx = rules.findIndex((r) => r.id === 'js/xss');
  const text = codeql([{ ...result('js/xss', 'apps/web/src/a.ts', 7), ruleId: undefined, rule: { id: 'js/xss', index: idx, toolComponent: { index: 0 } } }], rules);
  const { findings, rules: ids } = readFindings([{ file: 'x.sarif', text }], 'codeql');
  assert.deepEqual(findings, [{ tool: 'codeql', rule: 'js/xss', path: 'apps/web/src/a.ts', line: 7, severity: 7.8 }]);
  assert.ok(PROTO.every((id) => ids.has(id)));
});

test('명령줄은 판정 결과를 종료 코드로 내고 GitHub 주석에 규칙·파일·줄만 적는다', () => {
  const dir = tempDir('scan-gate-cli-');
  writeFileSync(join(dir, 'c.sarif'), codeql([result('js/xss', 'apps/web/src/a.ts', 7)]));
  const r = spawnSync(process.execPath, [SCRIPT, '--tool', 'codeql', '--sarif', join(dir, 'c.sarif')], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: '' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /::error file=apps\/web\/src\/a\.ts,line=7::/);
  assert.equal(r.stdout.includes('표시-메시지-원문'), false);
  writeFileSync(join(dir, 'ok.sarif'), codeql([]));
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--tool', 'codeql', '--sarif', join(dir, 'ok.sarif')], { encoding: 'utf8' }).status, 0);
});

// ---------- 받아들인 결과(설계로 받아들인 결과, devops §4.4 '예외 파일' 끝 문장, ADR-0263 결정 12) ----------
// 시험의 한도(5개월)·ADR 번호(0042)는 코드의 기본값(1년, 저장소의 ADR)과 다르게 고른다. 기본 한도는 정본의 값(1년)을 날짜로 적어 본다

/** 근거 ADR 파일이 있는 임시 ADR 폴더 */
function adrDir() {
  const dir = tempDir('scan-gate-adr-');
  writeFileSync(join(dir, '0042-accepted-public-repository.md'), '# ADR-0042: 시험용\n\n결정: GIT-0001(공개 저장소)은 받아들인다.\n');
  writeFileSync(join(dir, '0046-alerts.md'), '# ADR-0046: 시험용\n\nGIT-0003도 받아들인다.\n');
  writeFileSync(join(dir, '0045-other-decision.md'), '# ADR-0045: 규칙 ID가 없는 결정\n\nGIT-00011과 XGIT-0001은 다른 이름이다.\n');
  writeFileSync(join(dir, '0043.md'), '# 이름 꼴이 아닌 파일(번호-이름.md가 아니다)\n');
  return dir;
}
const accepted = (o = {}) => {
  const { issue, expiresOn, ...rest } = exception({ tool: 'trivy-config', rule: 'GIT-0001', path: 'infra/stacks/global/github/repositories.tf', reason: '소유자가 정한 공개 모노레포다(완화: 비공개 봇 저장소 분리, 저장소에 비밀 없음, gitleaks 검사)', createdOn: '2026-11-01' });
  return { ...rest, adr: 'ADR-0042', reviewOn: '2027-03-01', ...o };
};
const POLICY5 = { exceptionMaxDays: 12, acceptedMaxMonths: 5, utcOffsetMinutes: 540, blockSeverity: 7 };

test('[ASVS v5.0.0-16.5.3] 받아들인 결과 줄은 근거 ADR 파일이 있고 다시 볼 날이 한도 안이어야 하며 issue와 adr 가운데 하나만 쓴다', () => {
  const dir = adrDir();
  const parse = (o, { policy = POLICY5, now = NOW } = {}) => parseScanExceptions(JSON.stringify({ exceptions: [accepted(o)] }), { now, policy, adrDir: dir });
  const [line] = parse({});
  assert.deepEqual([line.adr, line.reviewOn, line.issue], ['ADR-0042', '2027-03-01', undefined]);
  // 근거 ADR 파일이 없으면 막는다(번호-이름.md 꼴의 파일만 센다)
  assert.throws(() => parse({ adr: 'ADR-0043' }), /ADR 파일/);
  assert.throws(() => parse({ adr: 'ADR-0044' }), /ADR 파일/);
  assert.throws(() => parseScanExceptions(JSON.stringify({ exceptions: [accepted()] }), { now: NOW, policy: POLICY5, adrDir: join(dir, 'none') }), /ADR 파일/);
  for (const adr of ['ADR-42', 'adr-0042', '0042', 'ADR-0042 ', 'ADR-00420']) assert.throws(() => parse({ adr }), /ADR-0000/, adr);
  // 다시 볼 날: 만든 날(11-01)부터 5개월(2027-04-01)까지 받고 그다음 날은 막는다
  assert.equal(parse({ reviewOn: '2027-04-01' }).length, 1);
  assert.throws(() => parse({ reviewOn: '2027-04-02' }), /5개월/);
  assert.throws(() => parse({ reviewOn: '2026-10-31' }), /앞/);
  assert.throws(() => parse({ reviewOn: '2027-02-30' }), /YYYY-MM-DD/);
  // 기본 한도는 1년이다: 2026-11-10에 만든 줄은 2027-11-10까지
  const yearly = (reviewOn) => parseScanExceptions(JSON.stringify({ exceptions: [accepted({ createdOn: '2026-11-10', reviewOn })] }), { now: new Date('2026-11-10T03:00:00Z'), adrDir: dir });
  assert.equal(yearly('2027-11-10').length, 1);
  assert.throws(() => yearly('2027-11-11'), /12개월/);
  // issue와 adr을 함께 쓰거나 둘 다 없으면 막는다. 예외는 expiresOn, 받아들인 결과는 reviewOn이다
  assert.throws(() => parse({ issue: 42 }), /함께/);
  assert.throws(() => parse({ adr: undefined }), /하나/);
  assert.throws(() => parse({ reviewOn: undefined, expiresOn: '2026-11-11' }), /reviewOn/);
  assert.throws(() => parse({ expiresOn: '2026-11-11' }), /expiresOn/);
  assert.throws(() => parseScanExceptions(JSON.stringify({ exceptions: [exception({ reviewOn: '2026-11-11' })] }), { now: NOW, policy: POLICY5, adrDir: dir }), /reviewOn/);
  // 그 밖의 규칙은 예외 줄과 같다
  assert.throws(() => parse({ reason: '설계' }), /사유/);
  assert.throws(() => parse({ path: 'infra/**/*.tf' }), /경로/);
  assert.throws(() => parse({ tool: 'gitleaks', rule: 'generic-api-key' }), /예외 파일/);
  assert.throws(() => parse({ createdOn: '2026-11-11', reviewOn: '2027-01-01' }), /오늘/);
  assert.throws(() => parseScanExceptions(JSON.stringify({ exceptions: [accepted(), accepted({ reviewOn: '2027-02-01' })] }), { now: NOW, policy: POLICY5, adrDir: dir }), /겹친다/);
});

test('[ASVS v5.0.0-16.5.3] 받아들인 결과는 다시 볼 날까지만 받고 다음 날 다시 막으며, 쓰이지 않으면 막는다', () => {
  const dir = adrDir();
  const f = { tool: 'trivy-config', rule: 'GIT-0001', path: 'infra/stacks/global/github/repositories.tf', line: 36, severity: 9.5 };
  const lines = (o, now) => parseScanExceptions(JSON.stringify({ exceptions: [accepted(o)] }), { now, policy: POLICY5, adrDir: dir });
  // 한국 2027-03-01 23:59:59.999(= 14:59:59.999Z)까지 받는다
  const last = new Date('2027-03-01T14:59:59.999Z');
  const ok = judge({ tool: 'trivy-config', findings: [f], exceptions: lines({}, last), now: last, policy: POLICY5 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.accepted.map((x) => [x.rule, x.accepted.adr, x.accepted.reviewOn]), [['GIT-0001', 'ADR-0042', '2027-03-01']]);
  assert.deepEqual([ok.blocking, ok.excepted, ok.unusedExceptions], [[], [], []]);
  // 한국 2027-03-02 00:00(= 03-01 15:00Z)부터 다시 막고, 다시 볼 날이 지난 줄로 적는다
  const next = new Date('2027-03-01T15:00:00.000Z');
  const over = judge({ tool: 'trivy-config', findings: [f], exceptions: lines({}, next), now: next, policy: POLICY5 });
  assert.equal(over.ok, false);
  assert.equal(over.blocking.length, 1);
  assert.deepEqual(over.accepted, []);
  assert.deepEqual(over.expiredExceptions.map((e) => [e.adr, e.reviewOn]), [['ADR-0042', '2027-03-01']]);
  // 경로·규칙·도구가 다르면 받지 않고, 그 줄은 쓰이지 않은 줄로 막힌다
  for (const o of [{ path: 'infra/stacks/global/github/teams.tf' }, { rule: 'GIT-0003', adr: 'ADR-0046' }]) {
    const r = judge({ tool: 'trivy-config', findings: [f], exceptions: lines(o, NOW), now: NOW, policy: POLICY5 });
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.equal(r.blocking.length, 1);
    assert.equal(r.unusedExceptions.length, 1);
  }
  // 결과가 없어도(고쳤으면) 줄을 지우라고 막는다. 다른 도구의 판정은 이 줄을 보지 않는다
  assert.equal(judge({ tool: 'trivy-config', findings: [], exceptions: lines({}, NOW), now: NOW, policy: POLICY5 }).ok, false);
  assert.equal(judge({ tool: 'codeql', findings: [], exceptions: lines({}, NOW), now: NOW, policy: POLICY5 }).ok, true);
});

test('받아들인 결과는 알림 줄에 \'받아들인 결과 ADR-…(다시 볼 날 …)\'로 보이고 판정 보고서에 따로 적힌다', async () => {
  const dir = adrDir();
  const files = {
    'out/infra.sarif': sarif(
      run({
        name: 'Trivy',
        rules: [rule('GIT-0001', 9.5)],
        results: [{ ...result('GIT-0001', 'stacks/global/github/repositories.tf', 36), locations: [{ physicalLocation: { artifactLocation: { uri: 'stacks/global/github/repositories.tf', uriBaseId: 'ROOTPATH' }, region: { startLine: 36 } } }] }],
        base: { ROOTPATH: { uri: 'file:///src/infra/' } },
      }),
    ),
  };
  const ex = { exceptions: [accepted({ createdOn: '2026-11-01', reviewOn: '2027-11-01' })] };
  const r = await gate({ tool: 'trivy-config', sarifPath: 'out', files, exceptions: ex, extra: ['--adr-dir', dir] });
  assert.equal(r.code, 0, r.logs);
  assert.match(r.logs, /^알림: .*GIT-0001.*받아들인 결과 ADR-0042\(다시 볼 날 2027-11-01\)/m);
  assert.deepEqual(r.report.accepted.map((f) => [f.rule, f.path, f.accepted.adr, f.accepted.reviewOn]), [['GIT-0001', 'infra/stacks/global/github/repositories.tf', 'ADR-0042', '2027-11-01']]);
  assert.deepEqual(r.report.blocking, []);
  assert.match(r.summary, /받아들인 결과 ADR-0042\(다시 볼 날 2027-11-01\)/);
  // GitHub 주석에서는 그 파일·줄의 경고(알림) 줄이다
  const gha = await gate({ tool: 'trivy-config', sarifPath: 'out', files, exceptions: ex, extra: ['--adr-dir', dir], env: { GITHUB_ACTIONS: 'true' } });
  assert.match(gha.logs, /^::warning file=infra\/stacks\/global\/github\/repositories\.tf,line=36::.*받아들인 결과 ADR-0042\(다시 볼 날 2027-11-01\)/m);
  // ADR 파일이 없는 자리를 주면 판정하지 못해 막는다
  const missing = await gate({ tool: 'trivy-config', sarifPath: 'out', files, exceptions: ex, extra: ['--adr-dir', join(dir, 'none')] });
  assert.equal(missing.code, 1);
  assert.match(missing.report.errors.join('\n'), /ADR 파일/);
});

// ---------- 리뷰 뒤 더한 규칙 ②(docs/devops.md §4.4, ADR-0263 결정 13): 결과 수, 받아들인 결과의 도구·근거, PR의 쓰이지 않는 예외 ----------

test('[ASVS v5.0.0-16.5.3] 받아들인 결과는 IaC 설정 검사에만 쓰고 근거 ADR 파일에 그 규칙 ID가 적혀 있어야 한다(리뷰 H2 재현)', () => {
  const dir = adrDir();
  const parse = (o) => parseScanExceptions(JSON.stringify({ exceptions: [accepted(o)] }), { now: NOW, policy: POLICY5, adrDir: dir });
  assert.equal(parse({}).length, 1);
  // CodeQL 결과는 받아들이지 못한다(고치거나 30일 예외)
  assert.throws(() => parse({ tool: 'codeql', rule: 'js/sql-injection', path: 'services/a/src/x.ts' }), /trivy-config/);
  // ADR 파일은 있지만 그 규칙 ID가 없으면 막는다(비슷한 이름은 세지 않는다)
  assert.throws(() => parse({ adr: 'ADR-0045' }), /GIT-0001/);
  assert.throws(() => parse({ rule: 'GIT-0003' }), /GIT-0003/);
});

test('[ASVS v5.0.0-16.5.3] 예외·받아들인 결과 줄은 맞을 결과 수(count)를 적고 그보다 많이 맞으면 막는다(같은 경로·줄 결과 둘에 count 1, 리뷰 H2 재현)', () => {
  const dir = adrDir();
  const policy = POLICY5;
  const lines = (o, kind = 'accepted') => parseScanExceptions(JSON.stringify({ exceptions: [kind === 'accepted' ? accepted(o) : exception(o)] }), { now: NOW, policy, adrDir: dir });
  for (const [what, o] of [
    ['count 없음', { count: undefined }],
    ['count 0', { count: 0 }],
    ['count 소수', { count: 1.5 }],
    ['count 글', { count: '1' }],
  ]) {
    assert.throws(() => lines(o), /count/, `받아들인 결과 ${what}`);
    assert.throws(() => lines(o, 'exception'), /count/, `예외 ${what}`);
  }
  const g = (line) => ({ tool: 'trivy-config', rule: 'GIT-0001', path: 'infra/stacks/global/github/repositories.tf', line, severity: 9.5 });
  // 같은 경로·같은 줄 결과 둘에 count 1이면 둘 다 막고 그 줄을 '결과 수 넘음'으로 적는다
  const two = judge({ tool: 'trivy-config', findings: [g(36), g(36)], exceptions: lines({ count: 1 }), now: NOW, policy });
  assert.equal(two.ok, false);
  assert.equal(two.blocking.length, 2);
  assert.deepEqual(two.accepted, []);
  assert.deepEqual(two.overCount.map((e) => [e.rule, e.count, e.matched]), [['GIT-0001', 1, 2]]);
  // count 2면 둘 다 받고, 하나만 맞아도(적게 맞음) 받는다
  assert.equal(judge({ tool: 'trivy-config', findings: [g(36), g(40)], exceptions: lines({ count: 2 }), now: NOW, policy }).accepted.length, 2);
  assert.equal(judge({ tool: 'trivy-config', findings: [g(36)], exceptions: lines({ count: 2 }), now: NOW, policy }).ok, true);
  // 30일 예외도 같다
  const x = { tool: 'codeql', rule: 'js/xss', path: 'apps/web/src/a.ts', line: 5, severity: 7.8 };
  const ex2 = judge({ tool: 'codeql', findings: [x, { ...x, line: 99 }], exceptions: lines({}, 'exception'), now: NOW, policy });
  assert.equal(ex2.ok, false);
  assert.deepEqual(ex2.overCount.map((e) => [e.issue, e.count, e.matched]), [[42, 1, 2]]);
});

test('[ASVS v5.0.0-16.5.3] PR에서는 쓰이지 않는 예외를 알림만 남기고 푸시·예약 실행에서는 막는다', async () => {
  const policy = POLICY5;
  const ex = parseScanExceptions(JSON.stringify({ exceptions: [exception()] }), { now: NOW, policy });
  const pr = judge({ tool: 'codeql', findings: [], exceptions: ex, now: NOW, policy, event: 'pull_request' });
  assert.equal(pr.ok, true);
  assert.equal(pr.unusedExceptions.length, 1);
  for (const event of ['push', 'schedule', 'workflow_dispatch', undefined]) assert.equal(judge({ tool: 'codeql', findings: [], exceptions: ex, now: NOW, policy, event }).ok, false, String(event));
  // PR이어도 결과 수를 넘거나 만료된 줄은 막는다
  const x = { tool: 'codeql', rule: 'js/xss', path: 'apps/web/src/a.ts', line: 5, severity: 7.8 };
  assert.equal(judge({ tool: 'codeql', findings: [x, x], exceptions: ex, now: NOW, policy, event: 'pull_request' }).ok, false);
  const later = new Date('2026-11-20T03:00:00Z');
  assert.equal(judge({ tool: 'codeql', findings: [x], exceptions: parseScanExceptions(JSON.stringify({ exceptions: [exception()] }), { now: later, policy }), now: later, policy, event: 'pull_request' }).ok, false);
  // 명령줄: --event pull_request면 쓰이지 않는 예외는 알림(통과), 주지 않으면 막음
  const files = { 'c/javascript.sarif': codeql([]) };
  const r = await gate({ tool: 'codeql', files, sarifPath: 'c', exceptions: { exceptions: [exception()] }, extra: ['--event', 'pull_request'] });
  assert.equal(r.code, 0, r.logs);
  assert.match(r.logs, /^알림: 쓰이지 않는 예외/m);
  assert.equal((await gate({ tool: 'codeql', files, sarifPath: 'c', exceptions: { exceptions: [exception()] }, extra: ['--event', 'push'] })).code, 1);
});

// ---------- 리뷰 뒤 더한 규칙 ⑦과 독립 검사 M24: 직접 실행 판별, 기본 정책(명령줄)의 한국 날짜 경계 ----------

test('판정 도구는 링크 경로로 실행해도 판정하고, 직접 실행 판별이 맞지 않으면 통과가 아니라 실패로 끝낸다', async () => {
  const { symlinkSync } = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  const { isMain } = await import('./entry.mjs');
  const dir = tempDir('scan-gate-link-');
  const link = join(dir, 'ci');
  symlinkSync(HERE, link, 'junction');
  writeFileSync(join(dir, 'block.sarif'), codeql([result('js/xss', 'apps/web/src/a.ts', 7)]));
  writeFileSync(join(dir, 'ok.sarif'), codeql([]));
  const viaLink = (s) => spawnSync(process.execPath, [join(link, 'scan-gate.mjs'), '--tool', 'codeql', '--sarif', join(dir, s), '--exceptions', join(dir, 'ex.json')], { encoding: 'utf8' });
  writeFileSync(join(dir, 'ex.json'), JSON.stringify({ exceptions: [] }));
  const blocked = viaLink('block.sarif');
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /막음: codeql 막음 1/);
  const passed = viaLink('ok.sarif');
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.match(passed.stdout, /통과: codeql/);
  // 판별: 실제 경로가 같으면 참, 다른 파일이면 거짓, 이름은 같은데 경로가 다르면(판별 실패) 던진다
  const self = pathToFileURL(join(HERE, 'scan-gate.mjs')).href;
  assert.equal(isMain(self, join(link, 'scan-gate.mjs')), true);
  assert.equal(isMain(self, join(HERE, 'scan-gate.test.mjs')), false);
  assert.equal(isMain(self, undefined), false);
  assert.throws(() => isMain(self, join(dir, 'elsewhere', 'scan-gate.mjs')), /직접 실행/);
  // 다른 판정 도구도 같은 판별을 쓴다
  for (const f of ['scan-gate.mjs', 'scan-tools.mjs', 'vuln-deadline.mjs', 'check-repo-visibility.mjs']) assert.match(readFileSync(join(HERE, f), 'utf8'), /runIfMain\(import\.meta\.url,/, f);
});

test('[ASVS v5.0.0-16.5.3] 기본 정책(명령줄, 정책 인자 없음)으로도 예외 만료일·다시 볼 날은 한국 날짜로 그날 끝까지 받고 다음 날 막는다(M24)', () => {
  const dir = tempDir('scan-gate-kst-');
  const adr = join(dir, 'adr');
  mkdirSync(adr);
  writeFileSync(join(adr, '0077-accepted.md'), '# ADR-0077\n\nGIT-0001을 받아들인다.\n');
  const ex = join(dir, 'ex.json');
  writeFileSync(
    ex,
    JSON.stringify({
      exceptions: [
        exception({ createdOn: '2026-11-01', expiresOn: '2026-11-11' }),
        { tool: 'trivy-config', rule: 'GIT-0001', path: 'infra/stacks/global/github/repositories.tf', reason: '공개 모노레포라 받아들인 결과다(시험)', adr: 'ADR-0077', count: 1, createdOn: '2026-11-01', reviewOn: '2026-11-11' },
      ],
    }),
  );
  writeFileSync(join(dir, 'c.sarif'), codeql([result('js/xss', 'apps/web/src/a.ts', 5)]));
  writeFileSync(
    join(dir, 't.sarif'),
    sarif(run({ name: 'Trivy', rules: [rule('GIT-0001', 9.5)], results: [{ ...result('GIT-0001', 'stacks/global/github/repositories.tf', 36), locations: [{ physicalLocation: { artifactLocation: { uri: 'stacks/global/github/repositories.tf', uriBaseId: 'ROOTPATH' }, region: { startLine: 36 } } }] }], base: { ROOTPATH: { uri: 'file:///src/infra/' } } })),
  );
  const cli = (tool, file, now) => {
    const report = join(dir, `${tool}-${now}.json`.replace(/:/g, ''));
    const r = spawnSync(process.execPath, [SCRIPT, '--tool', tool, '--sarif', join(dir, file), '--exceptions', ex, '--adr-dir', adr, '--now', now, '--report', report, '--event', 'pull_request'], { encoding: 'utf8' });
    return { code: r.status, report: JSON.parse(readFileSync(report, 'utf8')), out: r.stdout };
  };
  for (const [tool, file] of [['codeql', 'c.sarif'], ['trivy-config', 't.sarif']]) {
    const last = cli(tool, file, '2026-11-11T14:59:59.999Z');
    assert.equal(last.code, 0, `${tool}: ${last.out}`);
    assert.equal(last.report.today, '2026-11-11');
    const next = cli(tool, file, '2026-11-11T15:00:00Z');
    assert.equal(next.code, 1, `${tool}: ${next.out}`);
    assert.equal(next.report.today, '2026-11-12');
    assert.equal(next.report.expiredExceptions.length, 1);
  }
});

// ---------- 다시 보기 5·7 ----------

test('[ASVS v5.0.0-16.5.3] PR에서 쓰이지 않는 예외를 알림만 남기는 것은 CodeQL뿐이고 IaC 설정 검사는 PR에서도 막는다(다시 보기 5)', () => {
  const dir = adrDir();
  const policy = POLICY5;
  const ex = parseScanExceptions(JSON.stringify({ exceptions: [accepted()] }), { now: NOW, policy, adrDir: dir });
  const pr = judge({ tool: 'trivy-config', findings: [], exceptions: ex, now: NOW, policy, event: 'pull_request' });
  assert.equal(pr.ok, false);
  assert.equal(pr.unusedExceptions.length, 1);
  const cq = parseScanExceptions(JSON.stringify({ exceptions: [exception()] }), { now: NOW, policy });
  assert.equal(judge({ tool: 'codeql', findings: [], exceptions: cq, now: NOW, policy, event: 'pull_request' }).ok, true);
});

test('IaC 설정 검사의 여러 결과 파일에 같은 (규칙, 경로, 줄) 결과가 있으면 하나로 센다(두 번 그린 공용 차트, 다시 보기 7)', () => {
  const trivy = (dir, rows) =>
    sarif(run({ name: 'Trivy', rules: [rule('KSV-0011', 2.0), rule('KSV-0118', 8.0)], results: rows.map(([id, uri, line]) => ({ ...result(id, uri, line), locations: [{ physicalLocation: { artifactLocation: { uri, uriBaseId: 'ROOTPATH' }, region: { startLine: line } } }] })), base: { ROOTPATH: { uri: `file:///src/${dir}/` } } }));
  const { findings } = readFindings(
    [
      { file: 'deploy.sarif', text: trivy('deploy', [['KSV-0011', 'charts/peaket-service/templates/deployment.yaml', 35], ['KSV-0118', 'charts/peaket-service/templates/deployment.yaml', 40]]) },
      { file: 'chart-ci.sarif', text: trivy('deploy/charts', [['KSV-0011', 'peaket-service/templates/deployment.yaml', 35], ['KSV-0011', 'peaket-service/templates/outbox-relay.yaml', 39], ['KSV-0118', 'peaket-service/templates/deployment.yaml', 41]]) },
    ],
    'trivy-config',
  );
  assert.deepEqual(findings.map((f) => `${f.rule} ${f.path}:${f.line}`).sort(), [
    'KSV-0011 deploy/charts/peaket-service/templates/deployment.yaml:35',
    'KSV-0011 deploy/charts/peaket-service/templates/outbox-relay.yaml:39',
    'KSV-0118 deploy/charts/peaket-service/templates/deployment.yaml:40',
    'KSV-0118 deploy/charts/peaket-service/templates/deployment.yaml:41',
  ]);
  // 다른 도구는 합치지 않는다(같은 줄의 비밀 둘은 둘이다)
  const g = gitleaks([gitleaksResult('a.ts', 1, 'c'.repeat(40)), gitleaksResult('a.ts', 1, 'c'.repeat(40))]);
  assert.equal(readFindings([{ file: 'g.sarif', text: g }], 'gitleaks').findings.length, 2);
});

test('잡 요약 표 칸은 역슬래시를 먼저 이스케이프한 뒤 | 를 이스케이프해 칸이 나뉘지 않는다(CodeQL js/incomplete-sanitization)', () => {
  // 원문 a\|b: 역슬래시를 그대로 두면 a\\|b가 되어 \\가 역슬래시 하나로 읽히고 |가 칸을 나눈다
  assert.equal(markdownCell('a\\|b'), 'a\\\\\\|b');
  assert.equal(markdownCell('C:\\x|y'), 'C:\\\\x\\|y');
  assert.equal(markdownCell('줄\n바꿈\r\n둘'), '줄 바꿈 둘');
  assert.equal(markdownCell(undefined), '');
  // 이스케이프한 칸은 이스케이프되지 않은 | 가 없다(표 칸이 하나로 남는다)
  for (const raw of ['a\\|b', 'a\\\\|b', '\\|\\|', 'x|y\\']) {
    const c = markdownCell(raw);
    assert.equal(c.replace(/\\\\/g, '').replace(/\\\|/g, '').includes('|'), false, raw);
  }
});
