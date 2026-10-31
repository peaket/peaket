// 전역 예외 필터: 모든 오류를 RFC 9457 Problem 본문으로 바꾼다(docs/api/guidelines.md §2, openspec 변경 add-service-template 결정 3).
// - 이름 붙은 오류(ProblemError)는 type URI·표준 칸·확장 필드를 싣는다.
// - 이름 없는 HTTP 오류(Nest 예외, Fastify 본문 해석 오류, 없는 경로)는 about:blank와 상태 문구만 싣는다(RFC 9457 §4.2.1).
// - 예상하지 못한 오류는 500·about:blank·일반 문구·traceId만 내고, 원본은 같은 traceId로 그 요청의 정규 로그 줄 err에 남긴다
//   (ASVS v5.0.0-16.5.1·16.3.4, openspec 변경 add-service-logging 결정 2).
import { STATUS_CODES } from 'node:http';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { newTraceId } from './context.js';
import { requestState } from './http-hooks.js';
import { PROBLEM_CONTENT_TYPE, ProblemError } from './problem.js';
import { errorInfoOf } from './request-log.js';

export interface ProblemFilterOptions {
  debugErrors: boolean;
}

const isErrorStatus = (code: unknown): code is number => typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599;

/**
 * 응답 상태로 믿는 것: HTTP 예외의 4xx·5xx와 Fastify 자체 오류(code가 FST_로 시작, 본문 해석·크기 등)의 상태.
 * 그 밖의 오류가 단 statusCode(다른 서비스를 부른 HTTP 클라이언트 오류 등)는 믿지 않고 500으로 본다(코드 리뷰, 2026-11-01)
 */
export const statusOf = (exception: unknown): number | undefined => {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return isErrorStatus(status) ? status : undefined;
  }
  const e = exception as { statusCode?: unknown; code?: unknown } | null;
  return typeof e?.code === 'string' && e.code.startsWith('FST_') && isErrorStatus(e.statusCode) ? e.statusCode : undefined;
};

const debugOf = (exception: unknown) =>
  exception instanceof Error
    ? { name: exception.name, message: exception.message, stack: (exception.stack ?? '').split('\n').slice(1, 11).map((l) => l.trim()) }
    : { name: typeof exception, message: String(exception), stack: [] as string[] };

/**
 * Fastify 라우터가 처리기를 찾기 전에 낸 오류(FST_ERR_BAD_URL 등, frameworkErrors). Nest 필터와 onRequest 훅을 지나지 않는다.
 * 요청 경로는 잘못된 값 그대로라 싣지 않는다(되비침 방지). 지표에는 맞는 경로 없음(unmatched)으로 넣는다
 */
export function frameworkErrorProblem(error: unknown, debugErrors: boolean): { status: number; body: Record<string, unknown> } {
  const status = statusOf(error) ?? 400;
  const body: Record<string, unknown> = { type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', status, traceId: newTraceId() };
  if (debugErrors) body.debug = debugOf(error);
  return { status, body };
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly options: ProblemFilterOptions) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const state = requestState(request);
    const traceId = state?.ctx.traceId ?? newTraceId();
    const instance = (request.url ?? '').split('?')[0];

    let body: Record<string, unknown>;
    let status: number;
    if (exception instanceof ProblemError) {
      status = exception.status;
      body = { type: exception.type, title: exception.title, status };
      if (exception.detail !== undefined) body.detail = exception.detail;
      body.instance = instance;
      body.traceId = traceId;
      Object.assign(body, exception.extensions);
      if (exception.retryAfterSeconds !== undefined) void reply.header('retry-after', String(exception.retryAfterSeconds));
      if (state && exception.normalBranch) state.normalBranch = true;
    } else {
      status = statusOf(exception) ?? 500;
      body = { type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', status };
      // 5xx는 요청 경로도 싣지 않는다(일반 문구와 traceId만, guidelines §2)
      if (status < 500) body.instance = instance;
      body.traceId = traceId;
    }
    // 정규 로그 줄의 err(5xx는 이름·메시지·스택, 4xx는 종류와 상태 문구만)
    if (state) state.error = errorInfoOf(exception, status);
    if (this.options.debugErrors) body.debug = debugOf(exception);
    void reply.status(status).header('content-type', PROBLEM_CONTENT_TYPE).send(JSON.stringify(body));
  }
}
