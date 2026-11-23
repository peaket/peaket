// 티켓 중계 조립(docs/observability.md §5 '경보 보내는 길' 티켓 중계, 기능 F-01-6, OPS-110). main.ts와 시험이 같은 함수를 부른다.
// 서비스 뼈대(createService: 앱 포트·관리 포트·로그·지표·준비 확인)에 웹훅 받는 곳 하나를 붙인다. 자기 DB가 없다.
// 환경 값이 틀리면 서비스를 만들기 전에 던진다(시작하지 않는다).
import 'reflect-metadata';
import type { Writable } from 'node:stream';
import { type Clock, Counter, createService, type PlatformLogger, type PlatformService, systemClock } from '@peaket/platform';
import { AppModule } from './app.module.js';
import { loadAlertIssueRelayConfig } from './config.js';
import { DECISIONS, GitHubRest, RelayAlerts, type Decision, VerifyWebhook, WEBHOOK_REJECT_REASONS, type WebhookRejectReason } from './modules/relay/index.js';

export const SERVICE = 'alert-issue-relay';

export interface AlertIssueRelayApp {
  /** http.inject로 부르고, management의 /metrics로 지표를 읽고, close로 닫는다 */
  service: PlatformService;
  /** 지금까지 받은 웹훅의 GitHub 호출이 모두 끝나면 풀린다 */
  idle(): Promise<void>;
}

export interface BuildAlertIssueRelayOptions {
  env: Record<string, string | undefined>;
  /** 기본 시스템 시계 */
  clock?: Clock;
  /** 로그 목적지. 기본 표준 출력 */
  logDestination?: Writable;
}

export async function buildAlertIssueRelay(o: BuildAlertIssueRelayOptions): Promise<AlertIssueRelayApp> {
  const config = loadAlertIssueRelayConfig(o.env);
  const clock = o.clock ?? systemClock;

  // 지표·로거는 서비스를 만든 뒤에 생긴다. 서비스가 듣기 전에는 웹훅이 오지 않으므로 그 뒤에 잇는다
  let decisions: Counter<'decision'> | undefined;
  let rejects: Counter<'reason'> | undefined;
  let log: PlatformLogger | undefined;
  const github = new GitHubRest({
    apiUrl: config.githubApiUrl,
    appId: config.appId,
    installationId: config.installationId,
    privateKey: config.privateKey,
    owner: config.owner,
    repository: config.repository,
    clock,
  });
  const relay = new RelayAlerts({ github, signals: { decision: (d: Decision) => decisions?.inc({ decision: d }) } });
  const verify = new VerifyWebhook({
    token: config.relayToken,
    onRejected: (reason: WebhookRejectReason) => {
      rejects?.inc({ reason });
      log?.warn({ kind: 'security', event: 'alert_relay_rejected', reason }, '경보 티켓 중계 웹훅을 거절했다');
    },
  });

  const service = await createService({
    name: SERVICE,
    env: o.env,
    clock,
    module: AppModule.register({ relay, verify }),
    ...(o.logDestination ? { logDestination: o.logDestination } : {}),
  });

  const registers = [service.metrics.registry];
  decisions = new Counter({ name: 'alert_relay_alerts_total', help: '받은 경보의 중계 결과 수(created·duplicate·closed·ignored)', labelNames: ['decision'], registers });
  rejects = new Counter({ name: 'alert_relay_rejected_total', help: '거절한 웹훅 수(까닭별, missing·mismatch)', labelNames: ['reason'], registers });
  for (const d of DECISIONS) decisions.inc({ decision: d }, 0);
  for (const r of WEBHOOK_REJECT_REASONS) rejects.inc({ reason: r }, 0);
  log = service.logger;

  return { service, idle: () => relay.idle() };
}
