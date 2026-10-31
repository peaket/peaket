// 도메인 층: 업무 규칙과 상태. 프레임워크·저장소·계약 생성물을 모른다(docs/architecture.md §3.1).
// 실패는 던지지 않고 결과 값으로 돌려준다. 유스케이스가 그것을 Problem으로 바꾼다(docs/api/guidelines.md §2).

export interface Note {
  readonly id: string;
  /** 쓴 계정(범위 값. 요청 맥락에서만 만든다, docs/security/authz-matrix.md §5.2) */
  readonly ownerAccountId: string;
  readonly title: string;
}

export type NoteRejection = 'title-empty' | 'title-too-long';

export const NOTE_TITLE_MAX = 50;

/** 제목 앞뒤 공백을 지우고 1~50자인지 본다(예시 규칙) */
export function createNote(id: string, ownerAccountId: string, title: string): { ok: true; note: Note } | { ok: false; reason: NoteRejection } {
  const t = title.trim();
  if (t.length === 0) return { ok: false, reason: 'title-empty' };
  if ([...t].length > NOTE_TITLE_MAX) return { ok: false, reason: 'title-too-long' };
  return { ok: true, note: { id, ownerAccountId, title: t } };
}
