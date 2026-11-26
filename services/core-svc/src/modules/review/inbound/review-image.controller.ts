// 받는 층: 후기 사진 올리기(openapi POST /v1/review-images, F-07-10, POL-042 ⑥).
// multipart는 Content-Type이 safelisted라 X-Requested-With를 요구한다(catalog-review 3.5.1).
import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { AcceptMultipart, ContractRouteSchema, CurrentPrincipal, ProblemError, type Principal, Roles, RouteDeadline } from '@peaket/platform';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FAN_MULTIPART_BULKHEAD, REVIEW_IMAGE_ENVELOPE_BYTES, REVIEW_IMAGE_MAX_BYTES } from '../domain/review-image.js';
import { type ReviewImageUploadResult, ReviewImages, REVIEW_IMAGE_ROUTE_DEADLINE_MS } from '../application/review-images.js';
import { readUploadForm, requireXRequestedWith } from '../../catalog/index.js';

const Result = z.object({ imageId: z.string(), status: z.literal('READY'), thumbnailUrl: z.string() });

const tooLarge = () => new ProblemError({ type: 'review-image-too-large', status: 413, title: '한 장에 10MB까지 올릴 수 있습니다' });

@Controller('v1/review-images')
export class ReviewImageController {
  constructor(private readonly images: ReviewImages) {}

  @Post()
  @Roles(['fan'])
  @HttpCode(201)
  @RouteDeadline(REVIEW_IMAGE_ROUTE_DEADLINE_MS)
  @AcceptMultipart({ maxBytes: REVIEW_IMAGE_MAX_BYTES + REVIEW_IMAGE_ENVELOPE_BYTES, tooLarge, bulkhead: FAN_MULTIPART_BULKHEAD })
  @ContractRouteSchema({ responses: { 201: Result } })
  async upload(@CurrentPrincipal() me: Principal, @Req() request: FastifyRequest, @Res({ passthrough: true }) _reply: FastifyReply): Promise<ReviewImageUploadResult> {
    requireXRequestedWith(request);
    const form = await readUploadForm(request);
    const file = form.files.find((f) => f.field === 'file');
    if (!file) throw new ProblemError({ type: 'review-image-invalid', status: 400, title: '사진 파일이 없습니다' });
    return this.images.upload({ accountId: me.accountId, file });
  }
}
