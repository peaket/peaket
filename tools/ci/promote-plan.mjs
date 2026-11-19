#!/usr/bin/env node
// 승격 PR의 계획과 본문(tools/ci/promote-plan.mjs, docs/devops.md §5.3, ADR-0169, BUILD_ORDER BAS-140, 묶음 BAT-080 G7).
// - 같은 다이제스트만 쓴다. 이미지를 다시 빌드하지 않고, `deploy/envs/<환경>/<서비스>.yaml`의 image.digest만 바꾼다.
// - 후보 목록은 릴리스 봇이 만든 JSON 파일이다(기본 .cache/release-candidates.json). 꼴:
//     [{ "service": "purchase-svc", "repository": "ghcr.io/peaket/purchase-svc", "digest": "sha256:<64자리>" }]
//   또는 { "services": [...] }. `repository`는 새 파일을 만들 때만 쓴다.
// - `--check`는 후보의 다이제스트가 이미 값 파일에 있는지 본다. 다르거나 파일이 없으면 실패(종료 코드 1)다.
// - `--write`는 바뀐 배포 단위의 파일만 고친다(주석을 지우지 않게 digest 줄만 바꾼다).
// 쓰는 법: node tools/ci/promote-plan.mjs --env demo --tag v1.2.3 [--candidates <파일>] [--write] [--body <파일>] [--summary <파일>]
//           node tools/ci/promote-plan.mjs --env prod --tag v1.2.3 --check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 승격 환경(docs/devops.md §5.1·§5.2). local·ci는 kind 시험이라 승격 PR을 만들지 않는다 */
export const PROMOTE_ENVS = ['local', 'ci', 'staging', 'demo', 'prod'];
/** 데모는 검사를 통과하면 자동 병합한다(docs/devops.md §5.3) */
export const DEMO_AUTO_MERGE = true;
/** 운영은 사람이 병합한다 */
export const PROD_MANUAL_MERGE = true;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SERVICE = /^[a-z][a-z0-9-]*$/;

/** 후보 목록 하나를 { service, repository?, digest }로 맞춘다. 꼴이 틀리면 던진다 */
function normaliseEntry(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('후보 목록의 칸은 객체다');
  const service = raw.service ?? raw.name ?? raw.workload;
  const digest = raw.digest ?? raw.imageDigest;
  if (typeof service !== 'string' || !SERVICE.test(service)) throw new Error(`후보의 service가 DNS 이름이 아니다: ${String(service)}`);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error(`${service}: digest는 sha256:<64자리 16진수>다(태그를 쓰지 않는다)`);
  const rawRepository = raw.repository ?? raw.image;
  let repository;
  if (rawRepository !== undefined) {
    if (typeof rawRepository !== 'string' || rawRepository.trim() === '' || rawRepository.includes('@') || /:[^/]+$/.test(rawRepository)) {
      throw new Error(`${service}: repository는 태그·다이제스트가 없는 이미지 이름이다: ${String(rawRepository)}`);
    }
    repository = rawRepository;
  }
  return {
    service,
    digest,
    ...(repository ? { repository } : {}),
    ...(typeof raw.changes === 'string' ? { changes: raw.changes } : {}),
    ...(typeof raw.sbom === 'string' ? { sbom: raw.sbom } : {}),
    ...(typeof raw.notes === 'string' ? { notes: raw.notes } : {}),
  };
}

/**
 * 후보 목록 JSON을 읽는다. 목록·{ services: [...] }·{ 서비스: 다이제스트 } 지도를 받는다
 * @param {string} text
 */
export function parseCandidates(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`후보 목록이 JSON이 아니다: ${e instanceof Error ? e.message : String(e)}`);
  }
  let raw;
  if (Array.isArray(doc)) raw = doc;
  else if (doc && typeof doc === 'object' && Array.isArray(doc.services)) raw = doc.services;
  else if (doc && typeof doc === 'object' && Array.isArray(doc.candidates)) raw = doc.candidates;
  else if (doc && typeof doc === 'object' && doc.digests && typeof doc.digests === 'object' && !Array.isArray(doc.digests)) raw = Object.entries(doc.digests).map(([service, digest]) => ({ service, digest }));
  else throw new Error('후보 목록은 배열이거나 { services: [...] }·{ digests: { <서비스>: <다이제스트> } }다');
  const entries = raw.map(normaliseEntry);
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.service)) throw new Error(`후보 목록에 ${e.service}가 두 번 있다`);
    seen.add(e.service);
  }
  return entries;
}

/** 후보 목록 파일을 읽는다 */
export function readCandidates(file) {
  if (!existsSync(file)) throw new Error(`후보 목록 파일이 없다: ${file}`);
  return parseCandidates(readFileSync(file, 'utf8'));
}

