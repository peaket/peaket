// 기기 가명(docs/features/bot-defense.md §3.2·§4.9, ADR-0171 결정 4, ADR-0251): deviceRef = invRef("device", deviceId) = "k" + 판 + "." + base64url(HMAC-SHA256(device 라벨 키, deviceId)).
// identity-svc의 device.device_ref와 같은 값이 되도록 같은 공용 라벨 키 링(packages/platform)을 쓴다. 라벨 키는 운영에서 KMS GenerateMac으로 받고(메모리 10분, 5분마다 다시 받기), local·ci·demo는 설정값으로 받는다.
// 키가 없으면 판정을 막지 않고 기기 신호를 '값 없음'으로 둔다(ref가 undefined). 키 회전의 이음(옛 판 값에서 옮기기)은 BUILD_ORDER BOT-065다.
import { type Clock, InvRefKeyRing, invRefSourcesFromEnv, type LabelMacClient } from '@peaket/platform';
import type { DeviceRefs } from '../domain/ports.js';

export function deviceRefsFromEnv(env: Record<string, string | undefined>, clock: Clock, client?: (endpoint: string | undefined) => LabelMacClient): { refs: DeviceRefs; ring: InvRefKeyRing<'device'>; warnings: string[] } {
  const { sources, warnings, endpoint, needsKms, countUnconfigured } = invRefSourcesFromEnv(env, ['device'] as const, { previous: false });
  const ring = new InvRefKeyRing<'device'>({ sources, clock, countUnconfigured, ...(needsKms && client ? { client: client(endpoint) } : {}) });
  return { refs: { ref: (deviceId) => ring.ref('device', deviceId) }, ring, warnings };
}
