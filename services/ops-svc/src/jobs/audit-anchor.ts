// 감사 공개 앵커 게시 작업(ops-svc 이미지의 별도 진입점, ADR-0348 결정 1·4~6·9·11). 실행: node --import @peaket/platform/telemetry/register dist/jobs/audit-anchor.js
// (package.json 스크립트 audit:anchor). 운영은 5분 [가정]마다 CronJob이 띄운다(차트·IAM·Pod Identity는 구간 5). 한 실행의 차례는 modules/audit/publisher.ts 머리 주석.
// 겹쳐 돌지 않는다: 연결 하나를 실행 내내 쥐고 세션 잠금 pg_try_advisory_lock(hashtextextended('ops.audit-anchor.job', 0))을 잡는다. 못 잡으면 이미 도는 실행이 있어 바로 끝낸다(끝 코드 0).
//   (작업의 DB 역할 ops_audit_anchor는 audit_chain·audit_chain_head 읽기와 audit_checkpoint·audit_signing_key 쓰기만 있어 임대 표 ops_worker_lease를 쓰지 못한다)
// 환경 값: PEAKET_DATABASE_URL(ops_audit_anchor 역할 사용자), PEAKET_ENV,
//   서명 PEAKET_AUDIT_CHECKPOINT_KMS_KEY_ID(local·ci는 PEAKET_AUDIT_CHECKPOINT_LOCAL_KEY나 임시 키), 흉내 KMS PEAKET_KMS_ENDPOINT(local·ci만),
//   게시 PEAKET_AUDIT_PUBLIC_BUCKET·PEAKET_AUDIT_ANCHOR_BUCKET(local·ci는 PEAKET_AUDIT_PUBLIC_DIR·PEAKET_AUDIT_ANCHOR_DIR·메모리), 흉내 S3 PEAKET_AUDIT_ANCHOR_S3_ENDPOINT(local·ci만),
//   캘린더 PEAKET_OTS_CALENDAR_URLS(local·ci는 비면 가짜), 끝난 회차 목록 PEAKET_CORE_HTTP_URL·PEAKET_INTERNAL_TOKEN.
// local·ci 밖에서 KMS 키 ID·두 버킷·캘린더·core 주소 가운데 하나라도 없으면 시작하지 않는다(끝 코드 2).
// 끝 코드: 0 실행 끝(다시 할 실패는 다음 실행이 잇는다), 1 SEV2 조건(루트 어긋남·서명 불일치·같은 이름의 다른 공개 파일), 2 설정·시작 실패.
import { createDatabase, createExternalHttpClient } from '@peaket/platform';
import { HttpCoreOnsaleClosed } from '../adapters/http-core-onsale-closed.js';
import {
  AUDIT_ANCHOR_JOB_OPEN_ENVS,
  AuditCheckpointPublisher,
  DrizzleAuditChain,
  DrizzleAuditPublishStore,
  auditEnvName,
  auditPublicTargetsFromEnv,
  checkpointSignerFromEnv,
  otsCalendarsFromEnv,
  type ClosedOnsaleSource,
} from '../modules/audit/index.js';

const log = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level, service: 'ops-svc', job: 'audit-anchor', ...fields, msg }));

/** 실행 잠금 키(겹쳐 돌지 않게) */
const JOB_LOCK = "hashtextextended('ops.audit-anchor.job', 0)";

async function main(): Promise<number> {
  const env = process.env;
  const url = env.PEAKET_DATABASE_URL;
  if (!url) {
    log('error', {}, 'PEAKET_DATABASE_URL이 없다(ops_audit_anchor 역할 사용자)');
    return 2;
  }
  const envName = auditEnvName(env);
  const open = AUDIT_ANCHOR_JOB_OPEN_ENVS.includes(envName);
  let signerR: ReturnType<typeof checkpointSignerFromEnv>;
  let targetsR: ReturnType<typeof auditPublicTargetsFromEnv>;
  let calendarsR: ReturnType<typeof otsCalendarsFromEnv>;
  try {
    signerR = checkpointSignerFromEnv(env, { envName });
    targetsR = auditPublicTargetsFromEnv(env, { envName });
    calendarsR = otsCalendarsFromEnv(env, { envName });
  } catch (e) {
    log('error', { err: e instanceof Error ? e.message : 'unknown' }, '게시 작업 설정이 틀려 시작하지 않는다');
    return 2;
  }
  for (const w of [signerR.warning, ...targetsR.warnings, calendarsR.warning]) if (w) log('warn', {}, w);
  const coreUrl = env.PEAKET_CORE_HTTP_URL?.trim();
  let closed: ClosedOnsaleSource | undefined;
  if (coreUrl) {
    closed = new HttpCoreOnsaleClosed(createExternalHttpClient({ provider: 'core-svc', baseUrl: coreUrl, timeoutCapMs: 5_000 }), env.PEAKET_INTERNAL_TOKEN);
  } else if (open) {
    log('warn', {}, 'PEAKET_CORE_HTTP_URL이 없어 회차 마감 체크포인트를 만들지 않는다(일·수동 체크포인트만)');
  } else {
    log('error', {}, 'PEAKET_CORE_HTTP_URL이 없다(끝난 회차 목록, 회차 마감 체크포인트)');
    return 2;
  }
  const database = createDatabase({ url, applicationName: 'ops-svc-audit-anchor', max: 3 });
  const lockClient = await database.pool.connect();
  let locked = false;
  try {
    const r = await lockClient.query<{ ok: boolean }>(`select pg_try_advisory_lock(${JOB_LOCK}) as ok`);
    locked = r.rows[0]?.ok === true;
    if (!locked) {
      log('info', {}, '다른 게시 작업 실행이 돌고 있어 이번 실행은 끝낸다');
      return 0;
    }
    const publisher = new AuditCheckpointPublisher({
      store: new DrizzleAuditPublishStore(database),
      chain: new DrizzleAuditChain(database),
      signer: signerR.signer,
      calendars: calendarsR.calendars,
      targets: targetsR.targets,
      ...(closed ? { closed } : {}),
      log,
    });
    const run = await publisher.run(Date.now());
    const bad = run.mismatches.length > 0 || run.invalidSignatures.length > 0 || run.conflicts.length > 0;
    log(
      bad ? 'error' : run.errors.length > 0 ? 'warn' : 'info',
      {
        created: run.created,
        signed: run.signed,
        stamped: run.stamped,
        published: run.published,
        completed: run.completed,
        mismatches: run.mismatches,
        invalidSignatures: run.invalidSignatures,
        conflicts: run.conflicts,
        errors: run.errors,
        keyId: signerR.signer.keyId,
      },
      '감사 공개 앵커 게시 작업 결과',
    );
    return bad ? 1 : 0;
  } finally {
    try {
      if (locked) await lockClient.query(`select pg_advisory_unlock(${JOB_LOCK})`);
    } finally {
      lockClient.release();
      await database.close();
    }
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log('error', { err: err instanceof Error ? err.name : 'unknown' }, '감사 공개 앵커 게시 작업이 실패했다');
    process.exit(2);
  },
);
