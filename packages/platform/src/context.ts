// 요청 맥락(docs/architecture.md §6.1 'REQUEST 스코프 대신 AsyncLocalStorage', openspec 변경 add-service-template 결정 5).
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { Principal } from './auth.js';
import type { Deadline } from './deadline.js';
import type { RequestLogState } from './request-log.js';

export interface RequestContext {
  /** 이 요청의 trace-id(32자리 16진수). OTel 서버 span이 있으면 그 값, 없으면 요청마다 새로 만든 값 */
  readonly traceId: string;
  /** OTel 서버 span의 span-id(SDK가 없으면 없다) */
  readonly spanId?: string;
  /** 받은 남은 시간(guidelines §5) */
  readonly deadline: Deadline;
  /** 지표 라벨과 같은 경로 틀(계약 표기, 맞는 경로가 없으면 unmatched) */
  readonly route: string;
  readonly method: string;
  /** 정규 로그 줄에 더할 값(requestLog()) */
  readonly log: RequestLogState;
  /** 인증 가드가 판정한 요청자(공개 경로는 없다, auth.ts) */
  principal?: Principal;
  /** 스캐너 기기 증명을 통과한 기기(스캐너 경로만, scanner-auth.ts) */
  scannerDevice?: { deviceId: string; jkt: string };
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runInRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** 지금 요청의 맥락. 요청 밖이면 undefined */
export function requestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** 스캐너 경로에서 기기 증명을 통과한 기기. 그 밖의 요청에서는 undefined */
export function currentScannerDevice(): { deviceId: string; jkt: string } | undefined {
  return storage.getStore()?.scannerDevice;
}

/** 지금 요청의 남은 시간. 요청 밖에서 부르면 던진다 */
export function currentDeadline(): Deadline {
  const ctx = storage.getStore();
  if (!ctx) throw new Error('요청 맥락 밖에서 남은 시간을 찾았다');
  return ctx.deadline;
}

export interface ActiveTrace {
  traceId: string;
  spanId?: string;
}

/** 지금 맥락의 OTel span(SDK가 만든 서버 span). 없으면 무작위 trace-id */
export function activeTrace(): ActiveTrace {
  const sc = trace.getActiveSpan()?.spanContext();
  if (sc && isSpanContextValid(sc)) return { traceId: sc.traceId, spanId: sc.spanId };
  return { traceId: randomBytes(16).toString('hex') };
}

export function newTraceId(): string {
  return activeTrace().traceId;
}