/** 값 파일에서 image.digest를 읽는다. 없으면 undefined */
export function readDigest(text) {
  const lines = text.split(/\r?\n/);
  let inImage = false;
  for (const line of lines) {
    if (/^image:\s*(#.*)?$/.test(line)) {
      inImage = true;
      continue;
    }
    if (!inImage) continue;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^\s+/.test(line)) break;
    const m = /^\s+digest:\s*["']?(sha256:[0-9a-f]{64})["']?\s*(#.*)?$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

/** 값 파일의 image.digest 줄만 바꾼다. 없으면 image: 아래에 더한다(주석을 지우지 않는다) */
export function setDigest(text, digest) {
  if (!DIGEST.test(digest)) throw new Error(`digest는 sha256:<64자리 16진수>다: ${digest}`);
  const lines = text.split(/\r?\n/);
  const image = lines.findIndex((l) => /^image:\s*(#.*)?$/.test(l));
  if (image < 0) {
    const sep = text === '' || text.endsWith('\n') ? '' : '\n';
    return `${text}${sep}image:\n  digest: ${digest}\n`;
  }
  let lastChild = image;
  let indent = '  ';
  for (let i = image + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const m = /^(\s+)\S/.exec(line);
    if (!m) break;
    indent = m[1];
    lastChild = i;
    const d = /^\s+digest:\s*/.exec(line);
    if (d) {
      lines[i] = `${indent}digest: ${digest}`;
      return lines.join('\n');
    }
  }
  lines.splice(lastChild + 1, 0, `${indent}digest: ${digest}`);
  return lines.join('\n');
}

/** 새 환경 값 파일(첫 승격 PR). 같은 다이제스트만 쓴다. repository가 없으면 GHCR의 공개 패키지 이름을 쓴다 */
function newFileText(entry, env) {
  const repository = entry.repository ?? `ghcr.io/peaket/${entry.service}`;
  return [
    `# 승격 PR이 만든 환경 값(docs/devops.md §5.3, ADR-0169). 같은 다이제스트만 쓰고 다시 빌드하지 않는다.`,
    `name: ${entry.service}`,
    '',
    'image:',
    `  repository: ${repository}`,
    `  digest: ${entry.digest}`,
    '',
    'env:',
    `  PEAKET_ENV: ${env}`,
    '',
    'diagnose:',
    `  bucket: peaket-diag-${env}`,
    '',
  ].join('\n');
}

/**
 * 승격 계획을 만든다. 파일을 쓰지 않는다
 * @param {{ env: string, tag: string, candidates: ReturnType<typeof parseCandidates>, root?: string }} o
 */
export function promotionPlan(o) {
  const env = String(o.env ?? '');
  if (!PROMOTE_ENVS.includes(env)) throw new Error(`환경은 ${PROMOTE_ENVS.join('·')} 가운데 하나다: ${env}`);
  const root = resolve(o.root ?? '.');
  const entries = o.candidates.map((c) => normaliseEntry(c)).map((c) => {
    const file = `deploy/envs/${env}/${c.service}.yaml`;
    const full = join(root, file);
    const before = existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    const beforeDigest = before === undefined ? undefined : readDigest(before);
    const action = before === undefined ? 'create' : beforeDigest === c.digest ? 'unchanged' : 'update';
    return { ...c, file, action, ...(beforeDigest ? { before: beforeDigest } : {}), ...(before === undefined ? {} : { text: before }) };
  });
  return {
    env,
    tag: String(o.tag ?? ''),
    entries,
    changes: entries.filter((e) => e.action !== 'unchanged'),
    unchanged: entries.filter((e) => e.action === 'unchanged'),
  };
}

/** 계획을 파일에 쓴다. 바뀐(또는 새) 배포 단위만 고친다 */
export function applyPlan(plan, root = '.') {
  const out = [];
  for (const entry of plan.changes) {
    const full = join(resolve(root), entry.file);
    mkdirSync(dirname(full), { recursive: true });
    const text = entry.text === undefined ? newFileText(entry, plan.env) : setDigest(entry.text, entry.digest);
    writeFileSync(full, text);
    out.push({ service: entry.service, file: entry.file, digest: entry.digest, action: entry.action });
  }
  return out;
}

/** 후보의 다이제스트가 값 파일과 같은지 본다. 다르거나 없으면 어긋남이다 */
export function checkPlan(plan, root = '.') {
  const mismatches = [];
  for (const entry of plan.entries) {
    const full = join(resolve(root), entry.file);
    if (!existsSync(full)) {
      mismatches.push({ service: entry.service, file: entry.file, expected: entry.digest, actual: null, reason: '파일 없음' });
      continue;
    }
    const actual = readDigest(readFileSync(full, 'utf8'));
    if (actual !== entry.digest) mismatches.push({ service: entry.service, file: entry.file, expected: entry.digest, actual: actual ?? null, reason: actual ? '다른 다이제스트' : 'digest 없음' });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * PR 본문을 만든다. 데모는 자동 병합, 운영은 사람 병합이고, 동결 창·조치 기한·Pact·arm64 스모크가 필수 조건이다
 * @param {ReturnType<typeof promotionPlan>} plan
 */
export function promotionBody(plan) {
  const rows = plan.changes.map((e) => `| ${e.service} | \`${e.file}\` | ${e.before ?? '—'} | \`${e.digest}\` | ${e.action === 'create' ? '새 값' : '바뀜'} |`);
  const same = plan.unchanged.map((e) => `- ${e.service}: \`${e.digest}\`(그대로)`);
  const changes = plan.changes.map((e) => e.changes ?? e.notes).filter(Boolean);
  const sbom = plan.entries.map((e) => e.sbom).filter(Boolean);
  return [
    `# 승격: ${plan.env} ${plan.tag}`,
    '',
    '같은 다이제스트만 승격한다. 환경마다 다시 빌드하지 않고, `main`에 병합한 뒤에도 다시 빌드하지 않는다(docs/devops.md §5.3, ADR-0169).',
    '',
    '## 바뀐 배포 단위',
    '',
    '| 배포 단위 | 파일 | 전 | 후 | 결과 |',
    '| --- | --- | --- | --- | --- |',
    ...(rows.length > 0 ? rows : ['| (없음) | — | — | — | — |']),
    '',
    '## 바뀌지 않은 배포 단위',
    '',
    ...(same.length > 0 ? same : ['- (없음)']),
    '',
    '## 변경 기록',
    '',
    ...(changes.length > 0 ? changes.map((c) => `- ${c}`) : [`- 출시 태그 ${plan.tag}의 후보 다이제스트 목록을 따른다.`]),
    '',
    '## SBOM 요약',
    '',
    ...(sbom.length > 0 ? sbom.map((s) => `- ${s}`) : ['- 후보 목록에 SBOM 요약이 없다(릴리스 봇이 붙인다).']),
    '',
    '## 필수 조건',
    '',
    '- 동결 창 밖일 것(docs/devops.md §8)',
    '- 조치 기한을 넘긴 취약점이 없을 것(docs/devops.md §4.4)',
    '- 제공자 Pact 검증을 통과했을 것(docs/devops.md §3.3)',
    '- arm64 이미지 스모크를 한 번은 통과했을 것(docs/devops.md §5.3)',
    ...(plan.env === 'demo'
      ? ['- 데모: 검사를 통과하면 자동 병합한다.']
      : plan.env === 'prod'
        ? ['- 운영: 사람이 병합한다. 데모 카나리 통과·체류 1시간 이상·오류 예산이 남아 있을 것도 함께 본다.']
        : ['- 이 환경은 승격 PR을 만들지 않는다(local·ci는 kind 시험, staging은 측정 캠페인).']),
    '',
  ].join('\n');
}

/** 명령줄 인자를 읽는다 */
export function parseArgs(argv) {
  const o = { env: '', tag: '', candidates: join('.cache', 'release-candidates.json'), write: false, check: false, body: '', summary: '', root: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a}에 값이 없다`);
      return v;
    };
    if (a === '--env') o.env = value();
    else if (a === '--tag') o.tag = value();
    else if (a === '--candidates') o.candidates = value();
    else if (a === '--write') o.write = true;
    else if (a === '--check') o.check = true;
    else if (a === '--body') o.body = value();
    else if (a === '--summary') o.summary = value();
    else if (a === '--root') o.root = value();
    else throw new Error(`모르는 인자: ${a}`);
  }
  if (!o.env) throw new Error('--env가 필요하다(demo·prod 등)');
  if (!PROMOTE_ENVS.includes(o.env)) throw new Error(`환경은 ${PROMOTE_ENVS.join('·')} 가운데 하나다: ${o.env}`);
  if (!o.tag) throw new Error('--tag가 필요하다(예 v1.2.3)');
  return o;
}

/** 명령줄 본체. 종료 코드를 돌려준다(0 통과, 1 검사 어긋남, 2 인자·파일 오류) */
export function main(argv) {
  const o = parseArgs(argv);
  const candidates = readCandidates(resolve(o.root, o.candidates));
  const plan = promotionPlan({ env: o.env, tag: o.tag, candidates, root: o.root });
  if (o.check) {
    const r = checkPlan(plan, o.root);
    console.log(JSON.stringify({ env: o.env, tag: o.tag, ok: r.ok, mismatches: r.mismatches }, null, 2));
    return r.ok ? 0 : 1;
  }
  if (o.write) applyPlan(plan, o.root);
  if (o.body) {
    mkdirSync(dirname(resolve(o.root, o.body)), { recursive: true });
    writeFileSync(resolve(o.root, o.body), promotionBody(plan));
  }
  if (o.summary) {
    mkdirSync(dirname(resolve(o.root, o.summary)), { recursive: true });
    writeFileSync(resolve(o.root, o.summary), `${JSON.stringify({ env: plan.env, tag: plan.tag, changed: plan.changes.map((e) => ({ service: e.service, file: e.file, digest: e.digest })), unchanged: plan.unchanged.map((e) => ({ service: e.service, file: e.file, digest: e.digest })) }, null, 2)}\n`);
  }
  console.log(JSON.stringify({ env: plan.env, tag: plan.tag, changed: plan.changes.map((e) => ({ service: e.service, file: e.file, digest: e.digest, action: e.action })), unchanged: plan.unchanged.map((e) => ({ service: e.service, digest: e.digest })) }, null, 2));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  }
}
