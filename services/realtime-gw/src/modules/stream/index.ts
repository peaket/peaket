// stream 모듈의 공개 이름(좌석 델타 WebSocket, BUILD_ORDER HOT-090). 조립(start.ts·app.module.ts)과 시험은 이 파일로만 가져온다.
export {
  BATCH_INTERVAL_MS,
  CLOSE,
  CLOSE_REASON,
  HEARTBEAT_EVERY_MS,
  MAX_BUFFERED_BYTES,
  MAX_SUBSCRIBED_SECTIONS,
  MAX_SUBSCRIBES_PER_WINDOW,
  MAX_WAIT_MS_CAP,
  SUBSCRIBE_WINDOW_MS,
  TIME_SYNC_MIN_GAP_MS,
  createStreamHub,
  type ChannelSubscriber,
  type StreamConnection,
  type StreamHub,
  type StreamHubDeps,
} from './application/hub.js';
export { KEY_PART, parseSeatDeltaMessage, parseSectionChannel, sectionChannel, type SeatDeltaMessage } from './application/message.js';
export { MAX_INBOUND_FRAME_BYTES, decodeInbound, encodeBatchInterval, encodeHeartbeat, encodeSeatDeltaBatch, type BatchEntry, type InboundFrame } from './application/frames.js';
export { AUTH_PROTOCOL_PREFIX, SEATS_PROTOCOL, StreamGateway, type HandshakeRejectReason, type HandshakeRejectStatus, type StreamGatewayDeps } from './inbound/handshake.js';
export { LAYOUT_MISSING_MAX, LAYOUT_MISSING_TTL_MS, LAYOUT_REFRESH_MS, LayoutSectionsFile, layoutSectionsOf, type LayoutSections, type LayoutSectionsOptions } from './adapters/layout-sections.js';
export { RedisChannelSubscriber, RedisChannelSubscriberStartError, SUBSCRIBER_STARTUP_TIMEOUT_MS, type RedisChannelSubscriberOptions } from './adapters/redis-subscriber.js';
