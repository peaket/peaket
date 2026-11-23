// 관제 SSE 모듈의 공개 면(ADR-0360). 다른 기능(갈래 1 OPS-160 실시간 표, F-02-1 자동 제어 control)은 이 파일로만 가져온다.
// F-03-3(ADR-0371): 자동 제어 상태 감시(ControlWatch·읽기 포트·주기), 관제 판단 위젯 원천, 경보 목록 REST와 경보 본문 규칙.
export { OpsLiveFeed, approvalOf, type OpsLiveCheckpointSource, type OpsLiveCommandSource, type OpsLiveFeedDeps, type PushDelivery } from './application/ops-live-feed.js';
export { PushHub, settleRows, type HubDelivery, type PushHubOptions, type PushListener } from './application/push-hub.js';
export { PresenceHub, type PresenceOptions, type PresenceSnapshot } from './application/presence.js';
export { WidgetFeed, unavailableValue, type WidgetFeedOptions, type WidgetListener } from './application/widget-feed.js';
export {
  OPS_LIVE_EVENTS,
  OPS_LIVE_GAP_WAIT_MS,
  OPS_LIVE_HEARTBEAT_MS,
  OPS_LIVE_LATE_WATCH_MAX,
  OPS_LIVE_LATE_WATCH_MS,
  OPS_LIVE_PENDING_LIMIT_BYTES,
  OPS_LIVE_POLL_MS,
  OPS_LIVE_REPLAY_WINDOW_MS,
  OPS_LIVE_RETRY_MS,
  OPS_LIVE_SESSION_CHECK_MS,
  OPS_LIVE_START_LOOKBACK,
  OPS_PRESENCE_GATHER_MS,
  OPS_PRESENCE_WINDOW_MS,
  OPS_PRESENCE_WRITE_MS,
  SSE_HEARTBEAT,
  TOKEN_EXP_HEADER,
  formatSse,
  lastEventIdOf,
  resumeVerdictOf,
  rolesOf,
  sseOpening,
  type LastEventId,
  type LiveCloseReason,
  type OpsLiveEvent,
  type OpsLiveEventName,
  type PushEventRow,
  type PushKind,
  type ResumeVerdict,
} from './domain/live.js';
export {
  BUDGET_JOURNEYS,
  LINKED_JOURNEYS,
  OpsBudgetJourneys,
  OpsDiagnosticsSummary,
  OpsReadinessChecklist,
  OpsSaturationSummary,
  SATURATION_LEVELS,
  PurchasePgStatusSummary,
  QueueAdmissionRateSummary,
  RtSalesSummary,
  WIDGET_KEYS,
  WIDGET_KEYS_PER_STREAM,
  WIDGET_MAX_RANGE_MS,
  WIDGET_RANGE_MS,
  WIDGET_SOURCE_OF,
  WIDGET_TICK_MS,
  WidgetUnavailable,
  WidgetValue,
  isWidgetKey,
  parseWidgetList,
  type WidgetKey,
} from './domain/widgets.js';
export { WidgetSourceUnavailable, type ControlReader, type PresenceEntry, type PresenceStore, type PushEventSource, type WidgetReadQuery, type WidgetSource } from './domain/ports.js';
export { DrizzlePushEvents, pushRowOf } from './adapters/db/drizzle-push-events.js';
export { DrizzlePresence } from './adapters/db/drizzle-presence.js';
export { MemoryPresence, MemoryPushEvents } from './adapters/memory-push-events.js';
export { PROMETHEUS_RANGE_STEP_S, PROMETHEUS_TIMEOUT_MS, PROMETHEUS_WIDGET_KEYS, PrometheusWidgetSource, REMOTE_WIDGET_KEYS, UnavailableWidgetSource, WIDGET_QUERIES } from './adapters/prometheus-widget-source.js';
export {
  BUDGET_RULES,
  PendingDiagnosticsSource,
  PrometheusBudgetSource,
  PrometheusQuery,
  PrometheusSaturationSource,
  ReadinessWidgetSource,
  SATURATION_QUERIES,
  SATURATION_THRESHOLDS,
  UnavailableJudgementSource,
  saturationLevelOf,
  worstLevel,
} from './adapters/prometheus-judgement-sources.js';
export { CONTROL_EVENTS_MAX, CONTROL_READ_DEADLINE_MS, RedisControlReader } from './adapters/redis-control-reader.js';
export { CONTROL_READ_ALERT_AFTER_MS, CONTROL_READ_ALERT_KEY, CONTROL_WATCH_TICK_MS, ControlWatch, type ControlListener, type ControlWatchOptions } from './application/control-watch.js';
export { ACTIVE_EVENTS_KEY, CONTROL_KINDS, NO_INPUT_ALERT, PLATFORM_CTL_KEY, controlOf, ctlKeyOf, inputStaleOf, sameControl, type ControlKind, type ControlValue, type LastDecrease } from './domain/control.js';
export { ALERT_DETAIL_FIELDS, ALERT_JOURNEYS, ALERT_KINDS, alertBodyOf } from './domain/alert-body.js';
export { ALERT_LIST_MAX, ALERT_LIST_RESOLVED_KEEP_MS, OpsAlertsController, OpsAlertsQuery } from './inbound/ops-alerts.controller.js';
export { ControlWatchJob } from './jobs/control-watch.job.js';
export { OpsLiveController, OpsLiveQuery } from './inbound/ops-live.controller.js';
export { OpsEventLiveController } from './inbound/ops-event-live.controller.js';
export { OpsWidgetsController } from './inbound/ops-widgets.controller.js';
export { OPS_LIVE_ACCESS_TOKEN_TTL_MS, SseConnection, tokenDeadlineOf, type SseConnectionOptions, type TerminatedSessionsView } from './inbound/sse-connection.js';
export { PushRetentionJob } from './jobs/push-retention.js';
export { CORE_HTTP_URL_ENV, LIVE_OPEN_ENVS, PROMETHEUS_URL_ENV, QUEUE_REDIS_CLUSTER_URLS_ENV, QUEUE_REDIS_URL_ENV, judgeAccountRefOf, liveWiringOf, widgetSourcesFromEnv, type LiveWiring } from './live-wiring.js';
export { LiveModule, type LiveModuleExtras } from './live.module.js';
export { CONTROL_READER, LIVE_ALERT_STORE, LIVE_RETENTION_ENABLED, LIVE_WIRING, PRESENCE_STORE, PUSH_EVENT_SOURCE, TERMINATED_SESSIONS, WIDGET_SOURCES } from './tokens.js';
