// 인증 가드·종료 세션 목록·역할 가드(openspec 변경 add-service-structure-and-request-checks 결정 7·8).
// - 게이트웨이가 토큰을 검증하고 신원을 내부 머리로 넘긴다. 서비스는 토큰을 다시 검증하지 않는다(docs/features/identity.md §3)
// - 끝난 세션은 메모리의 종료 세션 목록(종료 시각 + 15분)으로 거절한다(ASVS v5.0.0-7.4.1)
// - 역할은 토큰에 없다. 처리기마다 허용 역할을 적고(authz-matrix §5.5), 관리 역할은 요청마다 identity GetAdminAuthz로 받는다
//   (소유자 결정 2026-10-31, ADR-0172: 5초 캐시, 위험 작업은 캐시 없이, 답이 없으면 503 authz-unavailable)
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  SetMetadata,
  type Type,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Clock } from './clock.js';
import { requestContext } from './context.js';
import type { HotPathMetrics } from './hot-path.js';
import { ProblemError } from './problem.js';
import { IDEMPOTENT_METADATA, type IdempotentOptions, prepareIdempotency } from './idempotency.js';
import { PURCHASE_REJECTION_PROBLEMS, PURCHASE_SIGNED_METADATA, type PurchaseRejection, type PurchaseSessionPort, verifyPurchaseRequest } from './purchase-auth.js';
import { IDEMPOTENCY_KEY_BY_MODULE, PURCHASE_SIGNATURE_BY_MODULE, throwAttachedValidationError } from './request-checks.js';
import { athOf, DpopRejected, SCANNER_AUTH_METADATA, type ScannerAuthOptions, ScannerAuthState, verifyDpopProof } from './scanner-auth.js';

/** 허용 역할 값(docs/security/authz-matrix.md §5.5 표, openapi x-peaket-roles) */
export const ROLE_VALUES = [
  'public', 'fan', 'partner_admin', 'partner_member', 'viewer', 'operator', 'commander', 'cs_agent', 'cs_lead',
  'scanner_device', 'gate_staff', 'gate_lead',
] as const;
export type RoleValue = (typeof ROLE_VALUES)[number];
export type Audience = 'fan' | 'partner' | 'ops' | 'scanner';

/** 역할이 속한 토큰 대상(게이트웨이). public은 대상이 없다 */
const AUDIENCE_OF: Record<Exclude<RoleValue, 'public'>, Audience> = {
  fan: 'fan',
  partner_admin: 'partner', partner_member: 'partner',
  viewer: 'ops', operator: 'ops', commander: 'ops', cs_agent: 'ops', cs_lead: 'ops',
  scanner_device: 'scanner', gate_staff: 'scanner', gate_lead: 'scanner',
};
const AUDIENCES: readonly string[] = ['fan', 'partner', 'ops', 'scanner'];

export interface RolesOptions {
  /** 함께 있어야 하는 스코프(예: ticket:buy). 하나라도 없으면 403 */
  scopes?: readonly string[];
  /** 위험 작업(재인증 토큰을 받는 작업): 역할 캐시를 쓰지 않고 identity에 다시 묻는다(ADR-0172 결정 2) */
  fresh?: boolean;
  /** 비밀번호 바꾸기 필요 세션(관리 토큰 scope password:change)도 받는 처리기: 비밀번호 바꾸기·로그아웃만(identity §6 BOT-123, auth-controls §3.5) */
  passwordChangeSession?: boolean;
}

export interface RolesPolicy {
  roles: readonly RoleValue[];
  scopes: readonly string[];
  fresh: boolean;
  passwordChangeSession: boolean;
}

/** 비밀번호 바꾸기와 로그아웃만 되는 관리 세션의 스코프(auth-controls §3.5, BOT-123) */
export const PASSWORD_CHANGE_SCOPE = 'password:change';

export const ROLES_METADATA = 'peaket:roles';

