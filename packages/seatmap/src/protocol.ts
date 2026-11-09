// 메인 ↔ 좌석맵 Worker 메시지(docs/frontend.md §4.7 'Worker 메시지', BUILD_ORDER HOT-110). 받는 쪽이 Zod로 검사한다.
// 메시지 종류는 type 칸이고, 누르기 종류는 pointer의 kind 칸이다(§4.7의 pointer{type}는 이 kind다).
// 지금 있는 것(HOT-110·HOT-120): 첫 그림·카메라([+]·[−]·[전체 보기]·구역으로 확대)·누르기·고르기·테마, 단계 알림(view).
// 구역 구독·연결 상태는 HOT-357에서 더한다. 목록 열기(HOT-354, ADR-0227)는 listSections·listSection → sectionList·sectionState·stateChanged다.
import { z } from 'zod';

const int = z.number().int();
const nonNeg = int.nonnegative();

/** 접근성 목록의 좌석 상태 코드(states 배열의 값 = 이 배열의 색인). 휠체어석은 상태가 아니라 좌석의 속성이다(seats.wheelchair) */
export const LIST_STATES = ['available', 'held-by-others', 'mine', 'sold', 'unavailable'] as const;
const Bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, { message: '바이트 배열이 아니다' });
const Offsets = z.custom<Uint32Array>((v) => v instanceof Uint32Array, { message: '32비트 배열이 아니다' });

/** 입장 토큰과 첫 요청의 클라이언트 임시 공개키(openapi seatmap-snapshot: X-Admission-Token, X-Client-Ephemeral-Key) */
export const Admission = z.object({ token: z.string().min(1), ephemeralKey: z.string().min(1).optional() });

export const ToWorker = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('init'),
      canvas: z.custom<OffscreenCanvas>((v) => typeof v === 'object' && v !== null, { message: '캔버스가 아니다' }),
      layoutUrl: z.string().min(1),
      snapshotUrl: z.string().min(1).optional(),
      admission: Admission.optional(),
      /** 등급 ID를 가격이 높은 차례로(회차 가격표). 없으면 좌석맵 파일 tiers 차례 */
      tierRank: z.array(z.string().min(1)).max(16).optional(),
      /** 등급 ID → 화면 글자(회차 가격표, 예 'R석'). 없으면 좌석맵 파일의 ID를 그대로 쓴다 */
      tierNames: z.record(z.string(), z.string().min(1).max(32)).optional(),
      /** 화면 크기(CSS px). 캔버스 화소 크기는 이 값 × dpr로 Worker가 맞춘다 */
      width: z.number().positive().max(16_384),
      height: z.number().positive().max(16_384),
      dpr: z.number().positive().max(8),
      theme: z.enum(['light', 'dark']),
    })
    .refine((m) => !m.snapshotUrl || m.admission, { message: '스냅샷을 받으려면 입장 토큰(admission)이 있어야 한다' }),
  z.object({ type: z.literal('viewport'), w: z.number().positive().max(16_384), h: z.number().positive().max(16_384), dpr: z.number().positive().max(8) }),
  z.object({ type: z.literal('camera'), zoom: z.number().positive().max(1_000), x: z.number().min(-1e7).max(1e7), y: z.number().min(-1e7).max(1e7) }),
  /** [+]·[−]·휠·핀치. x·y(화면 점, CSS px)를 그대로 두고 factor배(없으면 가운데) */
  z.object({ type: z.literal('zoomBy'), factor: z.number().positive().max(100), x: z.number().min(-16_384).max(16_384).optional(), y: z.number().min(-16_384).max(16_384).optional() }),
  /** 등급 차례·이름을 나중에 준다(회차 가격표가 첫 그림보다 늦어도 그림을 늦추지 않는다). 엔진이 생기기 전에 오면 만들 때 쓴다 */
  z.object({ type: z.literal('tiers'), tierRank: z.array(z.string().min(1)).max(16).optional(), tierNames: z.record(z.string(), z.string().min(1).max(32)).optional() }),
  /** 끌기(화면 px만큼 옮긴다). 배치 밖 빈 곳이 보이지 않게 엔진이 묶는다 */
  z.object({ type: z.literal('pan'), dx: z.number().min(-16_384).max(16_384), dy: z.number().min(-16_384).max(16_384) }),
  /** [전체 보기] */
  z.object({ type: z.literal('fit') }),
  /** 구역으로 확대(목록·등급 칩에서 구역을 고를 때) */
  z.object({ type: z.literal('focusSection'), section: nonNeg }),
  z.object({ type: z.literal('pointer'), kind: z.enum(['down', 'up', 'move', 'leave']), x: z.number().min(-16_384).max(16_384), y: z.number().min(-16_384).max(16_384) }),
  z.object({ type: z.literal('select'), seatIndex: nonNeg }),
  /** 방금 놓은 좌석(30초 [가정] 흐리게 그리고 고르지 못하게 한다, docs/frontend.md §4.2.2 6행). untilMs는 벽시계 시각 */
  z.object({ type: z.literal('released'), seats: z.array(z.object({ seatId: z.string().min(1), untilMs: z.number().nonnegative() })).max(64) }),
  /** 다시 읽은 홀드의 좌석을 내 좌석으로 표시하거나 푼다(새로고침, docs/frontend.md §4.2.2 7행) */
  z.object({ type: z.literal('setMine'), seatIds: z.array(z.string().min(1)).max(64), on: z.boolean() }),
  z.object({ type: z.literal('theme'), theme: z.enum(['light', 'dark']) }),
  /** 접근성 목록을 열었다: 구역 목록을 한 번 답한다 */
  z.object({ type: z.literal('listSections') }),
  /** 접근성 목록이 연 구역(닫으면 null). 그 구역의 상태 전체를 한 번 답하고, 그 뒤에는 바뀐 좌석만 보낸다 */
  z.object({ type: z.literal('listSection'), section: nonNeg.nullable() }),
  z.object({ type: z.literal('dispose') }),
]);
export type ToWorker = z.infer<typeof ToWorker>;

