// 외부 보안 검사 게이트 워크플로 모양 시험(docs/devops.md §3.1 security-scan.yml·build-image.yml 행·§4.4 '외부 보안 검사 게이트',
// ADR-0263 결정 2·3·7·8, ASVS 13.3.1, BUILD_ORDER BAS-011 ②). 도구 시험(scan-tools·scan-gate)과 따로 실제 워크플로 파일을 읽어 조립을 본다.
// 실행: node --test "tools/ci/*.test.mjs" (yaml 패키지는 뿌리 devDependencies, tools-check는 설치한 뒤 돈다)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YAML = await import('yaml').catch(() => null);
const skip = !YAML && 'yaml 패키지가 없다(pnpm install 전)';
const read = (p) => readFileSync(join(REPO, p), 'utf8');
const load = (p) => YAML.parse(read(p));
// 계획 2장·ADR-0263 결정 1의 커밋(40자리)
const CODEQL_SHA = '9b3254085494b55a0f7c4c2b3d2d52cc712ce370';
const SCORECARD_SHA = ['fa7117db83c52d787ae5a89f35', '0999701505d78e'].join('');
const steps = (job) => job.steps ?? [];
const runs = (job) => steps(job).map((s) => s.run ?? '').join('\n');
const usesOf = (job, prefix) => steps(job).filter((s) => String(s.uses ?? '').startsWith(prefix));
const perms = (p) => (p && typeof p === 'object' ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])) : p);

/** GitHub 식(${{ … }})을 문맥으로 계산한다: 글자, 문맥 이름, ==·!=, &&·||(값을 돌려주는 JS와 같은 뜻), 괄호, ! */
function evalGh(expr, ctx) {
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(String(expr).trim());
  assert.ok(body, `식 꼴이 아니다: ${expr}`);
  const tokens = body[1].match(/'[^']*'|==|!=|&&|\|\||[()!]|[\w.-]+/g);
  let i = 0;
  const peek = () => tokens[i];
  const primary = () => {
    const t = tokens[i++];
    if (t === '(') {
      const v = or();
      assert.equal(tokens[i++], ')');
      return v;
    }
    if (t === '!') return !primary();
    if (t.startsWith("'")) return t.slice(1, -1);
    if (t === 'true' || t === 'false') return t === 'true';
    assert.ok(t in ctx, `문맥에 없다: ${t}`);
    return ctx[t];
  };
  const cmp = () => {
    let v = primary();
    while (peek() === '==' || peek() === '!=') {
      const op = tokens[i++];
      const r = primary();
      v = op === '==' ? v === r : v !== r;
    }
    return v;
  };
  const and = () => {
    let v = cmp();
    while (peek() === '&&') {
      i++;
      const r = cmp();
      v = v && r;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek() === '||') {
      i++;
      const r = and();
      v = v || r;
    }
    return v;
  };
  const v = or();
  assert.equal(i, tokens.length, `다 읽지 못했다: ${expr}`);
  return v;
}

/** ${{ a == 'x' || b != 'y' }} 꼴(|| 와 ==·!= 만)의 식을 문맥으로 계산한다 */
function evalOr(expr, ctx) {
  const body = /^\$\{\{\s*([\s\S]*?)\s*\}\}$/.exec(String(expr).trim());
  assert.ok(body, `식 꼴이 아니다: ${expr}`);
  return body[1].split('||').some((term) => {
    const m = /^\s*([\w.]+)\s*(==|!=)\s*'([^']*)'\s*$/.exec(term);
    assert.ok(m, `계산하지 못하는 항: ${term}`);
    const v = ctx[m[1]];
    assert.notEqual(v, undefined, `문맥에 없다: ${m[1]}`);
    return m[2] === '==' ? v === m[3] : v !== m[3];
  });
}