/** 처리기(또는 컨트롤러 전체)의 허용 역할. 모든 처리기에 있어야 하고 없으면 서비스가 시작하지 않는다(AZ-T1) */
export function Roles(roles: readonly RoleValue[], options: RolesOptions = {}): MethodDecorator & ClassDecorator {
  if (roles.length === 0) throw new Error('허용 역할 목록이 비었다(공개 작업은 [public])');
  if (new Set(roles).size !== roles.length) throw new Error(`허용 역할에 같은 값이 두 번 있다: ${roles.join(', ')}`);
  const policy: RolesPolicy = { roles: [...roles], scopes: [...(options.scopes ?? [])], fresh: options.fresh === true, passwordChangeSession: options.passwordChangeSession === true };
  return SetMetadata(ROLES_METADATA, policy);
}

/** 판정한 요청자. 계정·세션·pid는 게이트웨이 머리, 역할·테넌트는 요청마다 identity에서 받은 값이다 */
export interface Principal {
  accountId: string;
  sessionId: string;
  aud: Audience;
  scopes: string[];
  pid?: string;
  /** pid 키 전환 기간의 옛 pid */
  pidPrev?: string;
  /** 관리 계정의 지금 역할(팬은 없다). 스캐너는 기기 증명 뒤 CheckScannerSession의 역할이다 */
  role?: string;
  /** 파트너 테넌트(promoter_id). 경로·쿼리·본문의 promoterId가 아니라 이 값만 쓴다(authz-matrix §3.3) */
  tenantId?: string;
  /** 스캐너 기기 증명을 통과한 등록 기기 ID(GAT-170, scanner-auth.ts) */
  deviceId?: string;
  /** 스캐너 세션이 가리키는 회차(GAT-180). 경로 회차와 대조한다 */
  eventId?: string;
}

/** 지금 요청의 요청자(공개 경로나 요청 밖이면 undefined) */
export function currentPrincipal(): Principal | undefined {
  return requestContext()?.principal;
}

/** 처리기 매개변수로 요청자를 받는다 */
export const CurrentPrincipal = createParamDecorator(() => currentPrincipal());

/** 액세스 토큰 수명(15분). 종료 세션은 종료 시각부터 이만큼 둔다(identity §3) */
export const TERMINATED_SESSION_TTL_MS = 15 * 60_000;

/** 메모리 안의 종료 세션 목록. 상한을 두지 않는다(오래된 것을 밀어내면 끝난 세션이 다시 통한다) */
export class TerminatedSessions {
  readonly #until = new Map<string, number>();
  #sweptAt = 0;

  constructor(private readonly clock: Clock) {}

  /** @param terminatedAtMs 종료 시각(사건의 terminatedAt). 없으면 지금 */
  add(sessionId: string, terminatedAtMs?: number): void {
    const now = this.clock.now();
    const until = (terminatedAtMs ?? now) + TERMINATED_SESSION_TTL_MS;
    this.sweep(now);
    if (until <= now) return;
    const prev = this.#until.get(sessionId);
    if (prev === undefined || prev < until) this.#until.set(sessionId, until);
  }

  has(sessionId: string): boolean {
    const until = this.#until.get(sessionId);
    if (until === undefined) return false;
    if (until <= this.clock.now()) {
      this.#until.delete(sessionId);
      return false;
    }
    return true;
  }

  get size(): number {
    return this.#until.size;
  }

