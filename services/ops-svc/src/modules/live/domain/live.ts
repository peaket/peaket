// 관제 늘 여는 SSE 흐름의 값·형식(docs/api/openapi.yaml /v1/ops/live, asyncapi sse.ops-live, ADR-0100 결정 2·4, docs/frontend.md §4.4.4, ADR-0360).
// id는 ops DB 알림 표 ops_push_event의 순번(seq)이다. 다시 붙을 때 Last-Event-ID 뒤를 다시 보내고, 1시간 [가정] 밖이거나 지운 번호면 reset이다.
// 값의 정본은 ADR-0100·frontend §4.4.4이고, 여기 상수는 그 값을 코드에 둔 자리다(시험은 정본에서 값을 가져온다).
/** 다시 붙을 때 그 뒤를 다시 보내는 창이자 알림 표 보관 1시간 [가정](ADR-0100 결정 2·4) */
export const OPS_LIVE_REPLAY_WINDOW_MS = 3_600_000;
/** 파드마다 알림 표를 읽는 주기 0.5초 [가정](ADR-0100 결정 4) */
export const OPS_LIVE_POLL_MS = 500;
/** 주석 줄(: hb) 주기 15초 [가정](ADR-0100 결정 2) */
export const OPS_LIVE_HEARTBEAT_MS = 15_000;
/** 브라우저 다시 붙기 간격(retry) 10초(ADR-0100 결정 2) */
export const OPS_LIVE_RETRY_MS = 10_000;
/** 읽지 않는 연결에 쌓인 양의 상한 1MiB [가정]. 넘으면 닫는다(ADR-0100 결정 2 '서버', ADR-0360 결정 5) */
export const OPS_LIVE_PENDING_LIMIT_BYTES = 1_048_576;
/** 세션 종료(종료 세션 목록)를 보는 주기 5초 [가정](ADR-0360 결정 4) */
export const OPS_LIVE_SESSION_CHECK_MS = 5_000;
/** 알림 표 순번의 빈 번호(되돌린 트랜잭션·아직 커밋 전)를 기다리는 시간 2초 [가정]. 넘으면 건너뛴다(ADR-0360 결정 1) */
export const OPS_LIVE_GAP_WAIT_MS = 2_000;
/** 한 번에 읽는 알림 행 수 */
export const OPS_LIVE_READ_LIMIT = 200;
/** 정비 반복(1시간 지난 알림 행·45초 지난 접속자 행 지우기) 주기 1분 [가정] */
export const OPS_LIVE_RETENTION_MS = 60_000;

/** 접속자 행을 고쳐 쓰는 주기 15초 [가정](ADR-0100 결정 4) */
export const OPS_PRESENCE_WRITE_MS = 15_000;
/** 접속 중으로 보는 창 45초 [가정](ADR-0100 결정 4) */
export const OPS_PRESENCE_WINDOW_MS = 45_000;
/** 회차별 접속자를 모으는 주기 5초 [가정](ADR-0100 결정 4) */
export const OPS_PRESENCE_GATHER_MS = 5_000;

/** 늘 여는 흐름의 사건 이름(openapi /v1/ops/live). control·autoAction은 이름과 전달 길만 두고 원천은 F-02-1·F-03-4다 */
export const OPS_LIVE_EVENTS = ['command', 'approval', 'alert', 'control', 'autoAction', 'presence', 'reset'] as const;
export type OpsLiveEventName = (typeof OPS_LIVE_EVENTS)[number];
/** 알림 표에 쓰는 종류(presence는 표에 쓰지 않고 파드가 모아 보낸다, docs/data.md ops_push_event) */
export type PushKind = 'command' | 'approval' | 'alert' | 'autoAction';

/** 흐름을 닫은 까닭(서버 로그 reason, ADR-0360 결정 4·5) */
export type LiveCloseReason = 'token-expired' | 'session-ended' | 'backpressure' | 'client';

