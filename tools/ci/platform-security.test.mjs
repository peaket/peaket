// 플랫폼 보안 설정 정적·계약 시험(기능 F-09-4, 계획 docs/review/plans/F-09-4.md §5·§6).
// 정본: docs/infra.md §4.1·§9·WAF 규칙표, docs/devops.md §8.3·§9.4·D-T30·D-T37, docs/security/secrets-and-keys.md,
// docs/security/asvs/delivery.md 3.4.1·3.4.3·3.4.4·3.4.6·13.1.4·13.3.4, docs/features/search.md SR-T11 ②.
// 실제 AWS를 부르지 않는다. 계획 JSON과 저장소 코드를 읽어 규칙만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'tools', 'ci', 'platform-security.mjs');
const TEMP_DIRS = [];

const HSTS = 'max-age=31536000; includeSubDomains';
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";

function temp(files) {
  const root = mkdtempSync(join(tmpdir(), 'peaket-platform-security-'));
  TEMP_DIRS.push(root);
  for (const [path, body] of Object.entries(files)) write(root, path, body);
  return root;
}

function write(root, path, body) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function realPlan(module, file) {
  return JSON.parse(readFileSync(join(REPO, 'infra', 'modules', module, file), 'utf8'));
}

function header(value) {
  return { value, override: true };
}

function planHeaders(extra = {}) {
  return {
    'Strict-Transport-Security': header(HSTS),
    'X-Content-Type-Options': header('nosniff'),
    'Content-Security-Policy': header(DEFAULT_CSP),
    'Referrer-Policy': header('strict-origin-when-cross-origin'),
    ...extra,
  };
}

function behavior(path, cachePolicy, responseHeadersPolicy, originRequestPolicy) {
  return { path, cachePolicy, responseHeadersPolicy, originRequestPolicy, viewerProtocolPolicy: 'redirect-to-https' };
}

