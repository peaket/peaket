// 시험 도구: 고정 시계, 시험용 팬 토큰 키(매번 새로 만든다), 운영 신호 기록, 유스케이스 묶음.
import { createHmac, randomBytes } from 'node:crypto';
import { type Clock, type FakeClock, fakeClock } from '@peaket/platform';
import { sealTestAgencyResult, type TestAgencyOutcome } from '../src/modules/verification/adapters/test-agency.js';
import { TestVerificationProvider } from '../src/modules/verification/adapters/test-verification-provider.js';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { CreateSession } from '../src/modules/session/application/create-session.js';
import { EndSession } from '../src/modules/session/application/end-session.js';
import { IssueReauthToken } from '../src/modules/session/application/issue-reauth-token.js';
import { RefreshSession } from '../src/modules/session/application/refresh-session.js';
import { JoseTokenSigner } from '../src/modules/session/adapters/jose-token-signer.js';
import { TokenKeyRing } from '../src/modules/session/adapters/token-keys.js';
import { type AccountClaims, type AccountClosure, type DeviceRefs, noReverifications, type Reverifications, type SessionSignals, type SessionStore } from '../src/modules/session/domain/ports.js';

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

/** 본인확인 전 계정처럼 아무 값도 싣지 않는다 */
export const noClaims: AccountClaims = { of: async () => ({ scopes: [] }) };

export async function kit(store: SessionStore, o: { keyless?: boolean; clock?: FakeClock; claims?: AccountClaims; reverifications?: Reverifications } = {}): Promise<Kit> {
  const clock = o.clock ?? fakeClock({ now: Date.parse('2026-11-03T03:00:00.000Z') });
  const signals = recordingSignals();
  const { privateJwk, publicJwk } = await fanKey();
  const signer = new JoseTokenSigner(await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(privateJwk) }), ISSUER);
  const devices = testDeviceRefs(o.keyless);
  return {
    clock,
    signals,
    publicJwk,
    create: new CreateSession(store, signer, devices, signals, o.claims ?? noClaims, clock),
    end: new EndSession(store, signals, clock),
    reauth: new IssueReauthToken(store, signer, signals, o.reverifications ?? noReverifications, clock),
    refresh: new RefreshSession(store, signer, signals, o.claims ?? noClaims, clock),
  };
}

/** 계정 정리를 하지 않는 대역(정리 사유도 늘 없음) */
export const noClosure: AccountClosure = { start: async () => {}, closureReasonOf: async () => null };

/** 시험 기관 비밀과 모의 기관 주소(docs/features/identity.md §5 '모의 기관과 기관 창 흐름') */
export const AGENCY_SECRET = Buffer.alloc(32, 3);
export const AGENCY_URL = 'http://127.0.0.1:18920/verify';

/** 시험 어댑터(모의 기관 결과만 믿는다). 시계는 결과 값의 만든 시각을 보는 데 쓴다 */
export const testAgency = (clock: Clock, mode: 'POPUP' | 'REDIRECT' = 'POPUP'): TestVerificationProvider =>
  new TestVerificationProvider({ secret: AGENCY_SECRET, agencyUrl: AGENCY_URL, mode, clock });

/** 모의 기관이 돌려줄 결과 값(서명함). person이 있으면 VERIFIED, 없으면 outcome */
export function agencyResult(
  clock: Clock,
  verificationId: string,
  o: { person?: string; outcome?: TestAgencyOutcome; birth?: string; iatMs?: number },
  secret: Uint8Array = AGENCY_SECRET,
): Record<string, string> {
  const outcome = o.outcome ?? (o.person === undefined ? 'FAILED' : 'VERIFIED');
  // 생년월일을 주지 않으면 어른(2000-01-01)으로 둔다. 'birth' 칸을 undefined로 주면 생년월일 없는 결과다(BOT-020)
  const birth = 'birth' in o ? o.birth : '2000-01-01';
  return sealTestAgencyResult(secret, { v: 1, tx: verificationId, outcome, person: o.person, birth, iat: o.iatMs ?? clock.now() });
}

let n = 0;
/** 로그인 시도마다 새 멱등 키(앱 서버가 state를 HMAC한 모양: base64url 43자) */
export const newKey = (): string => createHmac('sha256', 'k').update(`state-${n++}-${Math.random()}`).digest('base64url');
