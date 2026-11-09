// 대기실 상태 기계를 실제 응답으로 돌린다(docs/frontend.md §3.4, ADR-0207·0208).
// boot → lobby-join → lobby → (셔플 결과) ─┐
//      → enter → (batching) ──────────────┴→ waiting ⇄ stale·paused·all-held·offline·grace → turn → soon·admitted·verify-redirect와 끝 상태.
// 바깥(네트워크·시간·저장소·이동·사람 확인·탭 조정)은 모두 주입받아, 시험이 가짜 시계로 흐름 전체를 돌린다.
// 기다림 규칙(§4.1 '기다림', §5.1): 서버가 준 하한(Retry-After·retryAfterSeconds·retryAfterMs·결과 공개 시각)은 탭 전환·연결 사건으로 깨지 않는다.
// 실패 뒤 다시 보내기는 전체 지터(0 ~ min(0.5초 × 2^n, 8초))다. 폴링 간격만 보이게 되거나 연결이 돌아오거나 리더가 되면 일찍 깬다.
// 여러 탭(§5.1, ADR-0208 결정 5): 리더만 자기 간격으로 묻고, 리더가 아닌 탭은 다른 탭의 방송이 자기 간격의 2배보다 오래됐을 때만 묻는다.
import type { Clock } from './clock.ts';
import type { Net, Reply } from './net.ts';
import { resultRetryDelayMs, spreadDelayMs } from './net.ts';
import { seatmapPath } from './preload.ts';
import { aheadCount, etaSeconds, MonotonicReader, nextDelayMs, parseQueueState, purchaseUnlikely, segmentOf, turnAtOf, type QueueState } from './queue-file.ts';
import type { Batching, Lobby, Store, Ticket } from './store.ts';
import { singleTab, type ResultState, type TabMessage, type Tabs } from './tabs.ts';

export type LiveState =
  | 'boot' | 'lobby-join' | 'lobby' | 'enter' | 'batching' | 'waiting' | 'stale' | 'paused' | 'all-held' | 'offline' | 'grace' | 'turn' | 'soon'
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
  /** offline·stale·lobby 오프라인: 마지막으로 받은 시각(보정 시계) */
  lastSyncAt?: number;
  /** lobby-join: not-yet(이 기기의 버튼이 아직)·checking(사람 확인·참가 중)·failed(사람 확인 실패). lobby: countdown·reveal·calculating·delayed */
  phase?: 'not-yet' | 'checking' | 'failed' | 'countdown' | 'reveal' | 'calculating' | 'delayed';
  /** lobby-join not-yet: 이 기기의 버튼이 열리는 시각(이 기기 시계) */
  joinAt?: number;
  /** lobby: 오픈 시각(이 기기 시계, 공연 공개 요약을 받았을 때) */
  openAt?: number;
  /** lobby: 공시한 시드 해시 */
  seedHash?: string;
  /** lobby: 연결이 끊겼다(카운트다운은 이어 간다) */
  offline?: boolean;
  /** grace: 입장해야 하는 마감(이 기기 시계) */
  graceUntil?: number;
  /** other-device·cancelled-elsewhere: 로비 참가인지 대기인지(문구가 다르다) */
  via?: 'lobby' | 'queue';
  /** 매진된 등급(대기 상태 파일 soldOutTiers, 자동 배정 희망 조건 줄의 경고에만, ADR-0212 결정 2) */
  soldOutTiers?: string[];
  /** 예매 제한의 ( 소명하기 › ) 대상(제한 ID, 소명 기한 전일 때만, ADR-0213 결정 4) */
  appealId?: string;
}

export interface Urls {
  queue: string;
  files: string;
  /** 팬 API 출처(예매 제한 조회) */
  api: string;
  event: string;
  seats: string;
  verify: string;
}

/** 공연 공개 요약의 일정(ADR-0208 결정 2) */
export interface Schedule {
  openAtMs: number;
  lobbyOpensAtMs: number | null;
  /** 좌석 자동 배정 공연(seatAssignment AUTO): 차례 직전 직접 확인을 한다(ADR-0212 결정 3) */
  autoAssign?: boolean;
}

export interface Env {
  eventId: string;
  urls: Urls;
  net: Net;
  store: Store;
  clock: Clock;
  /** 이 기기 시계(밀리초, 페이지를 연 뒤에는 단조 시계로 잰다). 기다림의 기준 */
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
  /** 공연 공개 요약의 일정. 받지 못하면 null */
  schedule(): Promise<Schedule | null>;
  /** 사람 확인 위젯을 그려 토큰을 받는다(action lobby). 위젯 실패면 null */
  humanCheck(signal: AbortSignal): Promise<string | null>;
  /** 같은 회차 탭 조정. 없으면 한 탭 */
  tabs?: Tabs;
  /** 좌석 자원 미리 받기(낮은 우선순위, 결과를 기다리지 않는다, ADR-0216). 없으면 받지 않는다 */
  preload?(seatmapLayoutPath: string): void;
}

export interface Controller {
  /** 대기 취소(확인 대화상자 뒤). 204면 저장소를 지우고 공연 상세로, 아니면 대기를 이어 가고 false */
  cancel(): Promise<boolean>;
  /** 만료 뒤 다시 줄 서기·다른 기기 참가 뒤 이 기기에서 다시 참가 */
  rejoin(): void;
  /** 사람 확인 실패 뒤 [다시 시도] */
  retry(): void;
  /** 차례 도래 유예의 [지금 입장] */
  admitNow(): void;
  stop(): void;
}