function validEdgePlan() {
  const noStore = { minTtl: 0, defaultTtl: 0, maxTtl: 0, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } };
  return {
    tls: { viewerMinimumProtocolVersion: 'TLSv1.2_2021', originProtocolPolicy: 'https-only', originSslProtocols: ['TLSv1.2'] },
    distributions: [
      {
        name: 'www',
        hosts: ['www.peaket.example'],
        webAcl: 'screen-partner-console',
        defaultBehavior: behavior('default', 'screen-html', 'screen-app-csp', 'www-app'),
        behaviors: [
          behavior('/_t/*', 'no-store', 'screen', 'www-app'),
          behavior('/serwist/*', 'static', 'screen', 'static'),
        ],
      },
      { name: 'queue', hosts: ['queue.peaket.example'], webAcl: 'queue-api', defaultBehavior: behavior('default', 'no-store', 'api', 'queue-api'), behaviors: [] },
      {
        name: 'queue-files',
        hosts: ['queue-files.peaket.example'],
        webAcl: null,
        defaultBehavior: behavior('default', 'static', 'queue-result', 'static'),
        behaviors: [
          behavior('/v1/queues/*/shuffle-results/*', 'static', 'queue-result', 'static'),
          behavior('/v1/queues/*/batch-results/*', 'static', 'queue-result', 'static'),
          behavior('/v1/queues/*/shuffle-proof', 'shuffle-proof', 'queue-result', 'static'),
        ],
      },
      { name: 'api', hosts: ['api.peaket.example'], webAcl: 'api', defaultBehavior: behavior('default', 'search-api', 'api', 'api'), behaviors: [] },
      { name: 'partner', hosts: ['partner.peaket.example'], webAcl: 'screen-partner-console', defaultBehavior: behavior('default', 'screen-html', 'screen-app-csp', 'www-app'), behaviors: [] },
      {
        name: 'console',
        hosts: ['console.peaket.example'],
        webAcl: 'screen-partner-console',
        defaultBehavior: behavior('default', 'screen-html', 'screen-app-csp', 'www-app'),
        behaviors: [behavior('/remotes/*', 'static', 'screen', 'static')],
      },
      { name: 'scanner', hosts: ['scanner.peaket.example'], webAcl: 'screen-partner-console', defaultBehavior: behavior('default', 'static', 'screen', 'static'), behaviors: [] },
      { name: 'developers', hosts: ['developers.peaket.example'], webAcl: null, defaultBehavior: behavior('default', 'static', 'api', 'static'), behaviors: [] },
    ],
    cachePolicies: [
      { name: 'screen-html', minTtl: 0, defaultTtl: 60, maxTtl: 300, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } },
      noStore,
      { name: 'static', minTtl: 86_400, defaultTtl: 2_592_000, maxTtl: 31_536_000, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } },
      { name: 'search-api', minTtl: 0, defaultTtl: 60, maxTtl: 300, cacheKey: { cookies: 'none', headers: 'none', queryStrings: ['q', 'page', 'limit'] } },
      { name: 'shuffle-proof', minTtl: 0, defaultTtl: 5, maxTtl: 5, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } },
    ],
    responseHeadersPolicies: [
      { name: 'screen', override: true, frameAncestors: 'none', headers: planHeaders() },
      {
        name: 'screen-app-csp',
        override: false,
        frameAncestors: 'none',
        headers: {
          'Strict-Transport-Security': header(HSTS),
          'X-Content-Type-Options': header('nosniff'),
          'Referrer-Policy': header('strict-origin-when-cross-origin'),
        },
      },
      { name: 'api', override: true, frameAncestors: 'none', headers: planHeaders() },
      {
        name: 'queue-result',
        override: true,
        frameAncestors: 'none',
        headers: planHeaders({ 'Access-Control-Allow-Origin': header('https://www.peaket.example') }),
      },
    ],
    webAcls: [
      {
        name: 'queue-api',
        rules: [
          { id: 'ip-reputation', action: 'count' },
          { id: 'common', action: 'count' },
          { id: 'rate', action: 'count', windowSec: 300 },
        ],
      },
      {
        name: 'screen-partner-console',
        rules: [
          { id: 'ip-reputation', action: 'count' },
          { id: 'common', action: 'count' },
          { id: 'rate', action: 'count', windowSec: 300 },
          {
            id: 'bot-control',
            action: 'count',
            level: 'common',
            scopeDown: { hosts: ['www.peaket.example'], paths: ['/login', '/auth/*'] },
          },
        ],
      },
      {
        name: 'api',
        rules: [
          { id: 'ip-reputation', action: 'count' },
          { id: 'common', action: 'count' },
          { id: 'rate', action: 'count', windowSec: 300 },
        ],
      },
    ],
    logging: {
      destination: 's3',
      fields: ['date', 'time', 'cs-method', 'cs-uri-stem', 'sc-status', 'x-edge-result-type'],
      dropAllowedVerdicts: true,
      queryString: 'excluded',
    },
    invalidation: {
      tagHeader: 'x-peaket-cache-tag',
      tags: ['event:{id}', 'home'],
      paths: [{ distribution: 'api', path: '/v1/search*' }],
    },
    originRequestPolicies: [
      { name: 'www-app', headers: ['CloudFront-Viewer-ASN'] },
      { name: 'queue-api', headers: ['CloudFront-Viewer-ASN', 'CloudFront-Viewer-JA4-Fingerprint'] },
      { name: 'api', headers: ['CloudFront-Viewer-ASN', 'CloudFront-Viewer-JA4-Fingerprint'] },
      { name: 'static', headers: [] },
    ],
    queueFiles: {
      fallbackOrigin: { path: '/queue/fallback', s3ListBucketPrefixes: ['queue/shuffle-results/', 'queue/batch-results/'] },
      resultPathPrefixes: ['/v1/queues/*/shuffle-results/*', '/v1/queues/*/batch-results/*'],
      errorCachingMinTtl: 1,
      resultHeaders: { 'Access-Control-Allow-Origin': 'https://www.peaket.example' },
      shuffleProof: { path: '/v1/queues/*/shuffle-proof', cacheControl: 'public, max-age=5' },
    },
    staticRetention: { days: 30, recentBuilds: 5 },
  };
}