  /** 지난 항목을 1분에 한 번 지운다 */
  private sweep(now: number): void {
    if (now - this.#sweptAt < 60_000) return;
    this.#sweptAt = now;
    for (const [sid, until] of this.#until) if (until <= now) this.#until.delete(sid);
  }
}

/** identity GetAdminAuthz의 답(identity.proto AdminAuthzService) */
export interface AdminAuthz {
  /** 그 세션이 그 계정의 살아 있는 관리 세션이고 계정이 로그인할 수 있으면 true. false면 401 */
  valid: boolean;
  role: string;
  /** 파트너만. 관제 계정은 비운다 */
  tenantId?: string;
}

/** identity-svc AdminAuthzService.GetAdminAuthz를 부르는 포트(gRPC 어댑터는 서비스가 넣는다) */
export interface AdminAuthzPort {
  /** opts.timeoutMs는 이 조회에 쓸 수 있는 시간(gRPC 데드라인으로 넘긴다), signal은 그 시간이 지나면 끊긴다 */
  getAdminAuthz(q: { adminAccountId: string; sessionId: string }, opts?: { timeoutMs: number; signal: AbortSignal }): Promise<AdminAuthz>;
}

/** identity 조회의 시간 한도 [가정]. 남은 처리 시간이 더 짧으면 그것을 쓴다. 넘으면 503(코드 리뷰 2026-11-01: 한도가 없어 매달렸다) */
export const ADMIN_AUTHZ_TIMEOUT_MS = 1000;

/** 역할 캐시 시간(ADR-0172 결정 2, [가정]) */
export const ADMIN_AUTHZ_CACHE_MS = 5000;

/** (계정, 세션)마다 5초. valid=false는 넣지 않는다 */
class AdminAuthzCache {
  readonly #bySession = new Map<string, Map<string, { value: AdminAuthz; at: number }>>();

  constructor(private readonly clock: Clock) {}

  get(accountId: string, sessionId: string): AdminAuthz | undefined {
    const e = this.#bySession.get(sessionId)?.get(accountId);
    if (!e) return undefined;
    if (this.clock.now() - e.at >= ADMIN_AUTHZ_CACHE_MS) {
      this.#bySession.get(sessionId)?.delete(accountId);
      return undefined;
    }
    return e.value;
  }

  set(accountId: string, sessionId: string, value: AdminAuthz): void {
    let m = this.#bySession.get(sessionId);
    if (!m) this.#bySession.set(sessionId, (m = new Map()));
    m.set(accountId, { value, at: this.clock.now() });
    if (this.#bySession.size > 10_000) this.sweep();
  }

  deleteSession(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }

  private sweep(): void {
    const now = this.clock.now();
    for (const [sid, m] of this.#bySession) {
      for (const [acc, e] of m) if (now - e.at >= ADMIN_AUTHZ_CACHE_MS) m.delete(acc);
      if (m.size === 0) this.#bySession.delete(sid);
    }
  }
}

/** 판정할 수 없어 닫는다(ADR-0172 결정 4) */
export function authzUnavailable(cause?: unknown): ProblemError {
  return new ProblemError({ type: 'authz-unavailable', status: 503, title: '권한을 확인하지 못했습니다', retryAfterSeconds: 1, cause });
}

/** 서비스 하나의 인증 상태(종료 세션 목록, 역할 캐시, identity 포트) */
export class AuthState {
  readonly terminated: TerminatedSessions;
  readonly #cache: AdminAuthzCache;

  constructor(
    readonly clock: Clock,
    readonly adminAuthz?: AdminAuthzPort,
    /** 관리 역할 처리기가 있는데 adminAuthz가 없으면 시작을 막는다(문서 뽑기에서는 끈다). 구매 세션 포트도 같다 */
    readonly requireAdminAuthz = true,
    /** 구매 요청 인증 훅(@PurchaseSigned)의 구매 세션 포트와 거절을 세는 곳 */
    readonly purchase: { sessions?: PurchaseSessionPort; onRejected?: (reason: PurchaseRejection) => void } = {},
    /** 핫패스 구간 진단(BAT-028). 없으면 계측하지 않는다 */
    readonly hotPath?: HotPathMetrics,
    /** 스캐너 기기 증명·세션 판정 포트(GAT-170). 없으면 스캐너 역할 처리기가 시작하지 않는다 */
    readonly scanner?: ScannerAuthState,
  ) {
    this.terminated = new TerminatedSessions(clock);
    this.#cache = new AdminAuthzCache(clock);
  }

  /** 세션 종료 사건(control.sessions-terminated)을 받았다. 목록에 넣고 그 세션의 역할 캐시를 지운다 */
  terminateSession(e: { sessionId: string; terminatedAt?: string }): void {
    if (!e.sessionId) return;
    const at = e.terminatedAt === undefined ? Number.NaN : Date.parse(e.terminatedAt);
    this.terminated.add(e.sessionId, Number.isFinite(at) ? at : undefined);
    this.#cache.deleteSession(e.sessionId);
  }

  async adminAuthzOf(accountId: string, sessionId: string, fresh: boolean): Promise<AdminAuthz> {
    if (!fresh) {
      const hit = this.#cache.get(accountId, sessionId);
      if (hit) return hit;
    }
    if (!this.adminAuthz) throw authzUnavailable();
    const remaining = requestContext()?.deadline.remainingMs() ?? ADMIN_AUTHZ_TIMEOUT_MS;
    const timeoutMs = Math.max(0, Math.min(ADMIN_AUTHZ_TIMEOUT_MS, remaining));
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`identity 조회가 ${timeoutMs}ms 안에 끝나지 않았다`));
      }, timeoutMs);
    });
    let got: AdminAuthz;
    try {
      got = await Promise.race([this.adminAuthz.getAdminAuthz({ adminAccountId: accountId, sessionId }, { timeoutMs, signal: abort.signal }), expired]);
    } catch (err) {
      throw authzUnavailable(err);
    } finally {
      clearTimeout(timer);
    }
    // 조회 중에 세션이 끝났으면 넣지 않는다
    if (!fresh && got.valid && !this.terminated.has(sessionId)) this.#cache.set(accountId, sessionId, got);
    return got;
  }
}

