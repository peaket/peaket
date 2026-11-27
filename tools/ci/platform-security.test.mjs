// 플랫폼 보안 설정 정적·계약 시험(기능 F-09-4, 계획 docs/review/plans/F-09-4.md §5·§6).
// 정본: docs/infra.md §4.1·§9·WAF 규칙표, docs/devops.md §8.3·§9.4·D-T30·D-T37, docs/security/secrets-and-keys.md,
// docs/security/asvs/delivery.md 3.4.1·3.4.3·3.4.4·3.4.6·13.1.4·13.3.4, docs/features/search.md SR-T11 ②.
// 실제 AWS를 부르지 않는다. 계획 JSON과 저장소 코드·HCL·CI 워크플로를 읽어 규칙만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP } from '../../packages/config/headers/security-headers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(REPO, 'tools', 'ci', 'platform-security.mjs');
const TEMP_DIRS = [];

const HSTS = 'max-age=31536000; includeSubDomains';
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";
const DISTRIBUTIONS = {
  www: ['www.peaket.example'],
  queue: ['queue.peaket.example'],
  'queue-files': ['queue-files.peaket.example'],
  api: ['api.peaket.example'],
  partner: ['partner.peaket.example', 'partner-api.peaket.example'],
  console: ['console.peaket.example', 'ops-api.peaket.example'],
  scanner: ['scanner.peaket.example'],
  developers: ['developers.peaket.example', 'peaket.example'],
};
const CONSOLE_HOSTS = ['console.peaket.example', 'ops-api.peaket.example'];
const KMS_KEYS = {
  'admin-totp': { spec: 'SYMMETRIC_DEFAULT', usage: 'ENCRYPT_DECRYPT', multi: true, rotation: 365, manual: null },
  'virtual-account': { spec: 'SYMMETRIC_DEFAULT', usage: 'ENCRYPT_DECRYPT', multi: true, rotation: 365, manual: null },
  'admin-password-pepper': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: true, rotation: null, manual: 730 },
  'ci-hmac': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: true, rotation: null, manual: null },
  'pid-hmac': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: true, rotation: null, manual: null },
  'analytics-pseudonym': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: false, rotation: null, manual: 365 },
  'inv-ref-key-device': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: true, rotation: null, manual: null },
  'inv-ref-key-contact': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: true, rotation: null, manual: null },
  'inv-ref-key-pay': { spec: 'HMAC_256', usage: 'GENERATE_VERIFY_MAC', multi: true, rotation: null, manual: null },
  'shuffle-seed': { spec: 'SYMMETRIC_DEFAULT', usage: 'ENCRYPT_DECRYPT', multi: false, rotation: null, manual: null },
};

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

function run(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env },
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

function behavior(path, cachePolicy, responseHeadersPolicy, originRequestPolicy, viewerProtocolPolicy = 'redirect-to-https') {
  return { path, cachePolicy, responseHeadersPolicy, originRequestPolicy, viewerProtocolPolicy };
}

function snake(name) {
  return name.replace(/-/g, '_');
}

