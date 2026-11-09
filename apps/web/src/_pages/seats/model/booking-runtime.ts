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
  extendable?: boolean;
  seats?: HeldSeat[];
  totalAmount?: number;
  assignResult?: string;
  /** 시간이 흐르지 않는다(결제 정지로 멈췄거나 결제 접수 뒤 묶였다). 타이머로 만료 처리하지 않는다(ADR-0254) */
  frozen?: boolean;
}

export interface HeldState extends HoldResult {
  /** 마감(받은 때 시계 + 서버 시각 기준 남은 시간). 단조 시계는 기기 절전 중 멈출 수 있어 벽시계도 함께 본다 */
  deadlineMono: number;
  deadlineWall: number;
  /** 멈춘 동안 보여 줄 남은 시간 */
  frozenLeftMs?: number;
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
  /** 시험에서 바꾼다(벽시계) */
  wall?: () => number;
  /** 입장 토큰(다시 읽기 GET의 머리) */
  admissionToken: string;
  /** 저장한 홀드 ID(없으면 undefined) */
  savedHoldId(): string | undefined;
  /** 지도에 내 좌석 표시를 켜거나 끈다(새로고침으로 복원한 좌석) */
  setMineOnMap(seatIds: readonly string[], on: boolean): void;
  /** 방금 놓은 좌석을 지도에 알린다 */
  markReleasedOnMap(seats: readonly { seatId: string; untilMs: number }[]): void;
}

/** 방금 놓은 좌석을 다시 고를 수 있을 때까지(서버와 같은 30초 [가정], docs/frontend.md §4.2.2 6행) */
export const REHOLD_WAIT_MS = 30_000;
/** 다시 읽기를 일시 오류 뒤 다시 하는 횟수와 간격 [가정] */
const RESTORE_RETRIES = 3;
const RESTORE_RETRY_MS = 2_000;

