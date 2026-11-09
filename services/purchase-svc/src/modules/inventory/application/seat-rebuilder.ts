// 좌석 Redis 다시 만들기 RB-06(BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현', 명세 specs/seat.qnt rebuild).
// 차례: 세대 키가 있으면 READY → purchase DB 임대를 잡으며 판 번호를 올려 커밋(못 잡으면 BUSY) → 시작 Lua(begin: 앞 시도의 bitmap·만료 인덱스를 지우고 rebuild 키 = gen) →
// 판매·원장 홀드·판매 좌석 원장 행 읽기 → 좌석맵 판으로 색인 바꾸기 → 좌석 Lua(REBUILD_BATCH석씩) → 보유 수·펜싱 카운터와 세대 키를 마지막에 → 임대 비우기(실패해도 비운다).
// 어느 Lua든 세대 키가 이미 있으면 READY, rebuild 키의 판 번호가 내 gen이 아니면 STALE로 멈춘다. 부르는 반복(세대 키 없는 판매 중 회차 찾기, SeatRebuildLoop)은 PRF-164이고 런북 RB-06은 그 반복의 지표·로그를 본다.
//
// 구현에서 정한 세부(PRF-143, 코드 리뷰로 고침):
// - 임대를 잡은 뒤 세대 키가 이미 서 있으면(다른 곳이 막 끝내고 임대를 비운 틈) 시작·좌석·끝내기 Lua가 READY와 세대 키의 gen을 돌려준다. 이때 release에
//   setGen(그 gen)을 실어 DB 판 번호를 세대 키의 gen에 맞춘다(절대값. 따로 isReady를 다시 부르지 않는다, Lua가 원자적으로 본다).
// - STALE(더 새 시도가 시작함)이면 BUSY로 끝낸다. release는 holder가 같을 때만 비우므로 해가 없고, 판 번호를 되돌리지 않는다.
// - 좌석맵 판이 없는 회차(seatMap.config가 undefined)는 임대를 잡기 전에 Error로 끝낸다(모든 좌석이 넘겨져 빈 좌석 Redis에 세대 키를 쓰면 오버셀이다).
// - 판매·만료 전 원장 홀드·판매 좌석 원장 행은 함께 읽는다(한 시점 읽기는 아니다, 알려진 한계). 좌석 ID → 색인은 seatMap.resolve 한 번(겹치지 않는 좌석 ID들)이고,
//   판매 제외석은 undefined라 넘겨진다(알려진 한계).
// - finish에는 되살린 원장 토큰의 최댓값(maxTokenOf, 판매 좌석의 원장 토큰 포함)을 싣는다(펜싱 카운터 되살리기).
// - 오류가 나면 임대를 비우고(그 release의 오류는 버린다) 원래 오류를 던진다. 끝까지 간 뒤 release가 던지면 그 오류를 던진다(세대 키는 이미 섰으므로 다음 번은 READY).
// - 지표 rebuilt(result)는 결과마다 한 번: rebuilt·ready·busy(STALE 포함)·failed(던질 때).
// 주문 기준 되살리기(BUILD_ORDER PRF-167, K1·K3): orders(RebuildOrderSource, booking이 구현하고 시작 파일이 꽂는다)가 있으면 판매 행의 주문 ID로 판매 주문의
// holdId·psid와 결제 접수했고 묶인 주문들, 그 좌석들의 원장 행(source.ledgerRows, 리뷰 고침 M2)을 함께 읽어 planRebuild의 주문 근거로 넘긴다
// (우선순위 판매 > 묶인 주문 > 원장 홀드). 묶인 주문의 좌석도 좌석맵 판으로 바꾼다.
import { type Clock, systemClock } from '@peaket/platform';
import type { RebuildOrderSource, SeatMap, SeatRebuildSource, SeatRebuildTarget } from '../domain/ports.js';
import { maxTokenOf, planRebuild, quotasOf, REBUILD_BATCH, type RebuildOrderInputs, type RebuildReport, type RebuildSale, type RebuildStep } from '../domain/rebuild.js';
import type { SeatRef } from '../domain/hold.js';

export interface SeatRebuilderSignals {
  /** seat_rebuild_total{result} */
  rebuilt(result: 'rebuilt' | 'ready' | 'busy' | 'failed'): void;
}

export interface SeatRebuilderDeps {
  source: SeatRebuildSource;
  target: SeatRebuildTarget;
  /**
   * 주문 근거(BUILD_ORDER PRF-167). 운영 조립은 늘 꽂는다(booking DrizzleRebuildOrders). 없으면 원장만 보는 옛 방식이다(K1·K3가 남는다, 옛 시험 대역용)
   */
  orders?: RebuildOrderSource;
  /** 묶인 주문 홀드의 잡은 시각(지금)을 재는 시계(없으면 systemClock) */
  clock?: Clock;
  seatMap: SeatMap;
  /** 임대의 holder(이 파드·프로세스 표지). 세대 키 node는 좌석 Redis가 구한 주 노드 표지라 넘기지 않는다(BUILD_ORDER PRF-168) */
  holder: string;
  signals?: SeatRebuilderSignals;
}

export class SeatRebuilder {
  constructor(private readonly deps: SeatRebuilderDeps) {}

