// 기기 가명 invRef("device", deviceId) = "k" + 판 + "." + base64url(HMAC-SHA256(라벨 키, deviceId))(docs/security/secrets-and-keys.md `inv-ref-key`).
// 운영은 라벨 키를 KMS GenerateMac으로 받아 10분 [가정]마다 다시 받는다(그 연결은 KMS를 쓰는 단계가 한다).
// 지금은 로컬·CI용 설정값 하나이고, 없으면 기기 행을 쓰지 않는다(docs/features/identity.md §2 '기기 한도'·§10).
import { createHmac } from 'node:crypto';
import type { DeviceRefs } from '../domain/ports.js';

export const DEVICE_LABEL_KEY_ENV = 'PEAKET_INV_REF_DEVICE_KEY';
export const DEVICE_LABEL_KEY_VERSION_ENV = 'PEAKET_INV_REF_DEVICE_KEY_VERSION';

export class HmacDeviceRefs implements DeviceRefs {
  readonly #key: Buffer | undefined;
  constructor(
    key: Buffer | undefined,
    private readonly version: number,
  ) {
    if (key !== undefined && key.length !== 32) throw new Error('기기 라벨 키는 32바이트다');
    if (!(Number.isInteger(version) && version > 0)) throw new Error('기기 라벨 키 판은 양의 정수다');
    this.#key = key && Buffer.from(key);
  }

  static fromEnv(env: Record<string, string | undefined>): { refs: HmacDeviceRefs; warning?: string } {
    const raw = env[DEVICE_LABEL_KEY_ENV];
    const version = Number(env[DEVICE_LABEL_KEY_VERSION_ENV] ?? '1');
    if (!raw) return { refs: new HmacDeviceRefs(undefined, version), warning: `${DEVICE_LABEL_KEY_ENV}가 없어 로그인의 기기 행을 쓰지 않는다(identity §10)` };
    return { refs: new HmacDeviceRefs(Buffer.from(raw, 'base64'), version) };
  }

  ref(deviceId: string): string | undefined {
    if (!this.#key) return undefined;
    return `k${this.version}.${createHmac('sha256', this.#key).update(deviceId, 'utf8').digest('base64url')}`;
  }

  toJSON(): string {
    return '[HmacDeviceRefs]';
  }
}
