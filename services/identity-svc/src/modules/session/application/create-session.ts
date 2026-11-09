// CreateSession(docs/features/identity.md §2, I-T50 ①②, ADR-0011·0119): 소셜 로그인 뒤 PEAKET 세션을 만든다.
// - 같은 멱등 키가 10분 안에 다시 오면 새 세션을 만들지 않고, 같은 세션에 토큰을 다시 주며 앞서 준 리프레시 토큰은 쓸 수 없게 한다
// - 같은 키에 다른 (제공자, provider_user_id)가 오면 ALREADY_EXISTS
// - (제공자, sub) 계정이 없으면: 검증 이메일이 같은 활성 계정이 정확히 하나면 연결 제안, 아니면 새 계정(identity §2.1 '가입 때 연결 제안의 첫 구현', BOT-040)
// - 연결 제안을 따라 온 로그인은 제안의 대상 계정일 때만 새 제공자를 잇고 세션을 만든다. 아니면 실패 횟수를 올린다(I-T30)
// 기기 한도를 넘으면 오래 쉰 기기의 세션을 끝낸다
// - 세션에는 User-Agent에서 뽑은 화면용 기기 이름만 둔다(원문은 두지 않는다, ADR-0209 결정 1). 연결 제안으로 새 수단을 이으면 그 로그인 세션 말고 대상 계정의 세션을 끝낸다(ASVS 7.4.3)
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import { deviceLabelOf } from './device-label.js';
import { contactEmail } from '../domain/inv-ref.js';
import {
  ACCOUNT_CLAIMS,
  type AccountClaims,
  DEVICE_REFS,
  type DeviceRefs,
  LINK_PROPOSALS,
  type LinkProposals,
  LinkStoreUnavailable,
  SESSION_SIGNALS,
  INV_REFS,
  type InvRefs,
  SESSION_STORE,
  type SessionSignals,
  type SessionStore,
  type SessionTx,
  type StoredLinkProposal,
  TOKEN_SIGNER,
  type TokenSigner,
  LOGIN_RISK,
  type LoginRisk,
} from '../domain/ports.js';
import {
  LINK_MAX_ATTEMPTS,
  LINK_PROPOSAL_TTL_MS,
  normalizeEmail,
  type Provider,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sessionAlive,
  sessionsOverDeviceLimit,
} from '../domain/session.js';
import { SessionError } from './session-error.js';

export interface CreateSessionInput {
  idempotencyKey: string;
  provider: Provider;
  providerUserId: string;
  email: string | null;
  /** 제공자가 준 이메일 검증 여부(네이버는 늘 false). 없으면 false */
  emailVerified?: boolean;
  deviceId: string | null;
  /** 앱 서버가 받은 User-Agent(512자까지). 화면용 기기 이름만 뽑아 세션에 두고 원문은 저장하지 않는다(ADR-0209 결정 1). 로그인 판정에도 넘긴다 */
  userAgent?: string | null;
  /** 앱 서버가 받은 IP(믿을 수 있는 끝단 머리가 정해지기 전에는 비어 있다, BUILD_ORDER HOT-400). 로그인 판정에만 넘긴다 */
  clientIp?: string;
  /** CloudFront-Viewer-ASN. 앱 서버가 원본 확인 헤더가 맞는 요청에서만 읽고 없으면 0이다(identity.proto) */
  asn?: number;
  /** 연결 제안을 따라 다시 로그인할 때만(identity §2.1) */
  link?: { proposalId: string; binding: string };
}

export interface SessionTokens {
  accountId: string;
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
}

export interface CreateSessionResult extends SessionTokens {
  newAccount: boolean;
  /** 같은 멱등 키의 다시 보내기였다 */
  replayed: boolean;
}

/** 로그인 결과: 세션, 연결 제안, 연결 제안을 따라 왔지만 대상 계정이 아님 */
export type LoginOutcome =
  | ({ kind: 'session'; linkedProvider: Provider | null } & CreateSessionResult)
  | { kind: 'link-proposed'; proposalId: string; binding: string }
  | { kind: 'link-mismatch'; attemptsLeft: number };

