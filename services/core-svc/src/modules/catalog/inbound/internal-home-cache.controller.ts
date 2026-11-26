// POST /internal/v1/home-cache/revalidate — 운영 배너·테마 저장 뒤 홈 피드 캐시 무효화(HOT-305).
import { Controller, HttpCode, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { HomeCacheInvalidator } from '../application/home-cache.js';
import { InternalToken401Guard } from './internal-sale-config.controller.js';

const NoBody = z.object({}).strict();

@Controller('internal/v1/home-cache')
@UseGuards(InternalToken401Guard)
export class InternalHomeCacheController {
  constructor(private readonly homeCache: HomeCacheInvalidator) {}

  @Post('revalidate')
  @HttpCode(204)
  @Roles(['public'])
  @ContractRouteSchema({ responses: { 204: NoBody } })
  async revalidate(@Res({ passthrough: true }) reply: FastifyReply): Promise<void> {
    void reply.header('cache-control', 'no-store');
    await this.homeCache.invalidate('HOME_LAYOUT_SAVED');
  }
}
