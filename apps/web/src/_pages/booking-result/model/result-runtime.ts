// 결제 결과의 실행부(docs/frontend.md §3.6, ADR-0230). 롱 폴링으로 결제 상태를 묻고 결과를 기계에 넣는다. 화면에서 늦게 가져온다(첫 JS 예산, §5.8).
import { ApiError, OPERATIONS, type ApiClient, type Operation } from '@peaket/api-client';
import { createActor } from 'xstate';
import { FINISHED, nextPollMs, resultMachine, statusOutcome, type PayStatus, type VirtualAccount } from './result-machine';

const statusOp = OPERATIONS.getOrderPaymentStatus as Operation;
/** 브라우저 쪽 시간 제한 30초 [가정](openapi getOrderPaymentStatus: 서버는 25초 안에 답한다) */
const POLL_TIMEOUT_MS = 30_000;
const HOUR_MS = 3_600_000;

interface Status {
  status: PayStatus;
  issueDelayed?: boolean;
  reason?: string;
  virtualAccount?: VirtualAccount;
}

export interface ResultDeps {
  orderId: string;
  client: ApiClient;
  refresh(): Promise<'ok' | 'rejected' | 'unavailable'>;
  /** 접수한 시각(없으면 화면을 연 시각) */
  acceptedAt: number;
}

export function startResult(d: ResultDeps) {
  const actor = createActor(resultMachine).start();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hourTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshed = false;
  let inFlight = false;
  /** 서버가 Retry-After로 준 다음 조회의 하한(ms) */
  let notBefore = 0;
  const abort = new AbortController();
  const elapsed = () => Date.now() - d.acceptedAt;
  const visible = () => document.visibilityState === 'visible';

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (stopped) return;
    const value = String(actor.getSnapshot().value);
    if (value === 'checking' && elapsed() >= 120_000) actor.send({ type: 'LONG' });
    // 폴링이 10분에 멈춰도 열어 둔 화면의 문구가 1시간에 바뀌게 따로 잰다
    if (value === 'unknown' && hourTimer === undefined) {
      hourTimer = setTimeout(() => !stopped && actor.send({ type: 'UNKNOWN_HOUR' }), Math.max(0, HOUR_MS - elapsed()));
    }
    const wait = nextPollMs(String(actor.getSnapshot().value), elapsed(), visible());
    clearTimer();
    if (wait !== null) timer = setTimeout(() => void tick(), Math.max(wait, notBefore - Date.now()));
  };

  async function tick(): Promise<void> {
    if (stopped || inFlight) return;
    clearTimer();
    inFlight = true;
    const limit = setTimeout(() => attempt.abort(), POLL_TIMEOUT_MS);
    const attempt = new AbortController();
    const leave = () => attempt.abort();
    abort.signal.addEventListener('abort', leave, { once: true });
    try {
      const r = await d.client.send<Status>(statusOp, { params: { orderId: d.orderId }, signal: attempt.signal });
      if (stopped) return;
      refreshed = false;
      actor.send({ type: 'STATUS', status: r.data.status, ...(r.data.issueDelayed ? { issueDelayed: true } : {}), ...(r.data.reason ? { reason: r.data.reason } : {}), ...(r.data.virtualAccount ? { virtualAccount: r.data.virtualAccount } : {}) });
    } catch (e) {
      if (stopped) return;
      // 429는 서버가 정한 시각보다 먼저 묻지 않는다(§4.1 '자동 재시도')
      const ra = e instanceof ApiError && e.status === 429 && e.retryAfter !== null ? Number(e.retryAfter) : Number.NaN;
      if (Number.isFinite(ra) && ra > 0) notBefore = Date.now() + ra * 1000;
      const out = statusOutcome(e instanceof ApiError ? { status: e.status, type: e.type } : {});
      if (out.kind === 'event') actor.send(out.event);
      else if (out.kind === 'refresh') {
        // 팬 쿠키가 만료됐으면 갱신한 뒤 다시 묻는다(§3.6)
        const r = refreshed ? 'rejected' : await d.refresh();
        if (r === 'rejected') actor.send({ type: 'GONE' });
        else if (r === 'ok') refreshed = true;
      }
    } finally {
      clearTimeout(limit);
      abort.signal.removeEventListener('abort', leave);
      inFlight = false;
    }
    schedule();
  }

  // 숨겨서 멈췄다면 다시 보일 때 이어 묻는다(끝났거나 10분이 지났으면 묻지 않는다)
  const onVisible = () => {
    if (visible() && timer === undefined && !inFlight && nextPollMs(String(actor.getSnapshot().value), elapsed(), true) !== null) void tick();
  };
  document.addEventListener('visibilitychange', onVisible);
  void tick();

  return {
    actor,
    stop() {
      stopped = true;
      clearTimer();
      clearTimeout(hourTimer);
      abort.abort();
      document.removeEventListener('visibilitychange', onVisible);
      actor.stop();
    },
  };
}
