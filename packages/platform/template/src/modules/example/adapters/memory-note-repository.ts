// 어댑터: 포트를 메모리로 구현한다(시험·로컬 시제품용). 한 번만 만들기도 DB 어댑터와 같게 답한다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused } from '@peaket/platform';
import type { Note } from '../domain/note.js';
import type { NoteRepository, RequestOnce } from '../domain/note-repository.js';

export class MemoryNoteRepository implements NoteRepository {
  readonly #notes = new Map<string, Note>();
  readonly #once = new Map<string, { hash: Buffer; noteId: string }>();

  async findOwned(id: string, ownerAccountId: string): Promise<Note | undefined> {
    const n = this.#notes.get(id);
    return n && n.ownerAccountId === ownerAccountId ? n : undefined;
  }

  async createOnce(note: Note, once: RequestOnce): Promise<Note> {
    const scope = `${once.accountRef}\n${once.operation}\n${once.key}`;
    const hash = Buffer.from(once.requestHash);
    const seen = this.#once.get(scope);
    if (seen) {
      if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
      return this.#notes.get(seen.noteId)!;
    }
    this.#notes.set(note.id, note);
    this.#once.set(scope, { hash, noteId: note.id });
    return note;
  }
}
