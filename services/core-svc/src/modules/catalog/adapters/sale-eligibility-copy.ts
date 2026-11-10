// 판매 자격 명단 사본 넘기기 어댑터(포트 SaleEligibilityCopy, ADR-0261 결정 9).
// 누가 대기열 Redis에 쓰는지는 소유자 결정 대기다(BAT-157 계획 OPEN 초안). 그때까지 운영 조립은 UnwiredSaleEligibilityCopy로 늘 실패하고
// 경고 지표 sale_eligibility_copy_unwired_total을 올린다(조용히 넘어간 것으로 보이지 않게). 메모리 어댑터는 시험이 넘긴 값을 본다.
import { Counter, type Registry } from '@peaket/platform';
import type { EligibilityCopyDrop, EligibilityCopyPut, MemberCodeDirectory, SaleEligibilityCopy } from '../domain/eligibility-ports.js';
import { MemberCodeLookupFailed } from '../domain/eligibility-ports.js';

/** 사본을 쓰는 쪽이 아직 없다 */
export class SaleEligibilityCopyUnwired extends Error {
  constructor() {
    super('판매 자격 명단 사본을 쓰는 쪽이 정해지지 않았다(ADR-0261 결정 9)');
    this.name = 'SaleEligibilityCopyUnwired';
  }
}

export class UnwiredSaleEligibilityCopy implements SaleEligibilityCopy {
  /** 쓰는 쪽이 없다: 정비 일은 구성원을 읽지 않고 넘길 명단 수만 센다(리뷰 C1) */
  readonly connected = false;
  readonly #unwired = new Counter({ name: 'sale_eligibility_copy_unwired_total', help: '쓰는 쪽이 정해지지 않아 넘기지 못한 판매 자격 명단 사본(op: put·drop, ADR-0261 결정 9). 0보다 크면 명단이 진입 대조에 쓰이지 않는다', labelNames: ['op'] as const, registers: [] });

  /** 서비스·relay의 지표 등록부에 단다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#unwired);
    return this;
  }

  async put(_c: EligibilityCopyPut): Promise<void> {
    this.#unwired.inc({ op: 'put' });
    throw new SaleEligibilityCopyUnwired();
  }

  async drop(_c: EligibilityCopyDrop): Promise<void> {
    this.#unwired.inc({ op: 'drop' });
    throw new SaleEligibilityCopyUnwired();
  }
}

/** 시험·로컬: 넘긴 값을 모은다. failing이면 던진다 */
export class MemorySaleEligibilityCopy implements SaleEligibilityCopy {
  readonly connected = true;
  readonly puts: EligibilityCopyPut[] = [];
  readonly drops: EligibilityCopyDrop[] = [];
  failing = false;

  async put(c: EligibilityCopyPut): Promise<void> {
    if (this.failing) throw new Error('사본 넘기기 실패(시험)');
    this.puts.push({ ...c, eventIds: [...c.eventIds], accountIds: [...c.accountIds] });
  }

  async drop(c: EligibilityCopyDrop): Promise<void> {
    if (this.failing) throw new Error('사본 지우기 실패(시험)');
    this.drops.push({ eventIds: [...c.eventIds], listKey: c.listKey, version: c.version });
  }
}

/** 시험 기본값: 회원 코드 변환을 잇지 않았으면 늘 실패한다(조용히 통과시키지 않는다) */
export const unavailableMemberCodes: MemberCodeDirectory = {
  resolve: async () => {
    throw new MemberCodeLookupFailed('UNAVAILABLE');
  },
};
