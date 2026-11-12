// 요청 검사(openspec 변경 add-service-structure-and-request-checks 결정 2~6, docs/api/guidelines.md §1·§2, ADR-0023).
// - 일반 경로: 계약 생성 Zod를 받는 매개변수 장식자(Zod 파이프). nestjs-zod 5.5.0은 peer가 NestJS 11까지라 같은 일을 여기서 한다
// - 핫패스: 같은 Zod를 z.toJSONSchema()로 바꾼 Fastify 경로 스키마와 플랫폼 검사기(Ajv, 형 바꾸기·칸 지우기 없음)
// - 두 길 모두 쿼리·경로·머리의 문자열을 같은 함수로 바꾸고(http-values.ts), 실패는 같은 Problem 400이다
// - 본문은 application/json만, @AcceptTextPlain()을 단 경로만 text/plain도 JSON으로 읽는다(그 밖은 415, asvs/delivery.md 3.5.2).
//   @AcceptMultipart()를 단 올리기 경로만 multipart/form-data를 바이트로 받는다(ADR-0257)
import { BadRequestException, Body, createParamDecorator, type ExecutionContext, Param, type PipeTransform, Query } from '@nestjs/common';
import { FASTIFY_ROUTE_CONFIG_METADATA, FASTIFY_ROUTE_SCHEMA_METADATA } from '@nestjs/platform-fastify/constants.js';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { FastifyInstance, FastifyRequest, FastifySchema } from 'fastify';
import { z } from 'zod';
import { type HttpPart, type JsonSchema, httpValueCoercer } from './http-values.js';
import { keepRawBody } from './raw-body.js';
import { ProblemError } from './problem.js';
import { PURCHASE_MAC_HEADER, PURCHASE_SEQ_HEADER } from './purchase-auth.js';

/** 검사 실패. 전역 필터가 about:blank 400으로 바꾼다(결정 5: 두 길의 본문이 같도록 설명을 싣지 않는다) */
export class RequestValidationError extends BadRequestException {
  constructor(readonly reason: string) {
    super();
    this.name = 'RequestValidationError';
  }
}

type ZodSchema = z.ZodType;
type Io = 'input' | 'output';

/**
 * 계약 Zod → JSON Schema(draft-07, $schema 뺌). 같은 스키마는 한 번만 바꾼다.
 * 경로 스키마는 JSON Schema로 못 옮기는 형(파일 등)이 있으면 시작 때 던진다(조용히 아무 값이나 받지 않게). 문자열 바꾸기용은 그 칸을 {}로 둔다
 */
const converted = new WeakMap<ZodSchema, Map<string, JsonSchema>>();
export function toJsonSchema(schema: ZodSchema, io: Io, unrepresentable: 'throw' | 'any' = 'throw'): JsonSchema {
  let byMode = converted.get(schema);
  if (!byMode) converted.set(schema, (byMode = new Map()));
  const key = `${io}:${unrepresentable}`;
  let out = byMode.get(key);
  if (!out) {
    const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io, target: 'draft-07', unrepresentable }) as JsonSchema;
    out = rest;
    byMode.set(key, out);
  }
  return out;
}

type PipePart = HttpPart | 'body';

/** 계약 Zod 파이프(결정 3). 쿼리·경로·머리는 문자열 값을 바꾼 뒤 검사하고, 성공하면 Zod 결과(기본값을 채운 값)를 넘긴다 */
export class ContractPipe implements PipeTransform {
  private readonly coerce?: ReturnType<typeof httpValueCoercer>;

  constructor(
    private readonly schema: ZodSchema,
    private readonly part: PipePart,
  ) {
    // 머리만 스키마의 칸만 골라 넘긴다(들어온 머리에는 host 등 계약 밖 머리가 늘 있다). 쿼리·경로는 모르는 키도 넘겨,
    // 닫은 스키마(.strict())면 경로 스키마처럼 거절하게 한다(코드 리뷰 2026-11-01)
    if (part !== 'body') this.coerce = httpValueCoercer(toJsonSchema(schema, 'input', 'any'), part, { pickSchemaKeys: part === 'headers' });
  }

