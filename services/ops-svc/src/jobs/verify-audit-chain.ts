// 감사 체인 검증 잡(ops-svc 이미지의 둘째 진입점, ADR-0341 결정 6). 실행: node --import @peaket/platform/telemetry/register dist/jobs/verify-audit-chain.js
// (package.json 스크립트 audit:verify). 운영은 1시간 [가정]마다 CronJob이 띄운다(차트·IAM 분리는 구간 5). 이 잡은 KMS VerifyMac만 쓴다.
// 끝 코드: VALID 0, MISMATCH 1, ERROR 2(검증하지 못함. 통과로 적지 않는다). 결과는 audit_verification_run에 남고, 어긋나면 SEV2 audit-chain-mismatch·AUDIT_CHAIN_MISMATCH를 낸다.
import { createDatabase } from '@peaket/platform';
import { DrizzleOpsAlertStore } from '../modules/alerts/index.js';
import {
  AuditChainVerifier,
  AuditCheckpointService,
  DrizzleAuditChain,
  DrizzleAuditCheckpointStore,
  DrizzleAuditMacStore,
  DrizzleAuditVerifyStore,
  auditEnvName,
  auditMacKeyFromEnv,
  macAnchorStoreFromEnv,
} from '../modules/audit/index.js';

const log = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level, service: 'ops-svc', job: 'verify-audit-chain', ...fields, msg }));

async function main(): Promise<number> {
  const env = process.env;
  const url = env.PEAKET_DATABASE_URL;
  if (!url) {
    log('error', {}, 'PEAKET_DATABASE_URL이 없다');
    return 2;
  }
  const envName = auditEnvName(env);
  const keyR = auditMacKeyFromEnv(env, { envName, onFailover: (op, err) => log('warn', { event: 'audit-kms-failover', op, err }, '감사 체인 키 호출을 복제 키 리전으로 넘겼다') });
  if (keyR.warning) {
    // 임시 키로는 서비스가 채운 mac을 검증할 수 없다: 통과로 적지 않는다
    log('error', {}, `${keyR.warning} — 검증 잡은 임시 키로 돌지 않는다`);
    return 2;
  }
  const anchorR = macAnchorStoreFromEnv(env, { envName });
  if (anchorR.warning) log('warn', {}, anchorR.warning);
  const database = createDatabase({ url, applicationName: 'ops-svc-verify-audit-chain', max: 2 });
  try {
    const chain = new DrizzleAuditChain(database);
    // 공개 체크포인트 서명은 audit_signing_key의 공개키로 확인한다(서명 키는 게시 작업만 쓴다, ADR-0348 결정 4)
    const checkpoints = new AuditCheckpointService(new DrizzleAuditCheckpointStore(database), chain, () => Date.now());
    const verifier = new AuditChainVerifier({
      store: new DrizzleAuditVerifyStore(database),
      key: keyR.key,
      ledger: new DrizzleAuditMacStore(database),
      anchors: anchorR.store,
      sourceMatches: (e) => chain.sourceMatches(e),
      checkpoints,
      alerts: new DrizzleOpsAlertStore(database),
      audit: chain,
    });
    const run = await verifier.verify({}, Date.now());
    log(run.result === 'VALID' ? 'info' : 'error', { result: run.result, fromSeq: run.fromSeq, toSeq: run.toSeq, ...(run.firstBadSeq !== undefined ? { firstBadSeq: run.firstBadSeq } : {}), ...(run.reason ? { reason: run.reason } : {}) }, '감사 체인 검증 결과');
    return run.result === 'VALID' ? 0 : run.result === 'MISMATCH' ? 1 : 2;
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log('error', { err: err instanceof Error ? err.name : 'unknown' }, '감사 체인 검증 잡이 실패했다');
    process.exit(2);
  },
);
