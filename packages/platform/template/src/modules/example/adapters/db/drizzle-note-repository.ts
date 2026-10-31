// 어댑터: 포트를 PostgreSQL(Drizzle SQL형 빌더)로 구현한다. 값은 빌더로만 넘긴다(ASVS v5.0.0-1.2.4).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { and, eq } from 'drizzle-orm';
import type { Note } from '../../domain/note.js';
import type { NoteRepository } from '../../domain/note-repository.js';
import { exampleNote } from './schema.js';

@Injectable()
export class DrizzleNoteRepository implements NoteRepository {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async findOwned(id: string, ownerAccountId: string): Promise<Note | undefined> {
    const [row] = await this.database.db
      .select()
      .from(exampleNote)
      .where(and(eq(exampleNote.id, id), eq(exampleNote.ownerAccountId, ownerAccountId)))
      .limit(1);
    return row;
  }

  async save(note: Note): Promise<void> {
    await this.database.db.insert(exampleNote).values(note);
  }
}