const KEY = /^[A-Za-z0-9_-]{16,128}$/;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{22}$/;
const BINDING = /^[A-Za-z0-9_-]{43}$/;
/** 로그인 트랜잭션을 처음부터 다시 하는 최대 횟수(병합 두 번이 겹치는 일은 드물어 세 번까지) */
const MAX_LOGIN_MOVES = 3;

/** 계정을 잠근 뒤 그 수단이 다른 계정으로 옮겨진 것을 봤다(트랜잭션을 되돌려 다시 한다, 밖으로 나가지 않는다) */
class AccountMoved extends Error {
  constructor() {
    super('잠근 뒤 로그인 수단이 다른 계정으로 옮겨졌다');
    this.name = 'AccountMoved';
  }
}

/** 리프레시 토큰: 256비트 난수(asvs/auth.md 7.2.3). identity에는 SHA-256만 둔다 */
export function newRefreshToken(): { token: string; hash: Uint8Array } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: refreshHash(token) };
}

export const refreshHash = (token: string): Uint8Array => createHash('sha256').update(token, 'utf8').digest();

/** 브라우저 묶음 값의 해시(base64url). 저장소에는 이것만 둔다 */
export const bindingHashOf = (binding: string): string => createHash('sha256').update(binding, 'utf8').digest('base64url');

