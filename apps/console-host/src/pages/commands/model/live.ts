// SCR-030 관제 늘 여는 SSE 흐름의 화면 쪽 값(BAT-465 R-584, openapi /v1/ops/live, ADR-0100).
// 콘솔은 5초 폴링 대신 이 흐름을 받는다. 다시 붙으면 Last-Event-ID를 브라우저가 보내고, 서버가 1시간 밖이면 reset을 보낸다.
// reset을 받으면 REST로 목록을 다시 읽는다(openapi 설명).

/** 관제 SSE 경로 */
export const OPS_LIVE_PATH = '/v1/ops/live';

/** 빌드의 관제 API 주소에서 SSE 주소를 만든다(끝의 /는 하나로 줄인다) */
export function liveUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${OPS_LIVE_PATH}`;
}

export interface LiveFrame {
  /** 마지막으로 바뀐 시각(epoch ms). 없거나 숫자가 아니면 undefined */
  id?: number;
  event: string;
  data: unknown;
}

/** EventSource의 한 사건을 화면 값으로. data가 JSON이 아니면 null */
export function parseLiveFrame(e: { lastEventId?: string; type?: string; data?: string }): LiveFrame | null {
  if (!e.data) return null;
  let data: unknown;
  try {
    data = JSON.parse(e.data) as unknown;
  } catch {
    return null;
  }
  const id = e.lastEventId !== undefined && /^\d{1,16}$/.test(e.lastEventId) ? Number(e.lastEventId) : undefined;
  return { ...(id !== undefined ? { id } : {}), event: e.type ?? 'message', data };
}

/** 명령 한 건을 목록에 합친다(있으면 바꾸고, 없으면 맨 앞에 넣는다). 같은 ID는 하나만 남긴다 */
export function mergeCommand<T extends { commandId: string; updatedAt: string }>(items: readonly T[], row: T, max = 100): T[] {
  const rest = items.filter((x) => x.commandId !== row.commandId);
  const next = [row, ...rest];
  next.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return next.slice(0, max);
}
