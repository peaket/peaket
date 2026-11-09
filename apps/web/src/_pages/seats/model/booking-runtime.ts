// 좌석 고르기·홀드의 실행부(docs/frontend.md §3.6·§4.2.2, ADR-0225). 예매 흐름 기계에 서명한 요청의 결과를 넣고 지도 선택과 맞춘다. 화면에서 늦게 가져온다(첫 JS 예산, §5.8).
import { ApiError, OPERATIONS, type ApiClient, type Operation } from '@peaket/api-client';
import { PurchaseKeyError, type PurchaseSigner } from '@peaket/api-client/purchase';
import { createActor } from 'xstate';
import { behaviorForHold, bookingMachine, holdIdempotencyKey, holdOutcome, type BookingEvent, type FirstHoldBehavior, type SeatPick } from './booking-machine';

export interface HeldSeat {
  seatId: string;
  label: string;
  tierId: string;
  tierName?: string;
  price: number;
}

export interface HoldResult {
  holdId: string;
  seatIds: string[];
  expiresAt: string;
  seats?: HeldSeat[];
  totalAmount?: number;
  assignResult?: string;
}

export interface HeldState extends HoldResult {
  /** 마감(받은 때 시계 + 서버 시각 기준 남은 시간). 단조 시계는 기기 절전 중 멈출 수 있어 벽시계도 함께 본다 */
  deadlineMono: number;
  deadlineWall: number;
}

export type AutoFailure = 'unavailable' | 'no-match' | 'wish-error';

export interface Wish {
  firstTierId: string;
  secondTierId?: string;
  count: number;
  wheelchair: boolean;
  allowSplit: boolean;
}

export interface BookingDeps {
  eventId: string;
  session: PurchaseSigner;
  client: ApiClient;
  /** 지도의 고른 표시를 뒤집는다(같은 메시지가 고르기·풀기) */
  toggleOnMap(seatIndex: number): void;
  refreshToken(): Promise<'ok' | 'rejected' | 'unavailable'>;
  limit: number;
  /** 첫 직접 선택 홀드에 실을 행동 요약(openapi BehaviorSummary). 없으면 싣지 않는다 */
  behaviorSummary?(): object | undefined;
  /** 홀드를 저장한다(결제 화면이 읽는다) */
  saveHold(h: HoldResult): void;
  /** 저장한 홀드를 지운다(만료·나가기) */
  clearHold(): void;
  /** 시험에서 바꾼다 */
  now?: () => number;
}

const holdOp = OPERATIONS.createEventHold as Operation;
const leaveOp = OPERATIONS.deleteEventPurchaseSession as Operation;

const problemOf = (e: unknown) => (e instanceof ApiError ? { status: e.status, type: e.type, extensions: e.extensions } : {});

/** 응답의 서버 시각과 만료로 남은 시간(기기 시계가 틀려도 맞는다). Date가 없으면 기기 시계 */
export function remainingMs(expiresAt: string, serverDate: string | null, nowMs: number): number {
  const server = serverDate ? Date.parse(serverDate) : Number.NaN;
  return Date.parse(expiresAt) - (Number.isFinite(server) ? server : nowMs);
}

