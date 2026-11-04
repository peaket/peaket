// CreateSession(docs/features/identity.md §2, I-T50 ①②, ADR-0011·0119): 소셜 로그인 뒤 PEAKET 세션을 만든다.
// - 같은 멱등 키가 10분 안에 다시 오면 새 세션을 만들지 않고, 같은 세션에 토큰을 다시 주며 앞서 준 리프레시 토큰은 쓸 수 없게 한다
// - 같은 키에 다른 (제공자, provider_user_id)가 오면 ALREADY_EXISTS
// - (제공자, sub) 계정이 없으면: 검증 이메일이 같은 활성 계정이 정확히 하나면 연결 제안, 아니면 새 계정(identity §2.1 '가입 때 연결 제안의 첫 구현', BOT-040)
// - 연결 제안을 따라 온 로그인은 제안의 대상 계정일 때만 새 제공자를 잇고 세션을 만든다. 아니면 실패 횟수를 올린다(I-T30)
// 기기 한도를 넘으면 오래 쉰 기기의 세션을 끝낸다
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import {
  ACCOUNT_CLAIMS,
  type AccountClaims,
  DEVICE_REFS,
  type DeviceRefs,
  LINK_PROPOSALS,
  type LinkProposals,
  LinkStoreUnavailable,
  SESSION_SIGNALS,
  SESSION_STORE,
  type SessionSignals,
  type SessionStore,
  type SessionTx,
  type StoredLinkProposal,
  TOKEN_SIGNER,
  type TokenSigner,
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

/** 트랜잭션이 돌려주는 세션 자리(토큰 서명은 트랜잭션 밖에서 한다) */
interface Opened {
  accountId: string;
  sessionId: string;
  idleExpiresAt: number;
  absoluteExpiresAt: number;
  newAccount: boolean;
  replayed: boolean;
  ended: string[];
}

@Injectable()
export class CreateSession {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(DEVICE_REFS) private readonly devices: DeviceRefs,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
    @Inject(ACCOUNT_CLAIMS) private readonly claims: AccountClaims,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 가입 때 연결 제안(없으면 제안하지 않는다: 시험) */
    @Optional() @Inject(LINK_PROPOSALS) private readonly links?: LinkProposals,
  ) {}

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

  async #login(i: CreateSessionInput, propose: boolean): Promise<LoginOutcome> {
    const now = this.clock.now();
    const refresh = newRefreshToken();
    const r = await this.store.transaction(async (tx): Promise<Opened | { proposal: Omit<StoredLinkProposal, 'id' | 'bindingHash'> }> => {
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
    if (!p || !bindingMatches(p, link.binding)) throw new SessionError('NOT_FOUND', '연결 제안이 없거나 만료됐다');
    const now = this.clock.now();
    const refresh = newRefreshToken();
    const r = await this.store.transaction(async (tx): Promise<(Opened & { linked: Provider | null }) | { mismatch: true } | { gone: true }> => {
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
      let linked: Provider | null = null;
      if (!(await tx.findAccountByProvider(p.newProvider, p.newProviderUserId))) {
        await tx.linkProvider(account.id, p.newProvider, p.newProviderUserId, now);
        linked = p.newProvider;
      }
      return { ...(await this.#open(tx, i, account.id, false, now, refresh)), linked };
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
    return { accountId: s.accountId, sessionId: s.id, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, newAccount: seen.newAccount, replayed: true, ended: [] };
  }

  /** 계정을 잠그고 기기·세션을 만든다(같은 트랜잭션) */
  async #open(tx: SessionTx, i: CreateSessionInput, found: string, isNew: boolean, now: number, refresh: { hash: Uint8Array }): Promise<Opened> {
    let accountId = found;
    let newAccount = isNew;
    // 같은 계정의 로그인이 겹쳐도 기기 수는 한 번에 하나씩 센다(POL-019)
    await tx.lockAccount(accountId);
    // 계정을 찾은 뒤 잠그기 전에 탈퇴가 끝났을 수 있다(새 맥락 리뷰 M1): 잠근 뒤 상태를 다시 본다. 탈퇴로 로그인 수단 연결도 지워졌으니
    // 그 계정에 세션·기기를 만들지 않고 새 계정으로 간다(바로 재가입, identity §8). 제공자 잠금을 잡고 있어 같은 제공자 계정의 다른 로그인과 겹치지 않는다
    if (!newAccount && (await tx.accountStatusOf(accountId)) === 'DELETED') {
      accountId = uuidv7(this.clock);
      newAccount = true;
      await tx.createAccount({ id: accountId, email: i.email, emailVerified: i.emailVerified === true }, now);
      await tx.linkProvider(accountId, i.provider, i.providerUserId, now);
      await tx.lockAccount(accountId);
    }
    const ref = i.deviceId === null ? undefined : this.devices.ref(i.deviceId);
    const deviceId = ref === undefined ? null : await tx.bindDevice(accountId, ref, now);
    const ended = sessionsOverDeviceLimit(await tx.activeSessions(accountId, now), deviceId);

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
    });
    await tx.recordRefreshHash({ hash: refresh.hash, sessionId, refreshFamily, issuedAt: now, expiresAt: absoluteExpiresAt });
    await tx.saveCreateKey(i.idempotencyKey, { provider: i.provider, providerUserId: i.providerUserId, sessionId, newAccount }, now);
    // 기기 한도 정리는 세션 종료 사건(Outbox)을 적으므로 트랜잭션의 마지막 쓰기로 둔다(ADR-0116 결정 3)
    if (ended.length) await tx.terminateSessions(ended, 'DEVICE_LIMIT', now);
    return { accountId, sessionId, idleExpiresAt, absoluteExpiresAt, newAccount, replayed: false, ended };
  }

  async #tokens(i: CreateSessionInput, r: Opened, refresh: { token: string }, now: number, linkedProvider: Provider | null): Promise<LoginOutcome> {
    if (r.replayed) this.signals.replayed(i.provider);
    else this.signals.created(i.provider, r.newAccount);
    if (r.ended.length) this.signals.terminated('DEVICE_LIMIT', r.ended.length);
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
