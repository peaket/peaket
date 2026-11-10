// 받는 층: 공연 이미지 올리기·고치기·지우기와 좌석맵 가져오기(openapi createPartnerProductionImage·updatePartnerProductionImage·
// deletePartnerProductionImage·createPartnerProductionSeatmapImport, ADR-0257, BUILD_ORDER HOT-190·HOT-210).
// 파트너 관리자·실무자. 테넌트는 플랫폼 인증 가드가 identity에서 받은 값만 쓴다. 다른 검사보다 소속 확인(404)을 먼저 한다.
// 올리기 두 경로의 본문 상한은 10MB + 봉투 64KB [가정]이고 넘으면 읽기 전에 그 경로의 이름 붙은 413이다(플랫폼 @AcceptMultipart).
// 응답은 프레임워크의 JSON 직렬화기로만 만든다(seat-hold ASVS 1.2.3).
import { Controller, Delete, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { AcceptMultipart, ContractBody, ContractParams, CurrentPrincipal, type Principal, Roles, RouteDeadline } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type Caller, ImportSeatmap, type SeatMapImportResult } from '../application/import-seatmap.js';
import { etagOf, ProductionImages, type ProductionImageView } from '../application/production-images.js';
import { imageTooLarge, seatmapImportTooLarge } from '../application/problems.js';
import { altValid, IMAGE_ENVELOPE_BYTES, IMAGE_MAX_BYTES, PARTNER_MULTIPART_BULKHEAD, UPLOAD_ROUTE_DEADLINE_MS } from '../domain/production-image.js';
import { SEATMAP_FILE_MAX_BYTES } from '../domain/seatmap-import.js';
import { readUploadForm, requireXRequestedWith } from './multipart.js';
import { ProductionParams, tenantOf } from './partner-production.controller.js';

export const ImageParams = z.object({ productionId: z.string(), imageId: z.string() }).strict();
/** 계약 updatePartnerProductionImage 본문(alt 1~300자, 코드 포인트로 센다. 계약 밖이면 400) */
export const ImagePatchBody = z.object({ alt: z.string().refine(altValid).optional(), order: z.int().min(0).max(9).optional() }).strict();

const caller = (me: Principal): Caller => ({ tenantId: tenantOf(me), accountId: me.accountId });

@Controller('v1/partner/productions')
export class PartnerMediaController {
  constructor(
    private readonly images: ProductionImages,
    private readonly seatmap: ImportSeatmap,
  ) {}

  @Post(':productionId/images')
  @Roles(['partner_admin', 'partner_member'])
  @RouteDeadline(UPLOAD_ROUTE_DEADLINE_MS)
  @AcceptMultipart({ maxBytes: IMAGE_MAX_BYTES + IMAGE_ENVELOPE_BYTES, tooLarge: imageTooLarge, bulkhead: PARTNER_MULTIPART_BULKHEAD })
  async upload(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProductionImageView> {
    const who = caller(me);
    const productionId = params.productionId.toLowerCase();
    await this.images.authorize(productionId, who, 'upload');
    requireXRequestedWith(request);
    const out = await this.images.upload({ productionId, who, form: await readUploadForm(request) });
    void reply.header('etag', etagOf(out.version));
    return out;
  }

  @Patch(':productionId/images/:imageId')
  @Roles(['partner_admin', 'partner_member'])
  async update(
    @ContractParams(ImageParams) params: z.output<typeof ImageParams>,
    @ContractBody(ImagePatchBody) body: z.output<typeof ImagePatchBody>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ProductionImageView> {
    const who = caller(me);
    const productionId = params.productionId.toLowerCase();
    await this.images.authorize(productionId, who, 'update');
    const ifMatch = request.headers['if-match'];
    const out = await this.images.update({
      productionId,
      imageId: params.imageId.toLowerCase(),
      who,
      ifMatch: typeof ifMatch === 'string' ? ifMatch : undefined,
      ...(body.alt !== undefined ? { alt: body.alt } : {}),
      ...(body.order !== undefined ? { order: body.order } : {}),
    });
    void reply.header('etag', etagOf(out.version));
    return out;
  }

  @Delete(':productionId/images/:imageId')
  @HttpCode(204)
  @Roles(['partner_admin', 'partner_member'])
  async remove(@ContractParams(ImageParams) params: z.output<typeof ImageParams>, @CurrentPrincipal() me: Principal): Promise<void> {
    const who = caller(me);
    const productionId = params.productionId.toLowerCase();
    await this.images.authorize(productionId, who, 'delete');
    await this.images.remove({ productionId, imageId: params.imageId.toLowerCase(), who });
  }

  @Post(':productionId/seatmap-imports')
  @HttpCode(200)
  @Roles(['partner_admin', 'partner_member'])
  @AcceptMultipart({ maxBytes: SEATMAP_FILE_MAX_BYTES + IMAGE_ENVELOPE_BYTES, tooLarge: seatmapImportTooLarge, bulkhead: PARTNER_MULTIPART_BULKHEAD })
  async importSeatmap(
    @ContractParams(ProductionParams) params: z.output<typeof ProductionParams>,
    @CurrentPrincipal() me: Principal,
    @Req() request: FastifyRequest,
  ): Promise<SeatMapImportResult> {
    const who = caller(me);
    const productionId = params.productionId.toLowerCase();
    await this.seatmap.authorize(productionId, who);
    requireXRequestedWith(request);
    return this.seatmap.run({ productionId, who, form: await readUploadForm(request) });
  }
}