function validEdgePlan() {
  const noStore = { minTtl: 0, defaultTtl: 0, maxTtl: 0, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } };
  return {
    tls: { viewerMinimumProtocolVersion: 'TLSv1.2_2021', originProtocolPolicy: 'https-only', originSslProtocols: ['TLSv1.2'] },
    distributions: [
      {
        name: 'www',
        hosts: DISTRIBUTIONS.www,
        webAcl: 'screen-partner-console',
        defaultBehavior: behavior('default', 'screen-html', 'screen-app-csp', 'www-app'),
        behaviors: [
          behavior('/_t/*', 'no-store', 'screen', 'www-app'),
          behavior('/serwist/*', 'static', 'screen', 'static'),
        ],
      },
      {
        name: 'queue',
        hosts: DISTRIBUTIONS.queue,
        webAcl: 'queue-api',
        defaultBehavior: behavior('default', 'no-store', 'api', 'queue-api', 'https-only'),
        behaviors: [],
      },
      {
        name: 'queue-files',
        hosts: DISTRIBUTIONS['queue-files'],
        webAcl: null,
        defaultBehavior: behavior('default', 'static', 'queue-result', 'static'),
        behaviors: [
          behavior('/v1/queues/*/shuffle-results/*', 'static', 'queue-result', 'static'),
          behavior('/v1/queues/*/batch-results/*', 'static', 'queue-result', 'static'),
          behavior('/v1/queues/*/shuffle-proof', 'shuffle-proof', 'queue-result', 'static'),
        ],
      },
      {
        name: 'api',
        hosts: DISTRIBUTIONS.api,
        webAcl: 'api',
        defaultBehavior: behavior('default', 'search-api', 'api', 'api', 'https-only'),
        behaviors: [],
      },
      {
        name: 'partner',
        hosts: DISTRIBUTIONS.partner,
        webAcl: 'screen-partner-console',
        defaultBehavior: behavior('default', 'screen-html', 'screen-app-csp', 'www-app'),
        behaviors: [behavior('/v1/*', 'no-store', 'api', 'api', 'https-only')],
      },
      {
        name: 'console',
        hosts: DISTRIBUTIONS.console,
        webAcl: 'screen-partner-console',
        defaultBehavior: behavior('default', 'screen-html', 'console-app-csp', 'www-app'),
        behaviors: [
          behavior('/remotes/*', 'static', 'screen', 'static'),
          behavior('/v1/*', 'no-store', 'api', 'api', 'https-only'),
        ],
      },
      {
        name: 'scanner',
        hosts: DISTRIBUTIONS.scanner,
        webAcl: 'screen-partner-console',
        defaultBehavior: behavior('default', 'static', 'scanner-app-csp', 'static'),
        behaviors: [],
      },
      {
        name: 'developers',
        hosts: DISTRIBUTIONS.developers,
        webAcl: null,
        defaultBehavior: behavior('default', 'static', 'api', 'static'),
        behaviors: [],
      },
    ],
    cachePolicies: [
      { name: 'screen-html', minTtl: 0, defaultTtl: 60, maxTtl: 300, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } },
      noStore,
      { name: 'static', minTtl: 86_400, defaultTtl: 2_592_000, maxTtl: 31_536_000, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } },
      { name: 'search-api', minTtl: 0, defaultTtl: 60, maxTtl: 300, cacheKey: { cookies: 'none', headers: 'none', queryStrings: ['q', 'page', 'limit'] } },
      { name: 'shuffle-proof', minTtl: 0, defaultTtl: 5, maxTtl: 5, cacheKey: { cookies: 'none', headers: 'none', queryStrings: [] } },
    ],
    responseHeadersPolicies: [
      { name: 'screen', frameAncestors: 'none', headers: planHeaders() },
      {
        name: 'screen-app-csp',
        frameAncestors: 'none',
        appCspVariant: 'A',
        headers: {
          'Strict-Transport-Security': header(HSTS),
          'X-Content-Type-Options': header('nosniff'),
          'Referrer-Policy': header('strict-origin-when-cross-origin'),
        },
      },
      {
        name: 'console-app-csp',
        frameAncestors: 'none',
        appCspVariant: 'C',
        headers: {
          'Strict-Transport-Security': header(HSTS),
          'X-Content-Type-Options': header('nosniff'),
          'Referrer-Policy': header('no-referrer'),
        },
      },
      {
        name: 'scanner-app-csp',
        frameAncestors: 'none',
        appCspVariant: 'D',
        headers: {
          'Strict-Transport-Security': header(HSTS),
          'X-Content-Type-Options': header('nosniff'),
          'Referrer-Policy': header('no-referrer'),
        },
      },
      { name: 'api', frameAncestors: 'none', headers: planHeaders() },
      {
        name: 'queue-result',
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
          { id: 'console-allowlist', action: 'block', allowlist: ['203.0.113.0/24'], scopeDown: { hosts: CONSOLE_HOSTS } },
          { id: 'ip-reputation', action: 'count' },
          { id: 'common', action: 'count' },
          { id: 'rate', action: 'count', windowSec: 300 },
          {
            id: 'bot-control',
            action: 'count',
            level: 'common',
            scopeDown: { hosts: ['www.peaket.example'], paths: ['/login/*'] },
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
      tags: ['#event:{id}', '#home'],
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
          'trade-control': [{ topic: 'trade.orders', group: 'purchase-svc', actions: ['WriteData', 'DescribeTopic', 'Connect'] }],
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
          'trade-control': [{ topic: 'support.cases-requested', group: 'queue-svc-support', actions: ['WriteData', 'DescribeTopic', 'Connect'] }],
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

function keyEntry(name, spec, usage, multiRegion, rotationDays, manualRotationDays, principals, extra = {}) {
  return {
    name,
    alias: `alias/peaket-${name}`,
    keySpec: spec,
    keyUsage: usage,
    multiRegion,
    rotationDays,
    manualRotationDays,
    deletionWindowDays: 30,
    principals: { encrypt: [], decrypt: [], generateMac: [], verifyMac: [], ...principals },
    ...extra,
  };
}

function validKeyPlan() {
  return {
    keys: [
      keyEntry('admin-totp', 'SYMMETRIC_DEFAULT', 'ENCRYPT_DECRYPT', true, 365, null, { encrypt: ['identity-svc'], decrypt: ['identity-svc'] }, { encryptionContext: 'peaket-admin-totp-v1' }),
      keyEntry('virtual-account', 'SYMMETRIC_DEFAULT', 'ENCRYPT_DECRYPT', true, 365, null, { encrypt: ['payment-svc'], decrypt: ['payment-svc'] }, { encryptionContext: 'peaket-virtual-account-v1' }),
      keyEntry('admin-password-pepper', 'HMAC_256', 'GENERATE_VERIFY_MAC', true, null, 730, { generateMac: ['identity-svc'], verifyMac: ['identity-svc'] }),
      keyEntry('ci-hmac', 'HMAC_256', 'GENERATE_VERIFY_MAC', true, null, null, { generateMac: ['identity-svc'] }),
      keyEntry('pid-hmac', 'HMAC_256', 'GENERATE_VERIFY_MAC', true, null, null, { generateMac: ['identity-svc'] }),
      keyEntry('analytics-pseudonym', 'HMAC_256', 'GENERATE_VERIFY_MAC', false, null, 365, { generateMac: ['analytics-ingest'] }),
      keyEntry('inv-ref-key-device', 'HMAC_256', 'GENERATE_VERIFY_MAC', true, null, null, { generateMac: ['identity-svc', 'trust-svc'] }, { version: 1 }),
      keyEntry('inv-ref-key-contact', 'HMAC_256', 'GENERATE_VERIFY_MAC', true, null, null, { generateMac: ['identity-svc'] }, { version: 1 }),
      keyEntry('inv-ref-key-pay', 'HMAC_256', 'GENERATE_VERIFY_MAC', true, null, null, { generateMac: ['payment-svc'] }, { version: 1 }),
      keyEntry('shuffle-seed', 'SYMMETRIC_DEFAULT', 'ENCRYPT_DECRYPT', false, null, null, { encrypt: ['queue-svc'], decrypt: ['admission-ctrl'] }, { encryptionContext: 'peaket-shuffle-seed-v1' }),
    ],
    secretsManager: {
      rotationDays: 30,
      maintenanceWindow: '04:00-06:00 Asia/Seoul',
      restartWithinDays: 30,
      exclusions: ['onsale', 'freeze'],
    },
  };
}

function kmsHcl(plan) {
  return [
    'locals {',
    '  keys = jsondecode(file("${path.module}/key-plan.json"))',
    '}',
    ...plan.keys.flatMap((key) => [
      `resource "aws_kms_key" "${snake(key.name)}" {}`,
      `resource "aws_kms_alias" "${snake(key.name)}_alias" {}`,
    ]),
  ].join('\n') + '\n';
}

function iamHcl(plan) {
  return [
    'locals {',
    '  iam = jsondecode(file("${path.module}/iam-plan.json"))',
    '}',
    ...plan.workloads.flatMap((workload) => [
      `resource "aws_iam_role" "${snake(workload.name)}_pod_identity" {}`,
      `resource "aws_iam_role" "${snake(workload.name)}_msk" {}`,
    ]),
  ].join('\n') + '\n';
}

function edgeHcl(plan) {
  return [
    'locals {',
    '  edge = jsondecode(file("${path.module}/edge-plan.json"))',
    '}',
    ...plan.distributions.map((distribution) => `resource "aws_cloudfront_distribution" "${snake(distribution.name)}" {}`),
    ...plan.webAcls.map((acl) => `resource "aws_wafv2_web_acl" "${snake(acl.name)}" {}`),
    ...plan.responseHeadersPolicies.map((policy) => `resource "aws_cloudfront_response_headers_policy" "${snake(policy.name)}" {}`),
  ].join('\n') + '\n';
}

function validRepoFiles(overrides = {}) {
  const edge = overrides.edge ?? validEdgePlan();
  const iam = overrides.iam ?? validIamPlan();
  const kms = overrides.kms ?? validKeyPlan();
  return {
    'infra/modules/cloudfront-waf/edge-plan.json': edge,
    'infra/modules/msk-iam/iam-plan.json': iam,
    'infra/modules/kms/key-plan.json': kms,
    'infra/modules/cloudfront-waf/main.tf': overrides.edgeHcl ?? edgeHcl(edge),
    'infra/modules/msk-iam/main.tf': overrides.iamHcl ?? iamHcl(iam),
    'infra/modules/kms/main.tf': overrides.kmsHcl ?? kmsHcl(kms),
    'packages/platform/src/msk-iam.ts': "import { generateAuthTokenFromRole } from 'aws-msk-iam-sasl-signer-js';\nexport const token = () => generateAuthTokenFromRole({});\n",
  };
}

function fixture(overrides = {}) {
  return temp(validRepoFiles(overrides));
}

test.after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

// ── 실제 저장소: 엣지 ────────────────────────────────────────────────────────

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
  assert.deepEqual(bot.scopeDown?.hosts, ['www.peaket.example'], 'Bot Control 범위 축소문 호스트가 www 하나가 아니다');
  assert.deepEqual(bot.scopeDown?.paths, ['/login/*'], 'Bot Control 범위 축소문이 로그인 시작·소셜 콜백 경로가 아니다');
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

test('D-T37 ⑤ 규칙 순서는 관제 허용 IP → IP 평판 → 기본 규칙 → IP 속도 제한 → Bot Control이다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const acl of plan.webAcls) {
    const ids = acl.rules.map((r) => r.id);
    if (ids.includes('console-allowlist')) {
      assert.equal(ids.indexOf('console-allowlist'), 0, `${acl.name} 관제 허용 IP 규칙이 맨 앞이 아니다`);
      const rule = acl.rules[0];
      assert.deepEqual(rule.scopeDown?.hosts, CONSOLE_HOSTS, `${acl.name} 관제 허용 IP 규칙이 콘솔 호스트만 보지 않는다`);
      assert.ok(Array.isArray(rule.allowlist) && rule.allowlist.length > 0, `${acl.name} 관제 허용 IP 목록이 비었다`);
    }
    const ip = ids.indexOf('ip-reputation');
    const common = ids.indexOf('common');
    const rate = ids.indexOf('rate');
    assert.ok(ip >= 0 && common > ip && rate > common, `${acl.name} 규칙 순서가 다르다: ${ids.join(' → ')}`);
    if (ids.includes('bot-control')) assert.equal(ids.at(-1), 'bot-control', `${acl.name} Bot Control이 마지막이 아니다`);
  }
  const screen = plan.webAcls.find((a) => a.name === 'screen-partner-console');
  assert.equal(screen.rules[0]?.id, 'console-allowlist', '화면·파트너·관제 ACL 맨 앞에 관제 허용 IP 규칙이 없다');
});

test('SR-T11 ② CDN 캐시 정책은 쿠키를 캐시 키에서 뺀다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const policy of plan.cachePolicies) {
    assert.equal(policy.cacheKey?.cookies, 'none', `${policy.name} 캐시 키에 쿠키가 들어간다`);
  }
});