  transform(value: unknown): unknown {
    let input = value;
    if (this.coerce) {
      const c = this.coerce(value);
      if (!c.ok) throw new RequestValidationError(c.reason);
      input = c.value;
    }
    const r = this.schema.safeParse(input);
    if (!r.success) throw new RequestValidationError(`${this.part} 검사 실패`);
    return r.data;
  }
}

/** 본문을 계약 Zod로 검사한다 */
export const ContractBody = (schema: ZodSchema): ParameterDecorator => Body(new ContractPipe(schema, 'body'));
/** 쿼리 전체를 계약 Zod로 검사한다(같은 이름이 겹치면 400) */
export const ContractQuery = (schema: ZodSchema): ParameterDecorator => Query(new ContractPipe(schema, 'querystring'));
/** 경로 매개변수 전체를 계약 Zod로 검사한다 */
export const ContractParams = (schema: ZodSchema): ParameterDecorator => Param(new ContractPipe(schema, 'params'));
const RawHeaders = createParamDecorator((_data: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<FastifyRequest>().headers);
/** 머리를 계약 Zod로 검사한다. 처리기는 계약의 칸 이름(Idempotency-Key 등)으로 받는다 */
export const ContractHeaders = (schema: ZodSchema): ParameterDecorator => {
  const inner = RawHeaders(undefined, new ContractPipe(withoutModuleHeaders(schema), 'headers'));
  return (target, key, index) => {
    inner(target, key, index);
    if (key !== undefined) markModuleHeaders((target as Record<string | symbol, object>)[key]!, schema);
  };
};

/** 멱등 키 머리 이름(소문자). 이 머리는 멱등 모듈만 본다(add-idempotency-and-outbox 결정 1) */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/**
 * 처리기 메타데이터: 계약 머리 스키마의 Idempotency-Key를 빼고 멱등 모듈에 맡겼다. 시작 확인이 그 처리기에 @Idempotent를 요구한다
 * (빠뜨리면 키 없는 요청이 통과해 다시 보낸 요청을 두 번 처리한다, 코드 리뷰 2026-11-01)
 */
export const IDEMPOTENCY_KEY_BY_MODULE = 'peaket:idempotency-key-by-module';

/**
 * 처리기 메타데이터: 계약 머리 스키마의 X-Purchase-Seq·X-Purchase-Mac을 빼고 구매 요청 인증 훅에 맡겼다. 시작 확인이 그 처리기에
 * @PurchaseSigned()를 요구한다(빠뜨리면 서명 없는 구매 쓰기 요청이 통과한다, openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 6)
 */
export const PURCHASE_SIGNATURE_BY_MODULE = 'peaket:purchase-signature-by-module';
const PURCHASE_HEADERS: readonly string[] = [PURCHASE_SEQ_HEADER, PURCHASE_MAC_HEADER];
/** 두 검사 길이 보지 않고 모듈이 보는 머리(소문자) */
const MODULE_HEADERS: readonly string[] = [IDEMPOTENCY_KEY_HEADER, ...PURCHASE_HEADERS];

function headerNames(schema: ZodSchema): string[] {
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : [];
}

function markModuleHeaders(handler: object, schema: ZodSchema): void {
  const names = headerNames(schema).map((n) => n.toLowerCase());
  if (names.includes(IDEMPOTENCY_KEY_HEADER)) Reflect.defineMetadata(IDEMPOTENCY_KEY_BY_MODULE, true, handler);
  if (names.some((n) => PURCHASE_HEADERS.includes(n))) Reflect.defineMetadata(PURCHASE_SIGNATURE_BY_MODULE, true, handler);
}

/** 머리 Zod 스키마에서 모듈이 보는 칸을 뺀다(이름은 대소문자를 가리지 않는다) */
function withoutModuleHeaders(schema: ZodSchema): ZodSchema {
  const drop = headerNames(schema).filter((n) => MODULE_HEADERS.includes(n.toLowerCase()));
  if (drop.length === 0) return schema;
  return (schema as z.ZodObject).omit(Object.fromEntries(drop.map((k) => [k, true])) as never) as unknown as ZodSchema;
}

export interface ContractRouteSchemaInput {
  params?: ZodSchema;
  query?: ZodSchema;
  headers?: ZodSchema;
  /** 본문 스키마 하나. text/plain으로도 받는 경로는 @AcceptTextPlain()을 단다(해석기가 같은 JSON을 내므로 형식별 스키마를 두지 않는다) */
  body?: ZodSchema;
  /** 상태 코드 → 응답 Zod(직렬화 스키마. 스키마에 없는 칸은 내보내지 않는다) */
  responses?: Record<number, ZodSchema>;
}

/**
 * 머리 스키마의 칸 이름을 소문자로 바꾼다. Node는 들어온 머리 이름을 소문자로 주는데, Fastify는 사용자 검사기 생성기에
 * 스키마를 그대로 넘겨 계약의 `Idempotency-Key`가 필수 칸 없음이 됐다(2026-11-01 확인)
 */
function withoutHeader(schema: JsonSchema, name: string): JsonSchema {
  const props = schema.properties as Record<string, unknown> | undefined;
  if (!props || !(name in props)) return schema;
  const { [name]: _drop, ...rest } = props;
  const out: JsonSchema = { ...schema, properties: rest };
  if (Array.isArray(schema.required)) out.required = (schema.required as string[]).filter((k) => k !== name);
  return out;
}

function lowerCaseHeaderNames(schema: JsonSchema): JsonSchema {
  const props = schema.properties as Record<string, unknown> | undefined;
  const out: JsonSchema = { ...schema };
  if (props) out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]));
  if (Array.isArray(schema.required)) out.required = (schema.required as string[]).map((k) => k.toLowerCase());
  return out;
}

