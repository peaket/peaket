#!/usr/bin/env node
// 플랫폼 보안 설정 정적 검사(기능 F-09-4, 계획 docs/review/plans/F-09-4.md §3.5·§5).
// 정본: docs/infra.md §4.1·§9, docs/devops.md §8.3·§9.4·D-T30·D-T37, docs/security/secrets-and-keys.md,
// docs/security/asvs/delivery.md 3.4.1·3.4.3·3.4.4·3.4.6·13.3.4, docs/features/search.md SR-T11 ②.
// 실제 AWS·Terraform을 부르지 않는다. 계획 JSON·HCL·CI 워크플로와 저장소 코드만 읽는다.
// 끝 코드: 0 통과, 1 위반, 2 인자·계획·정본 읽기 오류.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CSP } from '../../packages/config/headers/security-headers.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: 'string', default: '.' } },
});
const command = positionals[0];
const ROOT = resolve(values.root);
const errors = [];

class LoadError extends Error {}

const fail = (file, rule, message) => errors.push(`막음: ${file}: ${rule}: ${message}`);
const readText = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readPlan = (rel) => {
  try {
    return JSON.parse(readText(rel));
  } catch (error) {
    throw new LoadError(`${rel}을 읽지 못했다: ${error instanceof Error ? error.message : String(error)}`);
  }
};
const snake = (name) => name.replace(/-/g, '_');

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

export function checkKms(root = ROOT) {
  const before = errors.length;
  const planPath = 'infra/modules/kms/key-plan.json';
  const plan = readPlan(planPath);
  const keys = Array.isArray(plan.keys) ? plan.keys : [];
  if (keys.length === 0) fail(planPath, 'KMS', '키가 없다');
  const byName = new Map(keys.map((key) => [key.name, key]));
  const aliases = new Set();
  for (const [name, expected] of Object.entries(KMS_KEYS)) {
    const key = byName.get(name);
    if (!key) {
      fail(planPath, 'KMS', `${name} 키가 없다`);
      continue;
    }
    if (key.alias !== `alias/peaket-${name}`) fail(planPath, 'KMS', `${name} 별칭이 정본 꼴이 아니다`);
    if (aliases.has(key.alias)) fail(planPath, 'KMS', `${name} 별칭이 겹친다`);
    aliases.add(key.alias);
    if (key.keySpec !== expected.spec) fail(planPath, 'KMS', `${name} 키 종류가 다르다`);
    if (key.keyUsage !== expected.usage) fail(planPath, 'KMS', `${name} 키 용도가 다르다`);
    if (key.multiRegion !== expected.multi) fail(planPath, 'KMS', `${name} 다중 리전 여부가 다르다`);
    if (key.rotationDays !== expected.rotation) fail(planPath, 'KMS', `${name} 자동 교체 주기가 다르다`);
    if (key.manualRotationDays !== expected.manual) fail(planPath, 'KMS', `${name} 수동 교체 주기가 다르다`);
    if (key.deletionWindowDays !== 30) fail(planPath, 'KMS', `${name} 삭제 대기가 30일이 아니다`);
    const principals = JSON.stringify(key.principals ?? {});
    if (/"\*"|arn:aws:iam::\d+:root|kms:\*/.test(principals)) fail(planPath, 'KMS', `${name} 키 정책에 와일드카드·계정 루트 주체가 있다`);
    const verifyMac = key.principals?.verifyMac ?? [];
    if (verifyMac.length > 0 && name !== 'admin-password-pepper') fail(planPath, 'KMS', `${name}에 VerifyMac 권한이 있다`);
    if (['admin-totp', 'shuffle-seed'].includes(name) && !key.encryptionContext) fail(planPath, 'KMS', `${name}에 암호화 컨텍스트가 없다`);
  }
  const shuffle = byName.get('shuffle-seed');
  if (shuffle) {
    if (JSON.stringify(shuffle.principals?.encrypt ?? []) !== JSON.stringify(['queue-svc'])) {
      fail(planPath, '셔플', '셔플 시드 Encrypt 주체가 queue-svc 하나가 아니다');
    }
    if (JSON.stringify(shuffle.principals?.decrypt ?? []) !== JSON.stringify(['admission-ctrl'])) {
      fail(planPath, '셔플', '셔플 시드 Decrypt 주체가 admission-ctrl 하나가 아니다');
    }
    if ((shuffle.principals?.decrypt ?? []).includes('queue-svc')) {
      fail(planPath, '셔플', 'queue-svc가 셔플 시드를 풀 수 있다');
    }
  }
  const sm = plan.secretsManager ?? {};
  if (sm.rotationDays !== 30) fail(planPath, '13.3.4', '저장소 비밀 교체 주기가 30일이 아니다');
  if (sm.maintenanceWindow !== '04:00-06:00 Asia/Seoul') fail(planPath, '13.3.4', '교체 창이 정비 시간이 아니다');
  if (sm.restartWithinDays !== 30) fail(planPath, '13.3.4', '30일 안 파드 재시작 조건이 없다');
  if (JSON.stringify(sm.exclusions ?? []) !== JSON.stringify(['onsale', 'freeze'])) fail(planPath, '13.3.4', '온세일·동결 창 제외가 없다');
  return errors.length - before;
}