export function createBooking(d: BookingDeps) {
  const actor = createActor(bookingMachine, { input: { limit: d.limit } }).start();
  const indexes = new Map<string, number>();
  let idem: { key: string; seats: string } | null = null;
  let held: HeldState | null = null;
  let firstBehavior: FirstHoldBehavior | null = null;
  let autoFailure: AutoFailure | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((f) => f());
  const mono = d.now ?? (() => performance.now());

  /** 지도에 고른 표시를 지운다(경합 패배·홀드 만료) */
  const clearMap = () => {
    for (const i of indexes.values()) d.toggleOnMap(i);
    indexes.clear();
  };

  const send = (e: BookingEvent) => {
    if (e.type === 'HOLD_LOST' || e.type === 'HOLD_RECENT' || e.type === 'EXPIRED') clearMap();
    actor.send(e);
  };

  async function request(body: object, idempotencyKey: string): Promise<void> {
    let refreshed = false;
    for (;;) {
      try {
        const r = await d.client.send<HoldResult>(holdOp, { params: { eventId: d.eventId }, body, idempotencyKey, purchase: d.session });
        const left = remainingMs(r.data.expiresAt, r.headers.get('date'), Date.now());
        held = { ...r.data, deadlineMono: mono() + left, deadlineWall: Date.now() + left };
        idem = null;
        d.saveHold(r.data);
        actor.send({ type: 'HOLD_OK', hold: r.data });
        return;
      } catch (e) {
        if (e instanceof PurchaseKeyError) return send({ type: e.reason === 'storage' ? 'HOLD_FAILED' : 'SESSION_ENDED' });
        const out = holdOutcome(problemOf(e));
        if (out.type !== 'REFRESH') {
          if ((body as { auto?: unknown }).auto) autoFailure = autoFailureOf(problemOf(e));
          return send(out);
        }
        if (refreshed) return send({ type: 'SESSION_ENDED' });
        refreshed = true;
        const r2 = await d.refreshToken();
        if (r2 !== 'ok') return send({ type: r2 === 'rejected' ? 'SESSION_ENDED' : 'HOLD_FAILED' });
      }
    }
  }

  actor.subscribe(notify);
  return {
    actor,
    subscribe(f: () => void) {
      listeners.add(f);
      return () => listeners.delete(f);
    },
    held: () => held,
    autoFailure: () => autoFailure,
    /** 지도에서 누른 좌석. 한도를 넘으면 지도에 표시하지 않는다 */
    pick(seat: SeatPick, seatIndex: number) {
      const before = actor.getSnapshot().context.picks.some((p) => p.seatId === seat.seatId);
      actor.send({ type: 'TOGGLE', seat });
      const after = actor.getSnapshot().context.picks.some((p) => p.seatId === seat.seatId);
      if (before === after) return;
      d.toggleOnMap(seatIndex);
      if (after) indexes.set(seat.seatId, seatIndex);
      else indexes.delete(seat.seatId);
    },
    setLimit: (limit: number) => actor.send({ type: 'SET_LIMIT', limit }),
    expire() {
      held = null;
      idem = null;
      d.clearHold();
      send({ type: 'EXPIRED' });
    },
    resume: () => actor.send({ type: 'RESUME' }),
    /** 좌석 홀드하기 */
    async hold() {
      if (actor.getSnapshot().value !== 'selecting') return;
      actor.send({ type: 'HOLD' });
      const s = actor.getSnapshot();
      if (s.value !== 'holding') return;
      const seatIds = s.context.picks.map((p) => p.seatId).sort();
      idem = holdIdempotencyKey(idem, seatIds, () => crypto.randomUUID());
      const b = behaviorForHold(firstBehavior, idem.key, () => d.behaviorSummary?.());
      firstBehavior = b.first;
      await request({ seatIds, ...(b.behavior ? { behavior: b.behavior } : {}) }, idem.key);
    },
    /** 자동 배정 공연: 희망 조건으로 첫 홀드를 보낸다 */
    async autoHold(wish: Wish | null) {
      actor.send({ type: 'AUTO' });
      if (!wish) {
        autoFailure = 'wish-error';
        return send({ type: 'HOLD_FAILED' });
      }
      await request({ auto: wish, clientEphemeralPublicKey: d.session.clientPublicKey }, crypto.randomUUID());
      // 응답을 받지 못하거나 키를 쓰지 못해 실패한 때도 '배정하는 중'에 머물지 않는다
      if (actor.getSnapshot().value !== 'held' && !autoFailure) {
        autoFailure = 'unavailable';
        notify();
      }
    },
    /** 예매 그만두기: 구매 세션을 끝낸다(LEFT). 실패해도 화면은 나간다(서버는 무활동으로 끝낸다) */
    async leave() {
      const call = () => d.client.send(leaveOp, { params: { eventId: d.eventId }, purchase: d.session });
      await call().catch(async (e: unknown) => {
        // 팬 쿠키가 만료됐으면 한 번 갱신하고 다시 보낸다(§4.1 '401'). 실패해도 나간다(서버는 무활동으로 끝낸다)
        if (holdOutcome(problemOf(e)).type !== 'REFRESH') return;
        if ((await d.refreshToken()) === 'ok') await call().catch(() => undefined);
      });
      d.clearHold();
      await d.session.end().catch(() => undefined);
    },
    dispose: () => actor.stop(),
  };
}

export type Booking = ReturnType<typeof createBooking>;

/** 자동 배정 실패 → 화면(d5 §5.10 배정 실패·희망 조건 오류) */
export function autoFailureOf(e: { status?: number; type?: string }): AutoFailure {
  if (e.type === 'auto-assign-not-supported') return 'unavailable';
  if (e.status === 409) return 'no-match';
  if (e.status === 400 || e.status === 422) return 'wish-error';
  return 'unavailable';
}

/** localStorage peaket.autoassign.{eventId}(v1)을 요청 모양으로. 없거나 틀리면 null */
export function readWish(eventId: string, storage: Pick<Storage, 'getItem'>): Wish | null {
  try {
    const v = JSON.parse(storage.getItem(`peaket.autoassign.${eventId}`) ?? 'null') as Partial<Wish> & { v?: number };
    if (!v || v.v !== 1 || typeof v.firstTierId !== 'string' || !Number.isInteger(v.count) || (v.count as number) < 1) return null;
    return { firstTierId: v.firstTierId, count: v.count as number, wheelchair: v.wheelchair === true, allowSplit: v.allowSplit === true, ...(typeof v.secondTierId === 'string' ? { secondTierId: v.secondTierId } : {}) };
  } catch {
    return null;
  }
}
