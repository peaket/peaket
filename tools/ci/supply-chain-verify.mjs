#!/usr/bin/env node
// 공급망 검증(docs/devops.md §4.2·§4.3, D-T32 ③, ADR-0319). cosign 서명과 SLSA v1 출처 증명을 본다.
// 쓰는 법: node tools/ci/supply-chain-verify.mjs --image <저장소> --digest sha256:<64자리> [--attestation <파일>] [--json]
//   --attestation  cosign verify-attestation의 출력(JSON 줄)이나 in-toto statement JSON을 읽는다. 없으면 cosign을 부른다
//   --json         판정을 JSON 한 덩이로 찍는다
// 끝 코드: 0 통과, 1 거부, 2 인자 오류
// 판정의 정본 값은 docs/devops.md §4.2·§4.3이다. 이 파일은 그 값을 옮겨 적지 않고 상수 이름으로 가리킨다.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runIfMain } from './entry.mjs';

/** 서명 신원의 정규식(앞을 앵커한다). `build-image.yml.evil@…`을 받지 않는다(B9) */
export const IDENTITY_REGEXP = '^https://github\\.com/peaket/peaket/\\.github/workflows/build-image\\.yml@refs/heads/(release|hotfix)/';
/** 신원 발급자 */
export const IDENTITY_ISSUER = 'https://token.actions.githubusercontent.com';
/** 출처 증명의 정본 값(docs/devops.md §4.2) */
export const PROVENANCE = {
  predicateType: 'https://slsa.dev/provenance/v1',
  buildType: 'https://actions.github.io/buildtypes/workflow/v1',
  workflowRepository: 'https://github.com/peaket/peaket',
  workflowPath: '.github/workflows/build-image.yml',
  workflowRef: /^refs\/heads\/(release|hotfix)\//,
  runnerEnvironment: 'github-hosted',
};
/** Fulcio 확장 1.3.6.1.4.1.57264.1.11(실행기 종류)의 DER OID 바이트 */
const FULCIO_RUNNER_ENVIRONMENT_OID = Buffer.from('060b2b0601040183bf30010b', 'hex');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * cosign verify-attestation 출력(JSON 줄·JSON 배열·한 객체)과 in-toto statement를 statement 목록으로 푼다.
 * DSSE 봉투(payload·payloadType)는 base64로 풀어 안의 statement를 쓴다.
 * @param {string} text
 * @returns {{ statements: any[], problems: string[] }}
 */
export function parseAttestations(text) {
  const problems = [];
  const statements = [];
  const take = (value) => {
    if (typeof value === 'string') {
      try {
        take(JSON.parse(value));
      } catch {
        problems.push('증명 JSON을 읽지 못했다');
      }
    } else if (Array.isArray(value)) {
      for (const x of value) take(x);
    } else if (isObject(value)) {
      if (typeof value.payload === 'string' && (value.payloadType === 'application/vnd.in-toto+json' || value.payloadType === undefined)) {
        try {
          take(JSON.parse(Buffer.from(value.payload, 'base64').toString('utf8')));
        } catch {
          problems.push('증명 payload(base64)를 읽지 못했다');
        }
      } else if (value.predicateType || value._type === 'https://in-toto.io/Statement/v1' || value._type === 'https://in-toto.io/Statement/v0.1') {
        statements.push(value);
      } else if (isObject(value.predicate) && isObject(value.predicate.buildDefinition)) {
        // statement의 머리 없이 predicate만 저장한 고정물도 받는다(시험용)
        statements.push(value);
      } else {
        problems.push('in-toto statement가 아닌 JSON이다');
      }
    } else problems.push(`증명이 JSON 객체가 아니다(${typeof value})`);
  };
  const trimmed = text.trim();
  if (!trimmed) return { statements, problems: ['증명 파일이 비었다'] };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      take(JSON.parse(trimmed));
    } catch {
      // JSON 줄 여러 개일 수 있다
      for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
        try {
          take(JSON.parse(line));
        } catch {
          problems.push(`증명 줄을 읽지 못했다: ${line.slice(0, 80)}`);
        }
      }
    }
  } else {
    for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
      try {
        take(JSON.parse(line));
      } catch {
        problems.push(`증명 줄을 읽지 못했다: ${line.slice(0, 80)}`);
      }
    }
  }
  return { statements, problems };
}