export const AUTH_STATE = Symbol.for('peaket.platform.authState');

const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 1024 ? v : undefined);

/** 게이트웨이 내부 머리의 신원(x-user-id·x-session-id·x-user-aud는 셋 다 있어야 한다) */
function identityOf(headers: FastifyRequest['headers']): Principal | undefined {
  const accountId = one(headers['x-user-id']);
  const sessionId = one(headers['x-session-id']);
  const aud = one(headers['x-user-aud']);
  if (!accountId || !sessionId || !aud || !AUDIENCES.includes(aud)) return undefined;
  const rawScope = headers['x-user-scope'];
  const scope = one(rawScope);
  // 관리 신원은 스코프 머리가 있는데 읽지 못하면(여럿·1024자 넘음·쉼표) 신원 없음으로 닫는다: 제한 스코프가 빠져 보통 세션처럼 통과하지 않게(새 맥락 리뷰 2026-11-05). 빈 값은 스코프 없음이다
  if ((aud === 'partner' || aud === 'ops') && rawScope !== undefined && (typeof rawScope !== 'string' || rawScope.length > 1024 || rawScope.includes(','))) return undefined;
  const p: Principal = { accountId, sessionId, aud: aud as Audience, scopes: (scope ?? '').split(/\s+/).filter(Boolean) };
  const pid = one(headers['x-user-pid']);
  const pidPrev = one(headers['x-user-pid-prev']);
  if (pid) p.pid = pid;
  if (pidPrev) p.pidPrev = pidPrev;
  return p;
}

/** 쿠키 경로의 challenge(docs/api/guidelines.md §12) */
export const COOKIE_CHALLENGE = 'Cookie realm="peaket"';

