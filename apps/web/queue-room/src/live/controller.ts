// 대기실 오픈 뒤 경로의 상태 기계를 실제 응답으로 돌린다(docs/frontend.md §3.4, ADR-0207). 한 탭 기준이다(여러 탭 리더는 HOT-341).
// boot → enter → (batching) → waiting ⇄ stale·paused·all-held·offline → turn → soon·admitted·verify-redirect와 끝 상태.
// 바깥(네트워크·시간·저장소·이동)은 모두 주입받아, 시험이 가짜 시계로 흐름 전체를 돌린다.
// 기다림 규칙(§4.1 '기다림', §5.1): 서버가 준 하한(Retry-After·retryAfterSeconds·retryAfterMs·결과 공개 시각)은 탭 전환·연결 사건으로 깨지 않는다.
// 실패 뒤 다시 보내기는 전체 지터(0 ~ min(0.5초 × 2^n, 8초))다. 폴링 간격만 보이게 되거나 연결이 돌아오면 일찍 깬다.
import type { Clock } from './clock.ts';
import type { Net, Reply } from './net.ts';
import { resultRetryDelayMs, spreadDelayMs } from './net.ts';
import { aheadCount, etaSeconds, MonotonicReader, nextDelayMs, parseQueueState, purchaseUnlikely, segmentOf, type QueueState } from './queue-file.ts';
import type { Batching, Store, Ticket } from './store.ts';

export type LiveState =
  | 'boot' | 'enter' | 'batching' | 'waiting' | 'stale' | 'paused' | 'all-held' | 'offline' | 'turn' | 'soon'
  | 'admitted' | 'verify-redirect' | 'other-device' | 'cancelled-elsewhere' | 'already-admitted' | 'duplicate'
  | 'expired' | 'restricted' | 'sold-out' | 'ended' | 'login-expired' | 'leaving';

export interface QueueView {
  state: LiveState;
  /** 앞 인원·진행률(0~100)·예상 대기(초, 숨기면 null) — 순번이 있을 때 */
  ahead?: number;
  progress?: number;
  etaSec?: number | null;
  banner?: string;
  purchaseUnlikely?: boolean;
  /** soon: 다시 시도할 시각(이 기기 시계 밀리초, 화면 카운트다운) */
  retryAt?: number;
  /** enter: 혼잡(429)으로 다시 보낼 시각(이 기기 시계) */
  busyUntil?: number;
  /** expired: [다시 줄 서기]를 보일지 */
  rejoinAllowed?: boolean;
  /** offline·stale: 마지막으로 받은 파일 시각(보정 시계) */
  lastSyncAt?: number;
}

export interface Urls {
  queue: string;
  files: string;
  event: string;
  seats: string;
  verify: string;
}

export interface Env {
  eventId: string;
  urls: Urls;
  net: Net;
  store: Store;
  clock: Clock;
  /** 이 기기 시계(밀리초). 기다림의 기준 */
  deviceNow(): number;
  random(): number;
  /** ms만큼 기다린다. signal이 끊기면 바로 끝난다 */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  hidden(): boolean;
  online(): boolean;
  /** 보이게 되거나 연결 상태가 바뀌면 부른다(폴링 기다림을 깨운다). 돌려준 함수로 끊는다 */
  onWake(cb: () => void): () => void;
  navigate(url: string): void;
  sha256(text: string): Promise<string>;
  /** 팬 토큰 갱신 한 번(창끼리 하나씩) */
  refresh(): Promise<'ok' | 'rejected' | 'unavailable'>;
}

export interface Controller {
  /** 대기 취소(확인 대화상자 뒤). 204면 저장소를 지우고 공연 상세로, 아니면 대기를 이어 가고 false */
  cancel(): Promise<boolean>;
  /** 만료 뒤 다시 줄 서기·다른 기기 참가 뒤 이 기기에서 다시 참가 */
  rejoin(): void;
  stop(): void;
}

const STALE_FAILURES = 3;
const STALE_SILENCE_MS = 30_000;
/** 차례 1분 [가정] 전에 팬 토큰을 미리 갱신한다(§5.1 '차례와 입장') */
const PRE_REFRESH_ETA_SEC = 60;