const STALE_FAILURES = 3;
const STALE_SILENCE_MS = 30_000;
/** 차례 1분 [가정] 전에 팬 토큰을 미리 갱신한다(§5.1 '차례와 입장') */
const PRE_REFRESH_ETA_SEC = 60;
/** 로비 버튼 퍼뜨리기 창(lobbySpreadSec 60 [가정], queue-svc·공연 상세와 같은 값, §5.9) */
const LOBBY_SPREAD_SEC = 60;
/** 셔플 결과가 이만큼 늦으면 '순서 발표 지연'(§3.4 shuffle-fetch) */
const SHUFFLE_DELAYED_MS = 60_000;
/** 차례가 온 뒤의 입장 유예(POL-008) */
const GRACE_MS = 15 * 60_000;
/** 자동 배정 공연의 차례 직전 직접 확인 창(10초 [가정], ADR-0043, Q-T25) */
const DIRECT_WINDOW_SEC = 10;
/** 다른 탭이 다른 대기표를 저장했어도 다시 시작하지 않는 상태(입장 확정 중·떠나는 중) */
const BUSY: readonly LiveState[] = ['admitted', 'leaving', 'turn', 'soon'];

/** 짧은 지문(FNV-1a 32비트). 방송에 원문 토큰을 싣지 않고 같은 대기표인지 가린다 */
function fp(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
const ticketKey = (t: Ticket) => `t:${fp(t.queueTicket ?? t.lobbyToken ?? '')}:${t.seq}`;
const lobbyKey = (l: Lobby) => `l:${fp(l.lobbyToken)}`;

export function startQueue(env: Env, onView: (v: QueueView) => void): Controller {
  const { net, store, clock, urls } = env;
  const tabs = env.tabs ?? singleTab;
  const base = `/v1/queues/${encodeURIComponent(env.eventId)}`;
  let run = new AbortController();
  let current: QueueView = { state: 'boot' };
  let schedule: Schedule | null = null;
  /** 대기 중일 때만: 다른 탭이 방송한 파일을 받는 곳 */
  let onPeerFile: ((f: QueueState) => void) | null = null;
  /** 기다림을 깨우는 곳(방송·리더 바뀜·[지금 입장]) */
  const nudges = new Set<(why: 'peer' | 'leader' | 'admit') => void>();
  let forceAdmit = false;
  /** 이 탭이 지금 쓰는 값의 지문(대기표 t:·참가 토큰 l:·진행 중 진입 e:·참가 중 j). 방송은 같은 지문끼리만 쓴다 */
  let myKey: string | null = null;
  /** 대기 중일 때만 리더 잠금을 청한다. 다시 시작한 새 대기의 잠금을 옛 대기가 놓지 않게 차례 번호를 둔다 */
  let lease = 0;
  /** 저장소의 값 지문 */
  const storeKey = (): string | null => {
    const rec = store.read();
    if (rec?.ticket) return ticketKey(rec.ticket);
    if (rec?.lobby) return lobbyKey(rec.lobby);
    if (rec?.entry) return `e:${rec.entry.entryRequestId}`;
    return null;
  };
  /** 저장소가 이 탭의 값일 때만 지운다(다른 탭이 받은 새 대기표를 지우지 않는다) */
  const clearAllMine = () => {
    if (storeKey() === myKey) store.clearAll();
  };
  const clearEntryMine = () => {
    const k = storeKey();
    if (k === myKey || k === null) store.clearEntry();
  };
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
  /** 보정 시계 시각 → 이 기기 시계 시각(화면 카운트다운은 이 기기 시계로 센다) */
  const toDevice = (serverMs: number) => serverMs - (clock.now() - env.deviceNow());
  /** 서버 하한 위로만 0~20%(§4.1, 중간-038) */
  const above = (ms: number) => ms * (1 + env.random() * 0.2);
  /** 실패 뒤 다시 보내기: 전체 지터 0 ~ min(500 × 2^n, 8000)밀리초(§4.1 '기다림') */
  const backoff = (failures: number) => env.random() * Math.min(500 * 2 ** failures, 8000);

  /** 기다림. wakeable이면 보이게 되거나 연결 상태가 바뀔 때, nudge면 방송·리더 바뀜에도 일찍 끝난다. 끝난 까닭을 돌려준다 */
  const wait = async (ms: number, sig: AbortSignal, wakeable = false, nudge = false): Promise<'timer' | 'wake' | 'peer' | 'leader' | 'admit'> => {
    const stop = new AbortController();
    let why: 'timer' | 'wake' | 'peer' | 'leader' | 'admit' = 'timer';
    const stopWake = wakeable
      ? env.onWake(() => {
          why = 'wake';
          stop.abort();
        })
      : () => undefined;
    const onNudge = (w: 'peer' | 'leader' | 'admit') => {
      if (!nudge) return;
      why = w;
      stop.abort();
    };
    nudges.add(onNudge);
    const onAbort = () => stop.abort();
    sig.addEventListener('abort', onAbort, { once: true });
    try {
      await env.sleep(Math.max(0, ms), stop.signal);
    } finally {
      stopWake();
      nudges.delete(onNudge);
      sig.removeEventListener('abort', onAbort);
    }
    return why;
  };
  const nudge = (why: 'peer' | 'leader' | 'admit') => {
    for (const f of [...nudges]) f(why);
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

  /** 끝 상태를 보이고 다른 탭에 알린다 */
  /** 마지막으로 미리 받은 좌석맵 경로. 페이지마다 한 번이라 대기 루프를 다시 돌아도(다시 줄 서기·다른 탭의 대기표) 비우지 않는다(ADR-0216 결정 2) */
  let preloadedPath: string | null = null;

  const end = (state: ResultState, extra: Partial<QueueView> = {}) => {
    const via = extra.via ?? current.via;
    show({ state, ...extra });
    if (myKey) tabs.post({ t: 'result', k: myKey, state, ...(extra.rejoinAllowed !== undefined ? { rejoinAllowed: extra.rejoinAllowed } : {}), ...(via ? { via } : {}) });
    if (state === 'restricted') void restrictedAppeal();
  };

  /**
   * 예매 제한(입장 확정 403)에는 제한 ID가 없어 팬 API로 한 번 받는다(ADR-0213 결정 4). 소명 기한 전이면 ( 소명하기 › )를 잇고,
   * 실패·NONE(화면용 사본이 늦음)·기한 지남이면 공연 상세 링크 그대로다. 대기표는 지우지 않는다
   */
  async function restrictedAppeal(): Promise<void> {
    let r: Reply | undefined;
    try {
      r = await net.getFan(`${urls.api}/v1/booking-restrictions/me`);
    } catch {
      return;
    }
    if (!r || r.status !== 200 || current.state !== 'restricted') return;
    const b = r.body as { status?: unknown; restrictionId?: unknown; appealDueAt?: unknown } | undefined;
    if (b?.status !== 'ACTIVE' || typeof b.restrictionId !== 'string' || b.restrictionId === '') return;
    const due = typeof b.appealDueAt === 'string' ? Date.parse(b.appealDueAt) : Number.NaN;
    if (!Number.isNaN(due) && due <= clock.now()) return;
    show({ ...current, appealId: b.restrictionId });
  }

  /** 저장한 뒤 다른 탭에 알린다(그 탭은 저장소에서 다시 시작한다) */
  const stored = () => {
    const k = storeKey();
    if (k) tabs.post({ t: 'stored', k });
  };

  // ── 진입 ──
  async function enter(sig: AbortSignal, entryRequestId: string, token: string): Promise<void> {
    myKey = `e:${entryRequestId}`;
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
        myKey = ticketKey(t);
        stored();
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
        return end('login-expired');
      }
      if (reply?.status === 409) {
        if (reply.problem === 'already-waiting') {
          // 같은 기기의 다른 탭이 먼저 받은 대기표면 그것을 쓴다(ADR-0208 결정 5)
          const other = store.read()?.ticket;
          if (other) return waiting(sig, other);
          return show({ state: 'other-device', via: 'queue' });
        }
        if (reply.problem === 'already-admitted') return end('already-admitted');
        clearEntryMine();
        return leave(urls.event, sig);
      }
      if (reply?.status === 410) {
        clearAllMine();
        if (reply.problem !== 'sold-out') store.clearAutoAssign();
        // 취소한 참가의 재전송: 다른 기기에서 대기를 취소했다(ADR-0233)
        if (reply.problem === 'queue-ticket-removed') return end('cancelled-elsewhere', { via: 'queue' });
        return end(reply.problem === 'sold-out' ? 'sold-out' : 'ended');
      }
      if (reply?.status === 429 || reply?.status === 503) {
        const ms = above(reply.retryAfterMs ?? 1000);
        show(reply.status === 429 ? { state: 'enter', busyUntil: env.deviceNow() + ms } : { state: 'enter' });
        await wait(ms, sig);
        continue;
      }
      if (reply && reply.status >= 400 && reply.status < 500) {
        // 403·404 등과 꼴이 틀린 요청(400·415): 공연 상세가 상태(사람 확인·본인확인·오픈 전)를 다시 그린다
        clearEntryMine();
        // 사전 검증 토큰이 맞지 않으면 그 토큰도 지운다. 남기면 공연 상세가 그 토큰으로 다시 보내 두 화면을 오간다(ADR-0211 결정 4)
        if (reply.problem === 'preverify-invalid') store.write({ preverifyToken: undefined, preverifyIssuedAt: undefined, preverifyExpiresAt: undefined });
        return leave(urls.event, sig);
      }
      failures++;
      if (!env.online()) show({ state: 'offline' });
      await wait(backoff(failures), sig, !env.online());
    }
  }

  // ── 묶음 결과 ──
  async function batching(sig: AbortSignal, entryRequestId: string, token: string, b: Batching): Promise<void> {
    myKey = `e:${entryRequestId}`;
    show({ state: 'batching' });
    const h = await env.sha256(token).catch(() => null);
    if (stopped(sig)) return;
    if (!h) return show({ state: 'stale' });
    const due = b.resultAtMs + spreadDelayMs(h, b.spreadSec);
    await wait(due - clock.now(), sig);
    let attempt = 0;
    let missing = 0;
    while (!stopped(sig)) {
      const { reply } = await timed(() => net.getFile(`${urls.files}${b.resultPath}`, false, sig));
      if (stopped(sig)) return;
      const seq = reply?.status === 200 && reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>)[h] : undefined;
      if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 1) return enter(sig, entryRequestId, token);
      // 게시한 파일은 바뀌지 않는다: 두 번 연달아 내 해시가 없으면 서버에 묻는다(취소됐으면 410, 잃은 참가면 맨 뒤 번호, ADR-0233)
      if (reply?.status === 200 && ++missing >= 2) return enter(sig, entryRequestId, token);
      if (reply?.status !== 200) missing = 0;
      await wait(resultRetryDelayMs(attempt++, env.random), sig);
    }
  }

  // ── 로비 참가(ADR-0208 결정 3) ──
  async function lobbyJoin(sig: AbortSignal, s: Schedule, skipUnlock = false): Promise<void> {
    // 참가 전에도 오픈까지의 카운트다운을 보인다(d5 §5.7 ①)
    const joinView = (phase: 'not-yet' | 'checking' | 'failed', extra: Partial<QueueView> = {}): QueueView => ({ state: 'lobby-join', phase, openAt: toDevice(s.openAtMs), ...extra });
    myKey = 'j';
    if (!skipUnlock && s.lobbyOpensAtMs !== null) {
      // 이 기기의 로비 버튼 열리는 시각 = 로비 개방 + u32be(SHA-256("PEAKET-lobby-open-v1" ‖ 회차 ID ‖ deviceId)[0..4]) mod 60초(§5.9)
      // 해시를 못 내면(보안 맥락이 아니라 crypto.subtle이 없음) 퍼뜨림 끝(가장 늦은 시각)에 연다(웹 lobby-unlock과 같다)
      const h = await env.sha256(`PEAKET-lobby-open-v1${env.eventId}${store.deviceId() ?? pageDevice()}`).catch(() => null);
      if (stopped(sig)) return;
      const delay = h ? Number.parseInt(h.slice(0, 8), 16) % (LOBBY_SPREAD_SEC * 1000) : LOBBY_SPREAD_SEC * 1000 - 1;
      const joinAt = s.lobbyOpensAtMs + delay;
      if (clock.now() < joinAt) {
        show(joinView('not-yet', { joinAt: toDevice(joinAt) }));
        await wait(joinAt - clock.now(), sig);
        if (stopped(sig)) return;
      }
    }
    let token: string | null = null;
    let failures = 0;
    let refreshed = false;
    while (!stopped(sig)) {
      if (!token) {
        show(joinView('checking'));
        token = await env.humanCheck(sig);
        if (stopped(sig)) return;
        if (!token) return show(joinView('failed'));
      }
      const { reply, sentAt, receivedAt } = await timed(() => net.postJson(`${urls.queue}${base}/lobby-participants`, { humanCheckToken: token, ...deviceField() }, sig));
      if (stopped(sig)) return;
      if (reply?.status === 201) {
        clock.sample(field(reply, 'serverTimeMs'), sentAt, receivedAt);
        const l = lobbyOf(reply.body);
        if (!l) {
          token = null;
          await wait(backoff(++failures), sig);
          continue;
        }
        store.write({ lobby: l });
        myKey = lobbyKey(l);
        stored();
        if (field(reply, 'verification') === 'REQUIRED') return leave(urls.verify, sig);
        return lobby(sig, l);
      }
      if (reply?.status === 401) {
        // 게이트웨이가 거절해 사람 확인 토큰을 쓰지 않았다: 갱신 한 번 뒤 같은 토큰으로
        const r = refreshed ? 'rejected' : await env.refresh();
        refreshed = true;
        if (stopped(sig)) return;
        if (r === 'ok') continue;
        if (r === 'unavailable') {
          await wait(backoff(++failures), sig);
          refreshed = false;
          continue;
        }
        return end('login-expired');
      }
      if (reply?.status === 403 && reply.problem === 'identity-verification-required') return leave(urls.event, sig);
      if (reply?.status === 403 || reply?.status === 428) return show(joinView('failed'));
      if (reply?.status === 409) {
        const again = store.read();
        if (again?.lobby) return lobby(sig, again.lobby);
        if (again?.ticket) return waiting(sig, again.ticket);
        // 오픈이 지났으면(시계 차) 오픈 뒤 경로로 다시 고른다
        if (clock.now() >= s.openAtMs) return decide(sig, again);
        return show({ state: 'other-device', via: 'lobby', openAt: toDevice(s.openAtMs) });
      }
      if (reply?.status === 429) {
        await wait(above(reply.retryAfterMs ?? 1000), sig);
        // 축소 운영 한도(queue-request-limited, bot-defense §11.2)는 서버가 판정을 불러 토큰을 썼을 수 있어 503처럼 새 사람 확인을 받는다.
        // 게이트웨이 429는 토큰을 쓰지 않았으므로 같은 토큰으로 다시 보낸다
        if (reply.problem === 'queue-request-limited') token = null;
        continue;
      }
      if (reply?.status === 503) {
        await wait(reply.retryAfterMs !== null ? above(reply.retryAfterMs) : backoff(++failures), sig);
        token = null;
        continue;
      }
      if (reply && reply.status >= 400 && reply.status < 500) return leave(urls.event, sig);
      failures++;
      token = null;
      await wait(backoff(failures), sig, !env.online());
    }
  }

  // ── 로비 대기와 셔플 결과(ADR-0208 결정 4) ──
  async function lobby(sig: AbortSignal, l: Lobby): Promise<void> {
    myKey = lobbyKey(l);
    let s = schedule ?? (await env.schedule().catch(() => null));
    if (stopped(sig)) return;
    if (s) schedule = s;
    const h = await env.sha256(l.lobbyToken).catch(() => null);
    if (stopped(sig)) return;
    // 해시를 못 내면(보안 맥락이 아님) 결과 파일 이름을 정할 수 없다: 연결 확인 중으로 둔다
    if (!h) return show({ state: 'stale' });
    const due = l.shuffleResultAtMs + spreadDelayMs(h, l.shuffleSpreadSec);
    const view = (phase: QueueView['phase']): QueueView => {
      const v: QueueView = { state: 'lobby', phase, seedHash: l.seedHash, offline: !env.online() };
      if (s) v.openAt = toDevice(s.openAtMs);
      const synced = clock.sampledAt();
      if (synced !== null) v.lastSyncAt = synced;
      return v;
    };
    let scheduleFailures = 0;
    while (!stopped(sig) && clock.now() < due) {
      const now = clock.now();
      if (!s) {
        // 일정(오픈 시각)을 못 받았으면 공개 예정 시각 전까지는 카운트다운 자리로 두고 다시 받는다(새 맥락 리뷰 2026-11-05)
        show(view(now < l.shuffleResultAtMs ? 'countdown' : 'reveal'));
        await wait(Math.min(due - now, 1000 + backoff(++scheduleFailures)), sig, true);
        if (stopped(sig)) return;
        s = await env.schedule().catch(() => null);
        if (s) schedule = s;
        continue;
      }
      const beforeOpen = now < s.openAtMs;
      show(view(beforeOpen ? 'countdown' : 'reveal'));
      await wait((beforeOpen ? Math.min(s.openAtMs, due) : due) - now, sig, true);
    }
    let attempt = 0;
    let missing = 0;
    const startedAt = clock.now();
    while (!stopped(sig)) {
      const { reply } = await timed(() => net.getFile(`${urls.files}${base}/shuffle-results/${h.slice(0, 3)}.json`, false, sig));
      if (stopped(sig)) return;
      if (reply?.status === 200 && reply.body && typeof reply.body === 'object') {
        const seq = (reply.body as Record<string, unknown>)[h];
        if (typeof seq === 'number' && Number.isInteger(seq) && seq >= 1) {
          const t: Ticket = { lobbyToken: l.lobbyToken, seq, generation: 0, segment: segmentOf(seq) };
          store.write({ ticket: t, lobby: undefined });
          myKey = ticketKey(t);
          stored();
          return waiting(sig, t);
        }
        // 목록을 고정한 뒤 게시한 파일은 바뀌지 않는다: 두 번 연달아 없으면 다른 기기에서 취소된 참가다
        if (++missing >= 2) {
          clearAllMine();
          return end('cancelled-elsewhere', { via: 'lobby' });
        }
      } else missing = 0;
      const late = () => clock.now() - startedAt >= SHUFFLE_DELAYED_MS;
      show(view(late() ? 'delayed' : 'calculating'));
      let ms = resultRetryDelayMs(attempt++, env.random);
      // 다음 받기 전에 60초가 넘으면 그때 '순서 발표 지연'으로 바꾸고 나머지를 기다린다
      const untilLate = startedAt + SHUFFLE_DELAYED_MS - clock.now();
      if (!late() && untilLate < ms) {
        await wait(untilLate, sig);
        if (stopped(sig)) return;
        show(view('delayed'));
        ms -= untilLate;
      }
      await wait(ms, sig);
    }
  }

  // ── 대기 ──
  async function waiting(sig: AbortSignal, t: Ticket): Promise<void> {
    const reader = new MonotonicReader();
    let failures = 0;
    let retryAfterMs: number | null = null;
    let lastOkAt = env.deviceNow();
    let lastSyncAt: number | undefined;
    /** NOT_YET의 서버 하한(지터 없이 그 시각에, [지금 입장]으로도 깨지 않는다) */
    let floorUntil = 0;
    /** 입장 확정 실패 뒤 다시 보낼 때(전체 지터). [지금 입장]은 이 기다림을 건너뛴다 */
    let retryAt = 0;
    /** 입장 확정 실패 수(부를 때마다 0으로 돌리지 않아 기다림이 늘어난다) */
    let admitFailures = 0;
    let preRefreshed = false;
    /** 차례 전이던 마지막 파일의 생성 시각(차례가 온 시각의 아래 경계) */
    let lastBeforeAt: number | null = null;
    let turnAt: number | null = store.read()?.turnAtMs ?? null;
    /** 다른 탭의 마지막 방송을 받은 때(이 기기 시계) */
    let lastPeerAt: number | null = null;
    let nextTickAt = 0;
    let interval = 0;
    /** 자동 배정 공연: 예상 도래 시각(이 기기 시계). 직접 확인을 그때 보낸다 */
    let directAt: number | null = null;
    // 직접 확인에 쓸 일정(좌석 배정 방식)을 아직 모르면 받아 둔다(대기열 경로를 막지 않는다). 못 받으면 늘려 가며 다시
    let scheduleTries = 0;
    let scheduleAt = 0;
    let scheduleBusy = false;
    const fetchSchedule = () => {
      if (schedule || scheduleBusy || env.deviceNow() < scheduleAt) return;
      scheduleBusy = true;
      void env.schedule().then(
        (x) => {
          scheduleBusy = false;
          if (x) schedule = x;
          else scheduleAt = env.deviceNow() + 1000 + backoff(++scheduleTries);
        },
        () => {
          scheduleBusy = false;
          scheduleAt = env.deviceNow() + 1000 + backoff(++scheduleTries);
        },
      );
    };
    fetchSchedule();
    const accept = (f: QueueState) => {
      reader.accept(f, env.deviceNow());
      const cur = reader.current;
      if (cur && cur.serving < t.seq) lastBeforeAt = cur.generatedAtMs;
    };
    myKey = ticketKey(t);
    const myLease = ++lease;
    tabs.setActive(true);
    const mine = (f: QueueState) => {
      lastPeerAt = env.deviceNow();
      failures = 0;
      lastOkAt = env.deviceNow();
      lastSyncAt = clock.now();
      accept(f);
    };
    onPeerFile = mine;
    try {
      while (!stopped(sig)) {
        if (!env.online()) {
          show({ ...current, state: 'offline', ...(lastSyncAt !== undefined ? { lastSyncAt } : {}) });
          await wait(60_000, sig, true);
          nextTickAt = 0;
          continue;
        }
        const tick = env.deviceNow() >= nextTickAt;
        if (tick) {
          fetchSchedule();
          const leader = tabs.leader() && !env.hidden();
          const peerFresh = lastPeerAt !== null && env.deviceNow() - lastPeerAt < 2 * interval;
          if (leader || !peerFresh || !reader.current) {
            const { reply } = await timed(() => net.getFile(`${urls.files}${base}/segment-states/${t.segment}.json`, true, sig));
            if (stopped(sig)) return;
            const parsed = reply?.status === 200 ? parseQueueState(reply.body) : null;
            if (parsed) {
              failures = 0;
              retryAfterMs = null;
              lastOkAt = env.deviceNow();
              accept(parsed);
              lastSyncAt = clock.now();
              tabs.post({ t: 'file', k: ticketKey(t), file: reply!.body });
            } else {
              failures++;
              retryAfterMs = reply?.status === 503 ? reply.retryAfterMs : null;
            }
          }
        }
        const f = reader.current;
        const stale = failures >= STALE_FAILURES || (failures > 0 && env.deviceNow() - lastOkAt > STALE_SILENCE_MS);
        if (f) {
          if (f.saleStatus === 'ENDED') return finish('ended', true);
          if (f.saleStatus === 'SOLD_OUT') return finish('sold-out', false);
          const view = viewOf(t, f, stale);
          if (lastSyncAt !== undefined) view.lastSyncAt = lastSyncAt;
          if (!preRefreshed && view.etaSec !== null && view.etaSec !== undefined && view.etaSec <= PRE_REFRESH_ETA_SEC) {
            preRefreshed = true;
            void env.refresh();
          }
          // 좌석 자원은 예상 60초 안에 리더(보이는 탭)만 받는다. HTTP 캐시는 탭끼리 나눠 쓴다(ADR-0216 결정 2·4)
          const layout = seatmapPath(env.eventId, f.seatmapLayoutPath);
          // 차례가 온 뒤(serving ≥ 내 순번)에는 받지 않는다: 입장 확정·좌석 화면 이동과 대역폭을 다투지 않게
          if (layout && layout !== preloadedPath && f.serving < t.seq && view.state === 'waiting' && typeof view.etaSec === 'number' && view.etaSec <= PRE_REFRESH_ETA_SEC && tabs.leader() && !env.hidden()) {
            preloadedPath = layout;
            env.preload?.(layout);
          }
          const turn = f.serving >= t.seq && view.state === 'waiting';
          if (turn && turnAt === null) {
            // 다른 탭이 먼저 정해 저장한 시각이 있으면 그것을 쓴다
            const saved = storeKey() === ticketKey(t) ? store.read()?.turnAtMs : undefined;
            turnAt = saved ?? turnAtOf(t.seq, f, lastBeforeAt);
            if (saved === undefined && storeKey() === ticketKey(t)) store.write({ turnAtMs: turnAt });
          }
          // 자동 배정 공연은 예상 대기가 10초 안이면 예상 도래 시각에 직접 확인한다(리더만, ADR-0212 결정 3)
          const eta = view.etaSec;
          if (schedule?.autoAssign === true && !turn && view.state === 'waiting' && typeof eta === 'number' && eta <= DIRECT_WINDOW_SEC) {
            directAt ??= env.deviceNow() + eta * 1000;
          } else if (!turn) directAt = null;
          const directReady = directAt !== null && env.deviceNow() >= directAt;
          const floored = env.deviceNow() < floorUntil;
          const leaderNow = tabs.leader() && !env.hidden();
          const canSend = !floored && ((turn && (forceAdmit || (leaderNow && env.deviceNow() >= retryAt))) || (!turn && directReady && leaderNow && env.deviceNow() >= retryAt));
          // [지금 입장]은 이번 판단에 한 번만 쓴다(서버 하한 중에 누른 것은 버린다)
          forceAdmit = false;
          if (canSend) {
            // 차례 전 직접 확인은 화면을 '입장 중'으로 바꾸지 않는다(ADMITTED·SOON이 오면 그때 바뀐다)
            const r = await admission(sig, t, admitFailures, !turn);
            if (r === 'done' || stopped(sig)) return;
            admitFailures = r.failures;
            // NOT_YET은 서버 하한, 일시 실패는 전체 지터 뒤 다시(폴링은 이어 간다)
            if (r.kind === 'floor') floorUntil = env.deviceNow() + r.delayMs;
            else retryAt = env.deviceNow() + r.delayMs;
          }
          // 차례가 왔는데 이 탭이 지금 보내지 않으면 차례 도래 유예(숨김·리더 아님·실패 뒤 기다림). NOT_YET 하한 동안은 대기 화면(§3.4)
          if (turn && env.deviceNow() >= floorUntil) show({ state: 'grace', graceUntil: toDevice(turnAt! + GRACE_MS) });
          else show(view);
        } else if (stale) {
          show({ state: 'stale' });
        } else {
          show({ state: 'enter' });
        }
        if (tick) {
          const ahead = f ? aheadCount(t.seq, f) : 0;
          interval = nextDelayMs(
            { ahead, servingRate: f?.servingRate ?? 0, mySegment: t.segment, servingSegment: f ? segmentOf(Math.max(1, f.serving)) : t.segment, pollHintMs: f?.pollHintMs ?? 0 },
            failures,
            env.hidden(),
            retryAfterMs,
            env.random,
          );
          nextTickAt = env.deviceNow() + interval;
        }
        const nowD = env.deviceNow();
        const untilTurn = Math.min(floorUntil > nowD ? floorUntil - nowD : Infinity, retryAt > nowD ? retryAt - nowD : Infinity, directAt !== null && directAt > nowD ? directAt - nowD : Infinity);
        // 503 Retry-After가 하한이면 보이기·연결 사건으로 깨우지 않는다. 방송·리더 바뀜·[지금 입장]은 늘 깨운다(다시 그리기만 하고 묻기는 nextTickAt을 지킨다)
        const why = await wait(Math.min(nextTickAt - env.deviceNow(), untilTurn), sig, retryAfterMs === null, true);
        if ((why === 'wake' || why === 'leader') && retryAfterMs === null) nextTickAt = 0;
      }
    } finally {
      // 다시 시작한 새 대기가 이미 자기 것을 걸었으면 건드리지 않는다
      if (onPeerFile === mine) onPeerFile = null;
      if (lease === myLease) tabs.setActive(false);
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
    if (eta !== null && !rec?.firstEta && storeKey() === ticketKey(t)) store.write({ firstEta: { sec: Math.max(1, Math.round(eta)), atMs: Math.round(clock.now()) } });
    const progress = first <= 0 ? 100 : Math.min(100, Math.max(0, ((first - ahead) / first) * 100));
    const state: LiveState = stale ? 'stale' : f.saleStatus === 'PAUSED' || f.admissionPaused ? 'paused' : f.saleStatus === 'ALL_HELD' ? 'all-held' : 'waiting';
    const v: QueueView = { state, ahead, progress, etaSec: eta, purchaseUnlikely: purchaseUnlikely(ahead, f) };
    if (f.banner) v.banner = f.banner;
    if (f.soldOutTiers.length > 0) v.soldOutTiers = f.soldOutTiers;
    return v;
  }

  // ── 입장 확정 ──
  type AdmitWait = { kind: 'floor' | 'retry'; delayMs: number; failures: number };
  /**
   * 'done'(끝났거나 떠남), 아니면 다시 보내지 않을 밀리초와 그 종류: floor(NOT_YET 서버 하한, 지터 없음)·retry(일시 실패, 전체 지터).
   * 실패 수는 부를 때마다 이어 받아 기다림이 늘어난다(분당 재시도 예산, §4.1)
   */
  async function admission(sig: AbortSignal, t: Ticket, priorFailures: number, direct = false): Promise<'done' | AdmitWait> {
    let refreshed = false;
    let failures = priorFailures;
    let tries = 0;
    let soon = false;
    const retry = (): AdmitWait => ({ kind: 'retry', delayMs: backoff(failures), failures });
    while (!stopped(sig)) {
      // SOON 뒤 다시 보낼 때는 '곧 입장' 화면을 그대로 둔다(깜박임·다시 낭독 없음)
      if (!soon && !direct) show({ ...current, state: 'turn' });
      const firstEta = store.read()?.firstEta;
      const body = { ...(t.queueTicket ? { queueTicket: t.queueTicket } : { lobbyToken: t.lobbyToken }), ...(firstEta ? { firstEtaSec: firstEta.sec, firstEtaAtMs: firstEta.atMs } : {}) };
      const { reply, sentAt, receivedAt } = await timed(() => net.postText(`${urls.queue}${base}/admission`, body, sig));
      if (stopped(sig)) return 'done';
      if (!reply) {
        failures++;
        if (++tries >= STALE_FAILURES) return retry();
        await wait(backoff(failures), sig);
        continue;
      }
      clock.sample(field(reply, 'serverTimeMs'), sentAt, receivedAt);
      const status = field(reply, 'status');
      if (reply.status === 200 && status === 'ADMITTED') {
        const token = field(reply, 'admissionToken');
        if (typeof token !== 'string' || token.length === 0) {
          failures++;
          return retry();
        }
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
        clearAllMine();
        show({ state: 'admitted' });
        tabs.post({ t: 'result', k: ticketKey(t), state: 'admitted' });
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
        // 시도 간격은 1초 이상이다(queue-admission §4, 게이트웨이 레이트 리밋): 차례에 가까울수록 1초보다 작은 값이 오는 게 정상이다
        return { kind: 'floor', delayMs: Math.max(1000, typeof ms === 'number' && ms > 0 ? ms : 1000), failures: 0 };
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
          if (r === 'unavailable') {
            failures++;
            return retry();
          }
        }
        end('login-expired');
        return 'done';
      }
      if (reply.status === 403) {
        if (reply.problem === 'booking-restricted') end('restricted');
        else if (reply.problem === 'identity-verification-required') leave(urls.event, sig);
        else end('duplicate');
        return 'done';
      }
      if (reply.status === 409) {
        end('duplicate');
        return 'done';
      }
      if (reply.status === 410) {
        if (reply.problem === 'queue-ticket-expired') {
          const rejoinAllowed = field(reply, 'rejoinAllowed') === true;
          // [다시 줄 서기]에 쓸 사전 검증 토큰만 남긴다(§3.12의 410 예외, ADR-0207 결정 8)
          if (rejoinAllowed) clearEntryMine();
          else clearAllMine();
          end('expired', { rejoinAllowed });
        } else if (reply.problem === 'queue-ticket-removed') {
          clearAllMine();
          end('cancelled-elsewhere', { via: 'queue' });
        } else finish(reply.problem === 'sold-out' ? 'sold-out' : 'ended', true);
        return 'done';
      }
      if (reply.status === 503 || reply.status === 429) {
        await wait(above(reply.retryAfterMs ?? 1000), sig);
        continue;
      }
      failures++;
      if (++tries >= STALE_FAILURES) return retry();
      await wait(backoff(failures), sig);
    }
    return 'done';
  }

  function finish(state: 'sold-out' | 'ended', clear: boolean): void {
    if (clear) clearAllMine();
    // 판매가 끝나면 희망 조건도 지운다(§3.12, ADR-0212 결정 1)
    if (state === 'ended') store.clearAutoAssign();
    end(state);
  }

  function deviceField(): { deviceId?: string } {
    const id = store.deviceId();
    return id ? { deviceId: id } : {};
  }

  let pageId: string | null = null;
  /** 저장소를 못 써 기기 ID가 없으면 이 페이지에서만 쓰는 값(웹 lobby-unlock과 같다) */
  const pageDevice = () => (pageId ??= Array.from({ length: 4 }, () => Math.floor(env.random() * 2 ** 32).toString(16)).join(''));

  // ── 저장된 값이 없을 때: 공연 공개 요약의 일정으로 고른다(ADR-0208 결정 2) ──
  async function decide(sig: AbortSignal, rec: ReturnType<Store['read']>): Promise<void> {
    let failures = 0;
    while (!stopped(sig) && !schedule) {
      schedule = await env.schedule().catch(() => null);
      if (stopped(sig) || schedule) break;
      if (rec?.preverifyToken) return enter(sig, crypto.randomUUID(), rec.preverifyToken);
      await wait(backoff(++failures), sig, true);
    }
    if (stopped(sig) || !schedule) return;
    const now = clock.now();
    if (now < schedule.openAtMs && schedule.lobbyOpensAtMs !== null) {
      // 로비 공연의 오픈 전: 로비가 열렸으면 참가, 아직이면 공연 상세(사전 검증 토큰이 있어도 진입하지 않는다, ADR-0208 결정 2)
      return now >= schedule.lobbyOpensAtMs ? lobbyJoin(sig, schedule) : leave(urls.event, sig);
    }
    // 오픈 뒤, 또는 로비가 없는(선착순) 공연의 오픈 전(서버의 409 queue-not-open이 공연 상세로 보낸다)
    if (rec?.preverifyToken) return enter(sig, crypto.randomUUID(), rec.preverifyToken);
    leave(urls.event, sig);
  }

  // ── boot ──
  function boot(sig: AbortSignal): void {
    // 입장 뒤 [뒤로]로 돌아왔고 구매 세션이 남았으면 좌석 화면으로 돌려보낸다
    const adm = store.readAdmission();
    if (adm?.purchaseSessionExpiresAt && Date.parse(adm.purchaseSessionExpiresAt) > clock.now()) return leave(urls.seats, sig);
    const rec = store.read();
    if (rec?.ticket) void waiting(sig, rec.ticket);
    else if (rec?.lobby) void lobby(sig, rec.lobby);
    else if (rec?.entry?.batching) void batching(sig, rec.entry.entryRequestId, rec.entry.token, rec.entry.batching);
    else if (rec?.entry) void enter(sig, rec.entry.entryRequestId, rec.entry.token);
    else void decide(sig, rec);
  }

  const restart = (f: (sig: AbortSignal) => void = boot) => {
    run.abort();
    run = new AbortController();
    f(run.signal);
  };

  /**
   * 다른 탭이 다른 값(새 대기표·참가 토큰)을 저장했다고 알리면 저장소에서 다시 시작한다(끝 상태에서도).
   * 방송이 저장소 반영보다 먼저 올 수 있어, 저장소가 그 값이 될 때까지 잠깐씩 다시 본다
   */
  const adopt = (k: string, attempt = 0) => {
    if (BUSY.includes(current.state) || k === myKey) return;
    if (storeKey() === k) return restart();
    if (attempt >= 5) return;
    void env.sleep(50 * 2 ** attempt, new AbortController().signal).then(() => adopt(k, attempt + 1));
  };

  // 다른 탭의 방송은 같은 대기표(지문)일 때만 쓴다(새 맥락 리뷰 2026-11-05: 다른 대기표 탭이 서로를 끝내지 않게)
  const stopMessages = tabs.onMessage((m: TabMessage) => {
    if (m.t === 'stored') return adopt(m.k);
    if (m.k !== myKey) return;
    if (m.t === 'file') {
      const f = parseQueueState(m.file);
      if (f && onPeerFile) {
        onPeerFile(f);
        nudge('peer');
      }
    } else if (m.t === 'result') {
      if (BUSY.includes(current.state)) return;
      run.abort();
      if (m.state === 'admitted') show({ state: 'duplicate' });
      else show({ state: m.state, ...(m.rejoinAllowed !== undefined ? { rejoinAllowed: m.rejoinAllowed } : {}), ...(m.via ? { via: m.via } : {}) });
      if (m.state === 'restricted') void restrictedAppeal();
    }
  });
  const stopLeader = tabs.onLeader(() => nudge('leader'));

  boot(run.signal);

  return {
    async cancel() {
      // 진행 중인 폴링·입장 확정·진입을 먼저 멈춘다(그사이 입장·진입이 겹치지 않게)
      run.abort();
      const { reply } = await timed(() => net.send(`${urls.queue}${base}/entries/me`, 'DELETE'));
      if (reply?.status === 204) {
        // 같은 대기표를 연 다른 탭도 멈추게 알린다(새 맥락 리뷰 2026-11-05)
        if (myKey) tabs.post({ t: 'result', k: myKey, state: 'cancelled-elsewhere', via: 'queue' });
        clearAllMine();
        env.navigate(urls.event);
        return true;
      }
      // 취소하지 못했으면 대기를 이어 간다(404 queue-not-found도 실패로 본다)
      restart();
      return false;
    },
    rejoin() {
      // 다른 탭이 이미 새 대기표·참가 토큰을 받았으면 그것을 쓴다(지우거나 취소하지 않는다)
      const sk = storeKey();
      if (sk !== null && sk !== myKey) return restart();
      const rec = store.read();
      const token = rec?.preverifyToken;
      const via = current.via;
      const wasOther = current.state === 'other-device';
      restart((sig) => {
        clearEntryMine();
        const enterOrLeave = () => (token ? enter(sig, crypto.randomUUID(), token) : leave(urls.event, sig));
        if (!wasOther) return void enterOrLeave();
        // 이 기기에서 다시 참가(d5 '다른 기기 참가'): 오픈 전 로비면 로비 참가를 취소하고 다시 참가, 그 밖은 대기를 취소하고 진입
        void (async () => {
          if (via === 'lobby' && schedule && clock.now() < schedule.openAtMs) {
            const { reply } = await timed(() => net.send(`${urls.queue}${base}/lobby-participants/me`, 'DELETE'));
            if (stopped(sig)) return;
            if (reply?.status !== 409) return lobbyJoin(sig, schedule, true);
          }
          await timed(() => net.send(`${urls.queue}${base}/entries/me`, 'DELETE'));
          if (stopped(sig)) return;
          return enterOrLeave();
        })();
      });
    },
    retry() {
      if (current.state !== 'lobby-join' || current.phase !== 'failed' || !schedule) return;
      const s = schedule;
      restart((sig) => void lobbyJoin(sig, s, true));
    },
    admitNow() {
      forceAdmit = true;
      nudge('admit');
    },
    stop() {
      run.abort();
      lease++;
      tabs.setActive(false);
      stopMessages();
      stopLeader();
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

function lobbyOf(b: unknown): Lobby | null {
  const r = b as Record<string, unknown> | null;
  if (!r || typeof r.lobbyToken !== 'string' || r.lobbyToken.length === 0 || typeof r.shuffleResultAt !== 'string') return null;
  const at = Date.parse(r.shuffleResultAt);
  if (Number.isNaN(at)) return null;
  const l: Lobby = {
    lobbyToken: r.lobbyToken,
    seedHash: typeof r.seedHash === 'string' ? r.seedHash : '',
    shuffleResultAtMs: at,
    shuffleSpreadSec: Number.isInteger(r.shuffleSpreadSec) && (r.shuffleSpreadSec as number) >= 0 ? (r.shuffleSpreadSec as number) : 0,
  };
  if (typeof r.drandChain === 'string') l.drandChain = r.drandChain;
  if (Number.isInteger(r.drandRound)) l.drandRound = r.drandRound as number;
  return l;
}

function batchingOf(b: unknown, entryRequestId: string): Batching | null {
  const r = b as Record<string, unknown> | null;
  if (!r || typeof r.resultPath !== 'string' || !r.resultPath.startsWith('/v1/queues/') || typeof r.resultAt !== 'string') return null;
  const at = Date.parse(r.resultAt);
  if (Number.isNaN(at)) return null;
  const spread = Number.isInteger(r.spreadSec) && (r.spreadSec as number) >= 0 ? (r.spreadSec as number) : 0;
  return { entryRequestId: typeof r.entryRequestId === 'string' ? r.entryRequestId : entryRequestId, resultPath: r.resultPath, resultAtMs: at, spreadSec: spread };
}