function validIamPlan() {
  return {
    workloads: [
      {
        name: 'purchase-svc',
        podIdentityRole: 'peaket-purchase-svc',
        mskRole: 'peaket-purchase-svc-msk',
        trust: { principal: 'pod-identity:peaket-purchase-svc', actions: ['sts:AssumeRole'] },
        sessionName: 'purchase-svc-{env}',
        podIdentityActions: ['s3:GetObject'],
        clusters: {
          'trade-control': [
            { topic: 'trade.orders', actions: ['WriteData', 'DescribeTopic', 'Connect'] },
          ],
        },
      },
      {
        name: 'queue-svc',
        podIdentityRole: 'peaket-queue-svc',
        mskRole: 'peaket-queue-svc-msk',
        trust: { principal: 'pod-identity:peaket-queue-svc', actions: ['sts:AssumeRole'] },
        sessionName: 'queue-svc-{env}',
        podIdentityActions: ['sqs:ReceiveMessage'],
        clusters: {
          telemetry: [{ topic: 'telemetry.queue', group: 'queue-svc', actions: ['WriteData', 'DescribeTopic', 'Connect'] }],
          'trade-control': [{ topic: 'support.cases-requested', actions: ['WriteData', 'DescribeTopic', 'Connect'] }],
        },
      },
    ],
    invRefKeys: [
      {
        label: 'device',
        alias: 'alias/peaket-inv-ref-key-device',
        version: 1,
        generateMac: ['identity-svc', 'trust-svc'],
        verifyMac: [],
        readers: [
          { workload: 'identity-svc', alias: 'alias/peaket-inv-ref-key-device', version: 1 },
          { workload: 'trust-svc', alias: 'alias/peaket-inv-ref-key-device', version: 1 },
        ],
      },
      {
        label: 'contact',
        alias: 'alias/peaket-inv-ref-key-contact',
        version: 1,
        generateMac: ['identity-svc'],
        verifyMac: [],
        readers: [{ workload: 'identity-svc', alias: 'alias/peaket-inv-ref-key-contact', version: 1 }],
      },
      {
        label: 'pay',
        alias: 'alias/peaket-inv-ref-key-pay',
        version: 1,
        generateMac: ['payment-svc'],
        verifyMac: [],
        readers: [{ workload: 'payment-svc', alias: 'alias/peaket-inv-ref-key-pay', version: 1 }],
      },
    ],
  };
}

function validKeyPlan() {
  const symmetric = (name, multiRegion, rotationDays, extra = {}) => ({
    name,
    alias: `alias/peaket-${name}`,
    keySpec: 'SYMMETRIC_DEFAULT',
    keyUsage: 'ENCRYPT_DECRYPT',
    multiRegion,
    rotationDays,
    deletionWindowDays: 30,
    principals: { encryptDecrypt: [], generateMac: [], decrypt: [] },
    ...extra,
  });
  const hmac = (name, principals) => ({
    name,
    alias: `alias/peaket-${name}`,
    keySpec: 'HMAC_256',
    keyUsage: 'GENERATE_VERIFY_MAC',
    multiRegion: true,
    rotationDays: null,
    deletionWindowDays: 30,
    principals,
  });
  return {
    keys: [
      symmetric('admin-totp', true, 365, {
        principals: { encryptDecrypt: ['identity-svc'], generateMac: [], decrypt: ['identity-svc'] },
        encryptionContext: 'peaket-admin-totp-v1',
      }),
      symmetric('virtual-account', true, 365, {
        principals: { encryptDecrypt: ['payment-svc'], generateMac: [], decrypt: ['payment-svc'] },
        encryptionContext: 'peaket-virtual-account-v1',
      }),
      hmac('admin-password-pepper', { encryptDecrypt: [], generateMac: ['identity-svc'], decrypt: [], verifyMac: ['identity-svc'] }),
      hmac('ci-hmac', { encryptDecrypt: [], generateMac: ['identity-svc'], decrypt: [] }),
      hmac('pid-hmac', { encryptDecrypt: [], generateMac: ['identity-svc'], decrypt: [] }),
      symmetric('analytics-pseudonym', false, 365, {
        principals: { encryptDecrypt: [], generateMac: ['analytics-ingest'], decrypt: [] },
      }),
      hmac('inv-ref-key-device', { encryptDecrypt: [], generateMac: ['identity-svc', 'trust-svc'], decrypt: [] }),
      hmac('inv-ref-key-contact', { encryptDecrypt: [], generateMac: ['identity-svc'], decrypt: [] }),
      hmac('inv-ref-key-pay', { encryptDecrypt: [], generateMac: ['payment-svc'], decrypt: [] }),
      symmetric('shuffle-seed', false, null, {
        principals: { encryptDecrypt: ['queue-svc'], generateMac: [], decrypt: ['admission-ctrl'] },
        encryptionContext: 'peaket-shuffle-seed-v1',
      }),
    ],
    secretsManager: { rotationDays: 30, maintenanceWindow: '04:00-06:00 Asia/Seoul' },
  };
}

