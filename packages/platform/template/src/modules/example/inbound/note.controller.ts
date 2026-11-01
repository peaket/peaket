// 받는 층: HTTP 요청을 검사해(계약 생성 Zod) 유스케이스를 부른다. 어댑터를 모른다.
// 실제 서비스는 아래 스키마 대신 @peaket/contracts의 생성 스키마를 쓴다(docs/api/guidelines.md §1).
import { Controller, Get, Post } from '@nestjs/common';
import { ContractBody, ContractParams, CurrentPrincipal, IdempotencyRequest, Idempotent, type Principal, Roles } from '@peaket/platform';
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

  // 다시 보내면 두 번 생길 수 있는 쓰기: 멱등 키를 받고(없거나 틀리면 400), 같은 요청이면 처음 만든 메모를 돌려준다(guidelines §4)
  @Post()
  @Roles(['fan'])
  @Idempotent({ operation: 'CREATE_NOTE' })
  async create(
    @ContractBody(NoteCreateBody) body: z.output<typeof NoteCreateBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ) {
    const n = await this.createNote.run({ ownerAccountId: me.accountId, title: body.title, once });
    return { id: n.id, title: n.title };
  }
}