/** 모든 요청에 거는 가드(전역). 순서: 공개 → 신원 → 종료 세션 → 대상 → 스코프 → 관리 역할(세션 판정 → 비밀번호 바꾸기 필요 세션 → 역할) → 멱등 키 → 구매 세션 요청 서명 → 경로 스키마 검사 실패 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_STATE) private readonly state: AuthState,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const done = this.state.hotPath?.start('http.auth');
    try {
    const policy = this.reflector.getAllAndOverride<RolesPolicy | undefined>(ROLES_METADATA, [ctx.getHandler(), ctx.getClass()]);
    // 시작 때 모든 처리기를 확인하므로 여기 오지 않는다. 와도 닫는다
    if (!policy) throw new ForbiddenException();
    const http = ctx.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const unauthorized = () => {
      void http.getResponse<FastifyReply>().header('www-authenticate', COOKIE_CHALLENGE);
      return new UnauthorizedException();
    };
    const roles = policy.roles.filter((r) => r !== 'public') as Exclude<RoleValue, 'public'>[];
    const identity = identityOf(request.headers);
    // 공개 작업: 공개만 허용하면 신원 머리를 보지 않고, 세션이 있으면 더 보이는 작업([public, fan])은 신원이 없을 때만 익명으로 통과
    if (policy.roles.includes('public') && (roles.length === 0 || !identity)) {
      throwAttachedValidationError(request);
      return true;
    }
    if (!identity) throw unauthorized();
    if (this.state.terminated.has(identity.sessionId)) throw unauthorized();
    if (!roles.some((r) => AUDIENCE_OF[r] === identity.aud)) throw unauthorized();
    for (const s of policy.scopes) if (!identity.scopes.includes(s)) throw new ForbiddenException();

    let principal = identity;
    if (identity.aud === 'partner' || identity.aud === 'ops') {
      const authz = await this.state.adminAuthzOf(identity.accountId, identity.sessionId, policy.fresh);
      if (!authz.valid) throw unauthorized();
      // 비밀번호 바꾸기 필요 세션은 연 처리기(비밀번호 바꾸기·로그아웃)만(auth-controls §3.5, AC-T4). 끝난 세션이면 위에서 먼저 401이다
      if (identity.scopes.includes(PASSWORD_CHANGE_SCOPE) && !policy.passwordChangeSession) {
        throw new ProblemError({ type: 'password-change-required', status: 403, title: '비밀번호를 먼저 바꿔 주세요' });
      }
      const role = authz.role as RoleValue;
      if (!roles.includes(role as Exclude<RoleValue, 'public'>) || AUDIENCE_OF[role as Exclude<RoleValue, 'public'>] !== identity.aud) {
        throw new ForbiddenException();
      }
      principal = { ...identity, role: authz.role };
      if (authz.tenantId) principal.tenantId = authz.tenantId;
    }
    const rc = requestContext();
    if (rc) {
      rc.principal = principal;
      rc.log.identify({ pid: principal.pid, sessionId: principal.sessionId, accountId: principal.accountId });
    }
    // 멱등 키는 신원 판정 뒤, 모양 검사 실패보다 먼저 본다(두 검사 길의 순서가 같다, add-idempotency-and-outbox 결정 1)
    const idempotent = this.reflector.get<IdempotentOptions | undefined>(IDEMPOTENT_METADATA, ctx.getHandler());
    if (idempotent) prepareIdempotency(request, idempotent, principal.accountId);
    // 구매 세션 요청 서명은 형식만 보는 멱등 키 뒤, 모양 검사보다 먼저 본다. 틀리면 401이고 일련번호를 올리지 않는다
    // (openspec 변경 add-breakers-purchase-auth-and-grpc-channel 결정 6·7)
    if (this.reflector.get<boolean | undefined>(PURCHASE_SIGNED_METADATA, ctx.getHandler()) === true) {
      const port = this.state.purchase.sessions;
      // 시작 확인이 막으므로 오지 않는다. 와도 닫는다
      if (!port) throw unauthorized();
      const rejected = await verifyPurchaseRequest(request, principal, port);
      if (rejected) {
        this.state.purchase.onRejected?.(rejected);
        // 이유별 이름 붙은 401(BAS-040). 신원 401과 같은 WWW-Authenticate를 싣는다(RFC 9110 §15.5.2)
        void http.getResponse<FastifyReply>().header('www-authenticate', COOKIE_CHALLENGE);
        throw new ProblemError({ ...PURCHASE_REJECTION_PROBLEMS[rejected] });
      }
    }
    throwAttachedValidationError(request);
    return true;
    } finally {
      done?.();
    }
  }
}

const singleHeader = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined);

const scannerUnauthorized = (reply: FastifyReply, error: 'invalid_token' | 'invalid_dpop_proof'): UnauthorizedException => {
  void reply.header('www-authenticate', `DPoP error="${error}"`);
  return new UnauthorizedException();
};

/** DPoP 증명의 htu와 견줄 절대 주소. 게이트웨이가 넘긴 출처 머리를 먼저 쓴다(offline-gate §6.1) */
function requestUrlOf(request: FastifyRequest): string {
  const proto = singleHeader(request.headers['x-forwarded-proto']) ?? request.protocol;
  const host = singleHeader(request.headers['x-forwarded-host']) ?? singleHeader(request.headers.host);
  if (!host) throw new Error('요청 Host가 없다(DPoP htu를 만들 수 없다)');
  const path = request.url.split(/[?#]/)[0];
  return `${proto}://${host}${path}`;
}

/**
 * 스캐너 경로의 기기 증명·세션 판정(GAT-170, offline-gate §6.1). AuthGuard가 스태프 토큰의 신원을 판정한 뒤에 돈다.
 * - `@ScannerAuth()`가 없는 처리기는 그대로 통과한다.
 * - 증명·기기·세션이 하나라도 틀리면 401/403이고, 판정에 닿지 못하면 503이다.
 * - 통과하면 principal의 role·deviceId·tenantId와 요청 맥락의 scannerDevice를 채운다.
 */
@Injectable()
export class ScannerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_STATE) private readonly state: AuthState,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const options = this.reflector.getAllAndOverride<ScannerAuthOptions | undefined>(SCANNER_AUTH_METADATA, [ctx.getHandler(), ctx.getClass()]);
    if (!options) return true;
    const scanner = this.state.scanner;
    // 시작 확인이 막으므로 오지 않는다. 와도 닫는다
    if (!scanner) throw new Error('스캐너 인증 포트가 없다(createService의 scanner)');
    const http = ctx.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const principal = requestContext()?.principal;
    if (!principal || principal.aud !== 'scanner') throw scannerUnauthorized(reply, 'invalid_token');

    const proof = singleHeader(request.headers.dpop);
    if (!proof) throw scannerUnauthorized(reply, 'invalid_dpop_proof');
    const authorization = singleHeader(request.headers.authorization);
    // \s+와 (.+)가 공백에서 겹치면 긴 공백 머리에서 되짚기가 늘어난다(CodeQL js/polynomial-redos).
    // DPoP 접근 토큰은 공백 없는 한 토큰이므로 \S+로 못 박는다.
    const token = /^DPoP[ \t]+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw scannerUnauthorized(reply, 'invalid_token');
    const expectedJkt = singleHeader(request.headers['x-user-jkt']);
    if (!expectedJkt) throw scannerUnauthorized(reply, 'invalid_token');
    const forwardedAth = singleHeader(request.headers['x-user-ath']);
    const computedAth = athOf(token);
    if (forwardedAth !== undefined && forwardedAth !== computedAth) throw scannerUnauthorized(reply, 'invalid_token');

    let verified: { jkt: string; jti: string };
    try {
      verified = await verifyDpopProof({
        proof,
        method: request.method,
        url: requestUrlOf(request),
        accessToken: token,
        expectedAth: forwardedAth ?? computedAth,
        expectedJkt,
        clock: this.state.clock,
        replay: scanner.wiring.replay,
      });
    } catch (e) {
      if (e instanceof DpopRejected) throw scannerUnauthorized(reply, 'invalid_dpop_proof');
      throw e;
    }

    const device = await scanner.deviceByThumbprint(verified.jkt);
    if (!device) throw new ProblemError({ type: 'device-unregistered', status: 403, title: '등록되지 않은 스캐너 기기입니다' });
    if (device.status !== 'ACTIVE') throw new ProblemError({ type: 'device-revoked', status: 403, title: '폐기된 스캐너 기기입니다' });

    const session = await scanner.sessionOf(principal.sessionId, device.deviceId);
    if (!session.valid || !session.role) throw scannerUnauthorized(reply, 'invalid_token');
    const policy = this.reflector.getAllAndOverride<RolesPolicy | undefined>(ROLES_METADATA, [ctx.getHandler(), ctx.getClass()]);
    if (policy && !policy.roles.includes(session.role)) throw new ForbiddenException();

    principal.role = session.role;
    principal.deviceId = device.deviceId;
    principal.tenantId = device.promoterId;
    if (session.eventId) principal.eventId = session.eventId;
    const rc = requestContext();
    if (rc) rc.scannerDevice = { deviceId: device.deviceId, jkt: verified.jkt, ...(session.eventId ? { eventId: session.eventId } : {}) };
    return true;
  }
}

