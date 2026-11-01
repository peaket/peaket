// 어댑터: 포트를 PostgreSQL(Drizzle SQL형 빌더)로 구현한다. 값은 빌더로만 넘긴다(ASVS v5.0.0-1.2.4).
// 한 번만 만들기: 멱등 기록(첫 쓰기) → 메모 → Outbox 사건(마지막 문장)을 한 트랜잭션에 쓴다(docs/api/guidelines.md §4, ADR-0116 결정 3).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, DATABASE, type Database, IdempotencyStore, writeOutbox } from '@peaket/platform';
import { and, eq } from 'drizzle-orm';
import type { Note } from '../../domain/note.js';
import type { NoteRepository, RequestOnce } from '../../domain/note-repository.js';
import { exampleNote } from './schema.js';

/** 예시 사건 주제. 실제 서비스는 asyncapi의 주제를 쓴다 */
export const NOTE_TOPIC = 'example.notes';

@Injectable()
export class DrizzleNoteRepository implements NoteRepository {
  private readonly idempotency: IdempotencyStore;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.idempotency = new IdempotencyStore({ clock });
  }

  async findOwned(id: string, ownerAccountId: string): Promise<Note | undefined> {
    const [row] = await this.database.db
      .select()
      .from(exampleNote)
      .where(and(eq(exampleNote.id, id), eq(exampleNote.ownerAccountId, ownerAccountId)))
      .limit(1);
    return row;
  }

  async createOnce(note: Note, once: RequestOnce): Promise<Note> {
    return this.database.transaction((tx) =>
      this.idempotency.run(tx, once, {
        execute: async () => {
          await tx.insert(exampleNote).values(note);
          // 실제 서비스는 공용 Avro 인코더(BUILD_ORDER BAS-030)로 만든 Confluent 형식 바이트를 넣는다. 예시라 JSON 바이트를 넣는다
          await writeOutbox(tx, this.clock, [{ topic: NOTE_TOPIC, key: note.id, payload: Buffer.from(JSON.stringify({ noteId: note.id })) }]);
          return { resultRef: note.id, value: note };
        },
        replay: async (ref) => {
          const [row] = await tx.select().from(exampleNote).where(eq(exampleNote.id, ref)).limit(1);
          if (!row) throw new Error(`멱등 기록이 가리키는 메모가 없다: ${ref}`);
          return row;
        },
      }),
    );
  }
}