export function checkIam(root = ROOT) {
  const before = errors.length;
  const planPath = 'infra/modules/msk-iam/iam-plan.json';
  const plan = readPlan(planPath);
  const workloads = Array.isArray(plan.workloads) ? plan.workloads : [];
  if (workloads.length === 0) fail(planPath, 'D-T30 ①', '워크로드가 없다');
  const podRoles = new Set();
  const mskRoles = new Set();
  for (const workload of workloads) {
    const bad = (workload.podIdentityActions ?? []).filter((action) => /^kafka-cluster:/.test(action) || action === '*');
    if (bad.length > 0) fail(planPath, 'D-T30 ①', `${workload.name} Pod Identity 역할에 MSK 권한이 있다: ${bad.join(', ')}`);
    if (!workload.mskRole) fail(planPath, 'D-T30 ②', `${workload.name} MSK 역할이 비었다`);
    if (workload.trust?.principal !== `pod-identity:${workload.podIdentityRole}`) fail(planPath, 'D-T30 ②', `${workload.name} 신뢰 주체가 다르다`);
    if (JSON.stringify(workload.trust?.actions ?? []) !== JSON.stringify(['sts:AssumeRole'])) fail(planPath, 'D-T30 ②', `${workload.name} 신뢰 동작이 AssumeRole 하나가 아니다`);
    if (/\*|arn:aws:iam::\d+:root/.test(JSON.stringify(workload.trust ?? {}))) fail(planPath, 'D-T30 ②', `${workload.name} 신뢰 정책에 와일드카드가 있다`);
    if (workload.sessionName !== `${workload.name}-{env}`) fail(planPath, 'D-T30 ②', `${workload.name} 고정 세션 이름이 다르다`);
    if (podRoles.has(workload.podIdentityRole)) fail(planPath, 'D-T30 ③', 'Pod Identity 역할이 겹친다');
    if (mskRoles.has(workload.mskRole)) fail(planPath, 'D-T30 ③', 'MSK 전용 역할이 겹친다');
    podRoles.add(workload.podIdentityRole);
    mskRoles.add(workload.mskRole);
    for (const entries of Object.values(workload.clusters ?? {})) {
      for (const entry of entries) {
        if (entry.topic === '*') fail(planPath, 'D-T30 ③', `${workload.name} 토픽 권한에 와일드카드가 있다`);
        if ((entry.actions ?? []).includes('*')) fail(planPath, 'D-T30 ③', `${workload.name} 동작 권한에 와일드카드가 있다`);
        if (entry.group === '*') fail(planPath, 'D-T30 ③', `${workload.name} 소비자 그룹에 와일드카드가 있다`);
      }
    }
  }
  // iam-plan과 key-plan의 조사용 라벨 키 별칭·판 대조
  try {
    const kms = JSON.parse(readText('infra/modules/kms/key-plan.json'));
    for (const key of plan.invRefKeys ?? []) {
      const kmsKey = (kms.keys ?? []).find((candidate) => candidate.name === `inv-ref-key-${key.label}`);
      if (!kmsKey) {
        fail(planPath, '조사용 키', `key-plan에 inv-ref-key-${key.label}이 없다`);
        continue;
      }
      if (kmsKey.alias !== key.alias) fail(planPath, '조사용 키', `${key.label} 두 계획의 별칭이 다르다`);
      if (kmsKey.version !== key.version) fail(planPath, '조사용 키', `${key.label} 두 계획의 판이 다르다`);
      if ((key.verifyMac ?? []).length > 0) fail(planPath, '조사용 키', `${key.label}에 VerifyMac 권한이 있다`);
    }
  } catch {
    // kms 계획이 없으면 kms 검사가 따로 알린다
  }
  return errors.length - before;
}

