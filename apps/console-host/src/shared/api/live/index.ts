// 관제 실시간 연결의 공개 면(ADR-0360): 늘 여는 흐름·위젯 흐름·원격 위젯 통로.
export { onLive, openWidgetKeys, servicesFor, setLiveEvent, startLive, stopLive } from './connection';
export { LIVE_JITTER_MS, LIVE_REOPEN_MIN_MS, LIVE_RETRY_MS, LIVE_SILENCE_MS, ManagedStream, SseParser, frameData, type ManagedStreamDeps, type RefreshResult, type SseFrame, type StreamStatus } from './live-stream';
export { WIDGET_LIST_DEBOUNCE_MS, WidgetStreams, widgetStreamUrl, type WidgetValueMessage } from './widget-stream';
export { createConsoleServices, type ConsoleServicesDeps } from './console-services';
