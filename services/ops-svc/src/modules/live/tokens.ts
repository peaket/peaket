// 관제 SSE 모듈의 주입 이름.
/** 알림 표 읽기(PushEventSource): DB 조립은 DrizzlePushEvents, 메모리 조립은 MemoryPushEvents */
export const PUSH_EVENT_SOURCE = Symbol.for('peaket.ops.live.pushEventSource');
/** 접속자 표(PresenceStore) */
export const PRESENCE_STORE = Symbol.for('peaket.ops.live.presenceStore');
/** 위젯 값 원천 목록(WidgetSource[]) */
export const WIDGET_SOURCES = Symbol.for('peaket.ops.live.widgetSources');
/** 종료 세션 목록의 읽기 면(platform AuthState.terminated) */
export const TERMINATED_SESSIONS = Symbol.for('peaket.ops.live.terminatedSessions');
/** 정비 반복을 켤지(DB 조립만) */
export const LIVE_RETENTION_ENABLED = Symbol.for('peaket.ops.live.retentionEnabled');
/** 경보 기록 표의 쓰기·목록 읽기(OpsAlertStore & OpsAlertList, F-03-3): DB 조립은 DrizzleOpsAlertStore, 메모리 조립은 MemoryOpsAlertStore */
export const LIVE_ALERT_STORE = Symbol.for('peaket.ops.live.alertStore');
/** 대기열 Redis 제어 상태 읽기(ControlReader, 없으면 undefined) */
export const CONTROL_READER = Symbol.for('peaket.ops.live.controlReader');
/** 시작 조립 값(LiveWiring, 환경 값으로 고른 원천 주소·환경 이름) */
export const LIVE_WIRING = Symbol.for('peaket.ops.live.wiring');
