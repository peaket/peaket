// 좌석 스냅샷 읽기(GET /v1/events/{eventId}/seatmap-snapshot, docs/features/seat-hold.md §2 '스냅샷 API의 첫 구현', BUILD_ORDER PRF-137).
// 차례: 회차 설정 → 구역 검사 → 구매 세션 열기(입장 토큰의 첫 사용) → 스냅샷 읽기 Lua → 이진 본문.
import type { Clock, Deadline } from '@peaket/platform';
import { KEY_PART, SEAT_CALL_CAP_MS } from '../domain/hold.js';
import type { SeatMap, SeatMapSections, SeatSnapshots } from '../domain/ports.js';
import type { SectionRange } from '../domain/seat-layout.js';
import { encodeSnapshot, lsbFirstBits, U32_MAX } from '../domain/snapshot.js';
import type { OpenPurchaseSession } from './open-purchase-session.js';

/** 구역 검사·준비 상태 거절(구매 세션 열기의 거절은 OpenSessionError가 그대로 나간다) */
export type SnapshotErrorCode =
  /** 그 회차 좌석맵 판이 없거나 세대 키가 없다(좌석 저장소가 준비되지 않음). 받는 층이 503 seat-store-unavailable로 바꾼다 */
  | 'NOT_READY'
  /** section이 판의 구역 수 밖이다. 받는 층이 400으로 바꾼다 */
  | 'SECTION_OUT_OF_RANGE';

export class SnapshotError extends Error {
  constructor(readonly code: SnapshotErrorCode) {
    super(`스냅샷 거절: ${code}`);
    this.name = 'SnapshotError';
  }
}

export interface ReadSeatSnapshotDeps {
  opener: Pick<OpenPurchaseSession, 'execute'>;
  seatMap: SeatMap & SeatMapSections;
  snapshots: SeatSnapshots;
  clock: Clock;
}

export interface SnapshotCommand {
  /** 주소의 회차(KEY_PART 모양이어야 한다. 아니면 RangeError) */
  eventId: string;
  accountId: string;
  loginSessionId: string;
  /** X-Admission-Token 머리 값 */
  token: unknown;
  /** X-Client-Ephemeral-Key 머리 값. 세션이 열린 뒤의 재요청은 없어도 된다 */
  clientKey: unknown;
  /** ?section= 구역 색인(이미 정수로 읽은 값). 없으면 전체 */
  section: number | undefined;
  /** 요청의 남은 시간(좌석 Redis 호출 마감) */
  deadline?: Deadline;
}

export class ReadSeatSnapshot {
  constructor(private readonly deps: ReadSeatSnapshotDeps) {}

  /**
   * 이진 본문(domain/snapshot.ts encodeSnapshot)을 돌려준다.
   * 차례: ① seatMap.config(없으면 NOT_READY) ② section이 있고 판의 구역 수 밖이면 SECTION_OUT_OF_RANGE ③ opener.execute(거절은 OpenSessionError, 좌석 Redis 장애는 SeatStoreUnavailable)
   * ④ snapshots.read(NOT_READY면 NOT_READY, 좌석 Redis 호출 마감은 홀드와 같이 min(남은 시간, SEAT_CALL_CAP_MS)) ⑤ 본문 만들기.
   * 전체면 비트 0 ~ seatCount − 1과 모든 구역, 구역 하나만이면 그 구역 범위와 그 구역 하나다. 구역이 하나도 없는 판이면 NOT_READY가 아니라 구역 표가 빈 본문이다.
   * @throws SnapshotError, OpenSessionError, SeatStoreUnavailable, RangeError(eventId 모양)
   */
  async execute(c: SnapshotCommand): Promise<Buffer> {
    if (typeof c.eventId !== 'string' || !KEY_PART.test(c.eventId)) throw new RangeError('eventId가 키 조각 모양이 아니다');
    const config = await this.deps.seatMap.config(c.eventId);
    const sections = config ? await this.deps.seatMap.sections(c.eventId) : undefined;
    if (!config || !sections) throw new SnapshotError('NOT_READY');
    let range: SectionRange | undefined;
    if (c.section !== undefined) {
      range = sections.find((s) => s.sectionIndex === c.section);
      if (!range) throw new SnapshotError('SECTION_OUT_OF_RANGE');
    }
    // 판 번호는 앞 0 없는 10진 정수 글이어야 한다(Number('')가 0이 되는 것을 막는다)
    const layoutVersion = /^(0|[1-9][0-9]{0,9})$/.test(config.layoutVersion) ? Number(config.layoutVersion) : Number.NaN;
    if (!Number.isSafeInteger(layoutVersion) || layoutVersion > U32_MAX) throw new Error('좌석맵 판 번호가 0 ~ 2^32 − 1의 정수 글이 아니다');

    // 입장 토큰의 첫 사용: 구매 세션을 연다(읽기가 실패해도 세션은 남는다. 같은 입장 토큰으로 다시 받으면 REPLAY다)
    await this.deps.opener.execute({ token: c.token, accountId: c.accountId, loginSessionId: c.loginSessionId, eventId: c.eventId, clientKey: c.clientKey });

    const firstBit = range ? range.from : 0;
    const bitCount = range ? range.to - range.from + 1 : config.seatCount;
    const carried = range ? [range.sectionIndex] : sections.map((s) => s.sectionIndex);
    const opt = c.deadline ? { deadlineMs: Math.max(1, Math.floor(c.deadline.budgetFor(SEAT_CALL_CAP_MS))) } : undefined;
    // 구역이 하나도 없는 판도 세대와 비트맵을 읽어야 해서 구역 색인 하나(0)를 읽고 본문에는 싣지 않는다
    const r = await this.deps.snapshots.read({ eventId: c.eventId, firstBit, bitCount, sectionIndexes: carried.length > 0 ? carried : [0] }, opt);
    if (r.kind === 'NOT_READY') throw new SnapshotError('NOT_READY');
    return encodeSnapshot({
      layoutVersion,
      seatEpoch: r.seatEpoch,
      sectionOnly: range !== undefined,
      sections: carried.map((sectionIndex, k) => ({ sectionIndex, sectionVersion: r.sectionVersions[k]! })),
      bitmap: lsbFirstBits(r.bytes, Math.floor(firstBit / 8), firstBit, bitCount),
    });
  }
}
