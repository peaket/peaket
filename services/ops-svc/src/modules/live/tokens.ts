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