function validRepoFiles(overrides = {}) {
  return {
    'infra/modules/cloudfront-waf/edge-plan.json': overrides.edge ?? validEdgePlan(),
    'infra/modules/msk-iam/iam-plan.json': overrides.iam ?? validIamPlan(),
    'infra/modules/kms/key-plan.json': overrides.kms ?? validKeyPlan(),
    'infra/modules/cloudfront-waf/main.tf': 'locals {\n  edge = jsondecode(file("${path.module}/edge-plan.json"))\n}\n',
    'infra/modules/msk-iam/main.tf': 'locals {\n  iam = jsondecode(file("${path.module}/iam-plan.json"))\n}\n',
    'infra/modules/kms/main.tf': 'locals {\n  keys = jsondecode(file("${path.module}/key-plan.json"))\n}\n',
    'packages/platform/src/msk-iam.ts': "import { generateAuthTokenFromRole } from 'aws-msk-iam-sasl-signer-js';\nexport const token = () => generateAuthTokenFromRole({});\n",
  };
}

function fixture(overrides = {}) {
  return temp(validRepoFiles(overrides));
}

test.after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

// ── 실제 저장소: 계획 원천 ──────────────────────────────────────────────────

test('D-T37 ① 대기열 파일 배포에는 웹 ACL을 붙이지 않는다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const queueFiles = plan.distributions.find((d) => d.name === 'queue-files');
  assert.ok(queueFiles, 'queue-files 배포가 계획에 없다');
  assert.equal(queueFiles.webAcl, null, 'queue-files 배포에 웹 ACL이 붙었다');
  assert.equal(plan.distributions.find((d) => d.name === 'developers')?.webAcl, null, '개발자 포털 배포에 웹 ACL이 붙었다');
});

test('D-T37 ② Bot Control은 범위 축소문을 단 로그인 경로에만 세기 모드로 건다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const withBot = plan.webAcls.filter((acl) => acl.rules.some((r) => r.id === 'bot-control'));
  assert.equal(withBot.length, 1, `Bot Control을 쓰는 웹 ACL이 ${withBot.length}개다`);
  const acl = withBot[0];
  assert.equal(acl.name, 'screen-partner-console');
  const bot = acl.rules.find((r) => r.id === 'bot-control');
  assert.equal(bot.action, 'count', 'Bot Control이 세기 모드가 아니다');
  assert.equal(bot.level, 'common', 'Bot Control 단계가 common이 아니다');
  assert.ok(bot.scopeDown?.hosts?.includes('www.peaket.example'), 'Bot Control 범위 축소문에 www가 없다');
  assert.ok(Array.isArray(bot.scopeDown?.paths) && bot.scopeDown.paths.length > 0, 'Bot Control 범위 축소문 경로가 비었다');
  for (const other of plan.webAcls.filter((a) => a.name !== acl.name)) {
    assert.ok(!other.rules.some((r) => r.id === 'bot-control'), `${other.name}에 Bot Control이 있다`);
  }
});

test('D-T37 ③ Targeted 단계는 켜지 않는다', () => {
  const text = readFileSync(join(REPO, 'infra', 'modules', 'cloudfront-waf', 'edge-plan.json'), 'utf8');
  assert.equal(/targeted/i.test(text), false, '계획에 Targeted 단계가 있다');
});

test('D-T37 ④ 접근 로그는 허용 판정을 버리고 쿼리 문자열을 남기지 않는다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  assert.equal(plan.logging?.dropAllowedVerdicts, true, '허용 판정을 버리지 않는다');
  assert.equal(plan.logging?.queryString, 'excluded', '쿼리 문자열을 로그에 남긴다');
  assert.ok(!plan.logging?.fields?.includes('cs-uri-query'), '로그 칸에 cs-uri-query가 있다');
  assert.equal(plan.logging?.destination, 's3');
});

test('D-T37 ⑤ 규칙 순서는 IP 평판 → 기본 규칙 → IP 속도 제한 → Bot Control이다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const acl of plan.webAcls) {
    const ids = acl.rules.map((r) => r.id);
    const ip = ids.indexOf('ip-reputation');
    const common = ids.indexOf('common');
    const rate = ids.indexOf('rate');
    assert.ok(ip >= 0 && common > ip && rate > common, `${acl.name} 규칙 순서가 다르다: ${ids.join(' → ')}`);
    if (ids.includes('console-allowlist')) assert.equal(ids.indexOf('console-allowlist'), 0, `${acl.name} 관제 허용 IP 규칙이 맨 앞이 아니다`);
    if (ids.includes('bot-control')) assert.equal(ids.at(-1), 'bot-control', `${acl.name} Bot Control이 마지막이 아니다`);
  }
});

