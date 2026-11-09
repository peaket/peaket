// 받는 층: 공연 등록·회차 더하기(openapi createPartnerProduction·createPartnerProductionEvent, ADR-0198, BUILD_ORDER HOT-171).
// 파트너 관리자·실무자. 테넌트는 플랫폼 인증 가드가 identity GetAdminAuthz로 받은 값만 쓴다(본문에 판매자 칸이 없다, authz-matrix §3.3).
// 본문은 닫힌 객체다(모르는 칸 400, ASVS v5.0.0-8.2.3). 모양만으로 정할 수 있는 규칙(공연장은 placeId·newPlace 가운데 하나,
// 아티스트 칸마다 artistId·name 가운데 하나, 같은 artistId·다른 이름 겹침)은 여기서 400이다. 일정·정렬·오픈 간격은 유스케이스가 422·409로 판정한다.
import { Controller, Post } from '@nestjs/common';
import { ContractBody, ContractParams, CurrentPrincipal, IdempotencyRequest, Idempotent, type Principal, ProblemError, RequestValidationError, Roles } from '@peaket/platform';
import { z } from 'zod';
import { AddProductionEvent, type EventAdded } from '../application/add-production-event.js';
import { CreateProduction, type ProductionCreated, type ProductionInput } from '../application/create-production.js';
import { type DescriptionDoc, MAX_DESCRIPTION_BLOCKS, MAX_DESCRIPTION_CHARS, MAX_DESCRIPTION_NODES, withinDescriptionLimits } from '../domain/description.js';
import { GENRES } from '../domain/production.js';
import { type EventDraft, withEventDefaults } from '../domain/registration.js';

const dateTime = z.iso.datetime({ offset: true });

/** 계약 PartnerEventCreate */
export const PartnerEventBody = z
  .object({
    openAt: dateTime,
    lobbyMinutes: z.int().min(0).max(60).optional(),
    entryOpensAt: dateTime.optional(),
    startsAt: dateTime,
    endsAt: dateTime,
    reentryAllowed: z.boolean().optional(),
    lobbyShuffle: z.boolean().optional(),
    openBatch: z.boolean().optional(),
    seatAssignment: z.enum(['PICK', 'AUTO']).optional(),
    perPersonLimit: z.int().min(1).max(10).optional(),
  })
  .strict();

/** PostgreSQL이 저장하지 못하는 글자(NUL, 짝이 깨진 서로게이트)를 막는다(ADR-0244) */
const storable = (s: string): boolean => !/\p{Cs}/u.test(s) && !s.includes('\u0000');
const StorableText = (min: number, max: number) => z.string().min(min).max(max).refine(storable, '저장할 수 없는 글자가 있다');

const Inline = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), v: StorableText(0, MAX_DESCRIPTION_CHARS), b: z.literal(true).optional() }).strict(),
  z.object({ t: z.literal('br') }).strict(),
]);
const InlineList = z.array(Inline).max(MAX_DESCRIPTION_NODES);

/** 계약 ProductionDescriptionDoc: 허용 노드 다섯만 받는다(asvs/catalog-review 1.3.1) */
export const DescriptionDocBody = z
  .object({
    v: z.literal(1),
    blocks: z
      .array(
        z.discriminatedUnion('t', [
          z.object({ t: z.literal('p'), c: InlineList }).strict(),
          z.object({ t: z.literal('h'), level: z.union([z.literal(2), z.literal(3)]), c: InlineList }).strict(),
          z.object({ t: z.enum(['ul', 'ol']), items: z.array(InlineList).max(MAX_DESCRIPTION_NODES) }).strict(),
        ]),
      )
      .max(MAX_DESCRIPTION_BLOCKS),
  })
  .strict()
  .refine((d) => withinDescriptionLimits(d as DescriptionDoc), '글자·노드 합계 상한을 넘었다');

/** 계약 PartnerProductionCreate */
export const PartnerProductionBody = z
  .object({
    title: StorableText(1, 100),
    genre: z.enum(GENRES),
    ageRating: StorableText(1, 30).optional(),
    runningMinutes: z.int().min(1).max(1440).optional(),
    placeId: z.uuid().optional(),
    newPlace: z.object({ name: StorableText(1, 100), address: StorableText(1, 200) }).strict().optional(),
    artists: z.array(z.object({ artistId: z.uuid().optional(), name: StorableText(1, 100).optional() }).strict()).max(20),
    aliases: z.array(StorableText(1, 100)).max(5).optional(),
    description: DescriptionDocBody.optional(),
    kopisFields: z.object({ producer: StorableText(1, 200).optional(), notice: StorableText(1, 1000).optional() }).strict().optional(),
    events: z.array(PartnerEventBody).min(1).max(50),
  })
  .strict();

