// 서비스 로거(Pino, docs/observability.md §2·§7, openspec 변경 add-service-logging 결정 2·4·5).
// - 표준 출력에 JSON 한 줄. 시각은 주입한 시계의 KST 오프셋 ISO 8601(ASVS v5.0.0-16.2.2).
// - 요청 안이면 traceId·spanId를 자동으로 넣는다.
// - 가림 규칙(2단계 마스킹의 1차): 연락처·인증값·결제 값·원문 식별값 칸.
import { hostname } from 'node:os';
import type { LoggerService, LogLevel as NestLogLevel } from '@nestjs/common';
import { pino, type DestinationStream, type Logger } from 'pino';
import type { Clock } from './clock.js';
import type { LogLevelName } from './config.js';
import { requestContext } from './context.js';

export type PlatformLogger = Logger;
/** 서비스 로거를 주입받는 토큰(@Inject(PLATFORM_LOGGER)) */
export const PLATFORM_LOGGER = Symbol.for('peaket.platform.logger');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** 2026-11-01T14:03:05.120+09:00 */
export function kstIso(epochMs: number): string {
  return `${new Date(epochMs + KST_OFFSET_MS).toISOString().slice(0, -1)}+09:00`;
}

/** 가리는 칸 이름(observability §7 '개인정보 2단계 마스킹 통제'의 1차와 원문 식별값) */
export const REDACTED_KEYS = [
  // 이름·연락처·주소·연계정보
  'fullName', 'realName', 'holderName', 'buyerName', 'customerName', 'recipientName', 'accountHolder',
  'email', 'phone', 'phoneNumber', 'mobile', 'address', 'addressLine1', 'addressLine2', 'ci', 'di',
  // 인증 값
  'password', 'secret', 'token', 'accessToken', 'refreshToken', 'idToken', 'authorization', 'cookie', 'set-cookie',
  // 관리 계정 로그인·해제의 1회용 값(identity §6, BOT-120·121): 1단계 통과 토큰, 해제 링크 토큰, 새·지금 비밀번호, 사람 확인 토큰.
  // 인증 앱·복구 코드 칸(code)은 다른 서비스가 오류 코드를 같은 이름으로 남겨 넣지 않는다(요청 본문은 로그에 남기지 않는다)
  'loginStep', 'unlockToken', 'currentPassword', 'newPassword', 'humanCheckToken',
  // 결제 값(paymentKey는 아래에서 뒤 4자만 남긴다)
  'paymentKey', 'paymentToken', 'cardNumber', 'refundAccount', 'refundAccountNumber', 'bankAccount', 'accountNumber',
  'virtualAccount', 'virtualAccountNumber',
  // 입장권 QR 서명
  'qrSignature', 'ticketSignature',
  // 원문 식별값(가명은 requestLog().identify로만 넣는다, ADR-0053 결정 1)
  'pid', 'sid', 'sessionId', 'accountId', 'ip', 'clientIp',
] as const;

const REDACTED = new Set<string>(REDACTED_KEYS.map((k) => k.toLowerCase()));
/** 이보다 깊은 값은 들여다보지 못하므로 통째로 뺀다 */
const MAX_DEPTH = 8;

const censor = (key: string, value: unknown): string =>
  key.toLowerCase() === 'paymentkey' && typeof value === 'string' && value.length > 8 ? `****${value.slice(-4)}` : '[REDACTED]';

/** JSON으로 그대로 나가는 값(들여다볼 칸이 없다) */
const isLeaf = (v: unknown): boolean =>
  v === null || typeof v !== 'object' || v instanceof Date || v instanceof RegExp || ArrayBuffer.isView(v) || v instanceof ArrayBuffer;

/**
 * 가리는 칸 이름을 대소문자와 깊이에 관계없이 가린 사본(원래 객체는 바꾸지 않는다).
 * Pino redact는 대소문자를 가리고 깊이를 경로로 정해야 해서(Authorization·깊은 email이 남았다, 코드 리뷰 2026-11-01) 쓰지 않는다.
 * 클래스 객체(DTO 등)도 JSON에 나가는 자기 칸을 본다. toJSON이 있으면 그 결과를 본다(다시 본 리뷰, 2026-11-01).
 * Error는 어디에 있든 이름·메시지·스택만 남긴다(아래 walk)
 */
export function redactDeep(value: unknown): unknown {
  return walk(value, 0, new Set<object>(), { left: MAX_NODES });
}

/** 한 번 기록할 때 들여다보는 값의 상한. 넘으면 나머지는 통째로 뺀다(큰 객체 하나로 이벤트 루프가 멈추지 않게) */
const MAX_NODES = 5_000;

/**
 * - Error는 어디에 있든 {type, message, stack}만 남긴다. 그 밖의 칸(HTTP 클라이언트 오류의 config.headers 등)은 내보내지 않는다
 * - 지나온 객체를 다시 만나면 '[Circular]'(세 번째 리뷰, 2026-11-01: 순환 객체 하나가 수십 MB 줄이 됐다)
 */
