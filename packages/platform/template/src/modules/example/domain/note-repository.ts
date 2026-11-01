// 도메인이 정한 포트(인터페이스). 저장소 어댑터가 구현한다(adapters/).
import type { Note } from './note.js';

/**
 * 한 번만 처리할 쓰기 요청의 범위·키·지문(docs/api/guidelines.md §4). 받는 층이 플랫폼 멱등 모듈에서 받아 넘긴다.
 * 도메인은 플랫폼을 모르므로 같은 모양을 여기 적는다
 */
export interface RequestOnce {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}

export interface NoteRepository {
  /** 그 계정의 메모만 찾는다(범위 값을 인자로 받는다, docs/security/authz-matrix.md §5.2) */
  findOwned(id: string, ownerAccountId: string): Promise<Note | undefined>;
  /**
   * 메모를 한 번만 만든다. 같은 요청(범위·키·지문)이 다시 오면 처음 만든 메모를 돌려주고, 같은 키에 다른 지문이면 422,
   * 첫 요청이 아직 처리 중이면 409다(멱등 기록·메모·Outbox 사건을 한 트랜잭션에 쓴다)
   */
  createOnce(note: Note, once: RequestOnce): Promise<Note>;
}

/** 주입 이름(모듈 조립 파일이 어댑터를 이 이름에 묶는다) */
export const NOTE_REPOSITORY = Symbol('NoteRepository');