test('SR-T11 ② CDN 캐시 정책은 쿠키를 캐시 키에서 뺀다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const policy of plan.cachePolicies) {
    assert.equal(policy.cacheKey?.cookies, 'none', `${policy.name} 캐시 키에 쿠키가 들어간다`);
  }
});

test('[ASVS v5.0.0-3.4.4] 모든 배포·캐시 동작에 nosniff를 원본 값 재정의로 붙인다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const policies = new Map(plan.responseHeadersPolicies.map((p) => [p.name, p]));
  const behaviors = (d) => [d.defaultBehavior, ...(d.behaviors ?? [])];
  for (const distribution of plan.distributions) {
    for (const behavior of behaviors(distribution)) {
      const policy = policies.get(behavior.responseHeadersPolicy);
      assert.ok(policy, `${distribution.name} ${behavior.path}의 응답 헤더 정책이 없다`);
      assert.deepEqual(policy.headers?.['X-Content-Type-Options'], { value: 'nosniff', override: true }, `${policy.name}에 재정의하는 nosniff가 없다`);
    }
  }
  const www = plan.distributions.find((d) => d.name === 'www');
  assert.ok(behaviors(www).some((b) => b.path === '/serwist/*'), 'www에 서비스 워커 캐시 동작이 없다');
  const console = plan.distributions.find((d) => d.name === 'console');
  assert.ok(behaviors(console).some((b) => b.path === '/remotes/*'), 'console에 원격 모듈 캐시 동작이 없다');
});

test('[ASVS v5.0.0-3.4.1] 모든 응답 헤더 정책이 HSTS를 원본 값 재정의로 붙인다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const policy of plan.responseHeadersPolicies) {
    const hsts = policy.headers?.['Strict-Transport-Security'];
    assert.equal(hsts?.override, true, `${policy.name}가 원본 HSTS를 덮지 않는다`);
    assert.ok(typeof hsts?.value === 'string' && /max-age=\d+/.test(hsts.value), `${policy.name} HSTS가 없다`);
    const maxAge = Number(/max-age=(\d+)/.exec(hsts.value)[1]);
    assert.ok(maxAge >= 31_536_000, `${policy.name} HSTS max-age가 1년 미만이다`);
    assert.match(hsts.value, /includeSubDomains/, `${policy.name} HSTS에 includeSubDomains가 없다`);
    assert.doesNotMatch(hsts.value, /preload/, `${policy.name} HSTS에 preload가 있다`);
  }
});

test('[ASVS v5.0.0-3.4.3] 앱 CSP는 덮어쓰지 않고 기본 정책은 default-src none·frame-ancestors none이다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const appOwned = plan.responseHeadersPolicies.filter((p) => p.headers?.['Content-Security-Policy'] === undefined);
  assert.ok(appOwned.length > 0, '앱이 CSP를 보내는 정책(CSP 없음)이 없다');
  for (const policy of appOwned) {
    assert.deepEqual(policy.headers?.['X-Content-Type-Options'], { value: 'nosniff', override: true }, `${policy.name}가 앱 CSP와 함께 nosniff를 잃었다`);
  }
  for (const policy of plan.responseHeadersPolicies.filter((p) => p.headers?.['Content-Security-Policy'] !== undefined)) {
    assert.match(policy.headers['Content-Security-Policy'].value ?? '', /default-src 'none'/, `${policy.name} 기본 CSP에 default-src none이 없다`);
  }
});

test('[ASVS v5.0.0-3.4.6] 모든 응답 헤더 정책의 CSP에 frame-ancestors none이 있다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const policy of plan.responseHeadersPolicies) {
    assert.equal(policy.frameAncestors, 'none', `${policy.name} frameAncestors가 none이 아니다`);
    const csp = policy.headers?.['Content-Security-Policy']?.value ?? DEFAULT_CSP;
    assert.match(csp, /frame-ancestors 'none'/, `${policy.name} CSP에 frame-ancestors none이 없다`);
  }
});