/**
 * 검사를 인증 가드 뒤로 미루는 경로 설정 칸. Nest 처리기 장식자 @ContractRouteSchema만 단다. 인증 가드를 지나지 않는 경로
 * (서비스가 Fastify에 바로 붙인 경로)는 같은 스키마를 써도 이 칸이 없어 Fastify 기본대로 바로 거절한다(다시 본 리뷰·세 번째 리뷰 2026-11-01)
 */
export const DEFER_VALIDATION_KEY = 'peaketDeferValidation';

/**
 * 계약 Zod에서 Fastify 경로 스키마를 만든다(결정 4). 처리기에는 @ContractRouteSchema로 단다.
 * byModule이면 머리 스키마에서 모듈이 보는 머리(Idempotency-Key, X-Purchase-Seq·X-Purchase-Mac)를 뺀다(@ContractRouteSchema만 쓴다).
 * Fastify에 바로 붙이는 경로는 인증 가드와 그 모듈을 지나지 않으므로 스키마에 남긴다(코드 리뷰 2026-11-01)
 */
export function contractRouteSchema(i: ContractRouteSchemaInput, o: { byModule?: boolean } = {}): FastifySchema {
  const out: Record<string, unknown> = {};
  if (i.params) out.params = toJsonSchema(i.params, 'input');
  if (i.query) out.querystring = toJsonSchema(i.query, 'input');
  // 멱등 키는 멱등 모듈이 신원 판정 뒤에 본다(머리 스키마가 먼저 about:blank 400을 내지 않게, add-idempotency-and-outbox 결정 1)
  if (i.headers) {
    const h = lowerCaseHeaderNames(toJsonSchema(i.headers, 'input'));
    out.headers = o.byModule ? MODULE_HEADERS.reduce((acc, name) => withoutHeader(acc, name), h) : h;
  }
  // 형식별(content) 본문 스키마는 들어온 형식과 맞는 것이 없으면 Fastify가 검사를 건너뛰어 본문 없는 POST가 통과했다(코드 리뷰 2026-11-01).
  // 본문 스키마 하나는 해석기가 낸 값을 형식과 관계없이 검사하고, 본문이 없으면 거절한다
  if (i.body) out.body = toJsonSchema(i.body, 'input');
  if (i.responses) {
    out.response = Object.fromEntries(Object.entries(i.responses).map(([code, s]) => [code, toJsonSchema(s, 'output')]));
  }
  return out as FastifySchema;
}

