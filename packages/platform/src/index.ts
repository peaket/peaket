// @peaket/platform: 서비스(NestJS·Fastify) 공용 시작 코드(docs/architecture.md §10, openspec 변경 add-service-template).
export { CLOCK, fakeClock, systemClock, type Clock, type FakeClock } from './clock.js';
export { DEBUG_ERRORS_ALLOWED, LOG_LEVELS, PEAKET_ENVS, PlatformConfigError, loadPlatformConfig, type LogLevelName, type PeaketEnv, type PlatformConfig } from './config.js';
export { currentDeadline, requestContext, type RequestContext } from './context.js';
export { DEADLINE_HEADER, DEFAULT_MAX_DEADLINE_MS, Deadline } from './deadline.js';
export { LATENCY_BUCKETS_SECONDS, PlatformMetrics } from './metrics.js';
export { contractSchema, emitOpenApi, type EmitOpenApiOptions } from './openapi.js';
export { PROBLEM_CONTENT_TYPE, PROBLEM_TYPE_BASE, ProblemError, deadlineExceeded, type ProblemInit } from './problem.js';
export { ProblemFilter } from './problem-filter.js';
export { createService, type CreateServiceOptions, type PlatformService } from './service.js';
export { clientFamily } from './client-family.js';
export { LOG_PSEUDONYM_KEY_ENV, LogPseudonymizer, ipPrefix, loadLogPseudonymizer } from './pseudonym.js';
export { sampleKeep, sampleThreshold } from './sampling.js';
export { APP_HEADER, APPS } from './http-hooks.js';
export { NestPinoLogger, PLATFORM_LOGGER, REDACTED_KEYS, createPlatformLogger, kstIso, type PlatformLogger, type PlatformLoggerOptions } from './log.js';
export { LogPolicy, requestLog, type QueuePhase, type RequestLog, type RequestLogFields, type RouteLogPolicy } from './request-log.js';
export { TRACE_PROPAGATION_HEADERS, createExternalHttpClient, type ExternalHttpClient, type ExternalHttpClientOptions, type ExternalRequest } from './http-client.js';
export { BoundaryPropagator, BoundarySpanProcessor, withoutTracePropagation, type InboundTrust } from './trace-boundary.js';
