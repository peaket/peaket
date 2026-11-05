// 시험용 소프트웨어 패스키 인증기(WebAuthn, ES256 P-256, 증명 none, BUILD_ORDER BOT-122, ADR-0206).
// 새 패키지 없이 node:crypto와 작은 CBOR 인코더로 만든다. 브라우저가 navigator.credentials.create()·get()의 결과를
// toJSON()한 꼴(W3C WebAuthn Level 3 RegistrationResponseJSON·AuthenticationResponseJSON)을 돌려준다.
// 시험이 바꿔 볼 수 있는 것: 출처(origin), RP ID, 사용자 확인 표시(UV), 서명 횟수, 챌린지, 자격 ID.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');

/** CBOR 머리(주 형식과 길이·값) */
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** 작은 CBOR 인코더(RFC 8949): 정수·바이트열·글자열·배열·맵(Map이나 평범한 객체)만 */
export function cbor(v: unknown): Buffer {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('정수만 받는다');
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as Record<string, unknown>);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export interface CeremonyOverrides {
  /** clientDataJSON의 출처(기본: 만들 때 준 출처) */
  origin?: string;
  /** 인증기 데이터의 RP ID 해시를 만들 값(기본: 옵션의 RP ID) */
  rpId?: string;
  /** 사용자 확인 표시(기본 참) */
  uv?: boolean;
  /** clientDataJSON의 챌린지(기본: 옵션의 챌린지) */
  challenge?: string;
  /** 이번 서명 횟수(기본: 세는 인증기는 하나 올린 값, 동기화 패스키는 0) */
  signCount?: number;
  /** 응답에 실을 자격 ID(기본: 이 인증기의 것). 등록이면 인증기 데이터 안의 자격 ID도 이 값이다 */
  credentialId?: Buffer;
  /** 응답 JSON의 id·rawId만 바꾼다(인증기 데이터 안의 자격 ID와 다르게 보낼 때) */
  responseId?: Buffer;
  /** clientDataJSON의 crossOrigin(다른 사이트 안의 iframe에서 불렀다는 표시, 기본 거짓)과 topOrigin */
  crossOrigin?: boolean;
  topOrigin?: string;
}

export class SoftAuthenticator {
  readonly credentialId: Buffer;
  readonly #key: KeyObject;
  readonly #cose: Buffer;
  /** 마지막으로 낸 서명 횟수 */
  signCount: number;

  /**
   * @param o.origin 이 인증기를 쓰는 브라우저 출처(기본 파트너 콘솔)
   * @param o.counting 참이면 서명마다 횟수를 올린다(하드웨어 키), 거짓이면 늘 0(동기화 패스키)
   */
  constructor(private readonly o: { origin?: string; counting?: boolean; synced?: boolean } = {}) {
    this.credentialId = randomBytes(32);
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.#key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    // COSE EC2 키: kty 2, alg -7(ES256), crv 1(P-256), x, y
    this.#cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    this.signCount = 0;
  }

  get origin(): string {
    return this.o.origin ?? 'https://partner.peaket.example';
  }

  #flags(uv: boolean, at: boolean): number {
    const synced = this.o.synced ?? !this.o.counting;
    return FLAG_UP | (uv ? FLAG_UV : 0) | (at ? FLAG_AT : 0) | (synced ? FLAG_BE | FLAG_BS : 0);
  }

  #nextCount(x?: number): number {
    if (x !== undefined) return (this.signCount = x);
    return this.o.counting ? ++this.signCount : 0;
  }

  #clientData(type: string, challenge: string, x: CeremonyOverrides): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge: x.challenge ?? challenge, origin: x.origin ?? this.origin, crossOrigin: x.crossOrigin ?? false, ...(x.topOrigin ? { topOrigin: x.topOrigin } : {}) }), 'utf8');
  }

  /** 등록(navigator.credentials.create)의 결과. options는 서버가 준 PublicKeyCredentialCreationOptionsJSON */
  register(options: { challenge: string; rp: { id?: string } }, x: CeremonyOverrides = {}) {
    const rpId = x.rpId ?? options.rp.id!;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.#nextCount(x.signCount));
    const credId = x.credentialId ?? this.credentialId;
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([this.#flags(x.uv ?? true, true)]), count, Buffer.alloc(16), idLen, credId, this.#cose]);
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = this.#clientData('webauthn.create', options.challenge, x);
    const responseId = x.responseId ?? credId;
    return {
      id: b64u(responseId),
      rawId: b64u(responseId),
      type: 'public-key' as const,
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal', 'hybrid'] },
    };
  }

  /** 확인(navigator.credentials.get)의 결과. options는 서버가 준 PublicKeyCredentialRequestOptionsJSON */
  assert(options: { challenge: string; rpId?: string }, x: CeremonyOverrides = {}) {
    const rpId = x.rpId ?? options.rpId!;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.#nextCount(x.signCount));
    const authenticatorData = Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([this.#flags(x.uv ?? true, false)]), count]);
    const clientDataJSON = this.#clientData('webauthn.get', options.challenge, x);
    // ES256 서명은 ASN.1 DER 꼴이다(WebAuthn §6.5.6, node:crypto의 기본)
    const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), this.#key);
    const credId = x.responseId ?? x.credentialId ?? this.credentialId;
    return {
      id: b64u(credId),
      rawId: b64u(credId),
      type: 'public-key' as const,
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(authenticatorData), signature: b64u(signature) },
    };
  }
}
