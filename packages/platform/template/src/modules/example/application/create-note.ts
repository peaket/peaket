// 유스케이스 층: 도메인 규칙의 거절을 422 Problem으로 바꾸고, 한 번만 만든다.
// ID는 주입한 시계의 UUIDv7이다(서버가 만든 시간순 ID, docs/data.md §2).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError, uuidv7 } from '@peaket/platform';
import { type Note, createNote } from '../domain/note.js';
import { NOTE_REPOSITORY, type NoteRepository, type RequestOnce } from '../domain/note-repository.js';

@Injectable()
export class CreateNote {
  constructor(
    @Inject(NOTE_REPOSITORY) private readonly notes: NoteRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(c: { ownerAccountId: string; title: string; once: RequestOnce }): Promise<Note> {
    const r = createNote(uuidv7(this.clock), c.ownerAccountId, c.title);
    if (!r.ok) throw new ProblemError({ type: 'note-title-invalid', status: 422, title: '메모 제목이 규칙에 맞지 않습니다', extensions: { reason: r.reason } });
    return this.notes.createOnce(r.note, c.once);
  }
}
