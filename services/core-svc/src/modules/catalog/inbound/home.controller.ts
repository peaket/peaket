// GET /v1/home — SCR-001 홈 피드(공개 캐시, 개인 값 없음, docs/features/search.md §2.4, openapi GetHomeResponse).
import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { ContractRouteSchema, Roles } from '@peaket/platform';
import { z } from 'zod';
import { HomeFeed } from '../application/home-feed.js';

export const HOME_CACHE = 'public, max-age=30, stale-while-revalidate=30, stale-if-error=86400';

// 홈 피드는 카드·테마가 겹친 커다란 계약 스키마라 라우트 응답 스키마를 그대로 쓰면 서비스 시작이 느려진다.
// 대신 공개 칸의 모양만 고정하고 카드 안쪽은 그대로 통과시킨다(응답 본문은 계약 시험이 GetHomeResponse로 검사한다).
const HomeFeedResponse = z.object({
  banners: z.array(z.object({}).passthrough()).optional(),
  upcoming: z.array(z.object({}).passthrough()).optional(),
  onSale: z.array(z.object({}).passthrough()).optional(),
  themes: z.array(z.object({}).passthrough()).optional(),
  places: z.array(z.object({}).passthrough()).optional(),
  rankingsPath: z.string().optional(),
  generatedAt: z.string().optional(),
});

@Controller('v1/home')
export class HomeController {
  constructor(private readonly home: HomeFeed) {}

  @Get()
  @ContractRouteSchema({ responses: { 200: HomeFeedResponse } })
  @Roles(['public'])
  async get(@Res({ passthrough: true }) reply: FastifyReply) {
    const body = await this.home.get();
    void reply.header('cache-control', HOME_CACHE);
    // CDN 태그 무효화는 원본이 태그 머리를 실은 응답에만 걸린다(docs/infra.md §4.1). 200 JSON에만 싣는다.
    void reply.header('x-peaket-cache-tag', 'home');
    return body;
  }
}