test('[ASVS v5.0.0-3.4.4] 배포 여덟·캐시 동작 모두에 nosniff를 원본 값 재정의로 붙인다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  assert.deepEqual(
    plan.distributions.map((d) => [d.name, d.hosts]).sort(),
    Object.entries(DISTRIBUTIONS).sort(),
    '배포 여덟의 이름·호스트가 정본과 다르다',
  );
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

test('[ASVS v5.0.0-3.4.3] 앱 CSP는 덮어쓰지 않고 실제 앱 정책을 가리킨다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  const appOwned = plan.responseHeadersPolicies.filter((p) => p.appCspVariant);
  assert.ok(appOwned.length > 0, '앱 CSP 정책(appCspVariant)이 없다');
  for (const policy of appOwned) {
    assert.equal(policy.headers?.['Content-Security-Policy'], undefined, `${policy.name}가 앱 CSP를 덮는다`);
    const csp = CSP[policy.appCspVariant];
    assert.ok(csp, `${policy.name}의 CSP 변형 ${policy.appCspVariant}이 security-headers.mjs에 없다`);
    assert.match(csp, /object-src 'none'/, `${policy.name} 앱 CSP에 object-src none이 없다`);
    assert.match(csp, /base-uri 'none'/, `${policy.name} 앱 CSP에 base-uri none이 없다`);
    assert.match(csp, /frame-ancestors 'none'/, `${policy.name} 앱 CSP에 frame-ancestors none이 없다`);
    assert.match(csp, /script-src/, `${policy.name} 앱 CSP에 script-src가 없다`);
  }
  for (const policy of plan.responseHeadersPolicies.filter((p) => !p.appCspVariant)) {
    assert.match(policy.headers?.['Content-Security-Policy']?.value ?? '', /default-src 'none'/, `${policy.name} 기본 CSP에 default-src none이 없다`);
  }
});

