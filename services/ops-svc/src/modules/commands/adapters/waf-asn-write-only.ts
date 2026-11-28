// F-02-6(동결 로컬) WAF ASN 쓰기 전용 함수의 호출 골격. 실제 AWS 함수 호출·IAM·배포는 미실행이고 구간 5(F-09-4)가 잇는다.
// 이 클래스는 WafBlocks 전체를 구현하지 않는다: CIDR은 기존 IP 집합 어댑터(waf-ip-sets)가 맡고,
// F-09-4가 둘을 합친 WafBlocks 구현을 만든다. 지금 이 파일은 포트 모양과 실패 전달만 고정한다.
import type { WafBlockInput } from '../domain/edge-ports.js';

/** 실제 AWS 함수(또는 그 얇은 클라이언트)가 제공해야 하는 세 동작. 실패는 던진다 */
export interface WafAsnFunction {
  /** 그 명령의 ASN 목록을 만료 시각과 함께 멱등으로 쓴다 */
  put(commandId: string, asns: readonly number[], expiresAtMs: number): Promise<void>;
  /** 그 명령이 소유한 ASN만 뺀다(다른 명령의 같은 ASN은 남긴다) */
  remove(commandId: string): Promise<void>;
  /** 그 명령이 아직 소유한 ASN 목록 */
  list(commandId: string): Promise<readonly number[]>;
}

/**
 * ASN만 다루는 어댑터. `WafBlocks`의 CIDR 쪽을 대신하지 않으므로 실행기에 직접 넣지 않는다.
 * F-09-4가 `AwsWafIpSets`(CIDR)와 이 어댑터를 합친 `WafBlocks`를 만든다.
 */
export class WafAsnWriteOnly {
  constructor(private readonly fn: WafAsnFunction) {}

  async applyAsns(commandId: string, block: Pick<WafBlockInput, 'asns' | 'expiresAtMs'>): Promise<void> {
    await this.fn.put(commandId, block.asns, block.expiresAtMs);
  }

  async releaseAsns(commandId: string): Promise<void> {
    await this.fn.remove(commandId);
  }

  async remainingAsns(commandId: string): Promise<readonly number[]> {
    return this.fn.list(commandId);
  }
}
