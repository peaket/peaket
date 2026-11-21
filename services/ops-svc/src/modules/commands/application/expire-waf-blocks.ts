// 만료 차단 정리 작업의 한 실행(ADR-0349 결정 9, docs/features/control-tower.md §5 'AWS WAF API' 행, C-T61 ①~⑤).
// 가족(IPv4·IPv6)마다: 보기 waf_block_expiry_v와 IP 집합을 읽어 뺄 대역을 고르고(domain/block-expiry.ts blockRemovalOf), 읽은 잠금 토큰으로 남길 전체를 쓴다.
// 잠금 토큰 충돌이면 보기와 집합을 다시 읽어 한 번 더 한다(그사이 더해진 대역은 다시 읽은 목록에 있어 남는다). 또 실패하거나 읽지 못하면 그 가족은 실패다.
// 뺀 대역과 명령 ID는 JSON 한 줄(kind waf-block-expired)로 남긴다. ops-svc를 부르지 않고 명령 상태를 쓰지 않는다(AUTO_EXPIRED는 ops-svc 정비가 확인 뒤 적는다).
import { WafLockConflict, blockRemovalOf, type BlockExpiryView, type IpFamily, type WafIpSets } from '../domain/block-expiry.js';

export type { BlockExpiryView } from '../domain/block-expiry.js';

export type ExpirerLog = (level: 'info' | 'warn' | 'error', fields: Record<string, unknown>, msg: string) => void;

export interface WafExpiryFamilyResult {
  readonly family: IpFamily;
  readonly removed: readonly string[];
  readonly commandIds: readonly string[];
  /** 잠금 토큰 충돌로 다시 한 횟수(0·1) */
  readonly retried: number;
  /** 실패 까닭(성공이면 없다): lock-conflict(두 번 충돌) 또는 오류 이름 */
  readonly error?: string;
}

export interface WafExpiryRun {
  readonly families: readonly WafExpiryFamilyResult[];
  /** 하나라도 실패했는가(끝 코드 1) */
  readonly failed: boolean;
}

const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === 'string' ? n : 'Error';
};

export class ExpireWafBlocks {
  constructor(
    private readonly deps: {
      readonly view: BlockExpiryView;
      readonly ipSets: WafIpSets;
      readonly log?: ExpirerLog;
    },
  ) {}

  async run(nowMs: number): Promise<WafExpiryRun> {
    const families: WafExpiryFamilyResult[] = [];
    for (const family of [4, 6] as const) families.push(await this.#family(family, nowMs));
    return { families, failed: families.some((f) => f.error !== undefined) };
  }

  async #family(family: IpFamily, nowMs: number): Promise<WafExpiryFamilyResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const rows = await this.deps.view.rows();
        const snap = await this.deps.ipSets.get(family);
        const removal = blockRemovalOf(family, snap.addresses, rows, nowMs);
        if (removal.addresses.length === 0) return { family, removed: [], commandIds: [], retried: attempt };
        await this.deps.ipSets.replace(family, removal.keep, snap.lockToken);
        this.deps.log?.('info', { kind: 'waf-block-expired', family: `IPV${family}`, cidrs: removal.addresses, commandIds: removal.commandIds }, '만료가 지난 명령 4의 대역을 IP 집합에서 뺐다');
        return { family, removed: removal.addresses, commandIds: removal.commandIds, retried: attempt };
      } catch (e) {
        if (e instanceof WafLockConflict && attempt === 0) {
          this.deps.log?.('warn', { family: `IPV${family}` }, 'IP 집합 잠금 토큰이 낡아 다시 읽어 한 번 더 한다');
          continue;
        }
        const error = e instanceof WafLockConflict ? 'lock-conflict' : errorName(e);
        this.deps.log?.('error', { family: `IPV${family}`, err: error }, '만료 차단 정리가 이 IP 집합에서 실패했다(다음 실행에서 다시)');
        return { family, removed: [], commandIds: [], retried: attempt, error };
      }
    }
    return { family, removed: [], commandIds: [], retried: 1, error: 'lock-conflict' };
  }
}
