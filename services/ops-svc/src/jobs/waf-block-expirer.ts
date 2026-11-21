// 만료 차단 정리 작업(ops-svc 이미지의 별도 진입점, ADR-0349 결정 9, ADR-0162, docs/features/control-tower.md §5 'AWS WAF API' 행).
// 실행: node --import @peaket/platform/telemetry/register dist/jobs/waf-block-expirer.js (package.json 스크립트 waf:expire). 운영은 1분 [가정]마다 CronJob이 띄운다(차트·IAM·kube-state-metrics 경보는 구간 5).
// 한 실행의 차례는 modules/commands/application/expire-waf-blocks.ts 머리 주석. ops-svc를 부르지 않고 명령 상태를 쓰지 않는다.
// 환경 값: PEAKET_DATABASE_URL(DB 사용자는 waf_block_expirer 역할 — 보기 waf_block_expiry_v의 SELECT만), PEAKET_ENV,
//   PEAKET_WAF_IPSET_V4·PEAKET_WAF_IPSET_V6('<이름>|<ID>'), PEAKET_WAF_SCOPE(REGIONAL|CLOUDFRONT), 흉내 끝점 PEAKET_WAF_ENDPOINT(local·ci만).
// IP 집합이 없으면 시작하지 않는다(끝 코드 2). 끝 코드: 0 끝(뺄 것 없음 포함), 1 이번 실행 실패(잠금 토큰 두 번 충돌·WAF·DB 오류, 다음 실행이 다시 한다), 2 설정·시작 실패.
import { createDatabase } from '@peaket/platform';
import { auditEnvName } from '../modules/audit/index.js';
import { AwsWafIpSets, DrizzleWafBlockExpiryView, ExpireWafBlocks, wafIpSetsConfigFromEnv } from '../modules/commands/index.js';

const log = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level, service: 'ops-svc', job: 'waf-block-expirer', ...fields, msg }));

async function main(): Promise<number> {
  const env = process.env;
  const url = env.PEAKET_DATABASE_URL;
  if (!url) {
    log('error', {}, 'PEAKET_DATABASE_URL이 없다(waf_block_expirer 역할 사용자)');
    return 2;
  }
  let config: ReturnType<typeof wafIpSetsConfigFromEnv>;
  try {
    config = wafIpSetsConfigFromEnv(env, { envName: auditEnvName(env) });
  } catch (e) {
    log('error', { err: e instanceof Error ? e.message : 'unknown' }, '만료 차단 정리 작업 설정이 틀려 시작하지 않는다');
    return 2;
  }
  if (!config) {
    log('error', {}, 'PEAKET_WAF_IPSET_V4·PEAKET_WAF_IPSET_V6이 없다(관제용 WAF IP 집합)');
    return 2;
  }
  const database = createDatabase({ url, applicationName: 'ops-svc-waf-block-expirer', max: 1 });
  try {
    const run = await new ExpireWafBlocks({ view: new DrizzleWafBlockExpiryView(database), ipSets: new AwsWafIpSets(config), log }).run(Date.now());
    log(
      run.failed ? 'error' : 'info',
      { families: run.families.map((f) => ({ family: `IPV${f.family}`, removed: f.removed.length, retried: f.retried, ...(f.error !== undefined ? { error: f.error } : {}) })) },
      '만료 차단 정리 작업 결과',
    );
    return run.failed ? 1 : 0;
  } finally {
    await database.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log('error', { err: err instanceof Error ? err.name : 'unknown' }, '만료 차단 정리 작업이 실패했다');
    process.exit(1);
  },
);