test('[ASVS v5.0.0-13.3.1] secrets 잡은 전체 이력을 받고 contents: read뿐이며 도구 원본 보고서를 산출물로 올리지 않는다', { skip }, () => {
  const wf = load('.github/workflows/security-scan.yml');
  const job = wf.jobs.secrets;
  assert.ok(job, 'secrets 잡이 없다');
  assert.deepEqual(perms(wf.permissions), { contents: 'read' });
  assert.ok(job.permissions === undefined || JSON.stringify(perms(job.permissions)) === JSON.stringify({ contents: 'read' }), JSON.stringify(job.permissions));
  assert.equal(job.if, undefined, '늘 돈다');
  const [checkout] = usesOf(job, 'actions/checkout@');
  assert.equal(Number(checkout.with['fetch-depth']), 0, '전체 이력을 받는다');
  assert.equal(String(checkout.with['persist-credentials']), 'false');
  const text = runs(job);
  const fetchAt = text.indexOf('scan-tools.mjs fetch-gitleaks');
  const scanAt = text.indexOf('scan-tools.mjs gitleaks');
  const gateAt = text.indexOf('scan-gate.mjs --tool gitleaks');
  assert.ok(fetchAt >= 0 && scanAt > fetchAt && gateAt > scanAt, '받기 → 검사 → 판정 차례');
  assert.match(text, /scan-gate\.mjs --tool gitleaks[^\n]*--exit-code/, '판정이 gitleaks 종료 코드를 받는다');
  // 예약 실행만 모든 가지·태그(--all-refs)를 본다(devops §4.4 '리뷰 뒤 더한 규칙' ⑤). 판정은 사건 이름을 받아 PR의 쓰이지 않는 예외를 알림만 남긴다(②)
  assert.match(text, /if \[ "\$GITHUB_EVENT_NAME" = "schedule" \]; then extra\+=\(--all-refs\); fi/);
  assert.match(text, /scan-tools\.mjs gitleaks [^\n]*"\$\{extra\[@\]\}"/);
  assert.match(text, /scan-gate\.mjs --tool gitleaks[^\n]*--event "\$GITHUB_EVENT_NAME"/);
  // 판정은 검사 단계가 실패해도 돈다(종료 코드를 남긴다)
  const gate = steps(job).find((s) => /scan-gate\.mjs --tool gitleaks/.test(s.run ?? ''));
  assert.match(String(gate.if), /!cancelled\(\)/);
  // 산출물은 판정 보고서뿐이다(가린 원본 SARIF도 올리지 않는다)
  const uploads = usesOf(job, 'actions/upload-artifact@');
  assert.equal(uploads.length, 1);
  assert.match(String(uploads[0].with.path), /secrets-gate\.json$/);
  assert.doesNotMatch(String(uploads[0].with.path), /\.sarif|gitleaks\.json/);
  assert.equal(Number(uploads[0].with['retention-days']), 30);
  // 비밀 값을 들이지 않는다
  assert.doesNotMatch(JSON.stringify(job), /secrets\./);
});

