// 가상계좌 번호 필드 암호화(docs/security/secrets-and-keys.md '가상계좌 번호 필드 암호화 키', ADR-0073, docs/features/payment.md §6, BUILD_ORDER HOT-151).
// 저장 꼴은 identity-svc TOTP 시드 봉투와 같다: 판 1바이트(1) ‖ 감싼 데이터 키 길이 2바이트 ‖ 감싼 데이터 키 ‖ IV 12바이트 ‖ 태그 16바이트 ‖ 암호문을 base64로 text 칸에 둔다.
// 데이터 키로 AES-256-GCM 암호화하고 추가 인증 데이터는 {paymentId, purpose}의 정렬한 JSON이다(다른 결제 행으로 옮기면 태그가 맞지 않는다).
// 키 값은 local·ci·demo에서만 받는다(라벨 키 pay와 같은 규칙). 운영의 KMS 받기는 HOT-146이고, 그때 데이터 키 감싸기만 KMS로 바꾼다. 그 전의 운영은 NoKeyVirtualAccountCipher다(저장하지 않고 드러낸다).
// 키는 비공개 칸에만 둔다. 객체를 로그로 찍거나 JSON으로 바꿔도 실리지 않는다([ASVS v5.0.0-16.2.5]). 오류 글에 값을 싣지 않는다.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { VirtualAccountCipher } from '../domain/virtual-account.js';

const KEY_ENV = 'PEAKET_PAYMENT_VA_FIELD_KEY';
const KMS_ENV = 'PEAKET_PAYMENT_VA_FIELD_KMS_KEY';
/** 키 값 설정을 받는 환경(결제 수단 라벨 키 pay와 같다). 운영·스테이징은 KMS 키만 */
const KEY_VALUE_ENVS: ReadonlySet<string> = new Set(['local', 'ci', 'demo']);
const KEY_BYTES = 32;
const VERSION = 1;
const PURPOSE = 'peaket-payment-va-v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = IV_BYTES + KEY_BYTES + TAG_BYTES;

class CipherFailure extends Error {
  constructor() {
    super('가상계좌 번호를 암호화하거나 열지 못했다');
    this.name = 'VirtualAccountCipherFailure';
  }
}

/** 키를 정렬한 JSON(추가 인증 데이터) */
function aadOf(paymentId: string): Buffer {
  return Buffer.from(JSON.stringify({ paymentId, purpose: PURPOSE }), 'utf8');
}

function encrypt(key: Uint8Array, aad: Buffer, plain: Uint8Array): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, tag: c.getAuthTag(), ct };
}

function decrypt(key: Uint8Array, aad: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** 키를 쓰지 못하는 환경(운영·스테이징 등)의 암호기. 부르는 쪽은 ready를 먼저 본다 */
export class NoKeyVirtualAccountCipher implements VirtualAccountCipher {
  readonly ready = false;

  async seal(): Promise<string> {
    throw new CipherFailure();
  }

  async open(): Promise<string> {
    throw new CipherFailure();
  }

  toJSON(): string {
    return '[NoKeyVirtualAccountCipher]';
  }
}

/** local·ci·demo의 봉투 암호화(환경 키로 데이터 키를 AES-256-GCM으로 감싼다) */
export class LocalVirtualAccountCipher implements VirtualAccountCipher {
  readonly ready = true;
  readonly #key: Buffer;

  /** @throws Error 키가 32바이트가 아님 */
  constructor(key: Uint8Array) {
    if (key.length !== KEY_BYTES) throw new Error(`가상계좌 필드 암호화 키는 ${KEY_BYTES}바이트다`);
    this.#key = Buffer.from(key);
  }

  async seal(paymentId: string, accountNumber: string): Promise<string> {
    const aad = aadOf(paymentId);
    const dataKey = randomBytes(KEY_BYTES);
    const wrapped = encrypt(this.#key, aad, dataKey);
    const wrappedKey = Buffer.concat([wrapped.iv, wrapped.ct, wrapped.tag]);
    const body = encrypt(dataKey, aad, Buffer.from(accountNumber, 'utf8'));
    const head = Buffer.alloc(3);
    head.writeUInt8(VERSION, 0);
    head.writeUInt16BE(wrappedKey.length, 1);
    return Buffer.concat([head, wrappedKey, body.iv, body.tag, body.ct]).toString('base64');
  }

  async open(paymentId: string, sealed: string): Promise<string> {
    try {
      const b = Buffer.from(sealed, 'base64');
      if (b.length < 3 || b.readUInt8(0) !== VERSION) throw new CipherFailure();
      const n = b.readUInt16BE(1);
      if (n !== WRAPPED_BYTES || b.length < 3 + n + IV_BYTES + TAG_BYTES + 1) throw new CipherFailure();
      const aad = aadOf(paymentId);
      const w = b.subarray(3, 3 + n);
      const dataKey = decrypt(this.#key, aad, w.subarray(0, IV_BYTES), w.subarray(IV_BYTES + KEY_BYTES), w.subarray(IV_BYTES, IV_BYTES + KEY_BYTES));
      const at = 3 + n;
      return decrypt(dataKey, aad, b.subarray(at, at + IV_BYTES), b.subarray(at + IV_BYTES, at + IV_BYTES + TAG_BYTES), b.subarray(at + IV_BYTES + TAG_BYTES)).toString('utf8');
    } catch {
      throw new CipherFailure();
    }
  }

  toJSON(): string {
    return '[LocalVirtualAccountCipher]';
  }
}

/**
 * 설정에서 만든다. 경고는 부른 쪽이 로그로 남긴다.
 * @throws Error local·ci·demo 밖에 키 값이 있음, 32바이트가 아님(시작 실패). 글에 키 값을 싣지 않는다
 */
export function virtualAccountCipherFromEnv(env: Record<string, string | undefined>): { cipher: VirtualAccountCipher; warnings: string[] } {
  const raw = env[KEY_ENV];
  if (raw) {
    const peaketEnv = env.PEAKET_ENV ?? 'prod';
    if (!KEY_VALUE_ENVS.has(peaketEnv)) throw new Error(`${KEY_ENV}(필드 암호화 키 값)는 ${[...KEY_VALUE_ENVS].join('·')}에서만 쓴다`);
    const key = Buffer.from(raw, 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`${KEY_ENV}는 base64 ${KEY_BYTES}바이트여야 한다`);
    return { cipher: new LocalVirtualAccountCipher(key), warnings: [] };
  }
  const why = env[KMS_ENV] ? `${KMS_ENV}가 있지만 KMS에서 키를 받는 길이 아직 없어(HOT-146)` : `${KEY_ENV}가 없어`;
  return { cipher: new NoKeyVirtualAccountCipher(), warnings: [`${why} 가상계좌 번호를 저장하지 않는다(payment §6)`] };
}
