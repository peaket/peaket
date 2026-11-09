// 조사용 가명의 라벨 키 링(docs/features/identity.md §9.1 '조사용 값의 첫 구현'·'조사용 가명 키 회전 이음의 첫 구현', docs/security/secrets-and-keys.md '조사용 가명 키', BUILD_ORDER BOT-045·BOT-046).
// 받기·10분 수명·이음 기간의 동작은 공용 InvRefKeyRing(packages/platform)이 맡는다. trust-svc의 기기 가명과 같은 코드라야 값이 같다(B-T16, ADR-0251). 여기는 identity-svc의 라벨과 설정 읽기만 둔다.
import { type Clock, invRefEnvPrefix, InvRefKeyRing as SharedInvRefKeyRing, invRefSourcesFromEnv, type LabelMacClient } from '@peaket/platform';
import { INV_REF_LABELS, type InvRefLabel } from '../domain/inv-ref.js';
import type { InvRefBridge, InvRefBridges, InvRefs } from '../domain/ports.js';

export type { LabelMacClient, LabelSource, MissingReason } from '@peaket/platform';
export { KMS_ENDPOINT_ENV } from '@peaket/platform';

export class InvRefKeyRing extends SharedInvRefKeyRing<InvRefLabel> implements InvRefs {
  /**
   * 설정에서 만든다. client는 KMS 키가 하나라도 있을 때 쓴다(main이 kmsMacClient로 만든다). 라벨마다 `PEAKET_INV_REF_<라벨>_KMS_KEY`(local·ci·demo는 `…_KEY`)와 판 `…_KEY_VERSION`,
   * 이음 기간이면 옛 판 `…_PREVIOUS_KMS_KEY`(`…_PREVIOUS_KEY`)·`…_PREVIOUS_KEY_VERSION`과 이음 끝 `…_BRIDGE_UNTIL`(ISO 시각)
   */
  static fromEnv(
    env: Record<string, string | undefined>,
    clock: Clock,
    client?: (endpoint: string | undefined) => LabelMacClient,
    /** 받을 라벨(relay는 contact만) */
    labels: readonly InvRefLabel[] = INV_REF_LABELS,
    /** 옛 판 키도 받는가(relay는 받지 않는다: EMAIL 다시 계산은 새 판 키만 쓴다) */
    o: { previous?: boolean } = {},
  ): { ring: InvRefKeyRing; warnings: string[] } {
    const { sources, warnings, endpoint, needsKms, countUnconfigured } = invRefSourcesFromEnv(env, labels, o);
    return { ring: new InvRefKeyRing({ sources, clock, countUnconfigured, ...(needsKms && client ? { client: client(endpoint) } : {}) }), warnings };
  }

  /**
   * 키 없이 설정의 이음(옛 판과 이음 끝)만 읽는다. 라벨 키를 받지 않는 프로세스(relay의 옛 판 지우기)가 쓴다
   */
  static bridgesFromEnv(env: Record<string, string | undefined>): InvRefBridges {
    const out = new Map<InvRefLabel, InvRefBridge>();
    for (const label of INV_REF_LABELS) {
      const p = invRefEnvPrefix(label);
      const v = Number(env[`${p}_PREVIOUS_KEY_VERSION`] ?? '');
      const until = Date.parse(env[`${p}_BRIDGE_UNTIL`] ?? '');
      if (!(Number.isInteger(v) && v > 0 && !Number.isNaN(until))) continue;
      const writeVersion = Number(env[`${p}_KEY_VERSION`] ?? '1');
      // 옛 판이 지금 판보다 작지 않으면 지금 판 행을 지울 수 있다: 시작하지 않는다(새 맥락 리뷰 중간 4)
      if (!(v < writeVersion)) throw new Error(`${label} 옛 판(${v})은 지금 판(${writeVersion})보다 작아야 한다`);
      out.set(label, { prevVersion: v, until, writeVersion });
    }
    return { bridgeOf: (label) => out.get(label) ?? null };
  }
}