test('F-09-4 시청자·원본 TLS는 1.2 이상만 받는다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  assert.equal(plan.tls?.viewerMinimumProtocolVersion, 'TLSv1.2_2021');
  assert.equal(plan.tls?.originProtocolPolicy, 'https-only');
  assert.deepEqual(plan.tls?.originSslProtocols, ['TLSv1.2']);
  for (const distribution of plan.distributions) {
    for (const behavior of [distribution.defaultBehavior, ...(distribution.behaviors ?? [])]) {
      assert.ok(['redirect-to-https', 'https-only'].includes(behavior.viewerProtocolPolicy), `${distribution.name} ${behavior.path}가 평문을 받는다`);
    }
  }
});

test('F-09-4 원본 요청 정책에 ASN·JA4를 넣고 복귀 경로 쿼리를 로그에서 뺀다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const policies = new Map(plan.originRequestPolicies.map((p) => [p.name, p]));
  for (const name of ['queue-api', 'api']) {
    const headers = policies.get(name)?.headers ?? [];
    assert.ok(headers.includes('CloudFront-Viewer-ASN'), `${name}에 ASN 헤더가 없다`);
    assert.ok(headers.includes('CloudFront-Viewer-JA4-Fingerprint'), `${name}에 JA4 헤더가 없다`);
  }
  assert.ok((policies.get('www-app')?.headers ?? []).includes('CloudFront-Viewer-ASN'), 'www 로그인 경로에 ASN 헤더가 없다');
  assert.ok(!(plan.logging?.fields ?? []).includes('cs-uri-query'), '복귀 경로 쿼리가 로그에 남는다');
});

test('F-09-4 공연 페이지 태그·검색 경로 무효화를 선언한다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  assert.equal(plan.invalidation?.tagHeader, 'x-peaket-cache-tag');
  assert.ok(plan.invalidation.tags.includes('event:{id}'), '공연 태그 무효화가 없다');
  assert.ok(plan.invalidation.tags.includes('home'), '홈 태그 무효화가 없다');
  assert.ok(
    plan.invalidation.paths.some((p) => p.distribution === 'api' && p.path === '/v1/search*'),
    '검색 경로 무효화가 없다',
  );
});

test('F-09-4 대기열 파일 배포의 S3 대체 원본·CORS·shuffle-proof 캐시를 선언한다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const queueFiles = plan.queueFiles;
  assert.equal(queueFiles?.fallbackOrigin?.path, '/queue/fallback');
  assert.deepEqual(queueFiles?.fallbackOrigin?.s3ListBucketPrefixes, ['queue/shuffle-results/', 'queue/batch-results/']);
  assert.equal(queueFiles?.errorCachingMinTtl, 1);
  assert.equal(queueFiles?.resultHeaders?.['Access-Control-Allow-Origin'], 'https://www.peaket.example');
  assert.equal(queueFiles?.shuffleProof?.cacheControl, 'public, max-age=5');
  assert.equal(plan.staticRetention?.days, 30);
  assert.equal(plan.staticRetention?.recentBuilds, 5);
});

// ── 실제 저장소: KMS ────────────────────────────────────────────────────────

