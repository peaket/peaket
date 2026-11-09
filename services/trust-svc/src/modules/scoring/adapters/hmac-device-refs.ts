// 기기 가명(docs/features/bot-defense.md §3.2): deviceRef = "k" + 판 + "." + base64url(HMAC-SHA256(device 라벨 키, deviceId)).
// identity-svc의 device.device_ref와 같은 식이다. 지금은 라벨 키 값을 설정으로 받고(local·ci·demo, PEAKET_INV_REF_DEVICE_KEY),
// KMS GenerateMac 라벨 키(10분마다 다시 받기)와 키 회전의 옛 판은 BUILD_ORDER BOT-060이 identity의 InvRefKeyRing과 함께 맞춘다.
// 키가 없으면 판정을 막지 않고 기기 신호를 '값 없음'으로 둔다(ref가 undefined).
import { createHmac } from 'node:crypto';
import type { DeviceRefs } from '../domain/ports.js';

const KEY_VALUE_ENVS = ['local', 'ci', 'demo'];

export function hmacDeviceRefsFromEnv(env: Record<string, string | undefined>): { refs: DeviceRefs; warning?: string } {
  const peaketEnv = env.PEAKET_ENV || 'prod';
  const raw = env.PEAKET_INV_REF_DEVICE_KEY;
  if (!raw) return { refs: { ref: () => undefined }, warning: 'PEAKET_INV_REF_DEVICE_KEY가 없어 기기 가명을 만들지 못하고 기기 신호를 값 없음으로 둔다(BOT-060이 KMS 라벨 키를 잇는다)' };
  if (!KEY_VALUE_ENVS.includes(peaketEnv)) throw new Error(`PEAKET_INV_REF_DEVICE_KEY(라벨 키 값)는 ${KEY_VALUE_ENVS.join('·')}에서만 쓴다`);
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('PEAKET_INV_REF_DEVICE_KEY는 32바이트(base64)여야 한다');
  const version = Number(env.PEAKET_INV_REF_DEVICE_KEY_VERSION ?? '1');
  if (!(Number.isInteger(version) && version > 0)) throw new Error('PEAKET_INV_REF_DEVICE_KEY_VERSION은 양의 정수여야 한다');
  return { refs: { ref: (deviceId) => `k${version}.${createHmac('sha256', key).update(deviceId, 'utf8').digest('base64url')}` } };
}