/** 시작 때 모든 처리기의 허용 역할을 확인한다(AZ-T1). 하나라도 틀리면 앱 초기화가 실패한다 */
@Injectable()
export class RolesCheck implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    @Inject(AUTH_STATE) private readonly state: AuthState,
  ) {}

  onApplicationBootstrap(): void {
    const problems: string[] = [];
    for (const wrapper of this.discovery.getControllers()) {
      const metatype = wrapper.metatype as Type<unknown> | undefined;
      if (!metatype?.prototype) continue;
      const classPolicy = Reflect.getMetadata(ROLES_METADATA, metatype) as RolesPolicy | undefined;
      for (const name of this.scanner.getAllMethodNames(metatype.prototype)) {
        const fn = (metatype.prototype as Record<string, unknown>)[name] as object;
        if (Reflect.getMetadata(PATH_METADATA, fn) === undefined || Reflect.getMetadata(METHOD_METADATA, fn) === undefined) continue;
        const where = `${metatype.name}.${name}`;
        const policy = (Reflect.getMetadata(ROLES_METADATA, fn) as RolesPolicy | undefined) ?? classPolicy;
        if (!policy) {
          problems.push(`${where}: 허용 역할(@Roles)이 없다`);
          continue;
        }
        const scannerAuth = (Reflect.getMetadata(SCANNER_AUTH_METADATA, fn) as ScannerAuthOptions | undefined) ?? (Reflect.getMetadata(SCANNER_AUTH_METADATA, metatype) as ScannerAuthOptions | undefined);
        for (const r of policy.roles) {
          if (!(ROLE_VALUES as readonly string[]).includes(r)) problems.push(`${where}: 표에 없는 역할 값 ${r}`);
          else if (AUDIENCE_OF[r as Exclude<RoleValue, 'public'>] === 'scanner' && !this.state.scanner) {
            problems.push(`${where}: 현장 스태프·기기 역할 ${r}은 기기 증명과 함께 판정한다(createService의 scanner 포트가 없다)`);
          }
        }
        if (policy.roles.some((r) => AUDIENCE_OF[r as Exclude<RoleValue, 'public'>] === 'scanner') && !scannerAuth) {
          problems.push(`${where}: 현장 스태프 역할을 단 처리기에는 @ScannerAuth()가 있어야 한다`);
        }
        if (scannerAuth && !this.state.scanner) {
          problems.push(`${where}: @ScannerAuth()의 기기·세션 포트가 없다(createService의 scanner)`);
        }
        if (Reflect.getMetadata(IDEMPOTENCY_KEY_BY_MODULE, fn) === true && Reflect.getMetadata(IDEMPOTENT_METADATA, fn) === undefined) {
          problems.push(`${where}: 계약이 Idempotency-Key를 요구하는데 @Idempotent가 없다(머리 스키마는 이 키를 보지 않는다, guidelines §4)`);
        }
        const purchaseSigned = Reflect.getMetadata(PURCHASE_SIGNED_METADATA, fn) === true;
        if (Reflect.getMetadata(PURCHASE_SIGNATURE_BY_MODULE, fn) === true && !purchaseSigned) {
          problems.push(`${where}: 계약이 X-Purchase-Seq·X-Purchase-Mac을 요구하는데 @PurchaseSigned()가 없다(머리 스키마는 이 둘을 보지 않는다, ADR-0050 결정 8)`);
        }
        if (purchaseSigned && policy.roles.includes('public')) {
          problems.push(`${where}: 공개 역할을 허용한 처리기에는 @PurchaseSigned()를 달 수 없다(구매 세션은 팬 신원에 묶인다)`);
        }
        if (purchaseSigned && !this.state.purchase.sessions && this.state.requireAdminAuthz) {
          problems.push(`${where}: @PurchaseSigned()의 구매 세션 포트(createService의 purchaseSessions)가 없다`);
        }
        if (Reflect.getMetadata(IDEMPOTENT_METADATA, fn) !== undefined && policy.roles.includes('public')) {
          problems.push(`${where}: 공개 역할을 허용한 처리기에는 @Idempotent를 달 수 없다(멱등 범위에 계정이 필요하다, guidelines §4)`);
        }
        const admin = policy.roles.some((r) => AUDIENCE_OF[r as Exclude<RoleValue, 'public'>] === 'partner' || AUDIENCE_OF[r as Exclude<RoleValue, 'public'>] === 'ops');
        if (admin && !this.state.adminAuthz && this.state.requireAdminAuthz) {
          problems.push(`${where}: 관리 역할을 판정할 identity 조회(createService의 adminAuthz)가 없다`);
        }
      }
    }
    if (problems.length) throw new Error(`허용 역할 확인 실패(AZ-T1):\n- ${problems.join('\n- ')}`);
  }
}
