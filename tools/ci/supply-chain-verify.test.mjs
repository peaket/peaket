// 공급망 검증(tools/ci/supply-chain-verify.mjs) 시험(GV-03, D-T32 ③, docs/devops.md §4.2·§4.3, ADR-0319, BAT-085).
// 고정물(tools/ci/fixtures/*.json)은 개인 키가 없는 공개 증명 모양이다. 판정은 정본(docs/devops.md:287~289)의 값과 견준다.
// 시험은 cosign을 부르지 않는다: 판정 함수와, 시험용 증명 파일을 읽는 길만 본다. 실행: node --test tools/ci/supply-chain-verify.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import {
  IDENTITY_ISSUER,
  IDENTITY_REGEXP,
  PROVENANCE,
  checkAttestation,
  cosignAttestationArgs,
  cosignVerifyArgs,
  digestProblem,
  imageReference,
  parseAttestations,
  runnerEnvironmentFromCertificate,
  verifyImage,
} from './supply-chain-verify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SCRIPT = join(HERE, 'supply-chain-verify.mjs');
const fixture = (name) => readFileSync(join(HERE, 'fixtures', name), 'utf8');
const statementOf = (name) => JSON.parse(fixture(name));
/** 정본 값: docs/devops.md §4.2 '서명·출처 증명' */
const REPOSITORY = 'https://github.com/peaket/peaket';
const WORKFLOW_PATH = '.github/workflows/build-image.yml';
const BUILD_TYPE = 'https://actions.github.io/buildtypes/workflow/v1';
const PREDICATE = 'https://slsa.dev/provenance/v1';
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** 시험용 인증서: Fulcio 확장 1.3.6.1.4.1.57264.1.11(실행기 종류)만 든 최소 DER. 서명 검증용이 아니다 */
function certificateWithRunner(runner) {
  const oid = Buffer.from('060b2b0601040183bf30010b', 'hex');
  const value = Buffer.from(runner, 'utf8');
  const utf8 = Buffer.concat([Buffer.from([0x0c, value.length]), value]);
  const octet = Buffer.concat([Buffer.from([0x04, utf8.length]), utf8]);
  const der = Buffer.concat([Buffer.from([0x30, oid.length + octet.length]), oid, octet]);
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
}

/** 한 칸만 바꾼 증명(값을 옮겨 적지 않고 정본 상수에서 시작한다) */
function mutated(mutate) {
  const s = statementOf('slsa-provenance-pass.json');
  mutate(s);
  return s;
}

function cli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// ===================== GV-03 D-T32 ③: 출처 증명 판정 =====================

test('GV-03 D-T32 ③ 출처 증명 고정물: release ref·GitHub 저장소·build-image.yml·github-hosted는 통과한다', () => {
  const s = statementOf('slsa-provenance-pass.json');
  assert.deepEqual(checkAttestation(s), []);
  assert.equal(s.predicateType, PREDICATE);
  assert.equal(s.predicate.buildDefinition.buildType, BUILD_TYPE);
  assert.equal(s.predicate.buildDefinition.externalParameters.workflow.repository, REPOSITORY);
  assert.equal(s.predicate.buildDefinition.externalParameters.workflow.path, WORKFLOW_PATH);
});

