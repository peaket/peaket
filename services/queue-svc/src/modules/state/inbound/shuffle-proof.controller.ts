// 받는 층: 셔플 검증 정보(openapi GET /v1/queues/{eventId}/shuffle-proof, ADR-0232 결정 8)와 local·ci·demo의 결과 파일 경로.
// 운영의 결과 파일은 대기열 파일 배포가 S3에서 바로 낸다(ADR-0232 결정 4). 이 경로의 머리는 그 응답과 같게 맞춘다.
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError, Roles } from '@peaket/platform';
import type { FastifyReply } from 'fastify';
import { type EventSchedules } from '../../entry/index.js';
import { shuffleProof } from '../domain/proof.js';
import { RESULT_FILE_READER, type ResultFileKind, type ResultFileReader, SHUFFLE_PROOF_SOURCE, type ShuffleProofSource, STATE_OPTIONS, type StateOptions, STATE_SCHEDULES } from '../domain/ports.js';

/** Redis 키의 해시 태그 안에 들어가는 회차 ID 모양(진입 경로와 같다) */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;
const FILE = /^([0-9a-f]{3})\.json$/;

@Controller('v1/queues/:eventId')
export class ShuffleProofController {
  constructor(
    @Inject(SHUFFLE_PROOF_SOURCE) private readonly source: ShuffleProofSource,
    @Inject(RESULT_FILE_READER) private readonly files: ResultFileReader,
    @Inject(STATE_SCHEDULES) private readonly schedules: EventSchedules,
    @Inject(STATE_OPTIONS) private readonly options: StateOptions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('shuffle-proof')
  @Roles(['public'])
  async proof(@Param('eventId') eventId: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<Record<string, unknown>> {
    const schedule = KEY_PART.test(eventId) ? await this.schedules.get(eventId) : null;
    if (!schedule) throw new ProblemError({ type: 'queue-not-found', status: 404, title: '이 회차의 대기열이 열리지 않았습니다', detail: '이 회차의 셔플 정보가 없습니다' });
    void reply.header('cache-control', 'public, max-age=5');
    return shuffleProof(eventId, schedule, await this.source.read(eventId), this.clock.now());
  }

  @Get('shuffle-results/:file')
  @Roles(['public'])
  shuffleResult(@Param('eventId') eventId: string, @Param('file') file: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    return this.#result(eventId, 'shuffle-results', file, reply);
  }

  @Get('batch-results/:file')
  @Roles(['public'])
  batchResult(@Param('eventId') eventId: string, @Param('file') file: string, @Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    return this.#result(eventId, 'batch-results', file, reply);
  }

  async #result(eventId: string, kind: ResultFileKind, file: string, reply: FastifyReply): Promise<string> {
    void reply.header('access-control-allow-origin', this.options.webOrigin);
    void reply.header('access-control-expose-headers', 'Retry-After');
    const m = FILE.exec(file);
    const body = m && KEY_PART.test(eventId) ? await this.files.read(eventId, kind, m[1]!) : null;
    if (body === null) {
      // 셔플 전. 대기열 파일 배포의 404 오류 캐시 1초 [가정]와 같게 둔다(ADR-0058)
      void reply.header('cache-control', 'public, max-age=1');
      throw new ProblemError({ type: 'queue-not-found', status: 404, title: '이 회차의 대기열이 열리지 않았습니다', detail: '결과 파일이 아직 없습니다' });
    }
    void reply.header('content-type', 'application/json; charset=utf-8');
    void reply.header('cache-control', 'public, max-age=60');
    return body;
  }
}
