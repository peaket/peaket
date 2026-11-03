// 회차(performance) 목업. 공연 상세·대기열·좌석·결제 주소의 id(`/events/[id]`, `/booking/[eventId]/…`, `/queue/[eventId]`)가 회차 id다
// (API 이름으로는 event, docs/data.md §2). 판매 종료는 회차 시작 24시간 전(ADR-0064).
export type PerformanceStatus = 'upcoming' | 'on_sale' | 'sold_out' | 'ended';

export interface Performance {
  id: string;
  productionId: string;
  startsAt: string;
  /** 회차 칩 글 '10/25(일) 18:00' */
  label: string;
  status: PerformanceStatus;
  /** 양도 마감(공연 시작 2시간 전과 입장 시작 중 이른 때) '10/25(일) 16:00' */
  transferDeadlineText: string;
  /** 입장 시작 '16:30' */
  gateOpenText?: string;
}

export const PERFORMANCES: readonly Performance[] = [
  { id: 'evt-lumen-1025', productionId: 'prd-lumen', startsAt: '2026-10-25T18:00:00+09:00', label: '10/25(일) 18:00', status: 'on_sale', transferDeadlineText: '10/25(일) 16:00', gateOpenText: '16:30' },
  { id: 'evt-lumen-1026', productionId: 'prd-lumen', startsAt: '2026-10-26T17:00:00+09:00', label: '10/26(월) 17:00', status: 'on_sale', transferDeadlineText: '10/26(월) 15:00', gateOpenText: '15:30' },
  { id: 'evt-fest-1107', productionId: 'prd-fest', startsAt: '2026-11-07T12:00:00+09:00', label: '11/7(토) 12:00', status: 'on_sale', transferDeadlineText: '11/7(토) 10:00', gateOpenText: '10:30' },
  { id: 'evt-musical-1101', productionId: 'prd-musical', startsAt: '2026-11-01T19:30:00+09:00', label: '11/1(일) 19:30', status: 'sold_out', transferDeadlineText: '11/1(일) 17:30' },
  { id: 'evt-musical-1102', productionId: 'prd-musical', startsAt: '2026-11-02T19:30:00+09:00', label: '11/2(월) 19:30', status: 'sold_out', transferDeadlineText: '11/2(월) 17:30' },
  { id: 'evt-musical-1103', productionId: 'prd-musical', startsAt: '2026-11-03T19:30:00+09:00', label: '11/3(화) 19:30', status: 'sold_out', transferDeadlineText: '11/3(화) 17:30' },
  { id: 'evt-fanmeet-1114', productionId: 'prd-fanmeet', startsAt: '2026-11-14T18:00:00+09:00', label: '11/14(토) 18:00', status: 'upcoming', transferDeadlineText: '11/14(토) 16:00' },
  { id: 'evt-gala-1121', productionId: 'prd-starlight-gala', startsAt: '2026-11-21T19:00:00+09:00', label: '11/21(토) 19:00', status: 'upcoming', transferDeadlineText: '11/21(토) 17:00' },
  { id: 'evt-gala-1122', productionId: 'prd-starlight-gala', startsAt: '2026-11-22T17:00:00+09:00', label: '11/22(일) 17:00', status: 'upcoming', transferDeadlineText: '11/22(일) 15:00' },
  { id: 'evt-jazz-1127', productionId: 'prd-jazz-night', startsAt: '2026-11-27T20:00:00+09:00', label: '11/27(금) 20:00', status: 'upcoming', transferDeadlineText: '11/27(금) 18:00' },
  { id: 'evt-orch-1205', productionId: 'prd-winter-orch', startsAt: '2026-12-05T19:00:00+09:00', label: '12/5(토) 19:00', status: 'upcoming', transferDeadlineText: '12/5(토) 17:00' },
  { id: 'evt-window-1201', productionId: 'prd-play-window', startsAt: '2026-12-01T20:00:00+09:00', label: '12/1(화) 20:00', status: 'upcoming', transferDeadlineText: '12/1(화) 18:00' },
  { id: 'evt-garden-1101', productionId: 'prd-classic-garden', startsAt: '2026-11-01T17:00:00+09:00', label: '11/1(일) 17:00', status: 'on_sale', transferDeadlineText: '11/1(일) 15:00' },
  { id: 'evt-city-1031', productionId: 'prd-jazz-city', startsAt: '2026-10-31T19:00:00+09:00', label: '10/31(토) 19:00', status: 'sold_out', transferDeadlineText: '10/31(토) 17:00' },
  { id: 'evt-comedy-1113', productionId: 'prd-comedy', startsAt: '2026-11-13T19:30:00+09:00', label: '11/13(금) 19:30', status: 'on_sale', transferDeadlineText: '11/13(금) 17:30' },
];

/** 대표 회차 id(E-1 LUMEN 첫 회차). 다른 담당이 경로 예시로 쓴다 */
export const DEMO_EVENT_ID = 'evt-lumen-1025';

export function getPerformance(id: string): Performance | undefined {
  return PERFORMANCES.find((p) => p.id === id);
}

export function listPerformances(productionId: string): Performance[] {
  return PERFORMANCES.filter((p) => p.productionId === productionId);
}

/** 공연 상세(회차) 주소 */
export function eventHref(performanceId: string): string {
  return `/events/${performanceId}`;
}
