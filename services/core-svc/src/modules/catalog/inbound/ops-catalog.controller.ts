// 받는 층: 관제 아티스트·공연장 찾기/만들기(openapi listOpsArtists·createOpsArtist·listOpsPlaces·createOpsPlace, LCH-080 잔여).
// 찾기는 viewer 이상과 CS 두 역할, 만들기는 operator·commander다(authz-matrix §4.1). 응답은 no-store이고 계좌·연락처를 싣지 않는다.
import { Controller, Get, Header, HttpCode, Post } from '@nestjs/common';
import { CreateOpsArtistBody, CreateOpsPlaceBody, ListOpsArtistsQueryParams, ListOpsPlacesQueryParams } from '@peaket/contracts/openapi/ops';
import { ContractBody, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import { z } from 'zod';
import { OpsCatalog } from '../application/ops-catalog.js';

const Artist = z.object({ artistId: z.string(), name: z.string(), aliases: z.array(z.string()) }).strict();
const ArtistPage = z.object({ items: z.array(Artist), nextCursor: z.string().nullable() }).strict();
const Place = z.object({ placeId: z.string(), name: z.string(), address: z.string(), region: z.string(), status: z.enum(['ACTIVE', 'CLOSED']), aliases: z.array(z.string()) }).strict();
const PlacePage = z.object({ items: z.array(Place), nextCursor: z.string().nullable() }).strict();
const ArtistCreated = z.object({ artistId: z.string() }).strict();
const PlaceCreated = z.object({ placeId: z.string() }).strict();

const READ_ROLES = ['viewer', 'operator', 'commander', 'cs_agent', 'cs_lead'] as const;
const WRITE_ROLES = ['operator', 'commander'] as const;

@Controller('v1/ops/artists')
export class OpsArtistController {
  constructor(private readonly catalog: OpsCatalog) {}

  @Get()
  @Header('cache-control', 'no-store')
  @ContractRouteSchema({ responses: { 200: ArtistPage } })
  @Roles([...READ_ROLES])
  async list(@ContractQuery(ListOpsArtistsQueryParams) q: z.output<typeof ListOpsArtistsQueryParams>) {
    return this.catalog.listArtists(q);
  }

  @Post()
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: ArtistCreated } })
  @Roles([...WRITE_ROLES])
  async create(@ContractBody(CreateOpsArtistBody) body: z.output<typeof CreateOpsArtistBody>, @CurrentPrincipal() me: Principal) {
    return this.catalog.createArtist({ name: body.name, reason: body.reason, actorId: me.accountId });
  }
}

@Controller('v1/ops/places')
export class OpsPlaceController {
  constructor(private readonly catalog: OpsCatalog) {}

  @Get()
  @Header('cache-control', 'no-store')
  @ContractRouteSchema({ responses: { 200: PlacePage } })
  @Roles([...READ_ROLES])
  async list(@ContractQuery(ListOpsPlacesQueryParams) q: z.output<typeof ListOpsPlacesQueryParams>) {
    return this.catalog.listPlaces(q);
  }

  @Post()
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: PlaceCreated } })
  @Roles([...WRITE_ROLES])
  async create(@ContractBody(CreateOpsPlaceBody) body: z.output<typeof CreateOpsPlaceBody>, @CurrentPrincipal() me: Principal) {
    return this.catalog.createPlace({ name: body.name, address: body.address, region: body.region, reason: body.reason, actorId: me.accountId });
  }
}
