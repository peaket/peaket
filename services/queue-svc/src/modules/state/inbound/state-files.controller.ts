// 받는 층: 구간별 대기 상태 파일(openapi GET /v1/queues/{eventId}/segment-states/{segment}.json, docs/features/queue-admission.md §4, ADR-0110).
// 인증·쿠키가 없는 공개 파일이다. 입장 임박 구간은 다음 생성 시각까지만 캐시하게 Expires를 주고, 그 밖 구간은 1초 캐시와 낡은 값 2초를 허락한다.
// 교차 출처 읽기는 소비자 웹 하나로 고정한다(출처마다 캐시가 갈리지 않게, ASVS v5.0.0-3.4.2).
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { StateFiles, StateUnavailable } from '../application/state-files.js';
import { STATE_OPTIONS, type StateOptions } from '../domain/ports.js';

/** Redis 키의 해시 태그 안에 들어가는 회차 ID 모양(진입 경로와 같다) */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
/** 구간 번호 파일 이름(100만 번호면 구간 999까지, 넉넉히 6자리) */
const FILE = /^(\d{1,6})\.json$/;

@Controller('v1/queues/:eventId/segment-states')
export class StateFilesController {
  constructor(
    private readonly files: StateFiles,
    @Inject(STATE_OPTIONS) private readonly options: StateOptions,
  ) {}

  @Get(':file')
  @Roles(['public'])
  async segment(@Param('eventId') eventId: string, @Param('file') file: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    void reply.header('access-control-allow-origin', this.options.webOrigin);
    void reply.header('access-control-expose-headers', 'Retry-After');
    const m = FILE.exec(file);
    const found = KEY_PART.test(eventId) && m ? await this.#file(eventId, Number(m[1]), reply) : null;
    if (!found) {
      // 없는 회차·구간도 엣지가 1초만 들고 있게 한다(같은 404가 원본으로 몰리지 않게)
      void reply.header('cache-control', 'public, max-age=1');
      throw new ProblemError({ type: 'queue-not-found', status: 404, title: '이 회차의 대기열이 열리지 않았습니다', detail: '이 회차·구간의 대기 상태가 없습니다' });
    }
    void reply.header('content-type', 'application/json; charset=utf-8');
    if (found.imminent) {
      // 모든 캐시 층이 같은 순간(다음 생성 시각)에 만료하게 절대 시각을 준다. max-age·stale-while-revalidate는 두지 않는다(ADR-0110)
      void reply.header('expires', new Date(found.generatedAtMs + 1000).toUTCString());
      void reply.header('cache-control', 'public');
    } else {
      void reply.header('cache-control', 'public, max-age=1, stale-while-revalidate=2');
    }
    return found.body;
  }

  async #file(eventId: string, segment: number, reply: FastifyReply) {
    try {
      return await this.files.file(eventId, segment);
    } catch (e) {
      // 오류 응답을 CDN이 기본 시간(10초) 동안 들고 있지 않게 한다
      if (e instanceof StateUnavailable) void reply.header('cache-control', 'no-store');
      if (e instanceof StateUnavailable) throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다', retryAfterSeconds: 1, cause: e });
      throw e;
    }
  }
}