export function startQueue(env: Env, onView: (v: QueueView) => void): Controller {
  const { net, store, clock, urls } = env;
  const base = `/v1/queues/${encodeURIComponent(env.eventId)}`;
  let run = new AbortController();
  let current: QueueView = { state: 'boot' };
  const show = (v: QueueView) => {
    current = v;
    onView(v);
  };
  const stopped = (sig: AbortSignal) => sig.aborted;
  const leave = (url: string, sig: AbortSignal) => {
    if (stopped(sig)) return;
    show({ state: 'leaving' });
    env.navigate(url);
  };
  /** 서버 하한 위로만 0~20%(§4.1, 중간-038) */
  const above = (ms: number) => ms * (1 + env.random() * 0.2);
  /** 실패 뒤 다시 보내기: 전체 지터 0 ~ min(500 × 2^n, 8000)밀리초(§4.1 '기다림') */
  const backoff = (failures: number) => env.random() * Math.min(500 * 2 ** failures, 8000);

  /** 기다림. wakeable이면 보이게 되거나 연결 상태가 바뀔 때 일찍 끝난다(폴링 간격만) */
  const wait = async (ms: number, sig: AbortSignal, wakeable = false) => {
    const stop = new AbortController();
    const stopWake = wakeable ? env.onWake(() => stop.abort()) : () => undefined;
    const onAbort = () => stop.abort();
    sig.addEventListener('abort', onAbort, { once: true });
    try {
      await env.sleep(Math.max(0, ms), stop.signal);
    } finally {
      stopWake();
      sig.removeEventListener('abort', onAbort);
    }
  };

  const timed = async (f: () => Promise<Reply>): Promise<{ reply: Reply | null; sentAt: number; receivedAt: number }> => {
    const sentAt = env.deviceNow();
    try {
      const reply = await f();
      return { reply, sentAt, receivedAt: env.deviceNow() };
    } catch {
      return { reply: null, sentAt, receivedAt: env.deviceNow() };
    }
  };

  // ── 진입 ──
  async function enter(sig: AbortSignal, entryRequestId: string, token: string): Promise<void> {
    store.write({ entry: { entryRequestId, token } });
    let failures = 0;
    let refreshed = false;
    while (!stopped(sig)) {
      show({ state: 'enter' });
      const { reply, sentAt, receivedAt } = await timed(() => net.postText(`${urls.queue}${base}/entries`, { preverifyToken: token, ...deviceField(), entryRequestId }, sig));
      if (stopped(sig)) return;
      if (reply?.status === 201) {
        clock.sample(field(reply, 'serverTimeMs'), sentAt, receivedAt);
        const t = ticketOf(reply.body);
        if (!t) {
          await wait(backoff(++failures), sig);
          continue;
        }
        store.write({ ticket: t, entry: undefined });
        if (field(reply, 'verification') === 'REQUIRED') return leave(urls.verify, sig);
        return waiting(sig, t);
      }
      if (reply?.status === 202) {
        clock.sample(field(reply, 'serverTimeMs'), sentAt, receivedAt);
        const b = batchingOf(reply.body, entryRequestId);
        if (!b) {
          await wait(backoff(++failures), sig);
          continue;
        }
        store.write({ entry: { entryRequestId, token, batching: b } });
        return batching(sig, entryRequestId, token, b);
      }
      if (reply?.status === 401) {
        // 팬 토큰(15분) 만료: 한 번 갱신하고 같은 요청 ID로 다시 보낸다. 또 401이거나 갱신이 거절되면 로그인 만료
        const r = refreshed ? 'rejected' : await env.refresh();
        refreshed = true;
        if (stopped(sig)) return;
        if (r === 'ok') continue;
        if (r === 'unavailable') {
          await wait(backoff(++failures), sig);
          refreshed = false;
          continue;
        }
        return show({ state: 'login-expired' });
      }
      if (reply?.status === 409) {
        if (reply.problem === 'already-waiting') return show({ state: 'other-device' });
        if (reply.problem === 'already-admitted') return show({ state: 'already-admitted' });
        store.clearEntry();
        return leave(urls.event, sig);
      }
      if (reply?.status === 410) {
        store.clearAll();
        return show({ state: reply.problem === 'sold-out' ? 'sold-out' : 'ended' });
      }
      if (reply?.status === 429 || reply?.status === 503) {
        const ms = above(reply.retryAfterMs ?? 1000);
        show(reply.status === 429 ? { state: 'enter', busyUntil: env.deviceNow() + ms } : { state: 'enter' });
        await wait(ms, sig);
        continue;
      }
      if (reply && reply.status >= 400 && reply.status < 500) {
        // 403·404 등과 꼴이 틀린 요청(400·415): 공연 상세가 상태(사람 확인·본인확인·오픈 전)를 다시 그린다
        store.clearEntry();
        return leave(urls.event, sig);
      }
      failures++;
      if (!env.online()) show({ state: 'offline' });
      await wait(backoff(failures), sig, !env.online());
    }
  }

  // ── 묶음 결과 ──
  async function batching(sig: AbortSignal, entryRequestId: string, token: string, b: Batching): Promise<void> {
    show({ state: 'batching' });
    const h = await env.sha256(token);
    if (stopped(sig)) return;
    const due = b.resultAtMs + spreadDelayMs(h, b.spreadSec);
    await wait(due - clock.now(), sig);
    let attempt = 0;
    while (!stopped(sig)) {
      const { reply } = await timed(() => net.getFile(`${urls.files}${b.resultPath}`, false, sig));
      if (stopped(sig)) return;
      const seq = reply?.status === 200 && reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>)[h] : undefined;
      if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 1) return enter(sig, entryRequestId, token);
      await wait(resultRetryDelayMs(attempt++, env.random), sig);
    }
  }

  // ── 대기 ──
  async function waiting(sig: AbortSignal, t: Ticket): Promise<void> {
    const reader = new MonotonicReader();
    let failures = 0;
    let retryAfterMs: number | null = null;
    let lastOkAt = env.deviceNow();
    let lastSyncAt: number | undefined;
    let notBefore = 0;
    let preRefreshed = false;
    while (!stopped(sig)) {
      if (!env.online()) {
        show({ ...current, state: 'offline', ...(lastSyncAt !== undefined ? { lastSyncAt } : {}) });
        await wait(60_000, sig, true);
        continue;
      }
      const { reply } = await timed(() => net.getFile(`${urls.files}${base}/segment-states/${t.segment}.json`, true, sig));
      if (stopped(sig)) return;
      const parsed = reply?.status === 200 ? parseQueueState(reply.body) : null;
      if (parsed) {
        failures = 0;
        retryAfterMs = null;
        lastOkAt = env.deviceNow();
        reader.accept(parsed, env.deviceNow());
        lastSyncAt = clock.now();
      } else {
        failures++;
        retryAfterMs = reply?.status === 503 ? reply.retryAfterMs : null;
      }
      const f = reader.current;
      const stale = failures >= STALE_FAILURES || (failures > 0 && env.deviceNow() - lastOkAt > STALE_SILENCE_MS);
      if (f) {
        if (f.saleStatus === 'ENDED') return finish('ended', true);
        if (f.saleStatus === 'SOLD_OUT') return finish('sold-out', false);
        const view = viewOf(t, f, stale);
        if (lastSyncAt !== undefined) view.lastSyncAt = lastSyncAt;
        show(view);
        if (!preRefreshed && view.etaSec !== null && view.etaSec !== undefined && view.etaSec <= PRE_REFRESH_ETA_SEC) {
          preRefreshed = true;
          void env.refresh();
        }
        const turnReady = f.serving >= t.seq && view.state === 'waiting' && !env.hidden() && env.deviceNow() >= notBefore;
        if (turnReady) {
          const r = await admission(sig, t);
          if (r === 'done' || stopped(sig)) return;
          // NOT_YET·일시 실패: 그 시각 전에는 입장 확정을 다시 보내지 않는다(폴링은 이어 간다)
          notBefore = env.deviceNow() + r.delayMs;
          continue;
        }
      } else if (stale) {
        show({ state: 'stale' });
      } else {
        show({ state: 'enter' });
      }
      const ahead = f ? aheadCount(t.seq, f) : 0;
      const delay = nextDelayMs(
        { ahead, servingRate: f?.servingRate ?? 0, mySegment: t.segment, servingSegment: f ? segmentOf(Math.max(1, f.serving)) : t.segment, pollHintMs: f?.pollHintMs ?? 0 },
        failures,
        env.hidden(),
        retryAfterMs,
        env.random,
      );
      const untilTurn = notBefore > env.deviceNow() ? notBefore - env.deviceNow() : Infinity;
      // 503 Retry-After가 하한이면 깨우지 않는다. 그 밖의 폴링 간격은 보이게 되거나 연결이 돌아오면 일찍 끝난다(서버 하한 notBefore는 위에서 지킨다)
      await wait(Math.min(delay, untilTurn), sig, retryAfterMs === null);
    }
  }

  function viewOf(t: Ticket, f: QueueState, stale: boolean): QueueView {
    const ahead = aheadCount(t.seq, f);
    let first = store.firstAhead();
    if (first === null) {
      first = ahead;
      store.setFirstAhead(ahead);
    }
    const eta = etaSeconds(ahead, f);
    const rec = store.read();
    if (eta !== null && !rec?.firstEta) store.write({ firstEta: { sec: Math.max(1, Math.round(eta)), atMs: Math.round(clock.now()) } });
    const progress = first <= 0 ? 100 : Math.min(100, Math.max(0, ((first - ahead) / first) * 100));
    const state: LiveState = stale ? 'stale' : f.saleStatus === 'PAUSED' || f.admissionPaused ? 'paused' : f.saleStatus === 'ALL_HELD' ? 'all-held' : 'waiting';
    const v: QueueView = { state, ahead, progress, etaSec: eta, purchaseUnlikely: purchaseUnlikely(ahead, f) };
    if (f.banner) v.banner = f.banner;
    return v;
  }

  // ── 입장 확정 ──
  /** 'done'(끝났거나 떠남), 아니면 다시 보내지 않을 밀리초(NOT_YET은 지터 없음, 일시 실패는 전체 지터) */
  async function admission(sig: AbortSignal, t: Ticket): Promise<'done' | { delayMs: number }> {
    let refreshed = false;
    let failures = 0;
    let soon = false;
    while (!stopped(sig)) {
      // SOON 뒤 다시 보낼 때는 '곧 입장' 화면을 그대로 둔다(깜박임·다시 낭독 없음)
      if (!soon) show({ ...current, state: 'turn' });
      const firstEta = store.read()?.firstEta;
      const body = { queueTicket: t.queueTicket, ...(firstEta ? { firstEtaSec: firstEta.sec, firstEtaAtMs: firstEta.atMs } : {}) };
      const { reply, sentAt, receivedAt } = await timed(() => net.postText(`${urls.queue}${base}/admission`, body, sig));
      if (stopped(sig)) return 'done';
      if (!reply) {
        if (++failures >= STALE_FAILURES) return { delayMs: backoff(failures) };
        await wait(backoff(failures), sig);
        continue;
      }
      clock.sample(field(reply, 'serverTimeMs'), sentAt, receivedAt);
      const status = field(reply, 'status');
      if (reply.status === 200 && status === 'ADMITTED') {
        const token = field(reply, 'admissionToken');
        if (typeof token !== 'string' || token.length === 0) return { delayMs: backoff(++failures) };
        const key = field(reply, 'serverEcdhPublicKey');
        const seatmap = field(reply, 'seatmapLayoutPath');
        const until = field(reply, 'purchaseSessionExpiresAt');
        // 공개키는 계약에서 선택이다(구매 세션 키 합의는 좌석 화면이 판단한다)
        store.saveAdmission({
          admissionToken: token,
          ...(key && typeof key === 'object' ? { serverEcdhPublicKey: key as Record<string, string> } : {}),
          ...(typeof seatmap === 'string' ? { seatmapLayoutPath: seatmap } : {}),
          ...(typeof until === 'string' ? { purchaseSessionExpiresAt: until } : {}),
          receivedAt: Math.round(clock.now()),
        });
        // 입장했으면 이 회차의 대기 값을 지운다(다시 열었을 때 쓴 대기표·토큰으로 다시 줄 서지 않게, ADR-0207 결정 8)
        store.clearAll();
        show({ state: 'admitted' });
        env.navigate(urls.seats);
        return 'done';
      }
      if (reply.status === 200 && status === 'SOON') {
        const sec = field(reply, 'retryAfterSeconds');
        const ms = above((typeof sec === 'number' && sec > 0 ? sec : 1) * 1000);
        soon = true;
        show({ ...current, state: 'soon', retryAt: env.deviceNow() + ms });
        await wait(ms, sig);
        continue;
      }
      if (reply.status === 200 && status === 'NOT_YET') {
        const ms = field(reply, 'retryAfterMs');
        return { delayMs: typeof ms === 'number' && ms > 0 ? ms : 1000 };
      }
      if (reply.status === 200 && status === 'VERIFYING') {
        leave(urls.verify, sig);
        return 'done';
      }
      if (reply.status === 401) {
        if (!refreshed) {
          refreshed = true;
          const r = await env.refresh();
          if (stopped(sig)) return 'done';
          if (r === 'ok') continue;
          if (r === 'unavailable') return { delayMs: backoff(++failures) };
        }
        show({ state: 'login-expired' });
        return 'done';
      }
      if (reply.status === 403) {
        if (reply.problem === 'booking-restricted') show({ state: 'restricted' });
        else if (reply.problem === 'identity-verification-required') leave(urls.event, sig);
        else show({ state: 'duplicate' });
        return 'done';
      }
      if (reply.status === 409) {
        show({ state: 'duplicate' });
        return 'done';
      }
      if (reply.status === 410) {
        if (reply.problem === 'queue-ticket-expired') {
          const rejoinAllowed = field(reply, 'rejoinAllowed') === true;
          // [다시 줄 서기]에 쓸 사전 검증 토큰만 남긴다(§3.12의 410 예외, ADR-0207 결정 8)
          if (rejoinAllowed) store.clearEntry();
          else store.clearAll();
          show({ state: 'expired', rejoinAllowed });
        } else if (reply.problem === 'queue-ticket-removed') {
          store.clearAll();
          show({ state: 'cancelled-elsewhere' });
        } else finish(reply.problem === 'sold-out' ? 'sold-out' : 'ended', true);
        return 'done';
      }
      if (reply.status === 503 || reply.status === 429) {
        await wait(above(reply.retryAfterMs ?? 1000), sig);
        continue;
      }
      if (++failures >= STALE_FAILURES) return { delayMs: backoff(failures) };
      await wait(backoff(failures), sig);
    }
    return 'done';
  }

  function finish(state: 'sold-out' | 'ended', clear: boolean): void {
    if (clear) store.clearAll();
    show({ state });
  }

  function deviceField(): { deviceId?: string } {
    const id = store.deviceId();
    return id ? { deviceId: id } : {};
  }

  // ── boot ──
  function boot(sig: AbortSignal): void {
    // 입장 뒤 [뒤로]로 돌아왔고 구매 세션이 남았으면 좌석 화면으로 돌려보낸다
    const adm = store.readAdmission();
    if (adm?.purchaseSessionExpiresAt && Date.parse(adm.purchaseSessionExpiresAt) > clock.now()) return leave(urls.seats, sig);
    const rec = store.read();
    if (rec?.ticket) void waiting(sig, rec.ticket);
    else if (rec?.entry?.batching) void batching(sig, rec.entry.entryRequestId, rec.entry.token, rec.entry.batching);
    else if (rec?.entry) void enter(sig, rec.entry.entryRequestId, rec.entry.token);
    else if (rec?.preverifyToken) void enter(sig, crypto.randomUUID(), rec.preverifyToken);
    else leave(urls.event, sig);
  }

  boot(run.signal);

  return {
    async cancel() {
      // 진행 중인 폴링·입장 확정·진입을 먼저 멈춘다(그사이 입장·진입이 겹치지 않게)
      run.abort();
      const { reply } = await timed(() => net.send(`${urls.queue}${base}/entries/me`, 'DELETE'));
      if (reply?.status === 204) {
        store.clearAll();
        env.navigate(urls.event);
        return true;
      }
      // 취소하지 못했으면 대기를 이어 간다(계약에 없는 404도 실패로 본다)
      run = new AbortController();
      boot(run.signal);
      return false;
    },
    rejoin() {
      const token = store.read()?.preverifyToken;
      run.abort();
      run = new AbortController();
      const sig = run.signal;
      store.clearEntry();
      if (current.state === 'other-device') {
        // 이 기기에서 다시 참가: 기존 대기를 취소한 뒤 새로 진입한다(d5 '다른 기기 참가')
        void timed(() => net.send(`${urls.queue}${base}/entries/me`, 'DELETE')).then(() => (token ? enter(sig, crypto.randomUUID(), token) : leave(urls.event, sig)));
        return;
      }
      if (token) void enter(sig, crypto.randomUUID(), token);
      else leave(urls.event, sig);
    },
    stop() {
      run.abort();
    },
  };
}

