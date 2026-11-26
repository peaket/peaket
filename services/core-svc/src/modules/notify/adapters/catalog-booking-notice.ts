// F-06-8 예매 확정 이메일의 catalog 읽기: 공연명·장소·회차 시각·등급 이름·판매자 7항목(notify §4.9.2).
// 판매자 정보는 작업을 만들 때가 아니라 보낼 때 읽는다(ADR-0388). 값이 없으면 seller=null로 돌려 이메일만 재시도한다.
import type { CatalogRepository } from '../../catalog/index.js';
import type { BookingNoticeCatalog, NoticeCatalogView } from '../domain/fan-notify-ports.js';

export class CatalogBookingNoticeView implements NoticeCatalogView {
  constructor(private readonly repo: CatalogRepository) {}

  async getBookingNotice(eventId: string, tierIds: readonly string[]): Promise<BookingNoticeCatalog | undefined> {
    const row = await this.repo.findEventSummary(eventId);
    if (!row) return undefined;
    const s = row.seller;
    const filled = (v: string | null): v is string => v !== null && v.trim() !== '';
    const hasReportOrExemption = filled(s.mailOrderReportNo ?? null) || filled(s.exemptionBasis ?? null);
    const seller =
      filled(s.representative) && filled(s.address) && filled(s.phone) && filled(s.email) && filled(s.businessRegNo) && hasReportOrExemption
        ? {
            legalName: s.legalName,
            representative: s.representative,
            address: s.address,
            phone: s.phone,
            email: s.email,
            businessRegNo: s.businessRegNo,
            ...(filled(s.mailOrderReportNo ?? null) ? { mailOrderReportNo: s.mailOrderReportNo! } : {}),
            ...(filled(s.exemptionBasis ?? null) ? { exemptionBasis: s.exemptionBasis! } : {}),
          }
        : null;
    const names = new Map(row.priceTiers.map((t) => [t.tierId, t.name]));
    const tierNames: Record<string, string> = {};
    for (const id of tierIds) {
      const name = names.get(id);
      if (name !== undefined) tierNames[id] = name;
    }
    return {
      productionName: row.production.title,
      venueName: row.place?.name ?? '',
      eventStartsAt: row.event.startsAt.toISOString(),
      tierNames,
      seller,
    };
  }
}
