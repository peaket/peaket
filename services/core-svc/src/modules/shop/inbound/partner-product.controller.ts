// 받는 층: 파트너 상품 목록·만들기·고치기(openapi list/create/get/updatePartnerProduct, SCR-023, FR-024).
// 테넌트는 플랫폼 인증 가드가 identity에서 받은 값만 쓴다. 본문·응답은 계약 스키마로 검사한다.
import { Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import {
  CreatePartnerProductBody,
  CreatePartnerProductResponse,
  GetPartnerProductParams,
  GetPartnerProductResponse,
  ListPartnerProductsQueryParams,
  ListPartnerProductsResponse,
  UpdatePartnerProductBody,
  UpdatePartnerProductParams,
  UpdatePartnerProductResponse,
} from '@peaket/contracts/openapi/partner';
import { ContractBody, ContractParams, ContractQuery, ContractRouteSchema, CurrentPrincipal, type Principal, Roles } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Products } from '../application/products.js';
import { productEtag, type ProductInput, type ProductPatch } from '../domain/product.js';
import { tenantOf } from '../../catalog/index.js';

const toInput = (b: z.output<typeof CreatePartnerProductBody>): ProductInput => ({
  type: b.type,
  name: b.name,
  price: b.price,
  shippingFee: b.shippingFee ?? null,
  returnShippingFee: b.returnShippingFee ?? null,
  returnAddress: b.returnAddress ?? null,
  ticketLinked: b.ticketLinked,
  linkedEventId: b.linkedEventId ?? null,
  limitedQty: b.limitedQty ?? null,
  fulfillments: b.fulfillments,
  transferable: b.transferable,
  status: b.status,
  saleStartsAt: b.saleStartsAt ?? null,
  saleEndsAt: b.saleEndsAt ?? null,
  attributes: b.attributes ?? {},
});

const toPatch = (b: z.output<typeof UpdatePartnerProductBody>): ProductPatch => ({
  ...(b.type !== undefined ? { type: b.type } : {}),
  ...(b.name !== undefined ? { name: b.name } : {}),
  ...(b.price !== undefined ? { price: b.price } : {}),
  ...(b.shippingFee !== undefined ? { shippingFee: b.shippingFee } : {}),
  ...(b.returnShippingFee !== undefined ? { returnShippingFee: b.returnShippingFee } : {}),
  ...(b.returnAddress !== undefined ? { returnAddress: b.returnAddress } : {}),
  ...(b.ticketLinked !== undefined ? { ticketLinked: b.ticketLinked } : {}),
  ...(b.linkedEventId !== undefined ? { linkedEventId: b.linkedEventId } : {}),
  ...(b.limitedQty !== undefined ? { limitedQty: b.limitedQty } : {}),
  ...(b.fulfillments !== undefined ? { fulfillments: b.fulfillments } : {}),
  ...(b.transferable !== undefined ? { transferable: b.transferable } : {}),
  ...(b.status !== undefined ? { status: b.status } : {}),
  ...(b.saleStartsAt !== undefined ? { saleStartsAt: b.saleStartsAt } : {}),
  ...(b.saleEndsAt !== undefined ? { saleEndsAt: b.saleEndsAt } : {}),
  ...(b.attributes !== undefined ? { attributes: b.attributes } : {}),
});

@Controller('v1/partner/products')
export class PartnerProductController {
  constructor(private readonly products: Products) {}

  @Get()
  @ContractRouteSchema({ responses: { 200: ListPartnerProductsResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async list(
    @ContractQuery(ListPartnerProductsQueryParams) q: z.output<typeof ListPartnerProductsQueryParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.products.list(tenantOf(me), {
      ...(q.ticketLinked !== undefined ? { ticketLinked: q.ticketLinked } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
      ...(q.linkedProductionId !== undefined ? { linkedProductionId: q.linkedProductionId.toLowerCase() } : {}),
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.cursor !== undefined ? { cursor: q.cursor } : {}),
      limit: q.limit ?? 20,
    });
  }

  @Post()
  @HttpCode(201)
  @ContractRouteSchema({ responses: { 201: CreatePartnerProductResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async create(
    @ContractBody(CreatePartnerProductBody) body: z.output<typeof CreatePartnerProductBody>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const out = await this.products.create(tenantOf(me), toInput(body));
    void reply.header('etag', productEtag(out.version));
    return out;
  }

  @Get(':productId')
  @ContractRouteSchema({ responses: { 200: GetPartnerProductResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async get(
    @ContractParams(GetPartnerProductParams) params: z.output<typeof GetPartnerProductParams>,
    @CurrentPrincipal() me: Principal,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const out = await this.products.get(tenantOf(me), params.productId.toLowerCase());
    void reply.header('etag', productEtag(out.version));
    return out;
  }

  @Patch(':productId')
  @HttpCode(200)
  @ContractRouteSchema({ responses: { 200: UpdatePartnerProductResponse } })
  @Roles(['partner_admin', 'partner_member'])
  async update(
    @ContractParams(UpdatePartnerProductParams) params: z.output<typeof UpdatePartnerProductParams>,
    @ContractBody(UpdatePartnerProductBody) body: z.output<typeof UpdatePartnerProductBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const ifMatch = request.headers['if-match'];
    const out = await this.products.update(tenantOf(me), params.productId.toLowerCase(), toPatch(body), typeof ifMatch === 'string' ? ifMatch : undefined);
    void reply.header('etag', productEtag(out.version));
    return out;
  }
}