export function checkEdge(root = ROOT) {
  const before = errors.length;
  const planPath = 'infra/modules/cloudfront-waf/edge-plan.json';
  const plan = readPlan(planPath);
  const distributions = Array.isArray(plan.distributions) ? plan.distributions : [];
  const behaviors = (distribution) => [distribution.defaultBehavior, ...(distribution.behaviors ?? [])];

  const queueFiles = distributions.find((d) => d.name === 'queue-files');
  if (!queueFiles) fail(planPath, 'D-T37 ①', 'queue-files 배포가 없다');
  if (queueFiles?.webAcl !== null) fail(planPath, 'D-T37 ①', 'queue-files 배포에 웹 ACL이 붙었다');
  if (distributions.find((d) => d.name === 'developers')?.webAcl !== null) fail(planPath, 'D-T37 ①', '개발자 포털 배포에 웹 ACL이 붙었다');

  const withBot = (plan.webAcls ?? []).filter((acl) => acl.rules?.some((rule) => rule.id === 'bot-control'));
  if (withBot.length !== 1) {
    fail(planPath, 'D-T37 ②', `Bot Control을 쓰는 웹 ACL이 ${withBot.length}개다`);
  } else {
    const acl = withBot[0];
    const bot = acl.rules.find((rule) => rule.id === 'bot-control');
    if (acl.name !== 'screen-partner-console') fail(planPath, 'D-T37 ②', 'Bot Control이 화면·파트너·관제 ACL에 없다');
    if (bot.action !== 'count') fail(planPath, 'D-T37 ②', 'Bot Control이 세기 모드가 아니다');
    if (bot.level !== 'common') fail(planPath, 'D-T37 ②', 'Bot Control 단계가 common이 아니다');
    if (JSON.stringify(bot.scopeDown?.hosts ?? []) !== JSON.stringify(['www.peaket.example'])) fail(planPath, 'D-T37 ②', 'Bot Control 범위 축소문 호스트가 www 하나가 아니다');
    if (JSON.stringify(bot.scopeDown?.paths ?? []) !== JSON.stringify(['/login/*'])) fail(planPath, 'D-T37 ②', 'Bot Control 범위 축소문이 로그인 시작·소셜 콜백 경로가 아니다');
  }
  if (/targeted/i.test(readText(planPath))) fail(planPath, 'D-T37 ③', 'Targeted 단계가 켜졌다');
  if (plan.logging?.dropAllowedVerdicts !== true) fail(planPath, 'D-T37 ④', '허용 판정을 버리지 않는다');
  if (plan.logging?.queryString !== 'excluded') fail(planPath, 'D-T37 ④', '쿼리 문자열을 로그에 남긴다');
  if ((plan.logging?.fields ?? []).includes('cs-uri-query')) fail(planPath, 'D-T37 ④', '로그 칸에 cs-uri-query가 있다');
  if (plan.logging?.destination !== 's3') fail(planPath, 'D-T37 ④', '접근 로그가 S3가 아니다');

  for (const acl of plan.webAcls ?? []) {
    const ids = (acl.rules ?? []).map((rule) => rule.id);
    if (ids.includes('console-allowlist')) {
      if (ids.indexOf('console-allowlist') !== 0) fail(planPath, 'D-T37 ⑤', `${acl.name} 관제 허용 IP 규칙이 맨 앞이 아니다`);
      const rule = acl.rules[0];
      if (JSON.stringify(rule.scopeDown?.hosts ?? []) !== JSON.stringify(CONSOLE_HOSTS)) fail(planPath, 'D-T37 ⑤', `${acl.name} 관제 허용 IP 규칙이 콘솔 호스트만 보지 않는다`);
      if (!Array.isArray(rule.allowlist) || rule.allowlist.length === 0) fail(planPath, 'D-T37 ⑤', `${acl.name} 관제 허용 IP 목록이 비었다`);
    }
    const ip = ids.indexOf('ip-reputation');
    const common = ids.indexOf('common');
    const rate = ids.indexOf('rate');
    if (!(ip >= 0 && common > ip && rate > common)) fail(planPath, 'D-T37 ⑤', `${acl.name} 규칙 순서가 다르다: ${ids.join(' → ')}`);
    if (ids.includes('bot-control') && ids.at(-1) !== 'bot-control') fail(planPath, 'D-T37 ⑤', `${acl.name} Bot Control이 마지막이 아니다`);
  }
  const screen = (plan.webAcls ?? []).find((acl) => acl.name === 'screen-partner-console');
  if (screen?.rules?.[0]?.id !== 'console-allowlist') fail(planPath, 'D-T37 ⑤', '화면·파트너·관제 ACL 맨 앞에 관제 허용 IP 규칙이 없다');

  for (const policy of plan.cachePolicies ?? []) {
    if (policy.cacheKey?.cookies !== 'none') fail(planPath, 'SR-T11 ②', `${policy.name} 캐시 키에 쿠키가 들어간다`);
  }

  const actual = distributions.map((distribution) => [distribution.name, distribution.hosts]);
  if (JSON.stringify([...actual].sort()) !== JSON.stringify(Object.entries(DISTRIBUTIONS).sort())) {
    fail(planPath, '3.4.4', '배포 여덟의 이름·호스트가 정본과 다르다');
  }
  const policies = new Map((plan.responseHeadersPolicies ?? []).map((policy) => [policy.name, policy]));
  for (const distribution of distributions) {
    for (const behavior of behaviors(distribution)) {
      const policy = policies.get(behavior.responseHeadersPolicy);
      if (!policy) {
        fail(planPath, '3.4.4', `${distribution.name} ${behavior.path}의 응답 헤더 정책이 없다`);
        continue;
      }
      if (JSON.stringify(policy.headers?.['X-Content-Type-Options']) !== JSON.stringify({ value: 'nosniff', override: true })) {
        fail(planPath, '3.4.4', `${policy.name}에 재정의하는 nosniff가 없다`);
      }
    }
  }

  for (const policy of plan.responseHeadersPolicies ?? []) {
    const hsts = policy.headers?.['Strict-Transport-Security'];
    const value = hsts?.value ?? '';
    const maxAge = Number(/max-age=(\d+)/.exec(value)?.[1] ?? 0);
    if (hsts?.override !== true || maxAge < 31_536_000 || !/includeSubDomains/.test(value) || /preload/.test(value)) {
      fail(planPath, '3.4.1', `${policy.name} HSTS가 정본과 다르다`);
    }
  }

  const appOwned = (plan.responseHeadersPolicies ?? []).filter((policy) => policy.appCspVariant);
  if (appOwned.length === 0) fail(planPath, '3.4.3', '앱 CSP 정책이 없다');
  for (const policy of appOwned) {
    if (policy.headers?.['Content-Security-Policy'] !== undefined) fail(planPath, '3.4.3', `${policy.name}가 앱 CSP를 덮는다`);
    const csp = CSP[policy.appCspVariant];
    if (!csp) fail(planPath, '3.4.3', `${policy.name}의 CSP 변형 ${policy.appCspVariant}이 security-headers.mjs에 없다`);
    else if (!/object-src 'none'/.test(csp) || !/base-uri 'none'/.test(csp) || !/frame-ancestors 'none'/.test(csp) || !/script-src/.test(csp)) {
      fail(planPath, '3.4.3', `${policy.name} 앱 CSP가 최소 지시자를 갖추지 못했다`);
    }
  }
  for (const policy of (plan.responseHeadersPolicies ?? []).filter((candidate) => !candidate.appCspVariant)) {
    if (!/default-src 'none'/.test(policy.headers?.['Content-Security-Policy']?.value ?? '')) fail(planPath, '3.4.3', `${policy.name} 기본 CSP에 default-src none이 없다`);
  }
  for (const policy of plan.responseHeadersPolicies ?? []) {
    const csp = policy.appCspVariant ? CSP[policy.appCspVariant] : policy.headers?.['Content-Security-Policy']?.value;
    if (policy.frameAncestors !== 'none' || !csp || !/frame-ancestors 'none'/.test(csp)) fail(planPath, '3.4.6', `${policy.name} CSP에 frame-ancestors none이 없다`);
  }

  if (plan.tls?.viewerMinimumProtocolVersion !== 'TLSv1.2_2021') fail(planPath, 'TLS', '시청자 최소 TLS가 1.2_2021이 아니다');
  if (plan.tls?.originProtocolPolicy !== 'https-only') fail(planPath, 'TLS', '원본 프로토콜이 https-only가 아니다');
  if (JSON.stringify(plan.tls?.originSslProtocols ?? []) !== JSON.stringify(['TLSv1.2'])) fail(planPath, 'TLS', '원본 TLS가 1.2만이 아니다');
  for (const name of ['queue', 'api']) {
    const distribution = distributions.find((candidate) => candidate.name === name);
    for (const behavior of behaviors(distribution ?? {})) {
      if (behavior.viewerProtocolPolicy !== 'https-only') fail(planPath, 'TLS', `${name} ${behavior.path}가 평문 API 요청을 받는다`);
    }
  }
  for (const name of ['partner', 'console']) {
    const distribution = distributions.find((candidate) => candidate.name === name);
    const apiBehavior = distribution?.behaviors?.find((behavior) => behavior.path === '/v1/*');
    if (!apiBehavior) fail(planPath, 'TLS', `${name}에 /v1/* 캐시 동작이 없다`);
    else if (apiBehavior.viewerProtocolPolicy !== 'https-only') fail(planPath, 'TLS', `${name} API 경로가 평문을 받는다`);
  }

  const originPolicies = new Map((plan.originRequestPolicies ?? []).map((policy) => [policy.name, policy]));
  for (const name of ['queue-api', 'api']) {
    const headers = originPolicies.get(name)?.headers ?? [];
    if (!headers.includes('CloudFront-Viewer-ASN')) fail(planPath, 'JA4', `${name}에 ASN 헤더가 없다`);
    if (!headers.includes('CloudFront-Viewer-JA4-Fingerprint')) fail(planPath, 'JA4', `${name}에 JA4 헤더가 없다`);
  }
  if (!(originPolicies.get('www-app')?.headers ?? []).includes('CloudFront-Viewer-ASN')) fail(planPath, 'JA4', 'www 로그인 경로에 ASN 헤더가 없다');

  if (plan.invalidation?.tagHeader !== 'x-peaket-cache-tag') fail(planPath, '무효화', '태그 헤더가 x-peaket-cache-tag가 아니다');
  if (!(plan.invalidation?.tags ?? []).includes('#event:{id}') || !(plan.invalidation?.tags ?? []).includes('#home')) fail(planPath, '무효화', '태그 무효화에 # 접두사가 없거나 태그가 빠졌다');
  if (!(plan.invalidation?.paths ?? []).some((entry) => entry.distribution === 'api' && entry.path === '/v1/search*')) fail(planPath, '무효화', '검색 경로 무효화가 없다');

  const queueFilesPlan = plan.queueFiles ?? {};
  if (queueFilesPlan.fallbackOrigin?.path !== '/queue/fallback') fail(planPath, '대기열 파일', 'S3 대체 원본 경로가 없다');
  if (JSON.stringify(queueFilesPlan.fallbackOrigin?.s3ListBucketPrefixes ?? []) !== JSON.stringify(['queue/shuffle-results/', 'queue/batch-results/'])) fail(planPath, '대기열 파일', '결과 접두사 s3:ListBucket 목록이 다르다');
  if (queueFilesPlan.errorCachingMinTtl !== 1) fail(planPath, '대기열 파일', '404 캐시 최소 TTL이 1초가 아니다');
  if (queueFilesPlan.resultHeaders?.['Access-Control-Allow-Origin'] !== 'https://www.peaket.example') fail(planPath, '대기열 파일', '결과 파일 CORS 출처가 다르다');
  if (queueFilesPlan.shuffleProof?.cacheControl !== 'public, max-age=5') fail(planPath, '대기열 파일', 'shuffle-proof 캐시가 5초가 아니다');
  if (plan.staticRetention?.days !== 30 || plan.staticRetention?.recentBuilds !== 5) fail(planPath, '대기열 파일', '정적 자산 보존이 30일·최근 5빌드가 아니다');
  return errors.length - before;
}