test('codeql 잡만 security-events: write이고 PR에서는 올리지 않으며 tools·trap 캐시를 쓰지 않는다', { skip }, () => {
  const wf = load('.github/workflows/security-scan.yml');
  for (const [name, job] of Object.entries(wf.jobs)) {
    const p = perms(job.permissions) ?? {};
    if (name === 'codeql') assert.deepEqual(p, { contents: 'read', 'security-events': 'write' });
    else assert.equal(p['security-events'], undefined, name);
    for (const k of ['id-token', 'packages', 'attestations']) assert.notEqual(p[k], 'write', `${name} ${k}`);
  }
  const job = wf.jobs.codeql;
  assert.match(String(job.if), /inputs\.sast/);
  assert.match(String(job.if), /github\.event_name == 'schedule'/);
  assert.match(String(job.if), /github\.event_name == 'workflow_dispatch'/);
  const [init] = usesOf(job, 'github/codeql-action/init@');
  const [analyze] = usesOf(job, 'github/codeql-action/analyze@');
  assert.equal(init.uses, `github/codeql-action/init@${CODEQL_SHA}`);
  assert.equal(analyze.uses, `github/codeql-action/analyze@${CODEQL_SHA}`);
  assert.match(read('.github/workflows/security-scan.yml'), new RegExp(`codeql-action/init@${CODEQL_SHA} # v4\\.39\\.1`));
  assert.equal(init.with.languages, 'javascript-typescript');
  assert.equal(init.with['build-mode'], 'none');
  assert.equal(init.with['config-file'], 'tools/ci/codeql-config.yml');
  assert.equal(String(init.with['trap-caching']), 'false');
  assert.equal('tools' in init.with, false, 'CodeQL 묶음은 액션 판이 정한 것(tools를 주지 않는다)');
  assert.equal(analyze.with.category, '/language:javascript-typescript');
  assert.match(String(analyze.with.output), /runner\.temp/);
  // 코드 스캐닝에 올리는 것은 develop 푸시와 예약 실행뿐이다(정본 ADR-0263 결정 3, devops §4.4 '리뷰 뒤 더한 규칙' ⑦)
  const upload = (event, ref) => evalGh(analyze.with.upload, { 'github.event_name': event, 'github.ref': ref });
  assert.equal(upload('pull_request', 'refs/pull/1/merge'), 'never');
  assert.equal(upload('push', 'refs/heads/develop'), 'always');
  assert.equal(upload('push', 'refs/heads/feature/x'), 'never');
  assert.equal(upload('push', 'refs/heads/main'), 'never');
  assert.equal(upload('schedule', 'refs/heads/develop'), 'always');
  assert.equal(upload('workflow_dispatch', 'refs/heads/develop'), 'never');
  assert.match(runs(job), /scan-gate\.mjs --tool codeql --sarif "\$RUNNER_TEMP\/codeql"[^\n]*--event "\$GITHUB_EVENT_NAME"/);
  assert.ok(steps(job).findIndex((s) => /scan-gate/.test(s.run ?? '')) > steps(job).indexOf(analyze), '판정은 분석 뒤');
});

test('scorecard는 security-scan.yml이 아니라 따로 된 scorecard.yml(주 1회·수동)에서 돌고 publish_results false이며 id-token이 없다', { skip }, () => {
  const text = read('.github/workflows/scorecard.yml');
  const wf = YAML.parse(text);
  assert.deepEqual(wf.on.schedule, [{ cron: '0 0 * * 1' }], '월요일 09:00 KST');
  assert.ok('workflow_dispatch' in wf.on);
  assert.equal('workflow_call' in wf.on, false, '다른 워크플로가 부르지 않는다');
  assert.deepEqual(perms(wf.permissions), { contents: 'read' });
  assert.deepEqual(Object.keys(wf.jobs), ['scorecard']);
  const job = wf.jobs.scorecard;
  assert.deepEqual(perms(job.permissions), { contents: 'read', actions: 'read' });
  const [sc] = usesOf(job, 'ossf/scorecard-action@');
  assert.equal(sc.uses, `ossf/scorecard-action@${SCORECARD_SHA}`);
  assert.match(text, new RegExp(`ossf/scorecard-action@${SCORECARD_SHA} # v2\\.5\\.0`));
  assert.equal(String(sc.with.publish_results), 'false');
  assert.equal(sc.with.results_format, 'sarif');
  assert.equal(typeof sc.with.results_file, 'string');
  assert.equal('repo_token' in sc.with, false, '비밀 토큰을 따로 주지 않는다');
  assert.doesNotMatch(text, /id-token/);
  const [up] = usesOf(job, 'actions/upload-artifact@');
  assert.equal(up.with.path, sc.with.results_file);
  assert.equal(Number(up.with['retention-days']), 30);
  // 코드 스캐닝에 올리지 않는다
  assert.equal(usesOf(job, 'github/codeql-action/upload-sarif@').length, 0);
  // security-scan.yml(ci.yml이 PR마다 부른다)에는 Scorecard도 actions 권한도 없다(리뷰 H1)
  const scan = read('.github/workflows/security-scan.yml');
  assert.doesNotMatch(scan, /scorecard-action/);
  assert.equal('scorecard' in YAML.parse(scan).jobs, false);
  assert.doesNotMatch(scan, /^\s+actions:\s*(read|write)/m);
  // 어느 워크플로도 scorecard.yml을 부르지 않는다
  for (const f of readdirSync(join(REPO, '.github', 'workflows'))) assert.doesNotMatch(read(`.github/workflows/${f}`), /uses:\s*\.\/\.github\/workflows\/scorecard\.ya?ml/, f);
  // 예약 실행에서도 의존성 판정은 라이선스 목록 없이 돈다(입력이 없다)
  assert.match(String(YAML.parse(scan).jobs.dependencies.steps.find((s) => /라이선스 목록/.test(s.name ?? '')).if), /inputs\.licenses/);
});

