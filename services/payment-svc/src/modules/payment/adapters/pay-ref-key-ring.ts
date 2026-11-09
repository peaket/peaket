// 결제 수단 연결값의 라벨 키 pay(docs/features/payment.md §2.1 '결제 수단 연결값의 첫 구현', docs/security/secrets-and-keys.md '조사용 가명 키', BUILD_ORDER HOT-145).
// invRef(라벨, 값) = "k" + 판 + "." + base64url(HMAC-SHA256(라벨 키, 값))(identity-svc domain/inv-ref.ts와 같은 계산).
// 라벨 키 값 설정은 local·ci·demo에서만 받는다. KMS에서 받는 길은 아직 없다(payment-svc에 KMS 클라이언트가 없다, BUILD_ORDER HOT-146). KMS 키 설정이 있어도 경고하고 라벨 키 없음으로 둔다(결제는 막지 않고, 지표 NO_KEY로 센다).
// 라벨 키는 비공개 칸에만 둔다. 객체를 로그로 찍거나 JSON으로 바꿔도 실리지 않는다([ASVS v5.0.0-16.2.5]).
import { createHmac } from 'node:crypto';
import type { PaymentMethodRefs } from '../domain/ports.js';

const KEY_ENV = 'PEAKET_INV_REF_PAY_KEY';
const VERSION_ENV = 'PEAKET_INV_REF_PAY_KEY_VERSION';
const KMS_ENV = 'PEAKET_INV_REF_PAY_KMS_KEY';
/** 라벨 키 값 설정을 받는 환경(identity-svc 라벨 키와 같다). 운영·스테이징은 KMS 키만 */
const KEY_VALUE_ENVS: ReadonlySet<string> = new Set(['local', 'ci', 'demo']);
const KEY_BYTES = 32;

export class PayRefKeyRing implements PaymentMethodRefs {
  readonly #key: Uint8Array | undefined;
  readonly #version: number;

  /**
   * 설정에서 만든다. 경고는 부른 쪽이 로그로 남긴다.
   * @throws Error local·ci·demo 밖에 라벨 키 값이 있음, 32바이트가 아님, 판이 양의 정수가 아님(시작 실패). 글에 키 값을 싣지 않는다
   */
  static fromEnv(env: Record<string, string | undefined>): { ring: PayRefKeyRing; warnings: string[] } {
    const raw = env[KEY_ENV];
    if (raw) {
      const peaketEnv = env.PEAKET_ENV ?? 'prod';
      if (!KEY_VALUE_ENVS.has(peaketEnv)) throw new Error(`${KEY_ENV}(라벨 키 값)는 ${[...KEY_VALUE_ENVS].join('·')}에서만 쓴다`);
      const key = Buffer.from(raw, 'base64');
      if (key.length !== KEY_BYTES) throw new Error(`${KEY_ENV}는 base64 ${KEY_BYTES}바이트여야 한다`);
      return { ring: new PayRefKeyRing({ key, version: versionOf(env[VERSION_ENV]) }), warnings: [] };
    }
    const why = env[KMS_ENV] ? `${KMS_ENV}가 있지만 KMS에서 라벨 키를 받는 길이 아직 없어` : `${KEY_ENV}가 없어`;
    return { ring: new PayRefKeyRing(), warnings: [`${why} 결제 수단 연결값을 늘 비운다(payment §2.1)`] };
  }

  constructor(o?: { key: Uint8Array; version: number }) {
    this.#key = o?.key;
    this.#version = o?.version ?? 0;
  }

  /** invRef("pay", 값). 라벨 키가 없으면 undefined */
  ref(value: string): string | undefined {
    if (this.#key === undefined) return undefined;
    return `k${this.#version}.${createHmac('sha256', this.#key).update(value, 'utf8').digest('base64url')}`;
  }

  toJSON(): string {
    return '[PayRefKeyRing]';
  }
}

function versionOf(raw: string | undefined): number {
  const text = raw ?? '1';
  const version = Number(text);
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(version)) throw new Error(`${VERSION_ENV}의 판은 양의 정수다`);
  return version;
}