/**
 * 핫패스 처리기의 경로 스키마(@RouteSchema 대신 단다). 검사 실패는 인증 가드가 신원·역할을 판정한 뒤 400으로 낸다(익명 요청은 401이 먼저).
 * 같은 처리기에 @ContractQuery 등 Zod 파이프를 함께 달지 않는다(경로 스키마가 바꾼 배열을 파이프가 겹친 쿼리로 본다)
 */
export function ContractRouteSchema(i: ContractRouteSchemaInput): MethodDecorator {
  const schema = contractRouteSchema(i, { byModule: true });
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    Reflect.defineMetadata(FASTIFY_ROUTE_SCHEMA_METADATA, schema, fn);
    if (i.headers) markModuleHeaders(fn, i.headers);
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [DEFER_VALIDATION_KEY]: true }, fn);
    return descriptor;
  };
}

// ajv-formats는 CJS 기본 내보내기다(ESM에서 default 아래에 있다)
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (ajv: Ajv) => Ajv;

/**
 * 플랫폼 검사기 생성기(결정 4). Fastify 기본(coerceTypes 'array', removeAdditional true)은 본문의 "1"을 숫자로 바꾸고
 * additionalProperties: false의 정의 밖 칸을 지운 뒤 통과시켜 Zod와 달랐다. 쿼리·경로·머리는 Zod 파이프와 같은 바꾸기를 한다
 */
export function platformValidatorCompiler() {
  // strict: false는 모르는 낱말(설명용 메타데이터)을 받으려는 것이다. 그것이 끄는 strictNumbers는 다시 켠다: 꺼지면 JSON의 1e400(무한대)이
  // 숫자 칸을 통과했다(Zod는 거절한다, 코드 리뷰 2026-11-01)
  const ajv = new Ajv({ coerceTypes: false, removeAdditional: false, useDefaults: true, allErrors: false, strict: false, strictNumbers: true });
  addFormats(ajv);
  return ({ schema, httpPart }: { schema: unknown; httpPart?: string }) => {
    const validate: ValidateFunction = ajv.compile(schema as object);
    if (httpPart !== 'querystring' && httpPart !== 'params' && httpPart !== 'headers') return validate;
    const coerce = httpValueCoercer(schema as JsonSchema, httpPart);
    return (data: unknown) => {
      const c = coerce(data);
      if (!c.ok) return { error: new RequestValidationError(c.reason) };
      return validate(c.value) ? { value: c.value } : { error: new RequestValidationError(`${httpPart} 검사 실패`) };
    };
  };
}

/** 경로 스키마 검사가 붙여 둔 실패를 400으로 낸다(인증 가드가 신원을 판정한 뒤 부른다) */
export function throwAttachedValidationError(request: FastifyRequest): void {
  const e = (request as FastifyRequest & { validationError?: Error }).validationError;
  if (e) throw new RequestValidationError(e.message);
}

export const TEXT_PLAIN_KEY = 'peaketTextPlain';

/** 본문을 text/plain으로도 받는 경로에 단다(대기열 진입·입장 확정, ADR-0065 결정 6). Fastify 경로 설정에 들어간다 */
export function AcceptTextPlain(): MethodDecorator {
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [TEXT_PLAIN_KEY]: true }, fn);
    return descriptor;
  };
}

export const MULTIPART_KEY = 'peaketMultipart';

export interface AcceptMultipartOptions {
  /** 본문 전체(파일과 multipart 봉투)의 상한(바이트). 넘으면 읽기를 멈추고 tooLarge()로 답한다 */
  maxBytes: number;
  /** 상한을 넘었을 때 낼 이름 붙은 413(경로마다 이름이 다르다, 예 image-too-large) */
  tooLarge: () => ProblemError;
  /**
   * 같은 이름의 경로들이 함께 쓰는 동시 처리 칸막이(벌크헤드, 서비스 인스턴스마다 하나). 자리는 본문을 읽기 전(그 경로의 onRequest)에 잡고
   * 응답이 끝나거나 연결이 끊기면 놓는다. 차면 본문을 읽지 않고 429 server-busy와 Retry-After(초)다(ADR-0257 결정 2)
   */
  bulkhead?: { name: string; limit: number; retryAfterSeconds: number };
}