function walk(value: unknown, depth: number, ancestors: Set<object>, budget: { left: number }): unknown {
  if (isLeaf(value)) return value;
  const obj = value as object;
  if (ancestors.has(obj)) return '[Circular]';
  if (depth > MAX_DEPTH || --budget.left < 0) return '[TRUNCATED]';
  if (obj instanceof Error) return { type: obj.name, message: obj.message, stack: obj.stack };
  ancestors.add(obj);
  try {
    const json = (obj as { toJSON?: unknown }).toJSON;
    let target: object = obj;
    if (typeof json === 'function') {
      const r = (json as () => unknown).call(obj);
      // toJSON이 자기 자신을 돌려주면 그 칸을 그대로 펼친다(순환으로 보면 내용이 통째로 빠진다, 네 번째 리뷰 2026-11-01)
      if (r !== obj) return walk(r, depth + 1, ancestors, budget);
      target = r as object;
    }
    if (Array.isArray(target)) return target.map((x) => walk(x, depth + 1, ancestors, budget));
    // Map·Set은 JSON에서 빈 객체가 되어 값이 나가지 않는다
    if (target instanceof Map || target instanceof Set) return {};
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(target as Record<string, unknown>)) {
      out[k] = REDACTED.has(k.toLowerCase()) ? censor(k, v) : walk(v, depth + 1, ancestors, budget);
    }
    return out;
  } finally {
    ancestors.delete(obj);
  }
}

export interface PlatformLoggerOptions {
  service: string;
  env: string;
  version: string;
  az?: string;
  pod?: string;
  clock: Clock;
  level: LogLevelName;
  /** 기본 표준 출력 */
  destination?: DestinationStream | NodeJS.WritableStream;
}

export function createPlatformLogger(o: PlatformLoggerOptions): PlatformLogger {
  const base: Record<string, string> = { service: o.service, env: o.env, version: o.version };
  if (o.az) base.az = o.az;
  base.pod = o.pod || hostname();
  // 기본 목적지는 Pino 기본값(표준 출력, 동기 쓰기)이다. 죽기 직전의 오류 줄을 잃지 않게 비동기 쓰기는 쓰지 않는다
  const root = pino(
    {
      level: o.level,
      base,
      messageKey: 'msg',
      timestamp: () => `,"ts":"${kstIso(o.clock.now())}"`,
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => redactDeep(obj) as Record<string, unknown>,
      },
      // Pino 기본 err 직렬화는 객체의 type을 생성자 이름으로 덮는다. 정규 로그 줄의 err({type, message, stack})는 그대로 두고,
      // Error 객체만 같은 모양으로 바꾼다
      serializers: { err: (e: unknown) => (e instanceof Error ? { type: e.name, message: e.message, stack: e.stack } : e) },
      mixin: () => {
        const ctx = requestContext();
        if (!ctx) return {};
        return ctx.spanId ? { traceId: ctx.traceId, spanId: ctx.spanId } : { traceId: ctx.traceId };
      },
    },
    (o.destination ?? pino.destination({ dest: 1, sync: true })) as DestinationStream,
  );
  // Pino는 child()로 붙인 값에 log 형식기를 걸지 않는다(resetChildingsFormatter). 붙이기 전에 가린다.
  // 자식은 Object.create(부모)라 이 child를 물려받아 손주도 같다(다시 본 리뷰, 2026-11-01)
  const protoChild = root.child;
  root.child = function child(this: Logger, bindings: Record<string, unknown>, options?: Parameters<Logger['child']>[1]) {
    return protoChild.call(this, redactDeep(bindings) as Record<string, unknown>, options);
  } as Logger['child'];
  return root;
}

/** NestJS 자체 기록을 서비스 로거로 보낸다(JSON 한 줄, 같은 바탕 필드) */
export class NestPinoLogger implements LoggerService {
  /** @param levels 내보낼 NestJS 수준(없으면 모두) */
  constructor(
    private readonly logger: PlatformLogger,
    private readonly levels?: readonly NestLogLevel[],
  ) {}

  private write(level: 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'fatal', message: unknown, rest: unknown[]) {
    const nestLevel: NestLogLevel = level === 'info' ? 'log' : level === 'trace' ? 'verbose' : level;
    if (this.levels && !this.levels.includes(nestLevel)) return;
    const context = typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    const fields: Record<string, unknown> = {};
    if (context) fields.context = context;
    if (level === 'error' && rest.length > 1 && typeof rest[0] === 'string') fields.stack = rest[0];
    if (message instanceof Error) this.logger[level]({ ...fields, err: { type: message.name, message: message.message, stack: message.stack } }, message.message);
    else if (typeof message === 'string') this.logger[level](fields, message);
    else this.logger[level]({ ...fields, value: message }, 'nest');
  }

  log(message: unknown, ...rest: unknown[]) {
    this.write('info', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.write('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.write('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.write('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.write('trace', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.write('fatal', message, rest);
  }
}