/** DER 길이(짧은 형식·긴 형식) */
function derLength(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined) return null;
  if (first < 0x80) return { length: first, end: offset + 1 };
  const n = first & 0x7f;
  if (n === 0 || offset + 1 + n > bytes.length) return null;
  let length = 0;
  for (let i = 0; i < n; i++) length = (length << 8) | bytes[offset + 1 + i];
  return { length, end: offset + 1 + n };
}

/**
 * Fulcio 인증서(PEM)의 확장 1.3.6.1.4.1.57264.1.11(실행기 종류)을 읽는다. 없거나 형식이 다르면 undefined.
 * cert-manager·cosign이 넣는 값은 UTF8String이다.
 * @param {string} pem
 * @returns {string | undefined}
 */
export function runnerEnvironmentFromCertificate(pem) {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!m) return undefined;
  let der;
  try {
    der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  } catch {
    return undefined;
  }
  const at = der.indexOf(FULCIO_RUNNER_ENVIRONMENT_OID);
  if (at < 0) return undefined;
  // OID 뒤에서 OCTET STRING(0x04)을 찾고 그 안의 UTF8String(0x0c)을 읽는다
  for (let i = at + FULCIO_RUNNER_ENVIRONMENT_OID.length; i < Math.min(der.length, at + 64); i++) {
    if (der[i] !== 0x04) continue;
    const outer = derLength(der, i + 1);
    if (!outer) continue;
    let j = outer.end;
    if (der[j] === 0x0c) {
      const inner = derLength(der, j + 1);
      if (!inner) continue;
      return der.subarray(inner.end, inner.end + inner.length).toString('utf8');
    }
  }
  return undefined;
}

/** attestation의 인증서(PEM) 자리에서 첫 인증서를 고른다(고정물·cosign 출력 모두) */
function certificateOf(statement) {
  for (const key of ['certificate', 'cert', 'pem']) {
    if (typeof statement?.[key] === 'string' && statement[key].includes('BEGIN CERTIFICATE')) return statement[key];
  }
  return undefined;
}

/**
 * SLSA v1 출처 증명 하나를 정본 값과 견준다.
 * @param {any} statement in-toto statement(predicate.buildDefinition을 가진 것)
 * @param {{ certificate?: string }} [o] runner_environment가 증명에 없을 때 읽을 인증서
 * @returns {string[]} 문제 목록(비었으면 통과)
 */
export function checkAttestation(statement, o = {}) {
  const problems = [];
  if (!isObject(statement)) return ['증명이 묶음이 아니다'];
  if (statement.predicateType !== PROVENANCE.predicateType) problems.push(`predicateType이 ${PROVENANCE.predicateType}가 아니다(${JSON.stringify(statement.predicateType)})`);
  const p = statement.predicate;
  if (!isObject(p) || !isObject(p.buildDefinition)) return [...problems, 'predicate.buildDefinition이 없다'];
  const b = p.buildDefinition;
  if (b.buildType !== PROVENANCE.buildType) problems.push(`buildDefinition.buildType이 ${PROVENANCE.buildType}가 아니다(${JSON.stringify(b.buildType)})`);
  const workflow = b.externalParameters?.workflow;
  if (!isObject(workflow)) problems.push('externalParameters.workflow가 없다');
  else {
    if (workflow.repository !== PROVENANCE.workflowRepository) problems.push(`workflow.repository가 ${PROVENANCE.workflowRepository}가 아니다(${JSON.stringify(workflow.repository)})`);
    if (workflow.path !== PROVENANCE.workflowPath) problems.push(`workflow.path가 ${PROVENANCE.workflowPath}가 아니다(${JSON.stringify(workflow.path)})`);
    if (typeof workflow.ref !== 'string' || !PROVENANCE.workflowRef.test(workflow.ref)) problems.push(`workflow.ref가 release/hotfix가 아니다(${JSON.stringify(workflow.ref)})`);
  }
  let runner = b.internalParameters?.github?.runner_environment;
  if (runner === undefined) runner = runnerEnvironmentFromCertificate(o.certificate ?? certificateOf(statement) ?? '');
  if (runner === undefined) problems.push('runner_environment를 증명이나 인증서에서 확인하지 못했다(닫힘 실패)');
  else if (runner !== PROVENANCE.runnerEnvironment) problems.push(`runner_environment가 ${PROVENANCE.runnerEnvironment}가 아니다(${JSON.stringify(runner)})`);
  return problems;
}

