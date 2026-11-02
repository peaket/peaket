// 대기열 v0 유스케이스(docs/features/queue-admission.md §13): 진입, 대기 상태, 대기 취소, 입장 확정, 입장 루프.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock, ProblemError } from '@peaket/platform';
import { POLL_NEAR_MS, etaSeconds, pollIntervalMs } from '../domain/polling.js';
import { QUEUE_STORE, type QueueStore } from '../domain/queue-store.js';
import { ADMISSION_GRACE_MS, isEpochMs, type QueueSnapshot, type TickResult } from '../domain/queue.js';

/** 대기 상태 조회 응답(GET /v1/queues/{eventId}/entries/me) */
export interface QueueStatusView {
  status: 'WAITING' | 'CALLED' | 'EXPIRED' | 'ADMITTED';
  seq: number;
  ahead: number;
  serving: number;
  servingRate: number;
  etaSeconds: number | null;
  pollAfterMs: number | null;
  saleStatus: 'ON_SALE' | 'ENDED';
  serverTimeMs: number;
}

export interface EntryView {
  seq: number;
  generation: 0;
  serverTimeMs: number;
}

export interface AdmissionView {
  status: 'ADMITTED' | 'NOT_YET';
  seq: number;
  serverTimeMs: number;
}

// 오류 이름(§13 '오류 이름'). 409는 업무상 정상 분기라 오류 통계와 따로 센다(guidelines §2, NFR-003)
const queueNotFound = () => new ProblemError({ type: 'queue-not-found', status: 404, title: '열려 있지 않은 대기열입니다' });
const notInQueue = () => new ProblemError({ type: 'not-in-queue', status: 404, title: '대기 중이 아닙니다' });
const saleEnded = () => new ProblemError({ type: 'sale-ended', status: 410, title: '판매 시간이 끝났습니다' });
const alreadyInQueue = () => new ProblemError({ type: 'already-in-queue', status: 409, title: '이미 대기 중입니다', normalBranch: true });
const alreadyAdmitted = () => new ProblemError({ type: 'already-admitted', status: 409, title: '이 회차에 이미 입장했습니다', normalBranch: true });
const ticketExpired = () =>
  new ProblemError({ type: 'queue-ticket-expired', status: 410, title: '대기표가 만료됐습니다', extensions: { rejoinAllowed: true } });

/** 입장 루프가 한 회차에서 실패했다(어느 회차인지 기록에 남긴다) */
export class QueueTickError extends Error {
  constructor(
    readonly eventId: string,
    cause: unknown,
  ) {
    super(`입장 루프가 회차 ${eventId}에서 실패했다`, { cause });
    this.name = 'QueueTickError';
  }
}

const ended = (q: QueueSnapshot, nowMs: number) => q.saleEndsAtMs !== undefined && nowMs >= q.saleEndsAtMs;

/**
 * 연 회차마다 입장 루프 1초 칸을 부른다(복제본마다 돌아도 1초 칸마다 한 번만 부른다).
 * 시각이 유닉스 밀리초 정수가 아니면 아무 회차도 부르지 않고 던진다(1초 칸 기록을 망가뜨리지 않게).
 * 한 회차가 실패해도 나머지 회차는 그 칸에 부르고, 끝에 실패를 모아 던진다
 */
export async function advanceQueues(store: QueueStore, nowMs: number): Promise<TickResult[]> {
  if (!isEpochMs(nowMs)) throw new RangeError(`입장 루프 시각은 유닉스 밀리초 정수다: ${String(nowMs)}`);
  const out: TickResult[] = [];
  const failed: unknown[] = [];
  for (const eventId of await store.openEventIds()) {
    try {
      out.push(await store.tick(eventId, nowMs));
    } catch (err) {
      failed.push(new QueueTickError(eventId, err));
    }
  }
  if (failed.length > 0) throw new AggregateError(failed, `입장 루프가 회차 ${failed.length}곳에서 실패했다`);
  return out;
}

@Injectable()
export class QueueService {
  constructor(
    @Inject(QUEUE_STORE) private readonly store: QueueStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async enter(eventId: string, pid: string): Promise<EntryView> {
    const now = this.clock.now();
    const r = await this.store.enter(eventId, pid, now, ADMISSION_GRACE_MS);
    switch (r.kind) {
      case 'entered':
        return { seq: r.seq, generation: 0, serverTimeMs: now };
      case 'already-in-queue':
        throw alreadyInQueue();
      case 'already-admitted':
        throw alreadyAdmitted();
      case 'sale-ended':
        throw saleEnded();
      case 'queue-not-found':
        throw queueNotFound();
    }
  }

  async status(eventId: string, pid: string): Promise<QueueStatusView> {
    const now = this.clock.now();
    const r = await this.store.read(eventId, pid);
    if (!r) throw queueNotFound();
    const { queue, place } = r;
    const isEnded = ended(queue, now);
    const base = { serving: queue.serving, servingRate: queue.servingRate, saleStatus: isEnded ? ('ENDED' as const) : ('ON_SALE' as const), serverTimeMs: now };
    switch (place.kind) {
      case 'none':
        throw notInQueue();
      case 'waiting':
        return {
          status: 'WAITING',
          seq: place.seq,
          ahead: place.ahead,
          ...base,
          etaSeconds: etaSeconds(place.ahead, queue.servingRate),
          pollAfterMs: isEnded ? null : pollIntervalMs(place.ahead, queue.servingRate),
        };
      case 'called': {
        const expired = now - place.calledAtMs > ADMISSION_GRACE_MS;
        return {
          status: expired ? 'EXPIRED' : 'CALLED',
          seq: place.seq,
          ahead: 0,
          ...base,
          etaSeconds: 0,
          pollAfterMs: expired || isEnded ? null : POLL_NEAR_MS,
        };
      }
      case 'admitted':
        return { status: 'ADMITTED', seq: place.seq, ahead: 0, ...base, etaSeconds: 0, pollAfterMs: null };
    }
  }

  async cancel(eventId: string, pid: string): Promise<void> {
    await this.store.cancel(eventId, pid);
  }

  async admit(eventId: string, pid: string): Promise<AdmissionView> {
    const now = this.clock.now();
    const r = await this.store.admit(eventId, pid, now, ADMISSION_GRACE_MS);
    switch (r.kind) {
      case 'admitted':
        return { status: 'ADMITTED', seq: r.seq, serverTimeMs: now };
      case 'not-yet':
        return { status: 'NOT_YET', seq: r.seq, serverTimeMs: now };
      case 'expired':
        throw ticketExpired();
      case 'sale-ended':
        throw saleEnded();
      case 'not-in-queue':
        throw notInQueue();
      case 'queue-not-found':
        throw queueNotFound();
    }
  }

  async tick(): Promise<TickResult[]> {
    return advanceQueues(this.store, this.clock.now());
  }
}
