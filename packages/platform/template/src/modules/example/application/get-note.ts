// 유스케이스 층: 포트로 도메인을 부르고 결과를 Problem으로 바꾼다. 받는 층·어댑터·웹 서버·저장소를 모른다.
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '@peaket/platform';
import type { Note } from '../domain/note.js';
import { NOTE_REPOSITORY, type NoteRepository } from '../domain/note-repository.js';

@Injectable()
export class GetNote {
  constructor(@Inject(NOTE_REPOSITORY) private readonly notes: NoteRepository) {}

  async run(q: { noteId: string; ownerAccountId: string }): Promise<Note> {
    const note = await this.notes.findOwned(q.noteId, q.ownerAccountId);
    // 남의 것과 없는 것을 가리지 않고 같은 404(docs/api/guidelines.md §12 '개인·거래 기록')
    if (!note) throw new ProblemError({ type: 'note-not-found', status: 404, title: '메모를 찾을 수 없습니다' });
    return note;
  }
}
