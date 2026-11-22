// 제어 gRPC로 받는 대기 화면 제어 상태(F-02-1 OPS-300, ADR-0365 결정 2·6, ADR-0214 결정 4, docs/data.md §3 q:{event:E}:notice).
// 명령 3 판매 일시정지(SALE_PAUSE, {"paused": bool})와 명령 7 대기실 공지(LOBBY_BANNER, {"banner": 글 또는 null})를 notice 키에 종류마다의 판·명령 칸과 함께 둔다.
// 범위가 전체면 회차 자리에 PLATFORM을 쓴 키(q:{event:PLATFORM}:notice)다. 대기 상태 파일이 두 키를 함께 읽는다(HOT-010).
// 이 파일은 프레임워크를 모른다. 바라는 상태 꼴 검사와 칸 이름만 둔다.

/** 받는 제어 종류(proto ControlKind 이름) */
export const QUEUE_NOTICE_KINDS = ['CONTROL_KIND_SALE_PAUSE', 'CONTROL_KIND_LOBBY_BANNER'] as const;
export type QueueNoticeKind = (typeof QUEUE_NOTICE_KINDS)[number];

/** 전체 범위 이름 */
export const QUEUE_NOTICE_PLATFORM = 'PLATFORM';

/** 공지 배너 글 상한 500자 [가정](ADR-0365 결정 2) */
export const LOBBY_BANNER_MAX = 500;

/** 종류마다 값·판·명령 칸(ADR-0365 결정 6). version·commandId는 종류와 상관없이 마지막으로 적용한 제어다(HOT-010) */
export const QUEUE_NOTICE_FIELDS: Readonly<Record<QueueNoticeKind, { readonly value: string; readonly rev: string; readonly cmd: string }>> = Object.freeze({
  CONTROL_KIND_SALE_PAUSE: { value: 'paused', rev: 'pausedRev', cmd: 'pausedCmd' },
  CONTROL_KIND_LOBBY_BANNER: { value: 'banner', rev: 'bannerRev', cmd: 'bannerCmd' },
});

/** notice 한 칸 쓰기. value가 null이면 값 칸을 지운다(배너 내리기) */
export interface QueueNoticeWrite {
  /** 회차 ID 또는 PLATFORM */
  readonly scope: string;
  readonly kind: QueueNoticeKind;
  /** 저장할 글('1'·'0' 또는 배너 글). null은 칸 지움 */
  readonly value: string | null;
  readonly revision: number;
  readonly commandId: string;
}

export const QUEUE_NOTICES = Symbol('queue.QueueNotices');
/** notice 비교하고 쓰기. 판이 그 종류의 판 칸보다 클 때만 쓰고, 쓴 뒤(또는 지금)의 판을 돌려준다. 실패하면 던진다 */
export interface QueueNotices {
  write(w: QueueNoticeWrite): Promise<number>;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[‪-‮⁦-⁩]/;

/** 바라는 상태 JSON을 객체로. 배열·다른 꼴은 undefined */
function objectOf(json: string): Record<string, unknown> | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * 종류마다의 바라는 상태를 저장할 값으로 바꾼다(ADR-0365 결정 2). 모르는 칸·틀린 꼴이면 undefined(받는 층이 INVALID_ARGUMENT, 쓰기 0).
 * - SALE_PAUSE: {"paused": bool} → '1'·'0'
 * - LOBBY_BANNER: {"banner": 글 | null} → 글(1~500자, NFC, 제어·양방향 제어 문자 없음) 또는 null
 */
export function noticeValueOf(kind: QueueNoticeKind, json: string): { readonly value: string | null } | undefined {
  const v = objectOf(json);
  if (!v) return undefined;
  const keys = Object.keys(v);
  if (kind === 'CONTROL_KIND_SALE_PAUSE') {
    if (keys.length !== 1 || keys[0] !== 'paused' || typeof v.paused !== 'boolean') return undefined;
    return { value: v.paused ? '1' : '0' };
  }
  if (keys.length !== 1 || keys[0] !== 'banner') return undefined;
  const banner = v.banner;
  if (banner === null) return { value: null };
  if (typeof banner !== 'string') return undefined;
  const length = [...banner].length;
  if (length === 0 || length > LOBBY_BANNER_MAX || banner.normalize('NFC') !== banner || CONTROL.test(banner) || BIDI.test(banner)) return undefined;
  return { value: banner };
}