const holdOp = OPERATIONS.createEventHold as Operation;
const leaveOp = OPERATIONS.deleteEventPurchaseSession as Operation;
const readOp = OPERATIONS.getHold as Operation;
const releaseOp = OPERATIONS.deleteHold as Operation;
const extendOp = OPERATIONS.createHoldExtension as Operation;

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
  /** 응답을 잃은 홀드 요청(서버에 닿았을 수 있다). 다른 좌석을 잡기 전에 같은 키로 먼저 확인한다 */
  let unconfirmed: { key: string; seats: string; body: object } | null = null;
  let restoring = false;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((f) => f());
  const mono = d.now ?? (() => performance.now());
  const wall = d.wall ?? (() => Date.now());
  /** 방금 놓은 좌석 → 다시 고를 수 있는 시각 */
  const released = new Map<string, number>();

  /** 응답 하나를 held 값으로 */
  const heldOf = (data: HoldResult, serverDate: string | null): HeldState => {
    const left = remainingMs(data.expiresAt, serverDate, wall());
    return { ...data, deadlineMono: mono() + left, deadlineWall: wall() + left, ...(data.frozen ? { frozenLeftMs: left } : {}) };
  };

  /** 놓은 좌석을 표시한다(서버의 다시 잡기 대기와 같은 30초) */
  const remember = (seatIds: readonly string[], untilMs: number) => {
    for (const id of seatIds) released.set(id, untilMs);
    d.markReleasedOnMap(seatIds.map((seatId) => ({ seatId, untilMs })));
  };

  /** 끝난 홀드를 비운다. 복원한 홀드는 indexes가 비어 있어 좌석 ID로 지도를 맞춘다 */
  const dropHeld = (seatIds: readonly string[]) => {
    if (indexes.size === 0 && seatIds.length > 0) d.setMineOnMap(seatIds, false);
    held = null;
    idem = null;
    d.clearHold();
  };

  /** 서명한 요청 하나. 이름 없는 401이면 한 번 갱신하고 다시 보낸다 */
  async function signed(op: Operation, params: Record<string, string>): Promise<{ data: unknown; headers: Headers } | { problem: ReturnType<typeof problemOf> } | 'ended'> {
    let refreshed = false;
    for (;;) {
      try {
        return await d.client.send(op, { params, purchase: d.session });
      } catch (e) {
        if (e instanceof PurchaseKeyError) return e.reason === 'storage' ? { problem: {} } : 'ended';
        const p = problemOf(e);
        const out = holdOutcome(p);
        if (out.type === 'REFRESH' && !refreshed) {
          refreshed = true;
          const r = await d.refreshToken();
          // 갱신의 일시 장애는 세션 끝이 아니다(M7)
          if (r === 'rejected') return 'ended';
          if (r !== 'ok') return { problem: {} };
          continue;
        }
        // 이름 있는 401·403은 구매 세션 끝이다(M7)
        if (out.type === 'SESSION_ENDED' || out.type === 'REFRESH') return 'ended';
        return { problem: p };
      }
    }
  }

  /** GET 홀드(서명 없음). 'gone' = 없음·끝남, 'ended' = 구매 세션 끝, 'failed' = 잠시 뒤 다시 */
  async function readHold(holdId: string): Promise<{ data: HoldResult; date: string | null } | 'gone' | 'ended' | 'failed'> {
    let refreshed = false;
    for (;;) {
      try {
        const r = await d.client.send<HoldResult>(readOp, { params: { holdId }, headers: { 'X-Admission-Token': d.admissionToken } });
        return { data: r.data, date: r.headers.get('date') };
      } catch (e) {
        const p = problemOf(e);
        if (p.status === 404) return 'gone';
        if (p.status === 401 || p.status === 403) {
          if (holdOutcome(p).type === 'REFRESH' && !refreshed) {
            refreshed = true;
            const r = await d.refreshToken();
            if (r === 'ok') continue;
            return r === 'rejected' ? 'ended' : 'failed';
          }
          return 'ended';
        }
        return 'failed';
      }
    }
  }

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
        held = heldOf(r.data, r.headers.get('date'));
        idem = null;
        unconfirmed = null;
        d.saveHold(r.data);
        actor.send({ type: 'HOLD_OK', hold: r.data });
        return;
      } catch (e) {
        if (e instanceof PurchaseKeyError) return send({ type: e.reason === 'storage' ? 'HOLD_FAILED' : 'SESSION_ENDED' });
        const problem = problemOf(e);
        // 답을 받지 못했다: 서버에 닿았을 수 있어 기억한다(답이 있으면 끝난 요청이다, L13)
        unconfirmed = problem.status === undefined && (body as { seatIds?: unknown }).seatIds ? { key: idempotencyKey, seats: [...((body as { seatIds: string[] }).seatIds)].sort().join(','), body } : null;
        const out = holdOutcome(problem);
        if (out.type === 'HOLD_RECENT') remember(out.seats, (out.availableAt && Date.parse(out.availableAt)) || wall() + REHOLD_WAIT_MS);
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
      if (restoring) return;
      const until = released.get(seat.seatId);
      if (until !== undefined && until > wall()) {
        actor.send({ type: 'NOTICE', notice: { kind: 'recent-pick', until } });
        return;
      }
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
      // 멈춘 홀드는 서버에 살아 있다(시계로 끝내지 않는다, H3)
      if (held?.frozen) return;
      const seatIds = held?.seatIds ?? [];
      if (seatIds.length > 0) remember(seatIds, wall() + REHOLD_WAIT_MS);
      dropHeld(seatIds);
      send({ type: 'EXPIRED' });
    },
    /** 새로고침·결제 화면에서 돌아옴: 저장한 홀드를 서버에서 다시 읽는다(docs/frontend.md §4.2.2 7행) */
    async restore(): Promise<void> {
      const holdId = d.savedHoldId();
      if (!holdId || actor.getSnapshot().value !== 'selecting') return;
      // 다시 읽는 동안 고른 좌석이 복원한 홀드와 어긋나지 않게 막는다(L13)
      restoring = true;
      try {
        for (let i = 0; i <= RESTORE_RETRIES; i += 1) {
          const r = await readHold(holdId);
          if (actor.getSnapshot().value !== 'selecting') return;
          if (r === 'ended') return send({ type: 'SESSION_ENDED' });
          if (r === 'gone') return d.clearHold();
          if (r !== 'failed') {
            held = heldOf(r.data, r.date);
            d.saveHold(r.data);
            d.setMineOnMap(r.data.seatIds, true);
            actor.send({ type: 'RESTORE', hold: r.data, extended: r.data.extendable === false });
            return;
          }
          if (i < RESTORE_RETRIES) await new Promise((f) => setTimeout(f, RESTORE_RETRY_MS));
        }
        actor.send({ type: 'NOTICE', notice: { kind: 'error' } });
      } finally {
        restoring = false;
      }
    },
    /** 멈춘 홀드를 다시 읽어 풀렸는지 본다(재개를 알려 주는 길이 아직 없다). 실패는 다음 차례에 다시 한다 */
    async refreshFrozen(): Promise<void> {
      const h = held;
      if (!h?.frozen || actor.getSnapshot().value !== 'held') return;
      const r = await readHold(h.holdId);
      if (r === 'ended') return send({ type: 'SESSION_ENDED' });
      if (r === 'gone') {
        dropHeld(h.seatIds);
        return send({ type: 'HOLD_GONE' });
      }
      if (r !== 'failed') {
        held = heldOf(r.data, r.date);
        notify();
      }
    },
    /** 1회 연장(서명). 두 번째는 409이고 서버가 준 만료로 맞춘다 */
    async extend(): Promise<void> {
      const h = held;
      if (!h || actor.getSnapshot().value !== 'held') return;
      const r = await signed(extendOp, { holdId: h.holdId });
      if (r === 'ended') return send({ type: 'SESSION_ENDED' });
      if ('data' in r) {
        held = heldOf(r.data as HoldResult, r.headers.get('date'));
        d.saveHold(r.data as HoldResult);
        actor.send({ type: 'EXTENDED' });
        return notify();
      }
      const p = r.problem;
      if (p.status === 409 && p.type === 'hold-already-extended') {
        // 응답을 잃어 다시 누른 경우 등: 서버의 실제 만료를 다시 읽는다
        const again = await readHold(h.holdId);
        if (again !== 'gone' && again !== 'ended' && again !== 'failed') {
          held = heldOf(again.data, again.date);
          d.saveHold(again.data);
        }
        actor.send({ type: 'EXTENDED' });
        return notify();
      }
      if (p.status === 409 && p.type === 'hold-in-payment') return actor.send({ type: 'NOTICE', notice: { kind: 'in-payment' } });
      if (p.status === 404) {
        clearMap();
        remember(h.seatIds, wall() + REHOLD_WAIT_MS);
        dropHeld(h.seatIds);
        return send({ type: 'HOLD_GONE' });
      }
      actor.send({ type: 'NOTICE', notice: { kind: 'error' } });
    },
    /** 홀드 해제(서명). 204면 30초 동안 흐리게 그리고 다시 고르지 못하게 한다 */
    async release(): Promise<void> {
      const h = held;
      if (!h || actor.getSnapshot().value !== 'held') return;
      const r = await signed(releaseOp, { holdId: h.holdId });
      if (r === 'ended') return send({ type: 'SESSION_ENDED' });
      const untilMs = wall() + REHOLD_WAIT_MS;
      if ('data' in r) {
        clearMap();
        remember(h.seatIds, untilMs);
        dropHeld(h.seatIds);
        return send({ type: 'RELEASED' });
      }
      const p = r.problem;
      if (p.status === 404) {
        clearMap();
        dropHeld(h.seatIds);
        return send({ type: 'HOLD_GONE' });
      }
      if (p.status === 409 && p.type === 'hold-in-payment') return actor.send({ type: 'NOTICE', notice: { kind: 'in-payment' } });
      // 답을 받지 못했다: 서버에서 이미 풀렸으면 놓은 것으로 끝낸다(응답 유실, L13)
      if (p.status === undefined) {
        const again = await readHold(h.holdId);
        if (again === 'ended') return send({ type: 'SESSION_ENDED' });
        if (again === 'gone') {
          clearMap();
          remember(h.seatIds, untilMs);
          dropHeld(h.seatIds);
          return send({ type: 'RELEASED' });
        }
      }
      actor.send({ type: 'NOTICE', notice: { kind: 'error' } });
    },
    resume: () => actor.send({ type: 'RESUME' }),
    /** 좌석 홀드하기 */
    async hold() {
      if (actor.getSnapshot().value !== 'selecting') return;
      actor.send({ type: 'HOLD' });
      const s = actor.getSnapshot();
      if (s.value !== 'holding') return;
      const seatIds = s.context.picks.map((p) => p.seatId).sort();
      // 앞 요청의 답을 잃었고 좌석이 달라졌으면, 서버에 잡혔는지 같은 키로 먼저 확인한다(잡혔으면 그 홀드를 잇는다, L13)
      if (unconfirmed && unconfirmed.seats !== seatIds.join(',')) {
        const prior = unconfirmed;
        try {
          const r = await d.client.send<HoldResult>(holdOp, { params: { eventId: d.eventId }, body: prior.body, idempotencyKey: prior.key, purchase: d.session });
          unconfirmed = null;
          held = heldOf(r.data, r.headers.get('date'));
          idem = null;
          d.saveHold(r.data);
          clearMap();
          d.setMineOnMap(r.data.seatIds, true);
          actor.send({ type: 'HOLD_OK', hold: r.data });
          return;
        } catch (e) {
          if (problemOf(e).status === undefined) return send({ type: e instanceof PurchaseKeyError && e.reason !== 'storage' ? 'SESSION_ENDED' : 'HOLD_FAILED' });
          // 답이 왔다: 앞 요청은 잡지 못했다. 새 좌석으로 잇는다
          unconfirmed = null;
        }
      }
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
