// 관제 늘 여는 SSE 흐름의 값·형식(docs/api/openapi.yaml /v1/ops/live, ADR-0100, BAT-465 R-584).
// event 이름은 openapi의 command·approval·alert·control·autoAction·presence·reset 가운데 이번 몫이 내는 command·audit·reset이다.
// id는 마지막으로 바뀐 시각(epoch ms)이다. 그래서 서버가 다시 떠도 Last-Event-ID로 그 뒤를 다시 보낼 수 있다.
// 1시간 [가정]보다 오래된 id면 reset을 보내고 화면은 REST로 다시 읽는다(openapi 설명).

/** 다시 붙을 때 그 뒤를 다시 보내는 창 1시간 [가정] */
export const OPS_LIVE_REPLAY_WINDOW_MS = 3_600_000;
/** 명령·감사 갱신을 훑는 주기 1초 [가정] */
export const OPS_LIVE_SCAN_MS = 1_000;
/** 주석 줄(연결 유지) 주기 15초 [가정] */
export const OPS_LIVE_HEARTBEAT_MS = 15_000;

export type OpsLiveEventName = 'command' | 'audit' | 'reset';

export interface OpsLiveEvent {
  /** 마지막으로 바뀐 시각(epoch ms). 같은 값이 여럿일 수 있어 화면은 대상 ID로 겹침을 지운다 */
  readonly id: number;
  readonly event: OpsLiveEventName;
  readonly data: unknown;
}

/** SSE 한 덩이. data는 한 줄 JSON이다 */
export function formatSse(e: OpsLiveEvent): string {
  return `id: ${e.id}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/** 연결 유지 주석 줄 */
export const SSE_HEARTBEAT = ': ping\n\n';

export type LastEventId = { kind: 'none' } | { kind: 'since'; sinceMs: number } | { kind: 'reset'; reason: 'too-old' | 'invalid' };

/**
 * Last-Event-ID 머리를 읽는다. 없으면 처음부터(지금부터) 보내고, 1시간 안이면 그 뒤를, 그보다 오래됐거나 숫자가 아니면 reset이다.
 * @param header 머리 값(없으면 undefined)
 * @param nowMs 지금(epoch ms)
 */
export function lastEventIdOf(header: string | undefined, nowMs: number): LastEventId {
  if (header === undefined || header.trim() === '') return { kind: 'none' };
  const raw = header.trim();
  if (!/^\d{1,16}$/.test(raw)) return { kind: 'reset', reason: 'invalid' };
  const sinceMs = Number(raw);
  if (!Number.isSafeInteger(sinceMs)) return { kind: 'reset', reason: 'invalid' };
  if (nowMs - sinceMs > OPS_LIVE_REPLAY_WINDOW_MS) return { kind: 'reset', reason: 'too-old' };
  return { kind: 'since', sinceMs };
}
