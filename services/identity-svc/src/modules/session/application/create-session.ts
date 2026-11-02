// CreateSession(docs/features/identity.md §2, I-T50 ①②, ADR-0011·0119): 소셜 로그인 뒤 PEAKET 세션을 만든다.
// - 같은 멱등 키가 10분 안에 다시 오면 새 세션을 만들지 않고, 같은 세션에 토큰을 다시 주며 앞서 준 리프레시 토큰은 쓸 수 없게 한다
// - 같은 키에 다른 (제공자, provider_user_id)가 오면 ALREADY_EXISTS
// - (제공자, sub) 계정이 없으면 새 계정(연결 제안은 wbs 3.1.3, identity §2 '첫 구현'). 기기 한도를 넘으면 오래 쉰 기기의 세션을 끝낸다
import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, uuidv7 } from '@peaket/platform';
import {
  DEVICE_REFS,
  type DeviceRefs,
  SESSION_SIGNALS,
  SESSION_STORE,
  type SessionSignals,
  type SessionStore,
  TOKEN_SIGNER,
  type TokenSigner,
} from '../domain/ports.js';
import { type Provider, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, sessionAlive, sessionsOverDeviceLimit } from '../domain/session.js';
import { SessionError } from './session-error.js';

export interface CreateSessionInput {
  idempotencyKey: string;
  provider: Provider;
  providerUserId: string;
  email: string | null;
  deviceId: string | null;
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

const KEY = /^[A-Za-z0-9_-]{16,128}$/;

/** 리프레시 토큰: 256비트 난수(asvs/auth.md 7.2.3). identity에는 SHA-256만 둔다 */
export function newRefreshToken(): { token: string; hash: Uint8Array } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: refreshHash(token) };
}

export const refreshHash = (token: string): Uint8Array => createHash('sha256').update(token, 'utf8').digest();

function check(i: CreateSessionInput): void {
  if (!KEY.test(i.idempotencyKey)) throw new SessionError('INVALID_ARGUMENT', 'idempotency_key는 16~128자 base64url이다');
  if (!i.providerUserId || i.providerUserId.length > 255) throw new SessionError('INVALID_ARGUMENT', 'provider_user_id가 없거나 255자를 넘는다');
  if (i.email !== null && i.email.length > 320) throw new SessionError('INVALID_ARGUMENT', 'email이 320자를 넘는다');
  if (i.deviceId !== null && i.deviceId.length > 128) throw new SessionError('INVALID_ARGUMENT', 'device_id가 128자를 넘는다');
}

@Injectable()
export class CreateSession {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(TOKEN_SIGNER) private readonly signer: TokenSigner,
    @Inject(DEVICE_REFS) private readonly devices: DeviceRefs,
    @Inject(SESSION_SIGNALS) private readonly signals: SessionSignals,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(i: CreateSessionInput): Promise<CreateSessionResult> {
    check(i);
    const now = this.clock.now();
    const refresh = newRefreshToken();
    const r = await this.store.transaction(async (tx) => {
      const seen = await tx.lockCreateKey(i.idempotencyKey, now);
      if (seen) {
        if (seen.provider !== i.provider || seen.providerUserId !== i.providerUserId) {
          throw new SessionError('ALREADY_EXISTS', '같은 멱등 키에 다른 제공자 계정이 왔다');
        }
        const s = await tx.getSessionForUpdate(seen.sessionId);
        if (!s || !sessionAlive(s, now)) throw new SessionError('FAILED_PRECONDITION', '그 멱등 키의 세션이 이미 끝났다');
        // identity에는 해시만 있어 앞서 준 값을 다시 줄 수 없다. 새 값으로 바꿔 앞서 준 리프레시 토큰은 쓸 수 없게 한다
        await tx.setRefreshHash(s.id, refresh.hash);
        return { accountId: s.accountId, sessionId: s.id, idleExpiresAt: s.idleExpiresAt, absoluteExpiresAt: s.absoluteExpiresAt, newAccount: seen.newAccount, replayed: true, ended: [] as string[] };
      }

      let accountId: string;
      let newAccount = false;
      // 다른 멱등 키로 같은 제공자 계정의 로그인이 겹쳐 와도 계정은 하나만 만든다
      await tx.lockProvider(i.provider, i.providerUserId);
      const account = await tx.findAccountByProvider(i.provider, i.providerUserId);
      if (account) {
        // 병합된 계정의 로그인 수단은 대표 계정으로 옮겨지고, 탈퇴한 계정의 것은 지워진다. 남아 있으면 불변식이 깨진 것이다
        if (account.status === 'MERGED' || account.status === 'DELETED') throw new SessionError('FAILED_PRECONDITION', `계정 상태 ${account.status}에 로그인 수단이 남아 있다`);
        accountId = account.id;
      } else {
        accountId = uuidv7(this.clock);
        newAccount = true;
        await tx.createAccount({ id: accountId, email: i.email }, now);
        await tx.linkProvider(accountId, i.provider, i.providerUserId, now);
      }

      // 같은 계정의 로그인이 겹쳐도 기기 수는 한 번에 하나씩 센다(POL-019)
      await tx.lockAccount(accountId);
      const ref = i.deviceId === null ? undefined : this.devices.ref(i.deviceId);
      const deviceId = ref === undefined ? null : await tx.bindDevice(accountId, ref, now);
      const ended = sessionsOverDeviceLimit(await tx.activeSessions(accountId, now), deviceId);
      if (ended.length) await tx.terminateSessions(ended, now);

      const sessionId = uuidv7(this.clock);
      const absoluteExpiresAt = now + SESSION_ABSOLUTE_MS;
      const idleExpiresAt = now + SESSION_IDLE_MS;
      await tx.insertSession({
        id: sessionId,
        accountId,
        deviceId,
        refreshHash: refresh.hash,
        refreshFamily: uuidv7(this.clock),
        absoluteExpiresAt,
        idleExpiresAt,
        loginVerdict: 'UNKNOWN',
        createdAt: now,
      });
      await tx.saveCreateKey(i.idempotencyKey, { provider: i.provider, providerUserId: i.providerUserId, sessionId, newAccount }, now);
      return { accountId, sessionId, idleExpiresAt, absoluteExpiresAt, newAccount, replayed: false, ended };
    });

    if (r.replayed) this.signals.replayed(i.provider);
    else this.signals.created(i.provider, r.newAccount);
    if (r.ended.length) this.signals.terminated('DEVICE_LIMIT', r.ended.length);
    const access = await this.signer.access({ accountId: r.accountId, sessionId: r.sessionId }, now);
    return {
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