test('iac-config 잡은 Trivy 설정 검사를 고정 표의 이미지로 돌리고 판정한다(워크플로에 이미지 글이 없다)', { skip }, () => {
  const wf = load('.github/workflows/security-scan.yml');
  const job = wf.jobs['iac-config'];
  assert.equal(job.if, undefined, '늘 돈다');
  assert.equal(job.permissions, undefined, '맨 위 권한(contents: read)뿐이다');
  const text = runs(job);
  assert.match(text, /scan-tools\.mjs trivy-config --out "\$RUNNER_TEMP\/trivy-config"/);
  assert.match(text, /scan-gate\.mjs --tool trivy-config --sarif "\$RUNNER_TEMP\/trivy-config"[^\n]*--event "\$GITHUB_EVENT_NAME"/);
  // 공개 모노레포를 받아들인 대신 봇 저장소가 비공개인지 따로 막는다(리뷰 뒤 더한 규칙 ②, POL-026). Trivy 앞에서 돈다
  const vis = steps(job).findIndex((x) => /node tools\/ci\/check-repo-visibility\.mjs/.test(x.run ?? ''));
  const scanStep = steps(job).findIndex((x) => /scan-tools\.mjs trivy-config/.test(x.run ?? ''));
  assert.ok(vis >= 0 && vis < scanStep, `차례: 비공개 검사 ${vis} → 설정 검사 ${scanStep}`);
  const [up] = usesOf(job, 'actions/upload-artifact@');
  assert.equal(Number(up.with['retention-days']), 30);
  for (const f of readdirSync(join(REPO, '.github', 'workflows'))) assert.doesNotMatch(read(`.github/workflows/${f}`), /aquasec(urity)?\/trivy|trivy-action|setup-trivy/, f);
});

test('[ASVS v5.0.0-13.3.1] build-image.yml 빌드 잡은 이미지 묶음을 올리기 전에 이미지 비밀 검사와 판정을 하고 판정 보고서만 7일 남긴다', { skip }, () => {
  const wf = load('.github/workflows/build-image.yml');
  const job = wf.jobs.build;
  const s = steps(job);
  const build = s.findIndex((x) => /image-build\.mjs/.test(x.run ?? ''));
  const scan = s.findIndex((x) => /scan-tools\.mjs trivy-image --input "image-out\/\$IMAGE-\$ARCH\.oci\.tar"/.test(x.run ?? ''));
  const gate = s.findIndex((x) => /scan-gate\.mjs --tool trivy-secret/.test(x.run ?? ''));
  const bundle = s.findIndex((x) => String(x.uses ?? '').startsWith('actions/upload-artifact@') && x.with?.path === 'image-out/');
  assert.ok(build >= 0 && scan > build && gate > scan && bundle > gate, `차례: 빌드 ${build} → 검사 ${scan} → 판정 ${gate} → 묶음 올리기 ${bundle}`);
  assert.match(String(s[gate].if), /!cancelled\(\)/);
  // 묶음 올리기는 판정이 통과해야 한다(조건 없이 앞 단계 성공에 기댄다)
  assert.equal(s[bundle].if, undefined);
  const report = s.find((x) => String(x.uses ?? '').startsWith('actions/upload-artifact@') && /image-secret-gate/.test(String(x.with?.path)));
  assert.ok(report, '판정 보고서 올리기');
  assert.equal(Number(report.with['retention-days']), 7);
  assert.doesNotMatch(String(report.with.path), /\.sarif/);
  assert.deepEqual(perms(job.permissions), { contents: 'read' });
});