export function checkHcl(root = ROOT) {
  const before = errors.length;
  const kms = readPlan('infra/modules/kms/key-plan.json');
  const iam = readPlan('infra/modules/msk-iam/iam-plan.json');
  const edge = readPlan('infra/modules/cloudfront-waf/edge-plan.json');
  const hcl = (rel) => {
    try {
      return readText(rel);
    } catch {
      fail(rel, 'HCL', 'HCL 파일을 읽지 못했다');
      return '';
    }
  };
  const kmsMain = hcl('infra/modules/kms/main.tf');
  if (kmsMain && !kmsMain.includes('jsondecode(file("${path.module}/key-plan.json"))')) fail('infra/modules/kms/main.tf', 'HCL', 'key-plan.json을 읽지 않는다');
  for (const key of kms.keys ?? []) {
    if (kmsMain && !kmsMain.includes(`resource "aws_kms_key" "${snake(key.name)}"`)) fail('infra/modules/kms/main.tf', 'HCL', `${key.name} 키 리소스가 없다`);
    if (kmsMain && !kmsMain.includes(`resource "aws_kms_alias" "${snake(key.name)}_alias"`)) fail('infra/modules/kms/main.tf', 'HCL', `${key.name} 별칭 리소스가 없다`);
  }
  const iamMain = hcl('infra/modules/msk-iam/main.tf');
  if (iamMain && !iamMain.includes('jsondecode(file("${path.module}/iam-plan.json"))')) fail('infra/modules/msk-iam/main.tf', 'HCL', 'iam-plan.json을 읽지 않는다');
  for (const workload of iam.workloads ?? []) {
    if (iamMain && !iamMain.includes(`resource "aws_iam_role" "${snake(workload.name)}_pod_identity"`)) fail('infra/modules/msk-iam/main.tf', 'HCL', `${workload.name} Pod Identity 역할이 없다`);
    if (iamMain && !iamMain.includes(`resource "aws_iam_role" "${snake(workload.name)}_msk"`)) fail('infra/modules/msk-iam/main.tf', 'HCL', `${workload.name} MSK 역할이 없다`);
  }
  const edgeMain = hcl('infra/modules/cloudfront-waf/main.tf');
  if (edgeMain && !edgeMain.includes('jsondecode(file("${path.module}/edge-plan.json"))')) fail('infra/modules/cloudfront-waf/main.tf', 'HCL', 'edge-plan.json을 읽지 않는다');
  for (const distribution of edge.distributions ?? []) {
    if (edgeMain && !edgeMain.includes(`resource "aws_cloudfront_distribution" "${snake(distribution.name)}"`)) fail('infra/modules/cloudfront-waf/main.tf', 'HCL', `${distribution.name} 배포가 없다`);
  }
  for (const acl of edge.webAcls ?? []) {
    if (edgeMain && !edgeMain.includes(`resource "aws_wafv2_web_acl" "${snake(acl.name)}"`)) fail('infra/modules/cloudfront-waf/main.tf', 'HCL', `${acl.name} 웹 ACL이 없다`);
  }
  for (const policy of edge.responseHeadersPolicies ?? []) {
    if (edgeMain && !edgeMain.includes(`resource "aws_cloudfront_response_headers_policy" "${snake(policy.name)}"`)) fail('infra/modules/cloudfront-waf/main.tf', 'HCL', `${policy.name} 응답 헤더 정책이 없다`);
  }
  return errors.length - before;
}

