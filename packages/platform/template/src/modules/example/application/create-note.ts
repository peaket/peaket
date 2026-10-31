// 유스케이스 층: 도메인 규칙의 거절을 422 Problem으로 바꾼다.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@peaket/platform';
import { type Note, createNote } from '../domain/note.js';
import { NOTE_REPOSITORY, type NoteRepository } from '../domain/note-repository.js';

@Injectable()
export class CreateNote {
  constructor(@Inject(NOTE_REPOSITORY) private readonly notes: NoteRepository) {}

  async run(c: { ownerAccountId: string; title: string }): Promise<Note> {
    const r = createNote(randomUUID(), c.ownerAccountId, c.title);
    if (!r.ok) throw new ProblemError({ type: 'note-title-invalid', status: 422, title: '메모 제목이 규칙에 맞지 않습니다', extensions: { reason: r.reason } });
    await this.notes.save(r.note);
    return r.note;
  }
}