test('ci.yml은 푸시에서 sast를 늘 켠다', { skip }, () => {
  const wf = load('.github/workflows/ci.yml');
  const job = wf.jobs['security-scan'];
  assert.equal(job.uses, './.github/workflows/security-scan.yml');
  // 부르는 잡이 주는 권한은 부른 워크플로의 잡들이 달라는 권한의 합과 같다(넘치게 주지 않고, 모자라면 GitHub이 실행을 시작하지 않는다, 리뷰 H1)
  const called = load('.github/workflows/security-scan.yml');
  const LEVEL = { none: 0, read: 1, write: 2 };
  const need = {};
  for (const j of Object.values(called.jobs)) {
    for (const [k, v] of Object.entries(perms(j.permissions ?? called.permissions) ?? {})) if (LEVEL[v] > LEVEL[need[k] ?? 'none']) need[k] = v;
  }
  assert.deepEqual(perms(job.permissions), need);
  assert.equal(need['security-events'], 'write', 'codeql 잡이 결과를 올린다');
  const ctx = (o) => ({ 'needs.changes.result': 'success', 'needs.changes.outputs.js': 'false', 'needs.changes.outputs.tools': 'false', 'needs.changes.outputs.ci': 'false', 'github.event_name': 'pull_request', ...o });
  const sast = job.with.sast;
  assert.equal(evalOr(sast, ctx({ 'github.event_name': 'push' })), true, '푸시는 늘');
  assert.equal(evalOr(sast, ctx({})), false, '문서만 바뀐 PR은 건너뛴다');
  for (const k of ['needs.changes.outputs.js', 'needs.changes.outputs.tools', 'needs.changes.outputs.ci']) assert.equal(evalOr(sast, ctx({ [k]: 'true' })), true, k);
  assert.equal(evalOr(sast, ctx({ 'needs.changes.result': 'failure' })), true, '범위를 못 골랐으면 돈다');
  assert.equal(evalOr(job.with.licenses, ctx({})), false);
  assert.equal(evalOr(job.with.licenses, ctx({ 'needs.changes.outputs.js': 'true' })), true);
});

test('codeql-config는 apps·services·packages·tools를 보고 빼는 것은 시험·생성물·빌드 결과와 운영에 배포하지 않는 결제 시뮬레이터뿐이다', { skip }, () => {
  const cfg = load('tools/ci/codeql-config.yml');
  assert.deepEqual(Object.keys(cfg).sort(), ['name', 'paths', 'paths-ignore'], '쿼리를 빼거나 바꾸는 키(queries·query-filters·disable-default-queries)가 없다');
  assert.deepEqual([...cfg.paths].sort(), ['apps', 'packages', 'services', 'tools']);
  const TEST = /^\*\*\/(?:test|test-int|tests|__tests__|e2e)$|^\*\*\/\*\.(?:test|spec)\.\*$|^\*\*\/\*\.test\.harness\.\*$/;
  const GEN = /^\*\*\/gen$|^packages\/contracts\/src\/gen$/;
  const BUILD = /^\*\*\/(?:node_modules|dist|dist-poc|\.next|\.next-\*|\.turbo|coverage|storybook-static|out)$/;
  // 운영에 배포하지 않는 결제 시뮬레이터(ADR-0263 결정 14) 하나만 서비스 폴더로 뺄 수 있다. 다른 서비스를 빼면 실패한다
  const NOT_DEPLOYED = new Set(['services/pg-simulator']);
  const allowed = (p) => TEST.test(p) || GEN.test(p) || BUILD.test(p) || NOT_DEPLOYED.has(p);
  for (const p of ['services/payment-svc', 'services/pg-simulator/src', 'services/*', 'services', 'apps/web', 'packages/platform', 'tools/ci', 'services/pg-simulator-x']) assert.equal(allowed(p), false, `뺄 수 없는 곳을 받는다: ${p}`);
  assert.ok(cfg['paths-ignore'].includes('services/pg-simulator'), '결제 시뮬레이터를 뺀다');
  assert.ok(cfg['paths-ignore'].length > 0);
  for (const p of cfg['paths-ignore']) assert.ok(allowed(p), `시험·생성물·빌드 결과·시뮬레이터가 아닌 것을 뺀다: ${p}`);
  for (const must of ['**/node_modules', '**/dist', '**/test', '**/*.test.*']) assert.ok(cfg['paths-ignore'].includes(must), must);
});