  /**
   * 회차 하나를 다시 만든다. keepUntilMs는 회차 키 수명(판매 종료 + 1일).
   * @throws Error 좌석 Redis·purchase DB 오류(임대는 비우고 던진다. 세대 키를 쓰기 전이면 다음 번에 처음부터 다시 한다), 좌석맵 판이 없는 회차
   */
  async rebuild(eventId: string, o: { keepUntilMs: number }): Promise<RebuildReport> {
    const { source, target, seatMap, holder } = this.deps;
    const signal = (r: 'rebuilt' | 'ready' | 'busy' | 'failed'): void => this.deps.signals?.rebuilt(r);

    let gen: number | null;
    try {
      if (await target.isReady(eventId)) {
        signal('ready');
        return { result: 'READY' };
      }
      if ((await seatMap.config(eventId)) === undefined) throw new Error(`다시 만들 회차의 좌석맵 판이 없다: ${eventId}`);
      gen = await source.acquire(eventId, holder);
    } catch (err) {
      signal('failed');
      throw err;
    }
    if (gen === null) {
      signal('busy');
      return { result: 'BUSY' };
    }

    let out: { report: RebuildReport; setGen?: number };
    try {
      out = await this.#write(eventId, gen, o.keepUntilMs);
    } catch (err) {
      // 실패해도 임대는 비운다(비우기의 오류는 버린다. 임대는 REBUILD_LEASE_MS 뒤 저절로 풀린다)
      await source.release(eventId, holder).catch(() => undefined);
      signal('failed');
      throw err;
    }
    try {
      await source.release(eventId, holder, out.setGen !== undefined ? { setGen: out.setGen } : undefined);
    } catch (err) {
      signal('failed');
      throw err;
    }
    const r = out.report.result;
    signal(r === 'READY' ? 'ready' : r === 'BUSY' ? 'busy' : 'rebuilt');
    return out.report;
  }

  /** 임대를 잡은 뒤: 시작 Lua → 읽기 → 계획 → 좌석 Lua 묶음들 → 끝내기. 어느 Lua든 READY(세대 키의 gen으로 판 번호를 맞춘다)·STALE(BUSY)면 멈춘다 */
  async #write(eventId: string, gen: number, keepUntilMs: number): Promise<{ report: RebuildReport; setGen?: number }> {
    const { source, target, seatMap } = this.deps;
    const stop = (step: RebuildStep): { report: RebuildReport; setGen?: number } | undefined =>
      step.result === 'READY' ? { report: { result: 'READY' }, setGen: step.gen } : step.result === 'STALE' ? { report: { result: 'BUSY' } } : undefined;

    const begun = stop(await target.begin(eventId, gen, keepUntilMs));
    if (begun) return begun;
    const [sales, holds, saleHolds] = await Promise.all([source.sales(eventId), source.holds(eventId), source.saleHolds(eventId)]);
    const orderSource = this.deps.orders;
    const orders = orderSource !== undefined ? await this.#orderInputs(orderSource, eventId, sales) : undefined;
    const ids = [...new Set([...sales.map((s) => s.seatId), ...(orders?.pinned.flatMap((o) => o.seatIds) ?? []), ...holds.map((h) => h.seatId)])];
    const refs = ids.length > 0 ? await seatMap.resolve(eventId, ids) : [];
    const byId = new Map<string, SeatRef>();
    ids.forEach((id, k) => {
      const ref = refs[k];
      if (ref !== undefined) byId.set(id, ref);
    });
    const plan = planRebuild(sales, holds, (id) => byId.get(id), saleHolds, orders);

    for (let k = 0; k < plan.seats.length; k += REBUILD_BATCH) {
      const s = stop(await target.writeSeats(eventId, plan.seats.slice(k, k + REBUILD_BATCH), keepUntilMs, gen));
      if (s) return s;
    }
    const f = stop(await target.finish(eventId, { quotas: quotasOf(plan.seats), gen, keepUntilMs, maxToken: maxTokenOf(plan.seats) }));
    if (f) return f;
    const sold = plan.seats.filter((s) => s.mode === 'SOLD').length;
    return { report: { result: 'REBUILT', gen, sold, held: plan.seats.length - sold, skipped: plan.skipped } };
  }

  /**
   * 주문 근거 읽기(BUILD_ORDER PRF-167): 판매 행의 주문 ID들(겹치지 않게)로 orders.saleOrders, 회차로 orders.pinnedOrders를 함께 읽고, 묶인 주문이 있으면
   * 그 좌석들(겹치지 않게)의 원장 행을 source.ledgerRows로 읽는다(리뷰 고침 M2: 원장 대조는 inventory가 한다. 없으면 부르지 않는다).
   * nowMs = clock.now()는 읽기가 끝난 뒤에 잰다(묶인 주문 홀드의 잡은 시각, 만료 = nowMs + 7분)
   */
  async #orderInputs(orders: RebuildOrderSource, eventId: string, sales: readonly RebuildSale[]): Promise<RebuildOrderInputs> {
    const orderIds = [...new Set(sales.map((s) => s.orderId))];
    const [saleOrders, pinned] = await Promise.all([orders.saleOrders(eventId, orderIds), orders.pinnedOrders(eventId)]);
    const seatIds = [...new Set(pinned.flatMap((o) => o.seatIds))];
    const pinnedLedger = seatIds.length > 0 ? await this.deps.source.ledgerRows(eventId, seatIds) : [];
    return { saleOrders, pinned, pinnedLedger, nowMs: (this.deps.clock ?? systemClock).now() };
  }
}
