// 시험 도구: 고정 시계, 시험용 팬 토큰 키(매번 새로 만든다), 운영 신호 기록, 유스케이스 묶음.
import { createHmac, randomBytes } from 'node:crypto';
import { type FakeClock, fakeClock } from '@peaket/platform';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { CreateSession } from '../src/modules/session/application/create-session.js';
import { EndSession } from '../src/modules/session/application/end-session.js';
import { IssueReauthToken } from '../src/modules/session/application/issue-reauth-token.js';
import { RefreshSession } from '../src/modules/session/application/refresh-session.js';
import { JoseTokenSigner } from '../src/modules/session/adapters/jose-token-signer.js';
import { TokenKeyRing } from '../src/modules/session/adapters/token-keys.js';
import type { DeviceRefs, SessionSignals, SessionStore } from '../src/modules/session/domain/ports.js';

export const ISSUER = 'https://identity.peaket.test';

export async function fanKey(): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = `fan-${randomBytes(4).toString('hex')}`;
  return { privateJwk: { ...(await exportJWK(privateKey)), kid, alg: 'ES256' }, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' } };
}

/** 운영 신호를 글로 모은다 */
export function recordingSignals(): SessionSignals & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    created: (p, n) => seen.push(`created:${p}:${n}`),
    replayed: (p) => seen.push(`replayed:${p}`),
    terminated: (r, c) => seen.push(`terminated:${r}:${c}`),
    reauthIssued: (p, s) => seen.push(`reauth:${p}:${s}`),
    reauthMismatch: (p) => seen.push(`mismatch:${p}`),
    reverifyRequired: (p) => seen.push(`reverify:${p}`),
    refreshed: (aud, result) => seen.push(`refresh:${aud}:${result}`),
  };
}

/** 시험용 기기 가명(라벨 키 고정, 판 1). keyless면 키가 없는 경우 */
export function testDeviceRefs(keyless = false): DeviceRefs {
  const key = Buffer.alloc(32, 7);
  return { ref: (id) => (keyless ? undefined : `k1.${createHmac('sha256', key).update(id).digest('base64url')}`) };
}

export interface Kit {
  clock: FakeClock;
  signals: ReturnType<typeof recordingSignals>;
  publicJwk: JWK;
  create: CreateSession;
  end: EndSession;
  reauth: IssueReauthToken;
  refresh: RefreshSession;
}

export async function kit(store: SessionStore, o: { keyless?: boolean; clock?: FakeClock } = {}): Promise<Kit> {
  const clock = o.clock ?? fakeClock({ now: Date.parse('2026-11-03T03:00:00.000Z') });
  const signals = recordingSignals();
  const { privateJwk, publicJwk } = await fanKey();
  const signer = new JoseTokenSigner(await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(privateJwk) }), ISSUER);
  const devices = testDeviceRefs(o.keyless);
  return {
    clock,
    signals,
    publicJwk,
    create: new CreateSession(store, signer, devices, signals, clock),
    end: new EndSession(store, signals, clock),
    reauth: new IssueReauthToken(store, signer, signals, clock),
    refresh: new RefreshSession(store, signer, signals, clock),
  };
}

let n = 0;
/** 로그인 시도마다 새 멱등 키(앱 서버가 state를 HMAC한 모양: base64url 43자) */
export const newKey = (): string => createHmac('sha256', 'k').update(`state-${n++}-${Math.random()}`).digest('base64url');