const field = (r: Reply, k: string): unknown => (r.body && typeof r.body === 'object' ? (r.body as Record<string, unknown>)[k] : undefined);

function ticketOf(b: unknown): Ticket | null {
  const r = b as Record<string, unknown> | null;
  if (!r || typeof r.queueTicket !== 'string' || !Number.isInteger(r.seq) || (r.seq as number) < 1) return null;
  const seq = r.seq as number;
  return { queueTicket: r.queueTicket, seq, generation: Number.isInteger(r.generation) ? (r.generation as number) : 0, segment: Number.isInteger(r.segment) ? (r.segment as number) : segmentOf(seq) };
}

function batchingOf(b: unknown, entryRequestId: string): Batching | null {
  const r = b as Record<string, unknown> | null;
  if (!r || typeof r.resultPath !== 'string' || !r.resultPath.startsWith('/v1/queues/') || typeof r.resultAt !== 'string') return null;
  const at = Date.parse(r.resultAt);
  if (Number.isNaN(at)) return null;
  const spread = Number.isInteger(r.spreadSec) && (r.spreadSec as number) >= 0 ? (r.spreadSec as number) : 0;
  return { entryRequestId: typeof r.entryRequestId === 'string' ? r.entryRequestId : entryRequestId, resultPath: r.resultPath, resultAtMs: at, spreadSec: spread };
}
