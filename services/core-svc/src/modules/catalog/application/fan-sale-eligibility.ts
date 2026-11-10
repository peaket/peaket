// 유스케이스: 팬별 판매 자격(openapi GET /v1/events/{eventId}/sale-eligibility getFanSaleEligibility, ADR-0261 결정 5, ADR-0213 결정 1, BUILD_ORDER HOT-250).
// 공개 요약과 같은 404·410 규칙이다. 단계는 공개 요약 salePhases와 같은 조각(마지막 승인 내용의 규칙)이고, 단계마다 그 계정의 진입 판정과 나올 수 있는 한도 가운데
// 가장 작은 값을 준다. 명단은 그 계정이 든 이 공연의 것만(표시 이름·파기 예정 시각, 키·다른 사람 정보는 싣지 않는다). 표시용이고 집행은 진입·로비와 홀드가 한다.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { entryGate, salePhases } from '@peaket/validation/sale-policy';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports.js';
import { isPublic, saleEndsAt } from '../domain/production.js';
import { smallestAllowedLimit } from '../domain/sale-eligibility.js';

export interface FanSaleEligibilityView {
  eventId: string;
  phases: { kind: 'PRESALE' | 'GENERAL'; startsAt: string; endsAt: string; eligible: boolean; limitPerPerson: number }[];
  lists: { name: string; destroyAt: string }[];
}

@Injectable()
export class FanSaleEligibility {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(eventId: string, accountId: string): Promise<FanSaleEligibilityView | 'suspended' | undefined> {
    // 쿼리 둘: 회차·공연·등급 칸 하나, 그 계정의 명단 하나(공개 요약 전체 조회를 쓰지 않는다, 리뷰 C3)
    const e = await this.repo.findSaleEligibilityEvent(eventId);
    if (!e) return undefined;
    if (!isPublic(e)) return e.saleReview === 'SUSPENDED' && e.saleApprovedAt !== null ? 'suspended' : undefined;
    const rules = e.salePolicy;
    const now = new Date(this.clock.now());
    const lists = await this.repo.memberLists(e.productionId, accountId, now);
    const keys = lists.map((l) => l.key);
    const grades = e.grades;
    // 단계마다 그 조각의 시작 시각으로 계산한다(조각은 명단 키 집합이 같을 때만 합치므로 조각 안에서 대상이 바뀌지 않는다, 리뷰 A2)
    const phases = salePhases(rules, e.eventId, { openAt: e.openAt, saleEndsAt: saleEndsAt(e), perPersonLimit: e.perPersonLimit }).map((ph) => ({
      kind: ph.kind,
      startsAt: ph.startsAt.toISOString(),
      endsAt: ph.endsAt.toISOString(),
      eligible: entryGate(rules, { at: ph.startsAt, round: e.eventId, lists: keys }).allowed,
      // 그 계정에게 허용되는 경우가 없으면(대상이 아님) 단계 요약의 표시 한도를 준다
      limitPerPerson: smallestAllowedLimit(rules, { at: ph.startsAt, round: e.eventId, lists: keys, grades, roundLimit: e.perPersonLimit }) ?? ph.limitPerPerson,
    }));
    return { eventId: e.eventId, phases, lists: lists.map((l) => ({ name: l.name, destroyAt: l.destroyDueAt.toISOString() })) };
  }
}
