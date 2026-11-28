// F-02-6(동결 로컬) WAF 포트의 시험·local 가짜. 명령 ID별 소유를 기억해 apply는 멱등(합집합)이고,
// release는 그 명령이 소유한 항목만 뺀다(다른 명령의 같은 대역·ASN은 남는다).
// 실제 AWS 호출은 미실행이다(control-tower §5 'AWS WAF API', ADR-0349 결정 9·10).
import { WafBlockApplyError, type WafBlockInput, type WafBlockPart, type WafBlockRemaining, type WafBlocks } from '../domain/edge-ports.js';

interface OwnedBlock {
  cidrs: string[];
  asns: number[];
}

export class MemoryWafBlocks implements WafBlocks {
  readonly #owned = new Map<string, OwnedBlock>();
  /** 시험 손잡이: 이 부분을 더하다 실패한다(부분 성공 재시험). cidr는 아무것도 더하지 않고, asn은 CIDR을 더한 뒤 실패한다 */
  failApplyPart: WafBlockPart | undefined;

  async apply(commandId: string, block: WafBlockInput): Promise<void> {
    if (this.failApplyPart === 'cidr') throw new WafBlockApplyError('cidr');
    const cur = this.#owned.get(commandId) ?? { cidrs: [], asns: [] };
    for (const cidr of block.cidrs) if (!cur.cidrs.includes(cidr)) cur.cidrs.push(cidr);
    this.#owned.set(commandId, cur);
    if (this.failApplyPart === 'asn') throw new WafBlockApplyError('asn');
    for (const asn of block.asns) if (!cur.asns.includes(asn)) cur.asns.push(asn);
  }

  async release(commandId: string): Promise<void> {
    this.#owned.delete(commandId);
  }

  async remaining(commandId: string): Promise<WafBlockRemaining> {
    const cur = this.#owned.get(commandId);
    return { cidrs: [...(cur?.cidrs ?? [])], asns: [...(cur?.asns ?? [])] };
  }
}
