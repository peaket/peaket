// 기기 가명(docs/features/bot-defense.md §3.2·§4.9·§4.10, ADR-0171 결정 4, ADR-0251): deviceRef = invRef("device", deviceId) = "k" + 판 + "." + base64url(HMAC-SHA256(device 라벨 키, deviceId)).
// identity-svc의 device.device_ref와 같은 값이 되도록 같은 공용 라벨 키 링(packages/platform)을 쓴다. 라벨 키는 운영에서 KMS GenerateMac으로 받고(메모리 10분, 5분마다 다시 받기), local·ci·demo는 설정값으로 받는다.
// 키가 없으면 판정을 막지 않고 기기 신호를 '값 없음'으로 둔다(ref가 undefined).
// 키 회전의 이음 기간에는 옛 판(PEAKET_INV_REF_DEVICE_PREVIOUS_*)과 이음 끝(PEAKET_INV_REF_DEVICE_BRIDGE_UNTIL)을 identity-svc와 같은 이름으로 읽고,
// prev가 옛 판 값과 이음 끝을 준다(이음 끝이 지났거나 옛 판 라벨 키를 받지 못했으면 없음, §4.10).
import { type Clock, InvRefKeyRing, invRefSourcesFromEnv, type LabelMacClient } from '@peaket/platform';
import type { DeviceRefs } from '../domain/ports.js';

export function deviceRefsFromEnv(env: Record<string, string | undefined>, clock: Clock, client?: (endpoint: string | undefined) => LabelMacClient): { refs: DeviceRefs; ring: InvRefKeyRing<'device'>; warnings: string[] } {
  const { sources, warnings, endpoint, needsKms, countUnconfigured } = invRefSourcesFromEnv(env, ['device'] as const);
  const ring = new InvRefKeyRing<'device'>({ sources, clock, countUnconfigured, ...(needsKms && client ? { client: client(endpoint) } : {}) });
  return {
    refs: {
      ref: (deviceId) => ring.ref('device', deviceId),
      prev: (deviceId) => {
        const bridge = ring.bridgeOf('device');
        if (!bridge) return undefined;
        // prevRef는 이음 끝이 지났거나 옛 판 라벨 키가 없으면 비운다(받지 못한 것은 inv_ref_missing_total로 센다)
        const ref = ring.prevRef('device', deviceId);
        return ref === undefined ? undefined : { ref, until: bridge.until };
      },
      // 판정이 읽는 판: 지금 판과(이음 끝 전이면) 옛 판. 라벨 반영이 다른 판의 기기 가명에 쓰지 않게 한다(§9 '기기 가명 찾기')
      versions: () => {
        const current = ring.writeVersion('device');
        const bridge = ring.bridgeOf('device');
        return [...(current === null ? [] : [current]), ...(bridge && bridge.until > clock.now() ? [bridge.prevVersion] : [])];
      },
    },
    ring,
    warnings,
  };
}
