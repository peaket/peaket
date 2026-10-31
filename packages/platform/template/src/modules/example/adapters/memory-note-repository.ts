// 어댑터: 포트를 메모리로 구현한다(시험·로컬 시제품용).
import type { Note } from '../domain/note.js';
import type { NoteRepository } from '../domain/note-repository.js';

export class MemoryNoteRepository implements NoteRepository {
  readonly #notes = new Map<string, Note>();

  async findOwned(id: string, ownerAccountId: string): Promise<Note | undefined> {
    const n = this.#notes.get(id);
    return n && n.ownerAccountId === ownerAccountId ? n : undefined;
  }

  async save(note: Note): Promise<void> {
    this.#notes.set(note.id, note);
  }
}