test('GV-03 D-T32 ③ develop·main에서 서명한 이미지는 거부한다(workflow.ref)', () => {
  assert.match(checkAttestation(statementOf('slsa-provenance-develop.json')).join('\n'), /workflow\.ref가 release\/hotfix가 아니다/);
  assert.match(checkAttestation(mutated((s) => (s.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/main'))).join('\n'), /workflow\.ref/);
  // 가지 이름 앞머리만 비슷한 값도 받지 않는다
  for (const ref of ['refs/heads/release', 'refs/heads/release-code/1.0', 'refs/heads/hotfix2/1.0', 'refs/tags/release/1.0']) {
    const problems = checkAttestation(mutated((s) => (s.predicate.buildDefinition.externalParameters.workflow.ref = ref)));
    assert.ok(problems.some((p) => p.includes('workflow.ref')), `${ref}: ${problems.join(' / ') || '통과했다'}`);
  }
  // release·hotfix는 통과한다
  for (const ref of ['refs/heads/release/1.5.0', 'refs/heads/hotfix/1.5.1']) {
    assert.deepEqual(checkAttestation(mutated((s) => (s.predicate.buildDefinition.externalParameters.workflow.ref = ref))), [], ref);
  }
});

test('GV-03 D-T32 ③ 자체 호스트 실행기(self-hosted)에서 서명한 이미지는 거부한다(runner_environment)', () => {
  assert.match(checkAttestation(statementOf('slsa-provenance-self-hosted.json')).join('\n'), /runner_environment가 github-hosted가 아니다/);
  for (const runner of ['self-hosted', 'self-hosted-runner', 'github-hosted-evil', 'GITHUB-HOSTED']) {
    const problems = checkAttestation(mutated((s) => (s.predicate.buildDefinition.internalParameters.github.runner_environment = runner)));
    assert.ok(problems.some((p) => p.includes('runner_environment')), `${runner}: ${problems.join(' / ') || '통과했다'}`);
  }
});

test('GV-03 D-T32 ③ runner_environment가 증명에 없으면 인증서 확장에서 읽고, 없으면 닫힌 쪽(거부)으로 실패한다', () => {
  const withoutRunner = mutated((s) => delete s.predicate.buildDefinition.internalParameters.github);
  assert.match(checkAttestation(withoutRunner).join('\n'), /확인하지 못했다/);
  assert.deepEqual(checkAttestation(withoutRunner, { certificate: certificateWithRunner('github-hosted') }), []);
  assert.match(checkAttestation(withoutRunner, { certificate: certificateWithRunner('self-hosted') }).join('\n'), /runner_environment가 github-hosted가 아니다/);
  // 인증서 확장 읽기(작은 DER 파서)도 시험한다
  assert.equal(runnerEnvironmentFromCertificate(certificateWithRunner('github-hosted')), 'github-hosted');
  assert.equal(runnerEnvironmentFromCertificate(certificateWithRunner('self-hosted')), 'self-hosted');
  assert.equal(runnerEnvironmentFromCertificate('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'), undefined);
  assert.equal(runnerEnvironmentFromCertificate('인증서가 아니다'), undefined);
});

test('GV-03 D-T32 ③ 다른 저장소·다른 워크플로 이름(build-image.yml.evil)·다른 buildType/predicateType은 거부한다', () => {
  const wrong = checkAttestation(statementOf('slsa-provenance-wrong-repo.json')).join('\n');
  assert.match(wrong, /workflow\.repository/);
  assert.match(wrong, /workflow\.path/);
  for (const [what, change] of [
    ['repository', (s) => (s.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/peaket-evil/peaket')],
    ['path', (s) => (s.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/build-image.yml.evil')],
    ['path2', (s) => (s.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml')],
    ['buildType', (s) => (s.predicate.buildDefinition.buildType = 'https://example.invalid/buildtype/v1')],
    ['predicateType', (s) => (s.predicateType = 'https://slsa.dev/provenance/v0.2')],
    ['predicate 없음', (s) => delete s.predicate.buildDefinition],
  ]) {
    const problems = checkAttestation(mutated(change));
    assert.ok(problems.length > 0, `${what}: 통과했다`);
  }
  assert.match(checkAttestation(statementOf('slsa-provenance-develop.json')).join('\n'), /workflow\.ref/);
});

test('GV-03 D-T32 ③ 서명 신원 정규식은 앞을 앵커해 build-image.yml.evil@…을 받지 않는다', () => {
  assert.equal(new RegExp(IDENTITY_REGEXP).test('https://github.com/peaket/peaket/.github/workflows/build-image.yml@refs/heads/release/1.5.0'), true);
  assert.equal(new RegExp(IDENTITY_REGEXP).test('https://github.com/peaket/peaket/.github/workflows/build-image.yml@refs/heads/hotfix/1.5.1'), true);
  for (const bad of [
    'https://github.com/peaket/peaket/.github/workflows/build-image.yml.evil@refs/heads/release/1.5.0',
    'https://github.com/peaket/peaket/.github/workflows/build-image.yml@refs/heads/develop',
    'https://github.com/peaket/peaket/.github/workflows/build-image.yml@refs/heads/main',
    'https://github.com/peaket-evil/peaket/.github/workflows/build-image.yml@refs/heads/release/1.5.0',
    'https://github.com/peaket/peaket/.github/workflows/build-image.yml@refs/tags/release/1.5.0',
  ]) {
    assert.equal(new RegExp(IDENTITY_REGEXP).test(bad), false, bad);
  }
  assert.equal(IDENTITY_ISSUER, 'https://token.actions.githubusercontent.com');
  // cosign 인자는 인덱스·플랫폼 이미지 모두(--recursive)와 정규식·발급자를 함께 준다
  const args = cosignVerifyArgs(`ghcr.io/peaket/queue-svc@${DIGEST}`);
  assert.ok(args.includes('--recursive'));
  assert.equal(args[args.indexOf('--certificate-identity-regexp') + 1], IDENTITY_REGEXP);
  assert.equal(args[args.indexOf('--certificate-oidc-issuer') + 1], IDENTITY_ISSUER);
  assert.equal(args.at(-1), `ghcr.io/peaket/queue-svc@${DIGEST}`);
  const att = cosignAttestationArgs(`ghcr.io/peaket/queue-svc@${DIGEST}`);
  assert.ok(att.includes('--recursive'));
  assert.equal(att[att.indexOf('--type') + 1], 'slsaprovenance1');
  assert.equal(att.at(-1), `ghcr.io/peaket/queue-svc@${DIGEST}`);
});

// ===================== 증명 읽기·이미지 참조 =====================

test('GV-03 D-T32 ③ 증명 읽기: JSON 한 객체·JSON 줄·배열·DSSE 봉투(base64 payload)를 같은 statement로 푼다', () => {
  const s = statementOf('slsa-provenance-pass.json');
  assert.deepEqual(parseAttestations(JSON.stringify(s)).statements, [s]);
  assert.deepEqual(parseAttestations(`${JSON.stringify(s)}\n${JSON.stringify(statementOf('slsa-provenance-develop.json'))}\n`).statements.length, 2);
  assert.deepEqual(parseAttestations(JSON.stringify([s])).statements, [s]);
  const envelope = JSON.stringify({ payloadType: 'application/vnd.in-toto+json', payload: Buffer.from(JSON.stringify(s)).toString('base64') });
  assert.deepEqual(parseAttestations(envelope).statements, [s]);
  // predicate만 저장한 고정물도 받는다(시험용)
  assert.deepEqual(parseAttestations(JSON.stringify({ predicate: s.predicate })).statements.length, 1);
  // 읽지 못하는 입력은 문제로 돌려준다(조용히 통과하지 않는다)
  assert.ok(parseAttestations('').problems.length > 0);
  assert.ok(parseAttestations('{').problems.length > 0);
  assert.ok(parseAttestations('"글"').problems.length > 0);
});

test('GV-03 D-T32 ③ 이미지 참조·다이제스트: sha256:<64자리>만 받고 태그·짧은 해시·빈 값은 거부한다', () => {
  assert.equal(imageReference('ghcr.io/peaket/queue-svc', DIGEST), `ghcr.io/peaket/queue-svc@${DIGEST}`);
  assert.equal(digestProblem(DIGEST), undefined);
  for (const bad of [undefined, '', 'sha256:abc', `sha256:${'A'.repeat(64)}`, `sha512:${'a'.repeat(128)}`, `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`]) {
    assert.ok(digestProblem(bad), String(bad));
  }
});

test('GV-03 D-T32 ③ verifyImage는 증명 파일이 있으면 cosign을 부르지 않고 그 증명만 본다', () => {
  const pass = join(HERE, 'fixtures', 'slsa-provenance-pass.json');
  assert.deepEqual(verifyImage({ image: 'ghcr.io/peaket/queue-svc', digest: DIGEST, attestationFile: pass }), { ok: true, problems: [] });
  const develop = join(HERE, 'fixtures', 'slsa-provenance-develop.json');
  const r = verifyImage({ image: 'ghcr.io/peaket/queue-svc', digest: DIGEST, attestationFile: develop });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /workflow\.ref/);
  const missing = verifyImage({ image: 'ghcr.io/peaket/queue-svc', digest: DIGEST, attestationFile: join(HERE, 'fixtures', '없는파일.json') });
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join('\n'), /증명 파일이 없다/);
  // 증명에 runner_environment가 없으면 닫힌 쪽으로 거부한다
  const dir = tempDir('scv-');
  const file = join(dir, 'no-runner.json');
  writeFileSync(file, JSON.stringify(mutated((s) => delete s.predicate.buildDefinition.internalParameters.github)));
  assert.match(verifyImage({ image: 'ghcr.io/peaket/queue-svc', digest: DIGEST, attestationFile: file }).problems.join('\n'), /runner_environment/);
});

test('GV-03 D-T32 ③ 명령줄: 통과 0, develop·자체 호스트·다른 저장소 1, 인자 오류 2', () => {
  const pass = cli(['--image', 'ghcr.io/peaket/queue-svc', '--digest', DIGEST, '--attestation', join(HERE, 'fixtures', 'slsa-provenance-pass.json')]);
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /^ok /m);
  for (const name of ['slsa-provenance-develop.json', 'slsa-provenance-self-hosted.json', 'slsa-provenance-wrong-repo.json']) {
    const r = cli(['--image', 'ghcr.io/peaket/queue-svc', '--digest', DIGEST, '--attestation', join(HERE, 'fixtures', name)]);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, /^fail /m, name);
  }
  const json = cli(['--image', 'ghcr.io/peaket/queue-svc', '--digest', DIGEST, '--attestation', join(HERE, 'fixtures', 'slsa-provenance-pass.json'), '--json']);
  assert.equal(json.code, 0, json.out);
  assert.equal(JSON.parse(json.out).ok, true);
  assert.equal(cli([]).code, 2);
  assert.equal(cli(['--image', 'ghcr.io/peaket/queue-svc']).code, 2);
  assert.equal(cli(['--image', 'ghcr.io/peaket/queue-svc', '--digest', 'abc']).code, 1);
  assert.equal(cli(['--image', 'ghcr.io/peaket/queue-svc', '--digest', DIGEST, '--attestation', join(REPO, '없는파일')]).code, 1);
});
