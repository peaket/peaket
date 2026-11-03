// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module } from '@nestjs/common';
import { DrizzleNoteRepository } from './adapters/db/drizzle-note-repository.js';
import { MemoryNoteRepository } from './adapters/memory-note-repository.js';
import { CreateNote } from './application/create-note.js';
import { GetNote } from './application/get-note.js';
import { NOTE_REPOSITORY } from './domain/note-repository.js';
import { NoteController } from './inbound/note.controller.js';

@Module({})
export class ExampleModule {
  /** 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 한다 */
  static register(o: { storage: 'database' | 'memory' }): DynamicModule {
    return {
      module: ExampleModule,
      controllers: [NoteController],
      providers: [
        GetNote,
        CreateNote,
        o.storage === 'database'
          ? { provide: NOTE_REPOSITORY, useClass: DrizzleNoteRepository }
          : { provide: NOTE_REPOSITORY, useValue: new MemoryNoteRepository() },
      ],
    };
  }
}
