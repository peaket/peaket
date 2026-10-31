// 도메인이 정한 포트(인터페이스). 저장소 어댑터가 구현한다(adapters/).
import type { Note } from './note.js';

export interface NoteRepository {
  /** 그 계정의 메모만 찾는다(범위 값을 인자로 받는다, docs/security/authz-matrix.md §5.2) */
  findOwned(id: string, ownerAccountId: string): Promise<Note | undefined>;
  save(note: Note): Promise<void>;
}

/** 주입 이름(모듈 조립 파일이 어댑터를 이 이름에 묶는다) */
export const NOTE_REPOSITORY = Symbol('NoteRepository');