export function checkIacCheck(root = ROOT) {
  const before = errors.length;
  let workflow;
  try {
    workflow = readText('.github/workflows/iac-check.yml');
  } catch {
    fail('.github/workflows/iac-check.yml', 'iac-check', '워크플로를 읽지 못했다');
    return 1;
  }
  for (const module of ['infra/modules/kms', 'infra/modules/msk-iam', 'infra/modules/cloudfront-waf']) {
    if (!workflow.includes(module)) fail('.github/workflows/iac-check.yml', 'iac-check', `${module}를 검증하지 않는다`);
  }
  if (!/terraform\s+validate/.test(workflow)) fail('.github/workflows/iac-check.yml', 'iac-check', 'terraform validate가 없다');
  if (!(/for\s+\w+\s+in[^\n]*infra\/modules/.test(workflow) || /find\s+infra\/modules/.test(workflow))) {
    fail('.github/workflows/iac-check.yml', 'iac-check', 'infra/modules를 순회해 validate하지 않는다');
  }
  if (!/terraform\s+-chdir="\$\{?\w+\}?"\s+(init|validate)/.test(workflow)) {
    fail('.github/workflows/iac-check.yml', 'iac-check', '모듈 디렉터리에서 terraform init/validate를 부르지 않는다');
  }
  return errors.length - before;
}

function main() {
  if (!['kms', 'iam', 'edge', 'all'].includes(command)) {
    console.error('쓰는 법: node tools/ci/platform-security.mjs <kms|iam|edge|all> [--root <폴더>]');
    process.exitCode = 2;
    return;
  }
  try {
    if (command === 'kms') checkKms();
    else if (command === 'iam') checkIam();
    else if (command === 'edge') checkEdge();
    else {
      checkKms();
      checkIam();
      checkEdge();
      checkHcl();
      checkIacCheck();
    }
  } catch (error) {
    if (error instanceof LoadError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  for (const error of errors) console.log(error);
  process.exitCode = errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  main();
}
