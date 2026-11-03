// 계정 없는 AWS 흉내 서버(moto)가 우리가 쓰는 기능을 흉내 내는지 본다(docs/infra.md §3 'LocalStack 준비물'의 ③, BUILD_ORDER FND-110).
// - S3 Object Lock: 증거 버킷의 보존 기한(COMPLIANCE)과 법적 보존(legal hold)이 지우기를 막는다(docs/security, FRN-040)
// - KMS 비대칭 서명: ECC_NIST_P256 키로 ECDSA_SHA_256 서명·검증(키 증명·토큰 서명 키의 KMS 대안을 시험할 때)
// - Secrets Manager: 새 판을 넣으면 AWSCURRENT가 바뀌고 앞 판은 AWSPREVIOUS로 남는다(비밀 교체)
// 자격 증명은 가짜 값이다(흉내 서버는 서명을 검사하지 않는다). AWS CLI v2를 쓴다(GitHub 호스트 러너에 있다).
// 실행(저장소 뿌리): node tools/local/cluster.mjs up && node --test tools/local/e2e/aws-emulator.e2e.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { ensureTool } from '../tools.mjs';
import { KUBECONFIG } from '../cluster.mjs';

const PORT = 15_000 + Math.floor(Math.random() * 1_000);
const ENV = { ...process.env, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_DEFAULT_REGION: 'ap-northeast-2', AWS_PAGER: '', AWS_EC2_METADATA_DISABLED: 'true' };
const aws = (args) => JSON.parse(execFileSync('aws', ['--endpoint-url', `http://127.0.0.1:${PORT}`, '--output', 'json', ...args], { encoding: 'utf8', env: ENV }) || '{}');
const awsFails = (args) => {
  try {
    aws(args);
    return '';
  } catch (e) {
    return String(e.stderr ?? e.message);
  }
};

test('FND110_AWS흉내서버_S3객체잠금·KMS비대칭서명·SecretsManager판을_계정없이흉내낸다', { timeout: 120_000 }, async (t) => {
  const k = await ensureTool('kubectl');
  const pf = spawn(k, ['--kubeconfig', KUBECONFIG, '-n', 'peaket-local', 'port-forward', 'svc/aws', `${PORT}:5000`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => pf.kill());
  await new Promise((res, rej) => {
    pf.stdout.on('data', (d) => String(d).includes('Forwarding from') && res());
    pf.on('exit', (c) => rej(new Error(`port-forward 끝남 ${c}`)));
  });

  await t.test('S3 Object Lock: 보존 기한·법적 보존이 판 지우기를 막는다', () => {
    const bucket = `evidence-${Date.now()}`;
    aws(['s3api', 'create-bucket', '--bucket', bucket, '--object-lock-enabled-for-bucket', '--create-bucket-configuration', 'LocationConstraint=ap-northeast-2']);
    assert.equal(aws(['s3api', 'get-object-lock-configuration', '--bucket', bucket]).ObjectLockConfiguration.ObjectLockEnabled, 'Enabled');
    const put = aws(['s3api', 'put-object', '--bucket', bucket, '--key', 'case-1/bundle.zip', '--body', 'tools/local/e2e/aws-emulator.e2e.mjs']);
    const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    aws(['s3api', 'put-object-retention', '--bucket', bucket, '--key', 'case-1/bundle.zip', '--retention', `Mode=COMPLIANCE,RetainUntilDate=${until}`]);
    // moto 5.2.5는 보존 기한 읽기(GetObjectRetention)를 구현하지 않고 객체를 돌려준다(2026-11-01 확인). 보존 값은 객체 머리로 본다
    const head = aws(['s3api', 'head-object', '--bucket', bucket, '--key', 'case-1/bundle.zip']);
    assert.equal(head.ObjectLockMode, 'COMPLIANCE');
    assert.ok(Date.parse(head.ObjectLockRetainUntilDate) > Date.now());
    assert.match(awsFails(['s3api', 'delete-object', '--bucket', bucket, '--key', 'case-1/bundle.zip', '--version-id', put.VersionId]), /AccessDenied/);
    const put2 = aws(['s3api', 'put-object', '--bucket', bucket, '--key', 'case-2/bundle.zip', '--body', 'tools/local/e2e/aws-emulator.e2e.mjs']);
    aws(['s3api', 'put-object-legal-hold', '--bucket', bucket, '--key', 'case-2/bundle.zip', '--legal-hold', 'Status=ON']);
    assert.equal(aws(['s3api', 'get-object-legal-hold', '--bucket', bucket, '--key', 'case-2/bundle.zip']).LegalHold.Status, 'ON');
    assert.match(awsFails(['s3api', 'delete-object', '--bucket', bucket, '--key', 'case-2/bundle.zip', '--version-id', put2.VersionId]), /AccessDenied/);
  });

  await t.test('KMS: P-256 서명 키로 서명하고 검증한다(바뀐 메시지는 검증 실패)', () => {
    const key = aws(['kms', 'create-key', '--key-spec', 'ECC_NIST_P256', '--key-usage', 'SIGN_VERIFY']).KeyMetadata.KeyId;
    const msg = Buffer.from('peaket-proof').toString('base64');
    const sig = aws(['kms', 'sign', '--key-id', key, '--message', msg, '--message-type', 'RAW', '--signing-algorithm', 'ECDSA_SHA_256']).Signature;
    assert.ok(sig);
    const ok = aws(['kms', 'verify', '--key-id', key, '--message', msg, '--message-type', 'RAW', '--signing-algorithm', 'ECDSA_SHA_256', '--signature', sig]);
    assert.equal(ok.SignatureValid, true);
    const bad = Buffer.from('peaket-proof!').toString('base64');
    // 실제 AWS는 틀린 서명에 KMSInvalidSignatureException을 던지고, moto는 SignatureValid false로 답한다(2026-11-01 확인). 둘 다 '검증 실패'로 본다
    let invalid;
    try {
      invalid = aws(['kms', 'verify', '--key-id', key, '--message', bad, '--message-type', 'RAW', '--signing-algorithm', 'ECDSA_SHA_256', '--signature', sig]).SignatureValid === false;
    } catch (e) {
      invalid = /KMSInvalidSignature/.test(String(e.stderr));
    }
    assert.equal(invalid, true);
    // 공개키만 꺼낼 수 있다(개인키는 KMS 밖으로 나오지 않는다)
    assert.ok(aws(['kms', 'get-public-key', '--key-id', key]).PublicKey);
  });

  await t.test('Secrets Manager: 새 판을 넣으면 앞 판이 AWSPREVIOUS로 남는다', () => {
    const name = `peaket/local/test-${Date.now()}`;
    aws(['secretsmanager', 'create-secret', '--name', name, '--secret-string', 'v1']);
    aws(['secretsmanager', 'put-secret-value', '--secret-id', name, '--secret-string', 'v2']);
    assert.equal(aws(['secretsmanager', 'get-secret-value', '--secret-id', name]).SecretString, 'v2');
    assert.equal(aws(['secretsmanager', 'get-secret-value', '--secret-id', name, '--version-stage', 'AWSPREVIOUS']).SecretString, 'v1');
  });
});