test('[ASVS v5.0.0-3.4.6] 앱이 보내는 CSP와 기본 CSP 모두 frame-ancestors none이다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  for (const policy of plan.responseHeadersPolicies) {
    assert.equal(policy.frameAncestors, 'none', `${policy.name} frameAncestors가 none이 아니다`);
    const csp = policy.appCspVariant ? CSP[policy.appCspVariant] : policy.headers?.['Content-Security-Policy']?.value;
    assert.ok(csp, `${policy.name}의 CSP를 찾지 못했다`);
    assert.match(csp, /frame-ancestors 'none'/, `${policy.name} CSP에 frame-ancestors none이 없다`);
  }
});

test('F-09-4 시청자·원본 TLS는 1.2 이상만 받고 API는 평문을 거부한다', () => {
  const plan = realPlan('cloudfront-waf', 'edge-plan.json');
  assert.equal(plan.tls?.viewerMinimumProtocolVersion, 'TLSv1.2_2021');
  assert.equal(plan.tls?.originProtocolPolicy, 'https-only');
  assert.deepEqual(plan.tls?.originSslProtocols, ['TLSv1.2']);
  for (const name of ['queue', 'api']) {
    const distribution = plan.distributions.find((d) => d.name === name);
    for (const behavior of [distribution.defaultBehavior, ...(distribution.behaviors ?? [])]) {
      assert.equal(behavior.viewerProtocolPolicy, 'https-only', `${name} ${behavior.path}가 평문 API 요청을 받는다`);
    }
  }
  for (const name of ['partner', 'console']) {
    const distribution = plan.distributions.find((d) => d.name === name);
    const apiBehavior = distribution.behaviors.find((b) => b.path === '/v1/*');
    assert.ok(apiBehavior, `${name}에 /v1/* 캐시 동작이 없다`);
    assert.equal(apiBehavior.viewerProtocolPolicy, 'https-only', `${name} API 경로가 평문을 받는다`);
  }
  for (const name of ['www', 'queue-files', 'scanner', 'developers']) {
    const distribution = plan.distributions.find((d) => d.name === name);
    for (const behavior of [distribution.defaultBehavior, ...(distribution.behaviors ?? [])]) {
      assert.ok(['redirect-to-https', 'https-only'].includes(behavior.viewerProtocolPolicy), `${name} ${behavior.path}가 평문을 받는다`);
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
  assert.ok(plan.invalidation.tags.includes('#event:{id}'), '공연 태그 무효화가 # 접두사 없이 적혔다');
  assert.ok(plan.invalidation.tags.includes('#home'), '홈 태그 무효화가 # 접두사 없이 적혔다');
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

// ── 실제 저장소: KMS·MSK IAM ─────────────────────────────────────────────────

test('F-09-4 KMS 키 계획이 서비스 데이터 키의 종류·별칭·다중 리전·교체를 담는다', () => {
  const plan = realPlan('kms', 'key-plan.json');
  const byName = new Map(plan.keys.map((k) => [k.name, k]));
  for (const [name, expected] of Object.entries(KMS_KEYS)) {
    const key = byName.get(name);
    assert.ok(key, `KMS 키 ${name}이 계획에 없다`);
    assert.equal(key.alias, `alias/peaket-${name}`, `${name} 별칭이 정본 꼴이 아니다`);
    assert.equal(key.keySpec, expected.spec, `${name} 키 종류가 다르다`);
    assert.equal(key.keyUsage, expected.usage, `${name} 키 용도가 다르다`);
    assert.equal(key.multiRegion, expected.multi, `${name} 다중 리전 여부가 다르다`);
    assert.equal(key.rotationDays, expected.rotation, `${name} 자동 교체 주기가 다르다`);
    assert.equal(key.manualRotationDays, expected.manual, `${name} 수동 교체 주기가 다르다`);
    assert.equal(key.deletionWindowDays, 30, `${name} 삭제 대기가 30일이 아니다`);
    const principalText = JSON.stringify(key.principals ?? {});
    assert.doesNotMatch(principalText, /"\*"|arn:aws:iam::\d+:root|kms:\*/, `${name} 키 정책에 와일드카드·루트 주체가 있다`);
    assert.ok(!(key.principals?.verifyMac ?? []).length || name === 'admin-password-pepper', `${name}에 VerifyMac 권한이 있다`);
  }
  for (const name of ['admin-totp', 'shuffle-seed']) assert.ok(byName.get(name).encryptionContext, `${name}에 암호화 컨텍스트가 없다`);
  const aliases = plan.keys.map((k) => k.alias);
  assert.equal(new Set(aliases).size, aliases.length, 'KMS 별칭이 겹친다');
});

test('F-09-4 셔플 시드 키는 queue-svc가 풀 수 없고 admission-ctrl만 푼다', () => {
  const plan = realPlan('kms', 'key-plan.json');
  const key = plan.keys.find((k) => k.name === 'shuffle-seed');
  assert.deepEqual(key.principals?.encrypt, ['queue-svc'], '셔플 시드 봉인 주체가 queue-svc 하나가 아니다');
  assert.deepEqual(key.principals?.decrypt, ['admission-ctrl'], '셔플 시드 풀기 주체가 admission-ctrl 하나가 아니다');
  assert.ok(!(key.principals?.decrypt ?? []).includes('queue-svc'), 'queue-svc가 셔플 시드를 풀 수 있다');
});

test('F-09-4 조사용 라벨 키는 정해진 워크로드만 GenerateMac 하고 두 계획의 별칭·판이 같다', () => {
  const iam = realPlan('msk-iam', 'iam-plan.json');
  const kms = realPlan('kms', 'key-plan.json');
  const byLabel = new Map(iam.invRefKeys.map((k) => [k.label, k]));
  for (const label of ['device', 'contact', 'pay']) assert.ok(byLabel.has(label), `조사용 라벨 키 ${label}이 없다`);
  assert.deepEqual([...byLabel.get('device').generateMac].sort(), ['identity-svc', 'trust-svc']);
  assert.deepEqual(byLabel.get('contact').generateMac, ['identity-svc']);
  assert.deepEqual(byLabel.get('pay').generateMac, ['payment-svc']);
  for (const key of iam.invRefKeys) {
    assert.deepEqual(key.verifyMac ?? [], [], `${key.label}에 VerifyMac 권한이 있다`);
    const kmsKey = kms.keys.find((k) => k.name === `inv-ref-key-${key.label}`);
    assert.ok(kmsKey, `key-plan에 inv-ref-key-${key.label}이 없다`);
    assert.equal(key.alias, kmsKey.alias, `${key.label} 두 계획의 별칭이 다르다`);
    assert.equal(key.version, kmsKey.version, `${key.label} 두 계획의 판이 다르다`);
  }
  const device = byLabel.get('device');
  const readers = new Map(device.readers.map((r) => [r.workload, r]));
  assert.equal(readers.get('identity-svc').alias, readers.get('trust-svc').alias, 'identity와 trust의 기기 라벨 키 별칭이 다르다');
  assert.equal(readers.get('identity-svc').version, readers.get('trust-svc').version, 'identity와 trust의 기기 라벨 키 판이 다르다');
});

test('[ASVS v5.0.0-13.1.4] 전달 경로 비밀의 교체 일정이 정본 목록에 있다', () => {
  const keys = readFileSync(join(REPO, 'docs', 'security', 'secrets-and-keys.md'), 'utf8');
  for (const row of ['Renovate GitHub 앱 개인 키', '소스 맵 올리기 토큰', 'Turborepo 원격 캐시 토큰']) {
    const line = keys.split('\n').find((l) => l.startsWith(`| ${row}`));
    assert.ok(line, `비밀 목록에 '${row}' 행이 없다`);
    assert.match(line, /90일|교체|정한다/, `'${row}' 행에 교체 일정이 없다`);
  }
  const threat = readFileSync(join(REPO, 'docs', 'security', 'threat-model.md'), 'utf8');
  assert.match(threat, /핵심 비밀과 교체 일정/, '위협 모델에 핵심 비밀과 교체 일정 절이 없다');
});

test('[ASVS v5.0.0-13.3.4] Secrets Manager 교체 일정과 30일 안 파드 재시작 창이 정본과 같다', () => {
  const plan = realPlan('kms', 'key-plan.json');
  assert.equal(plan.secretsManager?.rotationDays, 30, '저장소 비밀 교체 주기가 30일이 아니다');
  assert.equal(plan.secretsManager?.maintenanceWindow, '04:00-06:00 Asia/Seoul', '교체 창이 정비 시간이 아니다');
  assert.equal(plan.secretsManager?.restartWithinDays, 30, '30일 안 파드 재시작 조건이 없다');
  assert.deepEqual(plan.secretsManager?.exclusions, ['onsale', 'freeze'], '온세일·동결 창 제외가 없다');
});

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
    assert.ok(workload.mskRole, `${workload.name} MSK 역할이 비었다`);
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
    assert.ok(workload.mskRole, `${workload.name} MSK 역할이 비었다`);
    for (const entries of Object.values(workload.clusters ?? {})) {
      for (const entry of entries) {
        assert.notEqual(entry.topic, '*', `${workload.name} 토픽 권한에 와일드카드가 있다`);
        assert.ok(!(entry.actions ?? []).includes('*'), `${workload.name} 동작 권한에 와일드카드가 있다`);
        assert.notEqual(entry.group, '*', `${workload.name} 소비자 그룹에 와일드카드가 있다`);
      }
    }
  }
});

// ── HCL·CI 연결 ─────────────────────────────────────────────────────────────

test('F-09-4 HCL은 계획 JSON을 읽고 계획마다 실제 리소스를 만든다', () => {
  const kms = realPlan('kms', 'key-plan.json');
  const kmsMain = readFileSync(join(REPO, 'infra', 'modules', 'kms', 'main.tf'), 'utf8');
  assert.ok(kmsMain.includes('jsondecode(file("${path.module}/key-plan.json"))'), 'KMS HCL이 key-plan.json을 읽지 않는다');
  for (const key of kms.keys) {
    assert.ok(kmsMain.includes(`resource "aws_kms_key" "${snake(key.name)}"`), `KMS HCL에 ${key.name} 키 리소스가 없다`);
    assert.ok(kmsMain.includes(`resource "aws_kms_alias" "${snake(key.name)}_alias"`), `KMS HCL에 ${key.name} 별칭 리소스가 없다`);
  }

  const iam = realPlan('msk-iam', 'iam-plan.json');
  const iamMain = readFileSync(join(REPO, 'infra', 'modules', 'msk-iam', 'main.tf'), 'utf8');
  assert.ok(iamMain.includes('jsondecode(file("${path.module}/iam-plan.json"))'), 'IAM HCL이 iam-plan.json을 읽지 않는다');
  for (const workload of iam.workloads) {
    assert.ok(iamMain.includes(`resource "aws_iam_role" "${snake(workload.name)}_pod_identity"`), `IAM HCL에 ${workload.name} Pod Identity 역할이 없다`);
    assert.ok(iamMain.includes(`resource "aws_iam_role" "${snake(workload.name)}_msk"`), `IAM HCL에 ${workload.name} MSK 역할이 없다`);
  }

  const edge = realPlan('cloudfront-waf', 'edge-plan.json');
  const edgeMain = readFileSync(join(REPO, 'infra', 'modules', 'cloudfront-waf', 'main.tf'), 'utf8');
  assert.ok(edgeMain.includes('jsondecode(file("${path.module}/edge-plan.json"))'), '엣지 HCL이 edge-plan.json을 읽지 않는다');
  for (const distribution of edge.distributions) {
    assert.ok(edgeMain.includes(`resource "aws_cloudfront_distribution" "${snake(distribution.name)}"`), `엣지 HCL에 ${distribution.name} 배포가 없다`);
  }
  for (const acl of edge.webAcls) {
    assert.ok(edgeMain.includes(`resource "aws_wafv2_web_acl" "${snake(acl.name)}"`), `엣지 HCL에 ${acl.name} 웹 ACL이 없다`);
  }
  for (const policy of edge.responseHeadersPolicies) {
    assert.ok(edgeMain.includes(`resource "aws_cloudfront_response_headers_policy" "${snake(policy.name)}"`), `엣지 HCL에 ${policy.name} 응답 헤더 정책이 없다`);
  }
});

test('F-09-4 iac-check는 새 Terraform 모듈도 검증한다', () => {
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'iac-check.yml'), 'utf8');
  for (const module of ['infra/modules/kms', 'infra/modules/msk-iam', 'infra/modules/cloudfront-waf']) {
    assert.ok(workflow.includes(module), `iac-check가 ${module}를 검증하지 않는다`);
  }
  assert.match(workflow, /terraform\s+validate/, 'iac-check에 terraform validate가 없다');
  assert.ok(
    /for\s+\w+\s+in[^\n]*infra\/modules/.test(workflow) || /find\s+infra\/modules/.test(workflow),
    'iac-check가 infra/modules를 순회해 validate하지 않는다',
  );
  assert.match(workflow, /terraform\s+-chdir="\$\{?\w+\}?"\s+(init|validate)/, 'iac-check가 모듈 디렉터리에서 terraform init/validate를 부르지 않는다');
});