/**
 * multipart/form-data 본문을 받는 경로에 단다(올리기, ADR-0257 결정 2·8). 해석기는 바이트를 모으기만 하고(Buffer가 request.body가 된다),
 * 칸 해석은 처리기가 Node 내장 Response.formData()로 한다(새 패키지를 들이지 않는다). 표시하지 않은 경로의 multipart는 그대로 415다.
 * 상한은 이 경로만의 값이고 플랫폼 기본 상한(1MiB)보다 클 수 있다. Content-Length가 상한보다 크면 읽지 않고, 읽다가 넘으면 그 자리에서 멈춘다
 * @throws RangeError 양의 정수가 아님
 */
export function AcceptMultipart(o: AcceptMultipartOptions): MethodDecorator {
  if (!Number.isInteger(o.maxBytes) || o.maxBytes <= 0) throw new RangeError(`multipart 본문 상한은 양의 정수다: ${String(o.maxBytes)}`);
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [MULTIPART_KEY]: { maxBytes: o.maxBytes, tooLarge: o.tooLarge, ...(o.bulkhead ? { bulkhead: o.bulkhead } : {}) } }, fn);
    return descriptor;
  };
}

/** multipart 바이트 모으기(Fastify 기본 rawBody와 같은 차례: 길이 머리 먼저, 읽는 중 상한, 끝에서 길이 대조) */
function collectMultipart(request: FastifyRequest, payload: NodeJS.ReadableStream & { resume(): void }, done: (err: Error | null, body?: unknown) => void): void {
  const config = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
  const opts = config?.[MULTIPART_KEY] as AcceptMultipartOptions | undefined;
  if (!opts) {
    done(unsupportedMediaType(), undefined);
    return;
  }
  const declared = Number(request.headers['content-length']);
  if (declared > opts.maxBytes) {
    done(opts.tooLarge(), undefined);
    return;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  const stop = () => {
    payload.removeListener('data', onData);
    payload.removeListener('end', onEnd);
    payload.removeListener('error', onEnd);
  };
  function onData(chunk: Buffer | string) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    received += b.length;
    if (received > opts!.maxBytes) {
      stop();
      done(opts!.tooLarge(), undefined);
      return;
    }
    chunks.push(b);
  }
  function onEnd(err?: Error) {
    stop();
    if (err) {
      done(Object.assign(err, { statusCode: 400 }), undefined);
      return;
    }
    if (!Number.isNaN(declared) && declared !== received) {
      done(Object.assign(new Error('Content-Length와 본문 길이가 다르다'), { statusCode: 400, code: 'FST_ERR_CTP_INVALID_CONTENT_LENGTH' }), undefined);
      return;
    }
    // 받은 본문은 한 벌만 쥔다: 원시 본문 사본을 따로 남기지 않는다(올리기 경로는 멱등 지문·요청 서명을 쓰지 않는다, ADR-0257 결정 2)
    done(null, Buffer.concat(chunks, received));
  }
  payload.on('data', onData);
  payload.on('end', onEnd);
  payload.on('error', onEnd);
  payload.resume();
}

const BODY_LIMIT_KEY = 'peaketBodyLimit';
/** 표시하지 않은 경로의 본문 상한(Fastify 기본 bodyLimit 1MiB, 서비스가 바꾸지 않는다) */
export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const BULKHEAD_KEY = 'peaketBulkhead';
/** 칸막이 자리를 잡은 요청에 다는 '처리기가 끝났다' 표시 함수 */
const BULKHEAD_DONE = Symbol('peaket.bulkhead.done');

/** 같은 이름의 경로들이 함께 쓰는 동시 처리 칸막이(AcceptMultipartOptions.bulkhead와 같은 뜻, ADR-0257 결정 2) */
export interface RouteBulkhead {
  name: string;
  limit: number;
  retryAfterSeconds: number;
}