test('[ASVS v5.0.0-13.1.4] KMS 키 계획이 이 기능의 서비스 데이터 키 별칭·다중 리전·교체를 담는다', () => {
  const plan = realPlan('kms', 'key-plan.json');
  const expected = [
    'admin-totp',
    'virtual-account',
    'admin-password-pepper',
    'ci-hmac',
    'pid-hmac',
    'analytics-pseudonym',
    'inv-ref-key-device',
    'inv-ref-key-contact',
    'inv-ref-key-pay',
    'shuffle-seed',
  ];
  const byName = new Map(plan.keys.map((k) => [k.name, k]));
  for (const name of expected) assert.ok(byName.has(name), `KMS 키 ${name}이 계획에 없다`);
  const multiRegion = {
    'admin-totp': true,
    'virtual-account': true,
    'admin-password-pepper': true,
    'ci-hmac': true,
    'pid-hmac': true,
    'analytics-pseudonym': false,
    'inv-ref-key-device': true,
    'inv-ref-key-contact': true,
    'inv-ref-key-pay': true,
    'shuffle-seed': false,
  };
  const rotation = {
    'admin-totp': 365,
    'virtual-account': 365,
    'admin-password-pepper': null,
    'ci-hmac': null,
    'pid-hmac': null,
    'analytics-pseudonym': 365,
    'inv-ref-key-device': null,
    'inv-ref-key-contact': null,
    'inv-ref-key-pay': null,
    'shuffle-seed': null,
  };
  for (const name of expected) {
    const key = byName.get(name);
    assert.equal(key.alias, `alias/peaket-${name}`, `${name} 별칭이 정본 꼴이 아니다`);
    assert.equal(key.multiRegion, multiRegion[name], `${name} 다중 리전 여부가 다르다`);
    assert.equal(key.rotationDays, rotation[name], `${name} 교체 주기가 다르다`);
    assert.equal(key.deletionWindowDays, 30, `${name} 삭제 대기가 30일이 아니다`);
    const principals = JSON.stringify(key.principals ?? {});
    assert.doesNotMatch(principals, /"\*"|kms:\*|arn:aws:iam::\*/, `${name} 키 정책에 와일드카드 주체·동작이 있다`);
    assert.ok(!(key.principals?.verifyMac ?? []).length || name === 'admin-password-pepper', `${name}에 VerifyMac 권한이 있다`);
  }
  for (const name of ['admin-totp', 'shuffle-seed']) {
    assert.ok(byName.get(name).encryptionContext, `${name}에 암호화 컨텍스트가 없다`);
  }
  for (const name of ['ci-hmac', 'pid-hmac', 'inv-ref-key-device', 'inv-ref-key-contact', 'inv-ref-key-pay']) {
    assert.equal(byName.get(name).keyUsage, 'GENERATE_VERIFY_MAC', `${name} 키 용도가 HMAC이 아니다`);
  }
  const aliases = plan.keys.map((k) => k.alias);
  assert.equal(new Set(aliases).size, aliases.length, 'KMS 별칭이 겹친다');
});

// ── 실제 저장소: MSK IAM ────────────────────────────────────────────────────

test('D-T30 ① Pod Identity 역할에는 kafka-cluster 권한이 없다', () => {
  const plan = realPlan('msk-iam', 'iam-plan.json');
  for (const workload of plan.workloads) {
    const bad = (workload.podIdentityActions ?? []).filter((action) => /^kafka-cluster:/.test(action) || action === '*');
    assert.deepEqual(bad, [], `${workload.name} Pod Identity 역할에 MSK 권한이 있다: ${bad.join(', ')}`);
  }
});

test('D-T30 ② MSK 전용 역할의 신뢰 정책은 그 워크로드의 Pod Identity 역할만 믿는다', () => {
  const plan = realPlan('msk-iam', 'iam-plan.json');
  for (const workload of plan.workloads) {
    assert.equal(workload.trust?.principal, `pod-identity:${workload.podIdentityRole}`, `${workload.name} 신뢰 주체가 다르다`);
    assert.deepEqual(workload.trust?.actions, ['sts:AssumeRole'], `${workload.name} 신뢰 동작이 AssumeRole 하나가 아니다`);
    assert.doesNotMatch(JSON.stringify(workload.trust), /\*|arn:aws:iam::\d+:root/, `${workload.name} 신뢰 정책에 와일드카드가 있다`);
    assert.equal(workload.sessionName, `${workload.name}-{env}`, `${workload.name} 고정 세션 이름이 다르다`);
  }
});

