// 다시 만들기 반복의 회차 목록(SaleEventCatalog)을 좌석맵 판 폴더에서 읽는 어댑터(BUILD_ORDER PRF-164,
// docs/features/seat-hold.md §6 '릴레이 프로세스와 조립의 첫 구현' 다시 만들기 반복).
// 폴더의 판 파일 이름으로 회차를 찾고(FileSeatMapSource.list), 그 회차의 판(SeatMap.config)에서 판매 종료를 읽는다. 판을 읽지 못한 회차는 넘긴다.
// 구현에서 정한 것: 판은 회차마다 차례로 읽는다(동시에 읽지 않는다). 넘긴 회차는 이 어댑터가 따로 로그를 남기지 않는다(LayoutSeatMap이 읽기 실패를 경고 한 줄로 남긴다).
import type { SaleEvent, SaleEventCatalog, SeatMap } from '../domain/ports.js';

export interface SeatMapEventCatalogDeps {
  /** 판 파일이 있는 회차 ID들(운영은 FileSeatMapSource(PEAKET_SEATMAP_DIR). 폴더를 읽지 못하면 던진다) */
  files: { list(): Promise<string[]> };
  /** 회차의 판(운영은 LayoutSeatMap. 판이 없거나 틀리면 undefined) */
  seatMap: Pick<SeatMap, 'config'>;
}

/** SaleEventCatalog의 운영 구현 */
export class SeatMapEventCatalog implements SaleEventCatalog {
  constructor(private readonly deps: SeatMapEventCatalogDeps) {}

  /**
   * files.list()의 회차마다(그 차례 그대로) seatMap.config(eventId)를 읽어 { eventId, saleEndsAtMs: config.saleEndsAtMs }로 바꾼다.
   * config가 undefined인 회차(판이 없거나 틀림·읽지 못함)와 config가 던진 회차는 뺀다(던지지 않는다. 다른 회차는 그대로).
   * @throws Error files.list()가 던짐(폴더를 읽지 못함). 그대로 던진다
   */
  async list(): Promise<SaleEvent[]> {
    const ids = await this.deps.files.list();
    const out: SaleEvent[] = [];
    // 회차마다 차례로 읽는다(판 파일 해석이 한꺼번에 몰려 이벤트 루프를 오래 막지 않게. LayoutSeatMap은 읽은 판을 메모리에 둔다)
    for (const eventId of ids) {
      let saleEndsAtMs: number;
      try {
        const config = await this.deps.seatMap.config(eventId);
        if (config === undefined) continue;
        saleEndsAtMs = config.saleEndsAtMs;
      } catch {
        // 판을 읽지 못한 회차는 넘긴다(다른 회차는 그대로. LayoutSeatMap은 읽기 실패를 스스로 경고로 남긴다)
        continue;
      }
      out.push({ eventId, saleEndsAtMs });
    }
    return out;
  }
}
