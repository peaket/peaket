// [좌석맵 저장]의 답 표(ADR-0264 결정 8, d5 §6.5 '저장 전'·'다른 곳에서 바뀜'·'오픈 뒤 잠김'). 순수 함수만 둔다.
// 200은 응답으로 문서를 갈아끼우고 되돌리기 기록을 비운다. 그 밖의 답은 문서·변경 수·되돌리기 기록을 그대로 두고 화면 표시만 정한다.
// 서버의 title·detail 원문은 보이지 않고 상태·오류 갈래(type)로 문구를 고른다.
import { issueText } from './issues.ts';
import type { Issue } from './types.ts';

export const TEXT = {
  conflict: '다른 곳에서 좌석맵이 바뀌었습니다. 지금 변경을 JSON으로 내보낸 뒤 다시 불러오세요',
  locked: '판매가 시작돼 도형과 좌석은 바꿀 수 없습니다. 판매 제외·휠체어석·입장 게이트만 바꿀 수 있습니다',
  tiersLocked: '판매가 시작돼 가격 등급은 바꿀 수 없습니다',
  suspended: '판매가 중지된 공연이라 좌석맵을 저장할 수 없습니다',
  adminOnly: '판매 승인을 받은 공연의 좌석맵은 파트너 관리자만 저장할 수 있습니다',
  forbidden: '이 공연의 좌석맵을 저장할 권한이 없습니다',
  notSaved: '저장하지 않았습니다. 고칠 곳을 확인해 주세요',
  lockedGuide: '다시 불러온 뒤 판매 제외·휠체어석·입장 게이트만 고쳐 저장하세요',
  invalid: '좌석맵에 고칠 곳이 있습니다. 아래 표를 보고 고쳐 주세요',
  busy: '지금 저장이 많습니다. 잠시 뒤 다시 저장해 주세요',
  publish: '좌석맵 파일을 잠시 게시할 수 없어 저장하지 않았습니다. 잠시 뒤 다시 저장해 주세요',
  unknown: '저장했는지 확인하지 못했습니다. 다시 불러와 확인해 주세요',
  tooLarge: '좌석맵이 너무 큽니다. 좌석이나 구역을 줄여 주세요',
  notFound: '공연을 찾을 수 없습니다',
  unauthorized: '로그인이 끝났습니다. 다시 로그인해 주세요',
  notPublished: '좌석이 없는 구역이 있어 팬 좌석맵을 아직 게시하지 않았습니다',
} as const;

/** 429·503의 Retry-After가 없을 때 [좌석맵 저장]을 잠그는 시간(ms) [가정] */
export const DEFAULT_RETRY_MS = 10_000;
/** Retry-After를 따르는 상한(ms) [가정]. 그보다 길면 이 시간만 잠근다(서버 값이 터무니없이 커도 화면이 영영 잠기지 않게) */
export const MAX_RETRY_MS = 3_600_000;

export type SaveAnswer =
  | { kind: 'saved'; layout: unknown; version: number; notice: string | null }
  | { kind: 'conflict'; text: string }
  | { kind: 'locked'; text: string }
  | { kind: 'message'; text: string }
  | { kind: 'invalid'; text: string; rows: { field: string; text: string }[] }
  | { kind: 'busy'; text: string; retryAt: number }
  | { kind: 'unknown'; text: string }
  | { kind: 'notFound'; text: string };

/** 실패 답 하나(api-client ApiError 모양에서 고른 칸. 네트워크 오류·시간 초과는 status 0) */
export interface Failure {
  status: number;
  type: string;
  extensions?: Record<string, unknown>;
  /** 서버가 준 다시 시도 하한(ms, Retry-After). 없으면 undefined */
  retryFloorMs?: number;
}

/** 성공 답(200): ETag의 판과 본문 */
export function savedAnswer(layout: unknown, etag: string | null): SaveAnswer {
  const m = etag ? /^"(\d+)"$/.exec(etag.trim()) : null;
  const fromBody = typeof (layout as { layoutVersion?: unknown })?.layoutVersion === 'number' ? (layout as { layoutVersion: number }).layoutVersion : NaN;
  const version = m ? Number(m[1]) : fromBody;
  const published = (layout as { fanFilePublished?: unknown })?.fanFilePublished;
  return { kind: 'saved', layout, version, notice: published === false ? TEXT.notPublished : null };
}

export function failedAnswer(f: Failure, nowMs: number): SaveAnswer {
  switch (f.status) {
    case 400:
      // 서버가 저장하지 않은 것이 분명하다(ADR-0264 결정 31)
      return { kind: 'message', text: TEXT.notSaved };
    case 412:
      return { kind: 'conflict', text: TEXT.conflict };
    case 409:
      // 잠김 둘은 화면을 잠그고 배너로 안내한다(ADR-0264 결정 33)
      if (f.type === 'seatmap-geometry-locked') return { kind: 'locked', text: TEXT.locked };
      if (f.type === 'sale-setting-locked') return { kind: 'locked', text: TEXT.tiersLocked };
      if (f.type === 'production-suspended') return { kind: 'message', text: TEXT.suspended };
      return { kind: 'unknown', text: TEXT.unknown };
    case 403:
      return { kind: 'message', text: f.type === 'partner-admin-required' ? TEXT.adminOnly : TEXT.forbidden };
    case 404:
      return { kind: 'notFound', text: TEXT.notFound };
    case 401:
      return { kind: 'message', text: TEXT.unauthorized };
    case 413:
      return { kind: 'message', text: TEXT.tooLarge };
    case 422: {
      const result = f.extensions?.result as { errors?: Issue[] } | undefined;
      const rows = (Array.isArray(result?.errors) ? result!.errors : []).slice(0, 1_000).map((e) => ({ field: String(e.field ?? ''), text: issueText(String(e.code ?? '')) }));
      return { kind: 'invalid', text: TEXT.invalid, rows };
    }
    case 429:
    case 503:
      return { kind: 'busy', text: f.type === 'seatmap-publish-unavailable' ? TEXT.publish : TEXT.busy, retryAt: nowMs + Math.min(f.retryFloorMs ?? DEFAULT_RETRY_MS, MAX_RETRY_MS) };
    default:
      // 504 deadline-exceeded·500·시간 초과·네트워크 오류: 서버가 저장했는지 모른다
      return { kind: 'unknown', text: TEXT.unknown };
  }
}

/** [좌석맵 저장]을 눌러도 되는가(429·503 뒤 Retry-After 동안 잠근다) */
export const canSave = (busyUntil: number | null, nowMs: number) => busyUntil === null || nowMs >= busyUntil;

/** 오류 칸 이름 → 사람이 읽는 자리('A구역 3번째 좌석 등급' 같은 꼴). 모르는 꼴은 그대로 */
export function fieldLabel(field: string, sectionNames: readonly string[]): string {
  const m = /^sections\[(\d+)\](?:\.seats\[(\d+)\])?(?:\.(\w+))?/.exec(field);
  if (!m) return field;
  const name = sectionNames[Number(m[1])] ?? `${Number(m[1]) + 1}번째 구역`;
  const seat = m[2] !== undefined ? ` ${Number(m[2]) + 1}번째 좌석` : '';
  return `${name}${seat}${m[3] ? ` ${m[3]}` : ''}`;
}