// ── 음성 시험(임시 저장소) ──────────────────────────────────────────────────

test('D-T37 음성: 대기열 파일 배포에 웹 ACL을 붙이면 막는다', () => {
  const edge = validEdgePlan();
  edge.distributions.find((d) => d.name === 'queue-files').webAcl = 'queue-api';
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T37 ①/);
});

test('D-T37 음성: Bot Control 범위 축소문에서 로그인 경로를 빼면 막는다', () => {
  const edge = validEdgePlan();
  const acl = edge.webAcls.find((a) => a.name === 'screen-partner-console');
  acl.rules.find((r) => r.id === 'bot-control').scopeDown.paths = ['/'];
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T37 ②/);
});

test('D-T37 음성: 관제 허용 IP 규칙을 빼면 막는다', () => {
  const edge = validEdgePlan();
  const acl = edge.webAcls.find((a) => a.name === 'screen-partner-console');
  acl.rules = acl.rules.filter((r) => r.id !== 'console-allowlist');
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T37 ⑤/);
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

test('[ASVS v5.0.0-3.4.3] 음성: 앱 CSP 변형이 정본에 없으면 막는다', () => {
  const edge = validEdgePlan();
  edge.responseHeadersPolicies.find((p) => p.name === 'screen-app-csp').appCspVariant = 'Z';
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*3\.4\.3/);
});