export interface OpsLiveEvent {
  /** 알림 표 순번(위젯 흐름은 계산 시각 ms). 없으면 id 줄을 쓰지 않는다(presence) */
  readonly id?: number;
  readonly event: OpsLiveEventName | 'widget';
  readonly data: unknown;
}

/**
 * SSE 한 덩이. data는 JSON 한 줄이다: JSON.stringify는 줄바꿈을 \n으로 바꿔 쓰므로 본문 글에 줄바꿈·event:가 들어도 새 사건이 생기지 않는다(ASVS 1.2.3)
 */
export function formatSse(e: OpsLiveEvent): string {
  return `${e.id !== undefined ? `id: ${e.id}\n` : ''}event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/** 첫 덩이: 다시 붙기 간격. 커서를 주면 사건 없이 id만 둔다(브라우저의 마지막 id가 그 값이 되어, 첫 사건 전에 끊겨도 빠짐없이 다시 붙는다) */
export function sseOpening(cursor?: number): string {
  return `retry: ${OPS_LIVE_RETRY_MS}\n${cursor !== undefined ? `id: ${cursor}\n` : ''}\n`;
}

/** 연결 유지 주석 줄 */
export const SSE_HEARTBEAT = ': hb\n\n';

export type LastEventId = { kind: 'none' } | { kind: 'since'; seq: number } | { kind: 'reset'; reason: 'invalid' };

/**
 * Last-Event-ID 머리를 읽는다. 없으면 지금부터, 순번 꼴이면 그 뒤를(창 판정은 알림 표로 한다), 숫자가 아니면 reset이다.
 * @param header 머리 값(없으면 undefined)
 */
export function lastEventIdOf(header: string | undefined): LastEventId {
  if (header === undefined || header.trim() === '') return { kind: 'none' };
  const raw = header.trim();
  if (!/^\d{1,16}$/.test(raw)) return { kind: 'reset', reason: 'invalid' };
  const seq = Number(raw);
  if (!Number.isSafeInteger(seq)) return { kind: 'reset', reason: 'invalid' };
  return { kind: 'since', seq };
}

/** 알림 표 한 행 */
export interface PushEventRow {
  readonly seq: number;
  readonly kind: PushKind;
  readonly eventId: string | null;
  /** 받을 역할 */
  readonly roles: readonly string[];
  readonly body: Record<string, unknown>;
  readonly createdAtMs: number;
}

/** 다시 붙기 판정 결과 */
export type ResumeVerdict = 'ok' | 'too-old' | 'invalid';

/**
 * 커서(마지막으로 받은 seq)로 다시 붙을 수 있는가.
 * - 시퀀스의 마지막 값보다 크면 만든 적 없는 번호라 invalid
 * - 마지막 값과 같으면 빠진 것이 없다
 * - 창(1시간) 안 행이 없거나, 창 안의 가장 오래된 행보다 앞이면(그 사이 행이 지워졌거나 창 밖) too-old
 * @param cursor 브라우저가 보낸 seq
 * @param latest 시퀀스의 마지막 값(없으면 0)
 * @param oldestInWindow 창 안 행 가운데 가장 작은 seq(없으면 undefined)
 */
export function resumeVerdictOf(cursor: number, latest: number, oldestInWindow: number | undefined): ResumeVerdict {
  if (cursor > latest) return 'invalid';
  if (cursor === latest) return 'ok';
  if (oldestInWindow === undefined) return 'too-old';
  return cursor >= oldestInWindow - 1 ? 'ok' : 'too-old';
}

/** 역할 목록 글(ops_push_event.roles, 쉼표로 이음)을 배열로 */
export function rolesOf(text: string): string[] {
  return text
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
}

/** gw-ops가 액세스 토큰의 exp(epoch 초)를 넣는 내부 머리. 바깥 요청의 같은 머리는 게이트웨이의 x-user- 앞부분 지우기가 지운다(ADR-0360 결정 4) */
export const TOKEN_EXP_HEADER = 'x-user-token-exp';
