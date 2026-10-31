// 요청 맥락(docs/architecture.md §6.1 'REQUEST 스코프 대신 AsyncLocalStorage', openspec 변경 add-service-template 결정 5).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Deadline } from './deadline.js';

export interface RequestContext {
  /** 이 요청의 trace-id(32자리 16진수). OTel 스팬이 있으면 그 값, 없으면 요청마다 새로 만든 값 */
  readonly traceId: string;
  /** 받은 남은 시간(guidelines §5) */
  readonly deadline: Deadline;
  /** 지표 라벨과 같은 경로 틀(계약 표기, 맞는 경로가 없으면 unmatched) */
  readonly route: string;
  readonly method: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runInRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 지금 요청의 맥락. 요청 밖이면 undefined */
export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** 지금 요청의 남은 시간. 요청 밖에서 부르면 던진다 */
export function currentDeadline(): Deadline {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('요청 맥락 밖에서 남은 시간을 찾았다');
  return ctx.deadline;
}

export function newTraceId(): string {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && isSpanContextValid(sc) ? sc.traceId : randomBytes(16).toString('hex');
}
