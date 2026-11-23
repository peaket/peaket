// 증거 수집기 조립(docs/observability.md §5 '진단 증거' 증거 수집기의 동작, ADR-0070 결정 1, 기능 F-01-1). main.ts와 시험이 같은 함수를 부른다.
// 서비스 뼈대(createService: 앱 포트·관리 포트·로그·지표·준비 확인)에 웹훅 받는 곳 하나를 붙인다. 자기 DB가 없고 제어 토픽을 읽지 않는다
// (처리기가 public 하나뿐이라 종료 세션 목록이 필요 없다). 진단 증거 저장소는 부르는 쪽이 넘긴다(운영은 @peaket/platform s3EvidenceStore).
// 환경 값이 틀리면 서비스를 만들기 전에 던진다(시작하지 않는다).
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type Clock, Counter, createService, type EvidenceBytesStore, type PlatformService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { loadEvidenceCollectorConfig } from './config.js';
import {
  ALERT_DECISIONS,
  COLLECTION_RESULTS,
  CollectEvidence,
  type CollectorSignals,
  PostgresSnapshotSource,
  RedisSnapshotSource,
  VerifyWebhook,
  WEBHOOK_REJECT_REASONS,
  type WebhookRejectReason,
} from './modules/collector/index.js';

export { EVIDENCE_TARGET_INTERVAL_MS } from './modules/collector/index.js';

export const SERVICE = 'evidence-collector';

export interface EvidenceCollectorApp {
  /** http.inject로 부르고, management의 /metrics로 지표를 읽고, close로 닫는다 */
  service: PlatformService;
  /** 지금까지 받은 웹훅의 수집이 모두 끝나면 풀린다 */
  idle(): Promise<void>;
}

export interface BuildEvidenceCollectorOptions {
  env: Record<string, string | undefined>;
  /** 진단 증거 저장소(바이트 올리기). 파일 경로로 올리는 put은 쓰지 않는다 */
  store: EvidenceBytesStore;
  /** 기본 시스템 시계 */
  clock?: Clock;
  /** 로그 목적지. 기본 표준 출력 */
  logDestination?: Writable;
}

export async function buildEvidenceCollector(o: BuildEvidenceCollectorOptions): Promise<EvidenceCollectorApp> {
  const config = loadEvidenceCollectorConfig(o.env);
  const clock = o.clock ?? systemClock;

  // 지표·로거는 서비스를 만든 뒤에 생긴다. 서비스가 듣기 전에는 웹훅이 오지 않으므로 그 뒤에 잇는다
  let sink: CollectorSignals | undefined;
  let rejected: ((reason: WebhookRejectReason) => void) | undefined;
  const signals: CollectorSignals = {
    alert: (d) => sink?.alert(d),
    collection: (t, r) => sink?.collection(t, r),
    collected: (s) => sink?.collected(s),
    crashed: (t, c) => sink?.crashed(t, c),
  };
  const collect = new CollectEvidence({
    targets: config.targets,
    sources: { postgres: new PostgresSnapshotSource(), redis: new RedisSnapshotSource() },
    store: o.store,
    clock,
    signals,
  });
  const verify = new VerifyWebhook({ token: config.webhookToken, onRejected: (reason) => rejected?.(reason) });

  const service = await createService({
    name: SERVICE,
    env: o.env,
    clock,
    module: AppModule.register({ collect, verify }),
    ...(o.logDestination ? { logDestination: o.logDestination } : {}),
  });

  const registers = [service.metrics.registry];
  const collections = new Counter({
    name: 'evidence_collections_total',
    help: '증거 수집 결과 수(대상별, uploaded·partial·failed·throttled)',
    labelNames: ['target', 'result'],
    registers,
  });
  const alerts = new Counter({ name: 'evidence_webhook_alerts_total', help: '받은 경보 수(고른 결과별, collect·ignored·unknown_dependency)', labelNames: ['decision'], registers });
  const rejects = new Counter({ name: 'evidence_webhook_rejected_total', help: '거절한 웹훅 수(까닭별, missing·mismatch)', labelNames: ['reason'], registers });
  // 대상 수가 묶여 있어 라벨 값 조합을 처음부터 0으로 둔다(대시보드·경보가 없는 시계열과 0을 헷갈리지 않게)
  for (const t of config.targets) for (const result of COLLECTION_RESULTS) collections.inc({ target: t.name, result }, 0);
  for (const decision of ALERT_DECISIONS) alerts.inc({ decision }, 0);
  for (const reason of WEBHOOK_REJECT_REASONS) rejects.inc({ reason }, 0);

  // 수집 정보 로그 줄은 서비스 로그 수준과 관계없이 info부터 낸다
  const info = service.logger.child({}, { level: 'info' });
  sink = {
    alert: (decision) => alerts.inc({ decision }),
    collection: (target, result) => collections.inc({ target, result }),
    collected: (s) =>
      info.info(
        { kind: 'evidence', event: 'evidence_collected', target: s.target, targetKind: s.kind, result: s.result, objects: s.objects, bytes: s.bytes, durationMs: s.durationMs },
        '진단 증거를 떴다',
      ),
    crashed: (target, code) => service.logger.error({ kind: 'evidence', event: 'evidence_collect_crashed', target, code }, '진단 증거 수집이 예상하지 못한 오류로 멈췄다'),
  };
  rejected = (reason) => {
    rejects.inc({ reason });
    service.logger.warn({ kind: 'security', event: 'evidence_webhook_rejected', reason }, '증거 수집기 웹훅을 거절했다');
  };

  return { service, idle: () => collect.idle() };
}