export const FromWorker = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    /** 첫 그림을 화면에 내보낸 시각(절대 시각 ms, performance.timeOrigin + now). §4.7의 firstPaintMs는 이 값에서 시작 시각을 뺀 것이다 */
    firstPaintAt: z.number(),
    /** 첫 그림 명령을 다 낸 시각(절대 시각 ms). 화면 제시 기록은 이 뒤에 온다 */
    drawnAt: z.number(),
    layoutVersion: nonNeg,
    seatCount: nonNeg,
    sectionCount: nonNeg,
  }),
  /** 누른 좌석. 고를 수 없는 배율이거나 좌석이 없으면 seatIndex -1. 가격은 회차 가격표가 있는 좌석 화면(HOT-350)이 등급으로 찾는다 */
  z.object({ type: z.literal('hit'), seatIndex: int, seatId: z.string().nullable(), label: z.string().nullable(), tier: z.string().nullable(), selectable: z.boolean().optional() }),
  z.object({ type: z.literal('selection'), seatIndexes: z.array(nonNeg) }),
  /** 마우스가 고를 수 있는 좌석 위에 있는가(바뀔 때만, 화면이 커서를 바꾼다, ADR-0236) */
  z.object({ type: z.literal('hover'), selectable: z.boolean() }),
  /** 그린 단계가 바뀌거나 배율이 바뀔 때(화면이 '구역을 확대하면 좌석을 고를 수 있습니다' 안내와 [+]·[−] 상태를 고른다, CMP-021 onZoomChange) */
  z.object({
    type: z.literal('view'),
    level: z.enum(['loading', 'overview', 'seats']),
    zoom: z.number().positive(),
    /** 더 확대할 수 없는 배율(화면이 [+]를 막는다) */
    maxZoom: z.number().positive(),
    selectable: z.boolean(),
    /** 세계 좌표(cm) → 화면(CSS px) = 세계 × scale + t. 화면이 좌석 팝오버 같은 겹침을 좌석 위에 둘 때 쓴다 */
    camera: z.object({ scale: z.number().positive(), tx: z.number(), ty: z.number() }),
  }),
  /** 접근성 목록의 구역(이름과 남은 좌석 상태) */
  z.object({ type: z.literal('sectionList'), sections: z.array(z.object({ section: nonNeg, name: z.string(), status: z.enum(['plenty', 'few', 'soldout']) })) }),
  /** 목록이 구역을 열 때 한 번. 메인 스레드에는 좌석맵 파일이 없어 그 구역의 열·좌석 이름을 함께 싣는다(ADR-0227). tier는 tiers의 색인, wheelchair는 휠체어석의 구역 안 거리 */
  z.object({
    type: z.literal('sectionState'),
    section: nonNeg,
    version: nonNeg,
    baseIndex: nonNeg,
    states: Bytes,
    seats: z.object({ seatId: z.array(z.string()), row: z.array(z.string()), number: z.array(z.string()), tier: z.array(nonNeg), wheelchair: z.array(nonNeg) }),
    tiers: z.array(z.string()),
  }),
  /** 목록이 연 구역에서 바뀐 좌석만. 두 배열은 복사하지 않고 넘긴다(§5.2) */
  z.object({ type: z.literal('stateChanged'), section: nonNeg, version: nonNeg, offsets: Offsets, states: Bytes }),
  /** source·status·problem·retryAfter: 파일·스냅샷 요청이 HTTP 오류로 끝났을 때(화면이 다음 동작을 고른다, HOT-350 ①, ADR-0224 결정 5) */
  z.object({ type: z.literal('error'), message: z.string(), source: z.enum(['layout', 'snapshot']).optional(), status: int.optional(), problem: z.string().optional(), retryAfter: z.number().nonnegative().optional() }),
]);
export type FromWorker = z.infer<typeof FromWorker>;