/**
 * 그 경로의 본문 상한(바이트). 본문 해석기가 읽기 전에 413으로 막는다(BUILD_ORDER HOT-150 코드 리뷰). 줄이는 데 쓰고, 플랫폼 기본 상한(1MiB)보다 크게 쓰는
 * 경로는 칸막이(bulkhead)를 함께 달아 큰 본문을 동시에 쥐는 수를 묶는다(좌석맵 저장 12MiB, ADR-0260 결정 11). 칸막이는 @AcceptMultipart의 것과 같은
 * 이름이면 같은 자리를 함께 쓰고, 자리는 본문을 읽기 전(onRequest)에 잡는다
 * @throws RangeError 양의 정수가 아님, 기본 상한보다 큰데 칸막이가 없음
 */
export function BodyLimit(bytes: number, o: { bulkhead?: RouteBulkhead } = {}): MethodDecorator {
  if (!Number.isInteger(bytes) || bytes <= 0) throw new RangeError(`본문 상한은 양의 정수다: ${String(bytes)}`);
  if (bytes > DEFAULT_BODY_LIMIT_BYTES && !o.bulkhead) throw new RangeError(`기본 상한(${DEFAULT_BODY_LIMIT_BYTES})보다 큰 본문 상한에는 칸막이를 단다: ${bytes}`);
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [BODY_LIMIT_KEY]: bytes, ...(o.bulkhead ? { [BULKHEAD_KEY]: o.bulkhead } : {}) }, fn);
    return descriptor;
  };
}

/**
 * 경로의 동시 처리 칸막이(HTTP 백프레셔). 본문 상한과 별개로 쓸 수 있고, 같은 이름의 경로가 자리를 함께 쓴다.
 * 자리가 차면 본문을 읽기 전에 429 `server-busy`와 Retry-After로 답한다(ADR-0257 결정 2와 같은 자리 셈).
 * @throws RangeError 이름이 비었거나 limit이 양의 정수가 아니거나 retryAfterSeconds가 0 이상 정수가 아님
 */