test('D-T30 ③ 서비스의 토큰 함수는 기본 자격 사슬이 아니라 역할을 맡는다', () => {
  const source = readFileSync(join(REPO, 'packages', 'platform', 'src', 'msk-iam.ts'), 'utf8');
  assert.match(source, /generateAuthTokenFromRole\s*\(/, '토큰 함수가 역할을 맡지 않는다');
  assert.doesNotMatch(source, /generateAuthToken\s*\(/, '토큰 함수가 기본 자격 사슬을 쓴다');
  const plan = realPlan('msk-iam', 'iam-plan.json');
  const podRoles = plan.workloads.map((w) => w.podIdentityRole);
  const mskRoles = plan.workloads.map((w) => w.mskRole);
  assert.equal(new Set(podRoles).size, podRoles.length, 'Pod Identity 역할이 겹친다');
  assert.equal(new Set(mskRoles).size, mskRoles.length, 'MSK 전용 역할이 겹친다');
  for (const workload of plan.workloads) {
    for (const entries of Object.values(workload.clusters ?? {})) {
      for (const entry of entries) {
        assert.notEqual(entry.topic, '*', `${workload.name} 토픽 권한에 와일드카드가 있다`);
        assert.ok(!(entry.actions ?? []).includes('*'), `${workload.name} 동작 권한에 와일드카드가 있다`);
      }
    }
  }
});

test('F-09-4 조사용 라벨 키는 정해진 워크로드만 GenerateMac 하고 identity·trust의 판이 같다', () => {
  const plan = realPlan('msk-iam', 'iam-plan.json');
  const byLabel = new Map(plan.invRefKeys.map((k) => [k.label, k]));
  for (const label of ['device', 'contact', 'pay']) assert.ok(byLabel.has(label), `조사용 라벨 키 ${label}이 없다`);
  assert.deepEqual([...byLabel.get('device').generateMac].sort(), ['identity-svc', 'trust-svc']);
  assert.deepEqual(byLabel.get('contact').generateMac, ['identity-svc']);
  assert.deepEqual(byLabel.get('pay').generateMac, ['payment-svc']);
  for (const key of plan.invRefKeys) {
    assert.deepEqual(key.verifyMac ?? [], [], `${key.label}에 VerifyMac 권한이 있다`);
    assert.equal(key.alias, `alias/peaket-inv-ref-key-${key.label}`, `${key.label} 별칭이 다르다`);
  }
  const device = byLabel.get('device');
  const readers = new Map(device.readers.map((r) => [r.workload, r]));
  assert.equal(readers.get('identity-svc').alias, readers.get('trust-svc').alias, 'identity와 trust의 기기 라벨 키 별칭이 다르다');
  assert.equal(readers.get('identity-svc').version, readers.get('trust-svc').version, 'identity와 trust의 기기 라벨 키 판이 다르다');
});

// ── 음성 시험(임시 저장소) ──────────────────────────────────────────────────

test('D-T37 음성: 대기열 파일 배포에 웹 ACL을 붙이면 막는다', () => {
  const edge = validEdgePlan();
  edge.distributions.find((d) => d.name === 'queue-files').webAcl = 'queue-api';
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T37 ①/);
});

test('D-T37 음성: Bot Control을 범위 축소문 없이 켜면 막는다', () => {
  const edge = validEdgePlan();
  const acl = edge.webAcls.find((a) => a.name === 'screen-partner-console');
  acl.rules.find((r) => r.id === 'bot-control').scopeDown = undefined;
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T37 ②/);
});

test('D-T37 음성: 규칙 순서를 뒤집으면 막는다', () => {
  const edge = validEdgePlan();
  const acl = edge.webAcls.find((a) => a.name === 'api');
  acl.rules = [acl.rules[1], acl.rules[0], acl.rules[2]];
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T37 ⑤/);
});

test('SR-T11 ② 음성: 캐시 키에 쿠키를 넣으면 막는다', () => {
  const edge = validEdgePlan();
  edge.cachePolicies[0].cacheKey.cookies = 'all';
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*SR-T11 ②/);
});

test('[ASVS v5.0.0-3.4.1] 음성: HSTS를 원본 값으로 두게 하면 막는다', () => {
  const edge = validEdgePlan();
  edge.responseHeadersPolicies[0].headers['Strict-Transport-Security'].override = false;
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*3\.4\.1/);
});

test('[ASVS v5.0.0-13.1.4] 음성: KMS 키 정책에 와일드카드를 넣으면 막는다', () => {
  const kms = validKeyPlan();
  kms.keys[0].principals.decrypt = ['*'];
  const result = run(['kms', '--root', fixture({ kms })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*13\.1\.4/);
});

test('D-T30 음성: Pod Identity 역할에 MSK 권한을 넣으면 막는다', () => {
  const iam = validIamPlan();
  iam.workloads[0].podIdentityActions.push('kafka-cluster:Connect');
  const result = run(['iam', '--root', fixture({ iam })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T30 ①/);
});

test('F-09-4 음성: 계획 JSON을 HCL이 읽지 않으면 막는다', () => {
  const root = fixture();
  write(root, 'infra/modules/kms/main.tf', 'locals {\n  keys = {}\n}\n');
  const result = run(['all', '--root', root]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*HCL/);
});

test('F-09-4 정적 검사기는 실제 저장소에서 0으로 끝난다', () => {
  const result = run(['all']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
