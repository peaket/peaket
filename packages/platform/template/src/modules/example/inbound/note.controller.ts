// 받는 층: HTTP 요청을 검사해(계약 생성 Zod) 유스케이스를 부른다. 어댑터를 모른다.
// 실제 서비스는 아래 스키마 대신 @peaket/contracts의 생성 스키마를 쓴다(docs/api/guidelines.md §1).
import { Controller, Get, Post } from '@nestjs/common';
import { ContractBody, ContractParams, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { CreateNote } from '../application/create-note.js';
import { GetNote } from '../application/get-note.js';

const NoteParams = z.object({ noteId: z.uuid() });
const NoteCreateBody = z.object({ title: z.string().max(200) }).strict();

@Controller('v1/example/notes')
export class NoteController {
  constructor(
    private readonly getNote: GetNote,
    private readonly createNote: CreateNote,
  ) {}

  @Get(':noteId')
  @Roles(['fan'])
  async get(@ContractParams(NoteParams) params: z.output<typeof NoteParams>, @CurrentPrincipal() me: Principal) {
    const n = await this.getNote.run({ noteId: params.noteId, ownerAccountId: me.accountId });
    return { id: n.id, title: n.title };
  }

  @Post()
  @Roles(['fan'])
  async create(@ContractBody(NoteCreateBody) body: z.output<typeof NoteCreateBody>, @CurrentPrincipal() me: Principal) {
    const n = await this.createNote.run({ ownerAccountId: me.accountId, title: body.title });
    return { id: n.id, title: n.title };
  }
}