test('[ASVS v5.0.0-13.3.4] 음성: 교체 주기나 재시작 창이 틀리면 막는다', () => {
  const kms = validKeyPlan();
  kms.secretsManager.restartWithinDays = 31;
  const result = run(['kms', '--root', fixture({ kms })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*13\.3\.4/);
});

test('F-09-4 음성: KMS 키 정책에 계정 루트 주체를 넣으면 막는다', () => {
  const kms = validKeyPlan();
  kms.keys[0].principals.decrypt = ['arn:aws:iam::123456789012:root'];
  const result = run(['kms', '--root', fixture({ kms })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*KMS/);
});

test('F-09-4 음성: 셔플 시드 키에서 queue-svc가 풀 수 있으면 막는다', () => {
  const kms = validKeyPlan();
  kms.keys.find((k) => k.name === 'shuffle-seed').principals.decrypt.push('queue-svc');
  const result = run(['kms', '--root', fixture({ kms })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*셔플/);
});

test('D-T30 음성: Pod Identity 역할에 MSK 권한을 넣으면 막는다', () => {
  const iam = validIamPlan();
  iam.workloads[0].podIdentityActions.push('kafka-cluster:Connect');
  const result = run(['iam', '--root', fixture({ iam })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*D-T30 ①/);
});

test('F-09-4 음성: HCL에 계획 리소스가 빠지면 막는다', () => {
  const kms = validKeyPlan();
  const root = fixture({ kms });
  const hcl = kmsHcl(kms).split('\n').filter((line) => !line.includes('"admin_totp_alias"')).join('\n');
  write(root, 'infra/modules/kms/main.tf', hcl);
  const result = run(['all', '--root', root]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*HCL/);
});

test('F-09-4 음성: 무효화 태그에 # 접두사가 없으면 막는다', () => {
  const edge = validEdgePlan();
  edge.invalidation.tags = ['event:{id}', 'home'];
  const result = run(['edge', '--root', fixture({ edge })]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /막음: .*무효화/);
});

test('F-09-4 CLI는 없는 계획에 끝 코드 2다', () => {
  const root = temp({});
  const result = run(['all', '--root', root]);
  assert.equal(result.status, 2, result.stdout + result.stderr);
});

test('F-09-4 정적 검사기는 실제 저장소에서 0으로 끝난다', () => {
  const result = run(['all']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