export function Bulkhead(o: RouteBulkhead): MethodDecorator {
  if (typeof o.name !== 'string' || o.name.length === 0) throw new RangeError('칸막이 이름은 비지 않은 문자열이다');
  if (!Number.isInteger(o.limit) || o.limit <= 0) throw new RangeError('칸막이 한도는 양의 정수다');
  if (!Number.isInteger(o.retryAfterSeconds) || o.retryAfterSeconds < 0) throw new RangeError('칸막이 Retry-After는 0 이상 정수다');
  return (_target, _key, descriptor) => {
    const fn = descriptor.value as object;
    const prev = (Reflect.getMetadata(FASTIFY_ROUTE_CONFIG_METADATA, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(FASTIFY_ROUTE_CONFIG_METADATA, { ...prev, [BULKHEAD_KEY]: o }, fn);
    return descriptor;
  };
}

function unsupportedMediaType(): Error {
  return Object.assign(new Error('Unsupported Media Type'), { statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE' });
}

/**
 * 요청 검사 설치(결정 4·6). 경로를 붙이기(app.init) 전에 부른다.
 * - 플랫폼 검사기 생성기
 * - @ContractRouteSchema를 단 경로는 검사 결과를 요청에 붙이기만 하고(attachValidation), 인증 가드가 신원을 판정한 뒤 400을 낸다.
 *   Fastify 검사는 Nest 가드보다 먼저 돌아 익명 요청이 401 대신 400을 받았다(검사 규칙을 떠볼 수 있다, 코드 리뷰 2026-11-01)
 * - 본문 해석기: Fastify 기본 text/plain 해석기(문자열을 그대로 넘김)를 지우고, 표시한 경로만 기본 JSON 해석기(원형 오염 키 거부)로
 *   읽는다. application/json 밖의 형식은 해석기가 없어 Fastify가 415로 답한다
 */
export function installRequestChecks(http: FastifyInstance): void {
  http.setValidatorCompiler(platformValidatorCompiler());
  /** 칸막이 이름 → 쓰는 자리 수(이 서비스 인스턴스 안에서만 나눈다) */
  const inUse = new Map<string, number>();
  http.addHook('onRoute', (route) => {
    const config = route.config as Record<string, unknown> | undefined;
    if (config?.[DEFER_VALIDATION_KEY] === true && route.schema) route.attachValidation = true;
    if (typeof config?.[BODY_LIMIT_KEY] === 'number') route.bodyLimit = config[BODY_LIMIT_KEY];
    const bulkhead = (config?.[MULTIPART_KEY] as AcceptMultipartOptions | undefined)?.bulkhead ?? (config?.[BULKHEAD_KEY] as RouteBulkhead | undefined);
    if (bulkhead) {
      const hook = (request: FastifyRequest, reply: { raw: NodeJS.EventEmitter }, done: (err?: Error) => void) => {
        const used = inUse.get(bulkhead.name) ?? 0;
        if (used >= bulkhead.limit) {
          done(new ProblemError({ type: 'server-busy', status: 429, title: '요청이 많아 잠시 처리하지 못했습니다', retryAfterSeconds: bulkhead.retryAfterSeconds }));
          return;
        }
        inUse.set(bulkhead.name, used + 1);
        let released = false;
        let handled = false;
        let closed = false;
        const release = () => {
          if (released) return;
          released = true;
          inUse.set(bulkhead.name, (inUse.get(bulkhead.name) ?? 1) - 1);
        };
        // 응답이 끝나면(finish) 놓는다. 연결이 먼저 끊기면(close) 처리기가 끝난 뒤(응답을 보내기 시작한 때, onSend)에 놓는다:
        // 손님이 끊어도 처리기는 본문을 쥐고 일하고 있으므로 그 자리를 다른 요청에 주지 않는다(ADR-0260 결정 11). 요청 본문의 close는 본문을 다 읽은 때라 쓰지 않는다
        (request as unknown as Record<symbol, () => void>)[BULKHEAD_DONE] = () => {
          handled = true;
          if (closed) release();
        };
        reply.raw.once('finish', release);
        reply.raw.once('close', () => {
          closed = true;
          if (handled) release();
        });
        done();
      };
      const sent = (request: FastifyRequest, _reply: unknown, payload: unknown, done: (err: Error | null, payload?: unknown) => void) => {
        (request as unknown as Record<symbol, (() => void) | undefined>)[BULKHEAD_DONE]?.();
        done(null, payload);
      };
      const prev = route.onRequest;
      route.onRequest = (prev === undefined ? [] : Array.isArray(prev) ? prev : [prev]).concat(hook as never) as typeof route.onRequest;
      const prevSend = route.onSend;
      route.onSend = (prevSend === undefined ? [] : Array.isArray(prevSend) ? prevSend : [prevSend]).concat(sent as never) as typeof route.onSend;
    }
  });
  const json = http.getDefaultJsonParser('error', 'error');
  // 해석기는 바이트로 받아 해석 전 바이트를 남기고(요청 지문·요청 서명, add-idempotency-and-outbox 결정 4), 해석은 기본 JSON 해석기에 맡긴다
  http.removeContentTypeParser(['application/json', 'text/plain']);
  http.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    keepRawBody(request, body as Buffer);
    json(request, (body as Buffer).toString('utf8'), done);
  });
  http.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (request, body, done) => {
    const config = request.routeOptions?.config as unknown as Record<string, unknown> | undefined;
    if (config?.[TEXT_PLAIN_KEY] !== true) {
      done(unsupportedMediaType(), undefined);
      return;
    }
    keepRawBody(request, body as Buffer);
    json(request, (body as Buffer).toString('utf8'), done);
  });
  // multipart는 @AcceptMultipart()를 단 경로만 받는다(그 밖은 415). 해석기가 스트림을 받아 상한을 스스로 센다(Fastify bodyLimit 밖)
  http.addContentTypeParser('multipart/form-data', (request, payload, done) => collectMultipart(request, payload as unknown as NodeJS.ReadableStream & { resume(): void }, done));
}