/** 묶음 값이 제안과 맞는지(시간 일정 비교). 모양이 틀리면 false */
export function bindingMatches(p: StoredLinkProposal, binding: string): boolean {
  if (!BINDING.test(binding)) return false;
  const a = Buffer.from(bindingHashOf(binding));
  const b = Buffer.from(p.bindingHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 제안 ID 모양이 맞을 때만 저장소를 본다(아무 값이나 키로 보내지 않게) */
export const proposalIdOk = (id: string): boolean => PROPOSAL_ID.test(id);

function check(i: CreateSessionInput): void {
  if (!KEY.test(i.idempotencyKey)) throw new SessionError('INVALID_ARGUMENT', 'idempotency_key는 16~128자 base64url이다');
  if (!i.providerUserId || i.providerUserId.length > 255) throw new SessionError('INVALID_ARGUMENT', 'provider_user_id가 없거나 255자를 넘는다');
  if (i.email !== null && i.email.length > 320) throw new SessionError('INVALID_ARGUMENT', 'email이 320자를 넘는다');
  if (i.deviceId !== null && i.deviceId.length > 128) throw new SessionError('INVALID_ARGUMENT', 'device_id가 128자를 넘는다');
}

/** 종료 때 로그인 판정을 기다리는 시간 상한 [가정] */
export const DRAIN_TIMEOUT_MS = 5_000;

/** 트랜잭션이 돌려주는 세션 자리(토큰 서명은 트랜잭션 밖에서 한다) */
interface Opened {
  accountId: string;
  sessionId: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  newAccount: boolean;
  replayed: boolean;
  ended: string[];
  /** ended를 끝낸 까닭: 기기 한도, 또는 연결 제안으로 새 수단을 이어 다른 세션을 모두 끝냄 */
  endedReason: 'DEVICE_LIMIT' | 'LOGIN_METHOD_CHANGED';
}

@Injectable()
export class CreateSession {
  /** 응답 뒤에서 도는 로그인 판정(세션 커밋 뒤라 파드가 죽어도 UNKNOWN으로 남는다) */
  readonly #judging = new Set<Promise<void>>();

  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(DEVICE_REFS) private readonly devices: DeviceRefs,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
    @Inject(ACCOUNT_CLAIMS) private readonly claims: AccountClaims,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 가입 때 연결 제안(없으면 제안하지 않는다: 시험) */
    @Optional() @Inject(LINK_PROPOSALS) private readonly links?: LinkProposals,
    /** 조사용 연락처 가명(없으면 쓰지 않는다: 시험, identity §9.1 '조사용 값의 첫 구현') */
    @Optional() @Inject(INV_REFS) private readonly invRefs?: InvRefs,
    /** 로그인 판정(없으면 UNKNOWN, identity §7) */
    @Optional() @Inject(LOGIN_RISK) private readonly loginRisk?: LoginRisk,
  ) {}

  /** 새 계정의 로그인 이메일로 EMAIL 연락처 가명 행을 쓴다. 라벨 키가 없으면 쓰지 않는다(정비 contact-ref-backfill이 나중에 채운다) */
  async #emailRef(tx: SessionTx, accountId: string, raw: string | null | undefined, now: number): Promise<void> {
    const email = contactEmail(raw);
    const ref = email === null ? undefined : this.invRefs?.ref('contact', email);
    // 키 회전의 이음 기간이면 옛 판 값도 둔다(조사 적재가 회전 전 기록과 잇는다, BOT-046)
    if (ref) await tx.setContactRef({ accountId, kind: 'EMAIL', ref, refPrev: (email !== null && this.invRefs?.prevRef?.('contact', email)) || null, now });
  }

  /**
   * 응답과 떼어 뒤에서 도는 로그인 판정이 끝나기를 기다린다(종료와 시험, identity §7). 시간 상한을 넘으면 기다리지 않고 false다
   * (끝나지 않은 판정의 세션은 UNKNOWN으로 남는다)
   */
  async drain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((res) => {
      timer = setTimeout(() => res(false), timeoutMs);
    });
    const done = (async () => {
      while (this.#judging.size > 0) await Promise.all(this.#judging);
      return true as const;
    })();
    try {
      return await Promise.race([done, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 세션만 받는 쪽(시험·옛 호출): 연결 제안이나 불일치면 FAILED_PRECONDITION */
  async run(i: CreateSessionInput): Promise<CreateSessionResult> {
    const o = await this.outcome(i);
    if (o.kind !== 'session') throw new SessionError('FAILED_PRECONDITION', `세션 대신 ${o.kind}`);
    const { kind: _k, linkedProvider: _l, ...s } = o;
    return s;
  }

  /** 로그인 하나의 결과(gRPC CreateSession) */
  async outcome(i: CreateSessionInput): Promise<LoginOutcome> {
    check(i);
    if (i.link) return this.#viaLink(i, i.link);
    return this.#login(i, true);
  }

  /** 연결하지 않고 새 계정 만들기(SeparateAccount)가 부른다: 제안을 다시 만들지 않는다 */
  async withoutProposal(i: CreateSessionInput): Promise<CreateSessionResult> {
    check(i);
    const o = await this.#login({ ...i, link: undefined }, false);
    if (o.kind !== 'session') throw new SessionError('FAILED_PRECONDITION', `세션 대신 ${o.kind}`);
    const { kind: _k, linkedProvider: _l, ...s } = o;
    return s;
  }

  /**
   * 로그인 트랜잭션. 계정을 잠근 뒤 그 수단이 다른 계정으로 옮겨진 것을 보면(#open의 AccountMoved) 되돌려 잠금을 모두 놓고 처음부터 다시 한다.
   * 잡은 계정을 쥔 채 옮겨 간 계정을 잠그면 ID 순 규칙(병합 확정)을 벗어나 같은 쌍의 확정과 교착(40P01)한다(BOT-042가 넘긴 것). 세 번 넘게 옮겨지면 UNAVAILABLE
   */
  async #moveSafe<T>(fn: (tx: SessionTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.store.transaction(fn);
      } catch (e) {
        if (!(e instanceof AccountMoved)) throw e;
        if (attempt >= MAX_LOGIN_MOVES) throw new SessionError('UNAVAILABLE', '로그인하는 동안 로그인 수단이 계속 옮겨졌다');
      }
    }
  }

  async #login(i: CreateSessionInput, propose: boolean): Promise<LoginOutcome> {
    const now = this.clock.now();
    const refresh = newRefreshToken();
    const r = await this.#moveSafe(async (tx): Promise<Opened | { proposal: Omit<StoredLinkProposal, 'id' | 'bindingHash'> }> => {
      const replay = await this.#replay(tx, i, now, refresh);
      if (replay) return replay;
      // 다른 멱등 키로 같은 제공자 계정의 로그인이 겹쳐 와도 계정은 하나만 만든다
      await tx.lockProvider(i.provider, i.providerUserId);
      const account = await tx.findAccountByProvider(i.provider, i.providerUserId);
      if (account) {
        // 병합된 계정의 로그인 수단은 대표 계정으로 옮겨지고, 탈퇴한 계정의 것은 지워진다. 남아 있으면 불변식이 깨진 것이다
        if (account.status === 'MERGED' || account.status === 'DELETED') throw new SessionError('FAILED_PRECONDITION', `계정 상태 ${account.status}에 로그인 수단이 남아 있다`);
        return this.#open(tx, i, account.id, false, now, refresh);
      }
      // 같은 검증 이메일의 활성 계정이 정확히 하나면 계정을 만들지 않고 연결을 제안한다(I-T29). 그 계정에 이 제공자가 이미 있으면 제안하지 않는다 [가정]
      if (propose && this.links && i.emailVerified === true && i.email) {
        const email = normalizeEmail(i.email);
        const targets = email ? await tx.findLinkTargets(email) : [];
        const t = targets.length === 1 ? targets[0]! : null;
        if (t && t.providers.length > 0 && !t.providers.includes(i.provider)) {
          return {
            proposal: {
              newProvider: i.provider,
              newProviderUserId: i.providerUserId,
              email: i.email.trim(),
              targetAccountId: t.accountId,
              existingProvider: t.providers[0]!,
              attempts: 0,
              createdAt: now,
              expiresAt: now + LINK_PROPOSAL_TTL_MS,
            },
          };
        }
      }
      const accountId = uuidv7(this.clock);
      await tx.createAccount({ id: accountId, email: i.email, emailVerified: i.emailVerified === true }, now);
      await this.#emailRef(tx, accountId, i.email, now);
      await tx.linkProvider(accountId, i.provider, i.providerUserId, now);
      return this.#open(tx, i, accountId, true, now, refresh);
    });
    if ('proposal' in r) {
      const proposalId = randomBytes(16).toString('base64url');
      const binding = randomBytes(32).toString('base64url');
      await this.#links().save({ ...r.proposal, id: proposalId, bindingHash: bindingHashOf(binding) }).catch(unavailable);
      return { kind: 'link-proposed', proposalId, binding };
    }
    return this.#tokens(i, r, refresh, now, null);
  }

  /** 연결 제안을 따라 온 기존 제공자 로그인(I-T30) */
  async #viaLink(i: CreateSessionInput, link: { proposalId: string; binding: string }): Promise<LoginOutcome> {
    if (!proposalIdOk(link.proposalId)) throw new SessionError('NOT_FOUND', '연결 제안이 없다');
    const p = await this.#links().get(link.proposalId).catch(unavailable);
    // 새 계정 만들기에 쓴 제안으로는 잇지 않는다(BOT-040이 넘긴 것)
    if (!p || p.usedKey !== undefined || !bindingMatches(p, link.binding)) throw new SessionError('NOT_FOUND', '연결 제안이 없거나 만료됐다');
    const now = this.clock.now();
    const refresh = newRefreshToken();
    const r = await this.#moveSafe(async (tx): Promise<(Opened & { linked: Provider | null }) | { mismatch: true } | { gone: true }> => {
      const replay = await this.#replay(tx, i, now, refresh);
      if (replay) return { ...replay, linked: null };
      // 두 제공자 계정을 늘 같은 순서로 잠근다(같은 둘을 거꾸로 잡는 로그인과 서로 기다리지 않게)
      const both: [Provider, string][] = [
        [i.provider, i.providerUserId],
        [p.newProvider, p.newProviderUserId],
      ];
      both.sort((a, b) => (`${a[0]}\u0000${a[1]}` < `${b[0]}\u0000${b[1]}` ? -1 : 1));
      for (const [pv, sub] of both) await tx.lockProvider(pv, sub);
      const account = await tx.findAccountByProvider(i.provider, i.providerUserId);
      if (!account || account.id !== p.targetAccountId) return { mismatch: true };
      // 대상 계정을 잠근 뒤 상태를 본다: 탈퇴는 계정을 잠그므로, 잠그기 전에 끝난 탈퇴는 여기서 보이고 그 뒤의 탈퇴는 이 트랜잭션을 기다린다.
      // 활성이 아니면(탈퇴·정리 중) 주인의 로그인이라도 실패로 세지 않고 제안을 끝낸다(새 맥락 리뷰 중간 1·낮음 6)
      await tx.lockAccount(account.id);
      if ((await tx.accountStatusOf(account.id)) !== 'ACTIVE') return { gone: true };
      // 그 사이 새 제공자 계정이 다른 계정에 묶였으면 잇지 않고 대상 계정으로만 로그인한다
      // 대상 계정에 같은 종류가 그 사이 생겼으면(설정에서 추가) 잇지 않는다(종류마다 하나, 새 맥락 리뷰 중간 2)
      let linked: Provider | null = null;
      const sameType = (await tx.providersOf(account.id)).some((x) => x.provider === p.newProvider);
      if (!sameType && !(await tx.findAccountByProvider(p.newProvider, p.newProviderUserId))) {
        await tx.linkProvider(account.id, p.newProvider, p.newProviderUserId, now);
        linked = p.newProvider;
      }
      // 새 수단을 이었으면 인증 요소가 바뀌었다: 이 로그인으로 만든 세션 말고 대상 계정의 세션을 모두 끝낸다(ASVS 7.4.3, BOT-044, ADR-0209 결정 5).
      // 어차피 모두 끝나므로 기기 한도로 따로 고르지 않고 한 번에 LOGIN_METHOD_CHANGED로 끝낸다(새 맥락 리뷰 낮음 3)
      const opened = await this.#open(tx, i, account.id, false, now, refresh, linked !== null);
      // 연결 사건은 세션 쓰기와 세션 종료 사건 뒤, 트랜잭션의 마지막 쓰기로 적는다(I-T34, BOT-041)
      if (linked) await tx.recordLoginMethodChanged({ accountId: account.id, change: 'LINKED', provider: linked, occurredAt: now });
      return { ...opened, linked };
    });
    if ('gone' in r) {
      await this.#links()
        .remove(link.proposalId)
        .catch(() => undefined);
      throw new SessionError('NOT_FOUND', '연결 제안의 대상 계정이 활성이 아니다');
    }
    if ('mismatch' in r) {
      const n = await this.#links().fail(link.proposalId).catch(unavailable);
      return { kind: 'link-mismatch', attemptsLeft: n === null ? 0 : Math.max(0, LINK_MAX_ATTEMPTS - n) };
    }
    // 한 번만 쓴다. 지우지 못해도 10분 뒤 사라지고, 다시 와도 이미 이어 있어 같은 결과다
    await this.#links()
      .remove(link.proposalId)
      .catch(() => undefined);
    return this.#tokens(i, r, refresh, now, r.linked);
  }

  #links(): LinkProposals {
    if (!this.links) throw new SessionError('UNAVAILABLE', '연결 제안 저장소가 없다');
    return this.links;
  }

  /** 같은 멱등 키의 다시 보내기면 같은 세션에 새 리프레시 토큰을 준다 */
  async #replay(tx: SessionTx, i: CreateSessionInput, now: number, refresh: { hash: Uint8Array }): Promise<Opened | null> {
    const seen = await tx.lockCreateKey(i.idempotencyKey, now);
    if (!seen) return null;
    if (seen.provider !== i.provider || seen.providerUserId !== i.providerUserId) {
      throw new SessionError('ALREADY_EXISTS', '같은 멱등 키에 다른 제공자 계정이 왔다');
    }
    const s = await tx.getSessionForUpdate(seen.sessionId);
    if (!s || !sessionAlive(s, now)) throw new SessionError('FAILED_PRECONDITION', '그 멱등 키의 세션이 이미 끝났다');
    // identity에는 해시만 있어 앞서 준 값을 다시 줄 수 없다. 새 값으로 바꿔 앞서 준 리프레시 토큰은 쓸 수 없게 한다
    await tx.setRefreshHash(s.id, refresh.hash);
    await tx.recordRefreshHash({ hash: refresh.hash, sessionId: s.id, refreshFamily: s.refreshFamily, issuedAt: now, expiresAt: s.absoluteExpiresAt });
    return { accountId: s.accountId, sessionId: s.id, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, newAccount: seen.newAccount, replayed: true, ended: [], endedReason: 'DEVICE_LIMIT' };
  }

  /**
   * 계정을 잠그고 기기·세션을 만든다(같은 트랜잭션). endAllOthers: 연결 제안으로 새 수단을 이은 로그인이라 그 계정의 다른 살아 있는 세션을 모두
   * LOGIN_METHOD_CHANGED로 끝낸다(기기 한도 정리 대신). 세션 종료 사건은 이 함수의 마지막 쓰기다
   */
  async #open(tx: SessionTx, i: CreateSessionInput, found: string, isNew: boolean, now: number, refresh: { hash: Uint8Array }, endAllOthers = false): Promise<Opened> {
    let accountId = found;
    let newAccount = isNew;
    // 같은 계정의 로그인이 겹쳐도 기기 수는 한 번에 하나씩 센다(POL-019)
    await tx.lockAccount(accountId);
    // 잠근 뒤 그 (제공자, sub)의 계정을 다시 찾는다(BOT-030이 넘긴 것, BOT-042): 잠그기 전에 병합으로 다른 계정에 옮겨졌으면 그 계정으로 간다(흡수된 계정에 세션·기기를 만들지 않게).
    // 해제·탈퇴로 사라졌으면 아래 새 계정 길로 간다. 제공자 잠금을 잡고 있어 같은 제공자 계정의 다른 로그인과 겹치지 않는다
    // 옮겨 간 계정의 상태(탈퇴 정리 중 등)는 처음 찾은 계정과 같게 다룬다(그 수단은 그 계정 것이라 새 계정을 만들면 수단을 빼앗는다, 새 맥락 리뷰 중간 4).
    // 옮겨졌으면 잡은 계정을 쥔 채 옮겨 간 계정을 잠그지 않고 트랜잭션을 처음부터 다시 한다(#moveSafe, 교착을 막는다. BOT-042가 넘긴 것)
    let gone = false;
    if (!newAccount) {
      const again = await tx.findAccountByProvider(i.provider, i.providerUserId);
      if (!again) gone = true;
      else if (again.id !== accountId) throw new AccountMoved();
    }
    // 계정을 찾은 뒤 잠그기 전에 탈퇴가 끝났을 수 있다(새 맥락 리뷰 M1): 잠근 뒤 상태를 다시 본다. 탈퇴로 로그인 수단 연결도 지워졌으니
    // 그 계정에 세션·기기를 만들지 않고 새 계정으로 간다(바로 재가입, identity §8)
    const nowStatus = newAccount ? 'ACTIVE' : await tx.accountStatusOf(accountId);
    if (!newAccount && (gone || nowStatus === 'DELETED' || nowStatus === 'MERGED')) {
      accountId = uuidv7(this.clock);
      newAccount = true;
      await tx.createAccount({ id: accountId, email: i.email, emailVerified: i.emailVerified === true }, now);
      await this.#emailRef(tx, accountId, i.email, now);
      await tx.linkProvider(accountId, i.provider, i.providerUserId, now);
      await tx.lockAccount(accountId);
    }
    // 이 (제공자, sub)의 마지막 로그인 시각(SCR-040 '최근 로그인', BOT-041)
    await tx.touchProviderLogin(i.provider, i.providerUserId, now);
    const ref = i.deviceId === null ? undefined : this.devices.ref(i.deviceId);
    const deviceId = ref === undefined || i.deviceId === null ? null : await tx.bindDevice(accountId, ref, now, this.devices.prevRef?.(i.deviceId));
    const active = await tx.activeSessions(accountId, now);
    const endedReason = endAllOthers ? 'LOGIN_METHOD_CHANGED' : 'DEVICE_LIMIT';
    const ended = endAllOthers ? active.map((s) => s.sessionId) : sessionsOverDeviceLimit(active, deviceId);

    const sessionId = uuidv7(this.clock);
    const refreshFamily = uuidv7(this.clock);
    const absoluteExpiresAt = now + SESSION_ABSOLUTE_MS;
    const idleExpiresAt = now + SESSION_IDLE_MS;
    await tx.insertSession({
      id: sessionId,
      accountId,
      deviceId,
      refreshHash: refresh.hash,
      refreshFamily,
      absoluteExpiresAt,
      idleExpiresAt,
      loginVerdict: 'UNKNOWN',
      createdAt: now,
      deviceLabel: deviceLabelOf(i.userAgent),
    });
    await tx.recordRefreshHash({ hash: refresh.hash, sessionId, refreshFamily, issuedAt: now, expiresAt: absoluteExpiresAt });
    await tx.saveCreateKey(i.idempotencyKey, { provider: i.provider, providerUserId: i.providerUserId, sessionId, newAccount }, now);
    // 기기 한도 정리(또는 로그인 수단 변경의 끝내기)는 세션 종료 사건(Outbox)을 적으므로 트랜잭션의 마지막 쓰기로 둔다(ADR-0116 결정 3)
    if (ended.length) await tx.terminateSessions(ended, endedReason, now);
    return { accountId, sessionId, idleExpiresAt, absoluteExpiresAt, newAccount, replayed: false, ended, endedReason };
  }

  /**
   * 로그인 판정(identity §7 '로그인 판정의 처리'): 판정으로 로그인을 막거나 늦추지 않는다. CHALLENGE여도 세션을 만든다. 세션을 커밋한 뒤 응답과 떼어 뒤에서 부르고 결과를 세션에 적는다.
   * 판정을 받지 못했거나(서킷 열림, 데드라인 넘김) 적지 못하거나 파드가 그 사이 죽으면 세션을 만들 때 넣은 UNKNOWN에 머문다(양도·계좌 입력에서 안전 쪽으로 다룬다). 다시 보내기는 판정을 다시 받지 않는다
   */
  #judge(i: CreateSessionInput, r: Opened): void {
    if (r.replayed) return;
    if (!this.loginRisk) return;
    const work = this.#runJudge(i, r).finally(() => this.#judging.delete(work));
    this.#judging.add(work);
  }

  async #runJudge(i: CreateSessionInput, r: Opened): Promise<void> {
    if (!this.loginRisk) return;
    let verdict: 'ALLOW' | 'CHALLENGE' | 'UNKNOWN' = 'UNKNOWN';
    try {
      const v = await this.loginRisk.score({
        accountId: r.accountId,
        deviceId: i.deviceId,
        ...(i.clientIp !== undefined ? { clientIp: i.clientIp } : {}),
        ...(i.asn !== undefined ? { asn: i.asn } : {}),
        userAgent: i.userAgent ?? null,
      });
      verdict = v.verdict;
      if (v.verdict !== 'UNKNOWN') {
        const reason = v.verdict === 'CHALLENGE' ? v.reason : null;
        await this.store.transaction((tx) => tx.setLoginVerdict(r.sessionId, v.verdict, reason, this.clock.now()));
      }
    } catch {
      verdict = 'UNKNOWN';
    }
    try {
      this.signals.loginVerdict(verdict);
    } catch {
      // 지표가 실패해도 판정은 끝났다(뒤에서 도는 일이라 처리 못 한 거부를 남기지 않는다)
    }
  }

  async #tokens(i: CreateSessionInput, r: Opened, refresh: { token: string }, now: number, linkedProvider: Provider | null): Promise<LoginOutcome> {
    if (r.replayed) this.signals.replayed(i.provider);
    else this.signals.created(i.provider, r.newAccount);
    this.#judge(i, r);
    if (r.ended.length && r.endedReason === 'DEVICE_LIMIT') this.signals.terminated('DEVICE_LIMIT', r.ended.length);
    if (r.ended.length && r.endedReason === 'LOGIN_METHOD_CHANGED') this.signals.othersEnded('login_method_changed', r.ended.length);
    const access = await this.signer.access({ accountId: r.accountId, sessionId: r.sessionId, ...(await this.claims.of(r.accountId)) }, now);
    return {
      kind: 'session',
      linkedProvider,
      accountId: r.accountId,
      sessionId: r.sessionId,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: Math.min(r.idleExpiresAt, r.absoluteExpiresAt),
      newAccount: r.newAccount,
      replayed: r.replayed,
    };
  }
}

/** 제안 저장소 장애는 UNAVAILABLE로(앱 서버는 '잠시 뒤 다시') */
function unavailable(err: unknown): never {
  if (err instanceof LinkStoreUnavailable) throw new SessionError('UNAVAILABLE', '연결 제안 저장소에 닿지 못했다');
  throw err;
}
