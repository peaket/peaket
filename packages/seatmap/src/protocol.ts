// 메인 ↔ 좌석맵 Worker 메시지(docs/frontend.md §4.7 'Worker 메시지', BUILD_ORDER HOT-110). 받는 쪽이 Zod로 검사한다.
// 메시지 종류는 type 칸이고, 누르기 종류는 pointer의 kind 칸이다(§4.7의 pointer{type}는 이 kind다).
// 지금 단계(HOT-110)는 첫 그림·카메라·누르기·고르기·테마까지다. 구역 구독·홀드 요청·연결 상태·목록 열기는 좌석 화면을 잇는 HOT-350에서 더한다.
import { z } from 'zod';

const int = z.number().int();
const nonNeg = int.nonnegative();

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
      /** 화면 크기(CSS px). 캔버스 화소 크기는 이 값 × dpr로 Worker가 맞춘다 */
      width: z.number().positive().max(16_384),
      height: z.number().positive().max(16_384),
      dpr: z.number().positive().max(8),
      theme: z.enum(['light', 'dark']),
    })
    .refine((m) => !m.snapshotUrl || m.admission, { message: '스냅샷을 받으려면 입장 토큰(admission)이 있어야 한다' }),
  z.object({ type: z.literal('viewport'), w: z.number().positive().max(16_384), h: z.number().positive().max(16_384), dpr: z.number().positive().max(8) }),
  z.object({ type: z.literal('camera'), zoom: z.number().positive().max(1_000), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('pointer'), kind: z.enum(['down', 'up', 'move']), x: z.number(), y: z.number() }),
  z.object({ type: z.literal('select'), seatIndex: nonNeg }),
  z.object({ type: z.literal('theme'), theme: z.enum(['light', 'dark']) }),
  z.object({ type: z.literal('dispose') }),
]);
export type ToWorker = z.infer<typeof ToWorker>;

export const FromWorker = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    /** 첫 그림을 화면에 내보낸 시각(절대 시각 ms, performance.timeOrigin + now). §4.7의 firstPaintMs는 이 값에서 시작 시각을 뺀 것이다 */
    firstPaintAt: z.number(),
    layoutVersion: nonNeg,
    seatCount: nonNeg,
    sectionCount: nonNeg,
  }),
  /** 누른 좌석. 고를 수 없는 배율이거나 좌석이 없으면 seatIndex -1. 가격은 회차 가격표가 있는 좌석 화면(HOT-350)이 등급으로 찾는다 */
  z.object({ type: z.literal('hit'), seatIndex: int, seatId: z.string().nullable(), label: z.string().nullable(), tier: z.string().nullable() }),
  z.object({ type: z.literal('selection'), seatIndexes: z.array(nonNeg) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type FromWorker = z.infer<typeof FromWorker>;