/** 이미지 참조: 저장소@sha256:<64자리> */
export function imageReference(repository, digest) {
  return `${repository}@${digest}`;
}

/** 다이제스트 형식 */
export function digestProblem(digest) {
  return typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest) ? undefined : `다이제스트가 sha256:<64자리>가 아니다(${JSON.stringify(digest)})`;
}

/** cosign 서명 확인 인자(인덱스·플랫폼 이미지 모두, 정규식은 앵커) */
export function cosignVerifyArgs(ref) {
  return ['verify', '--recursive', '--certificate-identity-regexp', IDENTITY_REGEXP, '--certificate-oidc-issuer', IDENTITY_ISSUER, ref];
}

/** cosign 출처 증명 확인 인자 */
export function cosignAttestationArgs(ref) {
  return ['verify-attestation', '--type', 'slsaprovenance1', '--recursive', '--certificate-identity-regexp', IDENTITY_REGEXP, '--certificate-oidc-issuer', IDENTITY_ISSUER, ref];
}

/**
 * 이미지 하나를 검증한다. attestationFile이 있으면 cosign을 부르지 않고 그 증명만 본다(시험·오프라인).
 * @param {{ image: string, digest: string, attestationFile?: string, run?: (cmd: string, args: string[]) => string }} o
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function verifyImage(o) {
  const problems = [];
  const d = digestProblem(o.digest);
  if (d) problems.push(d);
  if (!o.image || !/^[a-z0-9][a-z0-9._/-]*$/.test(o.image)) problems.push(`이미지 저장소가 아니다(${JSON.stringify(o.image)})`);
  if (problems.length) return { ok: false, problems };
  const ref = imageReference(o.image, o.digest);
  const run = o.run ?? ((cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (o.attestationFile) {
    if (!existsSync(o.attestationFile)) return { ok: false, problems: [`증명 파일이 없다: ${o.attestationFile}`] };
    const parsed = parseAttestations(readFileSync(o.attestationFile, 'utf8'));
    problems.push(...parsed.problems);
    if (!parsed.statements.length) problems.push('증명 statement가 없다');
    for (const statement of parsed.statements) problems.push(...checkAttestation(statement));
    return { ok: problems.length === 0, problems };
  }
  try {
    run('cosign', cosignVerifyArgs(ref));
  } catch (e) {
    problems.push(`cosign 서명 확인이 실패했다(${String(e.stderr ?? e.message).trim().split(/\r?\n/).at(-1) ?? '까닭 없음'})`);
  }
  try {
    const out = run('cosign', cosignAttestationArgs(ref));
    const parsed = parseAttestations(out);
    problems.push(...parsed.problems);
    if (!parsed.statements.length) problems.push('SLSA 출처 증명을 찾지 못했다');
    for (const statement of parsed.statements) problems.push(...checkAttestation(statement));
  } catch (e) {
    problems.push(`cosign 출처 증명 확인이 실패했다(${String(e.stderr ?? e.message).trim().split(/\r?\n/).at(-1) ?? '까닭 없음'})`);
  }
  return { ok: problems.length === 0, problems };
}

const USAGE = '쓰는 법: node tools/ci/supply-chain-verify.mjs --image <저장소> --digest sha256:<64자리> [--attestation <파일>] [--json]';

/** @param {string[]} argv */
export function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { image: { type: 'string' }, digest: { type: 'string' }, attestation: { type: 'string' }, json: { type: 'boolean' } }, strict: true, allowPositionals: false }));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (!values.image || !values.digest) {
    console.error(USAGE);
    return 2;
  }
  const result = verifyImage({ image: values.image, digest: values.digest, attestationFile: values.attestation ? resolve(values.attestation) : undefined });
  if (values.json) console.log(JSON.stringify(result));
  else if (result.ok) console.log(`ok ${values.image}@${values.digest}: 서명·출처 증명이 정본과 같다`);
  else for (const p of result.problems) console.error(`fail ${values.image}@${values.digest}: ${p}`);
  return result.ok ? 0 : 1;
}

await runIfMain(import.meta.url, () => main(process.argv.slice(2)));