export const ProductionParams = z.object({ productionId: z.string() }).strict();

type EventBody = z.output<typeof PartnerEventBody>;

export function toDraft(e: EventBody): EventDraft {
  const { openAt, startsAt, endsAt, entryOpensAt, ...rest } = e;
  return withEventDefaults({
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
    openAt: new Date(openAt),
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    ...(entryOpensAt !== undefined ? { entryOpensAt: new Date(entryOpensAt) } : {}),
  });
}

const dropUndefined = (o: { producer?: string | undefined; notice?: string | undefined }) => ({ ...(o.producer !== undefined ? { producer: o.producer } : {}), ...(o.notice !== undefined ? { notice: o.notice } : {}) });

/** 모양 규칙(400). 맞으면 유스케이스 입력으로 바꾼다 */
export function toProductionInput(b: z.output<typeof PartnerProductionBody>): ProductionInput {
  if ((b.placeId === undefined) === (b.newPlace === undefined)) throw new RequestValidationError('placeId와 newPlace 가운데 꼭 하나');
  const artists = b.artists.map((a) => {
    if ((a.artistId === undefined) === (a.name === undefined)) throw new RequestValidationError('아티스트 칸마다 artistId와 name 가운데 꼭 하나');
    return a.artistId !== undefined ? { artistId: a.artistId.toLowerCase() } : { name: a.name as string };
  });
  const ids = artists.flatMap((a) => ('artistId' in a ? [a.artistId] : []));
  if (new Set(ids).size !== ids.length) throw new RequestValidationError('같은 artistId를 두 번 썼다');
  const aliases = b.aliases ?? [];
  if (new Set(aliases).size !== aliases.length) throw new RequestValidationError('다른 이름이 겹친다');
  return {
    title: b.title,
    genre: b.genre,
    ...(b.ageRating !== undefined ? { ageRating: b.ageRating } : {}),
    ...(b.runningMinutes !== undefined ? { runningMinutes: b.runningMinutes } : {}),
    ...(b.description ? { description: b.description as DescriptionDoc } : {}),
    ...(b.kopisFields ? { kopisFields: dropUndefined(b.kopisFields) } : {}),
    ...(b.placeId !== undefined ? { placeId: b.placeId.toLowerCase() } : {}),
    ...(b.newPlace ? { newPlace: b.newPlace } : {}),
    artists,
    aliases,
    events: b.events.map(toDraft),
  };
}

/** 파트너 역할의 테넌트. identity가 파트너 세션에는 늘 채운다. 없으면 권한을 확인하지 못한 것으로 닫는다(503 authz-unavailable, authz-matrix §3.1) */
function tenantOf(me: Principal): string {
  if (!me.tenantId) throw new ProblemError({ type: 'authz-unavailable', status: 503, title: '권한을 확인하지 못했습니다', retryAfterSeconds: 1 });
  return me.tenantId;
}

@Controller('v1/partner/productions')
export class PartnerProductionController {
  constructor(
    private readonly createProduction: CreateProduction,
    private readonly addEvent: AddProductionEvent,
  ) {}

  @Post()
  @Roles(['partner_admin', 'partner_member'])
  @Idempotent({ operation: 'CREATE_PRODUCTION' })
  async create(
    @ContractBody(PartnerProductionBody) body: z.output<typeof PartnerProductionBody>,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ): Promise<ProductionCreated> {
    return this.createProduction.run({ tenantId: tenantOf(me), accountId: me.accountId, input: toProductionInput(body), once });
  }

  @Post(':productionId/events')
  @Roles(['partner_admin', 'partner_member'])
  @Idempotent({ operation: 'CREATE_PRODUCTION_EVENT' })
  async createEvent(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @ContractBody(PartnerEventBody) body: EventBody,
    @CurrentPrincipal() me: Principal,
    @IdempotencyRequest() once: IdempotencyRequest,
  ): Promise<EventAdded> {
    return this.addEvent.run({ tenantId: tenantOf(me), role: me.role ?? '', productionId: params.productionId.toLowerCase(), input: toDraft(body), once });
  }
}
