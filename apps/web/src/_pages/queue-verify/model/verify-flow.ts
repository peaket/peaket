// SCR-009 추가 검증 흐름(d5 §5.9 상태 표·'제출 차례와 되살리기', docs/frontend.md §4.2.1 8·9번, ADR-0259 결정 1~4).
// 화면 틀(React)과 떼어 시계·타이머·보이기·위젯·호출·저장소·이동을 주입받는다(시험은 가짜로 바꾼다).
// - 들어오면(새로고침 포함) 상태 읽기 GET …/verification으로 사유 범주·이의 접수·결과를 되살리고, 추가 검증 중이면 몇 초 [가정] 간격으로 다시 묻는다
// - 제출 차례: ② 사람 확인 토큰을 받아 두고 → ③ 본인확인(REVERIFY)을 마친 뒤 → {challengeToken, deviceId}를 보낸다.
//   토큰을 받은 지 240초 [가정]가 넘었으면 보내기 전에 위젯을 다시 돌린다(토큰 수명 300초). 이의는 {appeal}만 따로 보낸다
// - 통과 뒤 이동은 고정 경로다(주소의 바깥 값을 쓰지 않는다, ASVS 3.7.2): 차례 전이면 대기실(SCR-008), 지났으면 입장 확정 → 좌석(SCR-010)
// - 429·503은 Retry-After 하한 위로만 0~20% 지터를 더해 자동으로 다시 보낸다(사전 검증 흐름과 같은 규칙, ADR-0211).
//   503·연결 끊김이면 받았던 사람 확인 토큰을 버리고 위젯을 다시 돌린 새 토큰으로만 보낸다(쓴 토큰을 다시 보내면 Turnstile이 중복으로 거절해
//   사람의 잘못이 아닌 실패가 기록된다). 자동 다시 보내기는 3번 [가정]까지이고 그 뒤에는 [다시 시도]를 기다린다(ADR-0259 결정 12)
// - 이 탭의 본인확인 기억에 기대지 않는다: 토큰을 받으면 바로 제출해 보고, 서버가 REVERIFY_REQUIRED로 답하면 ③으로 간다(새로고침 뒤에도 같다)
import { retryAfterMs } from '../../../features/preverify/flow.ts';
import { APPEAL_MAX, appealHasForbidden, appealLength, fixedPaths, reasonLabel } from './view.ts';

/** 위젯 토큰을 이만큼 [가정]보다 오래 들고 있었으면 보내기 전에 위젯을 다시 돌린다(토큰 수명 300초, d5 §5.9) */
export const TOKEN_MAX_AGE_MS = 240_000;
/** 추가 검증 중 상태 읽기 간격 5초 [가정](d5 §5.9 '몇 초 [가정] 간격'). 위로만 0~20% 지터 */
export const POLL_MS = 5_000;
/** 통과 안내를 보이고 옮기기까지 1.5초 [가정](넘어가는 중 스피너, d5 §5.9) */
export const LEAVE_AFTER_MS = 1_500;
/** 제출 503·연결 끊김 뒤 자동으로 다시 보내는 횟수 3번 [가정]. 넘으면 [다시 시도] 버튼(d5 §5.9 '챌린지 실패') */
export const AUTO_RETRY_MAX = 3;
/** 입장 유예 15분(POL-008). 차례가 지난 뒤 통과했으면 통과 시각부터 센다(queue-admission §7) */
const GRACE_MS = 15 * 60_000;

export type Phase = 'loading' | 'load-failed' | 'verifying' | 'passed' | 'accepted' | 'rejected' | 'leaving';
/** ② 사람 확인: idle(아직) · checking(위젯 도는 중) · ready(토큰 있음) · failed(실패·서버가 CHALLENGE_FAILED) · unavailable(위젯을 못 불러옴) */
export type ChallengeStep = 'idle' | 'checking' | 'ready' | 'failed' | 'unavailable';
/**
 * 제출: sending · retry(503·연결, 새 토큰으로 자동 다시) · limited(429, 자동 다시) · stalled(자동 다시 보내기를 다 써서 [다시 시도]를 기다림)
 * · reverify(서버가 REVERIFY_REQUIRED) · mismatch(PERSON_MISMATCH)
 */
export type SubmitStep = 'idle' | 'sending' | 'retry' | 'limited' | 'stalled' | 'reverify' | 'mismatch';
/** ⑤ 이의: open(양식) · sending · retry(503, 자동 다시) · received(접수됨) · failed(보내지 못함, 양식을 다시 연다) */
export type AppealStep = 'open' | 'sending' | 'retry' | 'received' | 'failed';

export interface VerifyView {
  phase: Phase;
  /** 사유 범주 글(표에 없는 값이면 null) */
  reason: string | null;
  challenge: ChallengeStep;
  /** ③ 본인확인을 이 화면에서 마쳤다(서버가 REVERIFY_REQUIRED·PERSON_MISMATCH로 답하면 다시 false) */
  reverified: boolean;
  /** reverify: 이 탭에서 본인확인을 마쳤는데도 서버가 재통과를 찾지 못했다(안내를 보인다). 처음 제출의 REVERIFY_REQUIRED는 ③으로만 보낸다 */
  reverifyAgain?: boolean;
  submit: SubmitStep;
  /** retry·limited: 다시 보낼 시각(now 바탕, 화면 카운트다운은 표시만) */
  retryAt?: number;
  appeal: AppealStep;
  appealReceivedAt?: string;
  /** 보낸 내용(이 화면에서 보냈거나 상태 읽기의 appeal.text) */
  appealText?: string;
  appealRetryAt?: number;
  /** passed·accepted: before(원래 순번) · after(바로 입장) · deciding(쓰지 않음: 상태 읽기의 graceUntil로 고른다) */
  turn?: 'before' | 'after' | 'deciding';
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 던진 값의 모양(api-client ApiError와 같은 칸). status가 없으면 연결 실패다 */
interface Problem {
  status?: unknown;
  type?: unknown;
  retryAfter?: unknown;
  date?: unknown;
  extensions?: unknown;
}

export interface VerifyDeps {
  eventId: string;
  now(): number;
  random(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  visible(): boolean;
  /** 다시 보이면 부른다. 돌려준 함수로 끊는다 */
  onVisible(cb: () => void): () => void;
  /** ② 위젯(action verify)을 돌려 토큰을 받는다. 실패면 null, 위젯을 못 불러왔으면 'unavailable' */
  humanCheck(signal: AbortSignal): Promise<string | null | 'unavailable'>;
  /** GET …/verification의 200 본문. 실패는 던진다(401은 토큰 갱신 한 번 뒤) */
  read(signal: AbortSignal): Promise<unknown>;
  /** POST …/verification. 200·202 응답. 실패는 던진다 */
  submit(body: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  /** POST …/admission(차례가 지난 뒤 통과). 200 응답. 실패는 던진다 */
  admit(body: Record<string, unknown>, signal: AbortSignal): Promise<{ status: number; body: unknown }>;
  deviceId(): string | undefined;
  /** localStorage(대기실 값 peaket.queue.{eventId}) */
  local: KV | null;
  /** sessionStorage(입장 값 peaket.admission.{eventId}) */
  session: KV | null;
  /** 페이지 이동(뒤로 가기로 이 화면에 돌아오지 않게 바꾸기) */
  navigate(url: string): void;
  onChange(v: VerifyView): void;
  tokenMaxAgeMs?: number;
  pollMs?: number;
  leaveAfterMs?: number;
  /** 제출 503·연결 끊김 뒤 자동 다시 보내기 횟수(기본 AUTO_RETRY_MAX) */
  autoRetries?: number;
}

export interface VerifyFlow {
  /** ③ 본인확인을 마쳤다(기관 창 결과 success). 토큰이 있으면 보낸다 */
  reverified(): void;
  /** ② 실패 뒤 [다시 시도] */
  retryChallenge(): void;
  /** 자동 다시 보내기를 다 쓴 뒤(stalled) [다시 시도]: 새 토큰으로 보낸다 */
  retrySubmit(): void;
  /** ⑤ 이의를 보낸다. 이미 보냈거나 보내는 중이면 'busy', 1,000자를 넘으면 'too-long', 둘 수 없는 글자가 있으면 'bad-chars'(보내지 않는다) */
  sendAppeal(text: string): 'sent' | 'busy' | 'too-long' | 'bad-chars';
  /** 첫 읽기 실패 뒤 [다시 시도] */
  retryLoad(): void;
  dispose(): void;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** 대기실 값에서 입장 확정에 쓸 대기표(또는 참가 토큰)와 처음 예상 대기 */
function admissionBody(local: KV | null, eventId: string): Record<string, unknown> | null {
  try {
    const r = JSON.parse(local?.getItem(`peaket.queue.${eventId}`) ?? 'null') as Record<string, unknown> | null;
    if (!r || typeof r !== 'object') return null;
    const t = r.ticket as Record<string, unknown> | undefined;
    const l = r.lobby as Record<string, unknown> | undefined;
    const key = str(t?.queueTicket) ? { queueTicket: t.queueTicket } : str(t?.lobbyToken) ? { lobbyToken: t.lobbyToken } : str(l?.lobbyToken) ? { lobbyToken: l.lobbyToken } : null;
    if (!key) return null;
    const f = r.firstEta as Record<string, unknown> | undefined;
    const sec = num(f?.sec);
    const at = num(f?.atMs);
    return { ...key, ...(sec !== null && sec > 0 && at !== null ? { firstEtaSec: sec, firstEtaAtMs: at } : {}) };
  } catch {
    return null;
  }
}

/** 곧 입장 등으로 대기실에 넘길 때: 유예를 셀 차례 시각을 통과 시각으로 옮긴다(차례와 통과 가운데 늦은 때, queue-admission §7) */
function moveTurnToPass(local: KV | null, eventId: string, passAt: number): void {
  const k = `peaket.queue.${eventId}`;
  try {
    const r = JSON.parse(local?.getItem(k) ?? 'null') as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || typeof r.ticket !== 'object' || r.ticket === null) return;
    const old = num(r.turnAtMs);
    r.turnAtMs = Math.round(Math.max(old ?? 0, passAt));
    local?.setItem(k, JSON.stringify(r));
  } catch {
    // 저장소를 못 쓰면 대기실이 옛 차례 시각으로 유예를 보인다(입장 판단은 서버가 한다)
  }
}

/** 입장 값을 탭 저장소에 두고 이 회차의 대기 값을 지운다(대기실 controller의 ADMITTED와 같은 모양, docs/frontend.md §3.12, ADR-0207 결정 8) */
function saveAdmission(d: VerifyDeps, body: Record<string, unknown>): boolean {
  const token = body.admissionToken;
  if (!str(token)) return false;
  const key = body.serverEcdhPublicKey;
  const rec = {
    admissionToken: token,
    ...(key && typeof key === 'object' ? { serverEcdhPublicKey: key } : {}),
    ...(str(body.seatmapLayoutPath) ? { seatmapLayoutPath: body.seatmapLayoutPath } : {}),
    ...(str(body.purchaseSessionExpiresAt) ? { purchaseSessionExpiresAt: body.purchaseSessionExpiresAt } : {}),
    receivedAt: Math.round(d.now()),
  };
  try {
    d.session?.setItem(`peaket.admission.${d.eventId}`, JSON.stringify(rec));
  } catch {
    return false;
  }
  try {
    d.local?.removeItem(`peaket.queue.${d.eventId}`);
    d.session?.removeItem(`peaket.queue.${d.eventId}.firstAhead`);
  } catch {
    // 지우지 못해도 좌석 화면은 입장 값으로 연다
  }
  return true;
}

/** 200 PASSED 본문 → 차례가 지난 뒤 통과한 시각(유예 마감 − 15분), 차례 전이면 'before'(graceUntil null) */
function passAtOf(b: Record<string, unknown>): number | 'before' {
  const grace = str(b.graceUntil) ? Date.parse(b.graceUntil) : Number.NaN;
  return Number.isNaN(grace) ? 'before' : grace - GRACE_MS;
}

type Route = { kind: 'go'; to: 'event' | 'queue' | 'login' } | { kind: 'rejected' } | { kind: 'retry'; delayMs: number } | { kind: 'limited'; delayMs: number } | { kind: 'failed' };

export function createVerifyFlow(d: VerifyDeps): VerifyFlow {
  const paths = fixedPaths(d.eventId);
  const maxAge = d.tokenMaxAgeMs ?? TOKEN_MAX_AGE_MS;
  const pollMs = d.pollMs ?? POLL_MS;
  const leaveAfter = d.leaveAfterMs ?? LEAVE_AFTER_MS;
  const autoMax = d.autoRetries ?? AUTO_RETRY_MAX;
  const v: VerifyView = { phase: 'loading', reason: null, challenge: 'idle', reverified: false, submit: 'idle', appeal: 'open' };
  const all = new AbortController();
  let disposed = false;
  let token: { value: string; at: number } | null = null;
  let challengeRun: AbortController | null = null;
  let sending = false;
  let submitTimer: unknown = null;
  let appealTimer: unknown = null;
  let pollTimer: unknown = null;
  let loadTimer: unknown = null;
  let leaveTimer: unknown = null;
  let pollWaiting = false;
  let submitFailures = 0;
  let loadFailures = 0;
  let pollFailures = 0;
  let appealFailures = 0;
  /** 503·연결 끊김 뒤 자동으로 다시 보낸 횟수(성공·[다시 시도]면 0) */
  let autoRetried = 0;
  /** 서버가 재통과를 찾지 못했다(REVERIFY_REQUIRED·PERSON_MISMATCH): ③을 마칠 때까지 보내지 않는다 */
  let mustReverify = false;

  const emit = () => {
    if (!disposed) d.onChange({ ...v });
  };
  const set = (patch: Partial<VerifyView>) => {
    Object.assign(v, patch);
    if (patch.submit !== undefined && patch.submit !== 'retry' && patch.submit !== 'limited') delete v.retryAt;
    if (patch.submit !== undefined && patch.submit !== 'reverify') delete v.reverifyAgain;
    if (patch.appeal !== undefined && patch.appeal !== 'retry') delete v.appealRetryAt;
    emit();
  };
  const clear = (t: unknown) => {
    if (t !== null) d.clearTimer(t);
  };
  const active = () => !disposed && v.phase === 'verifying';

  /** 하한(Retry-After)이 있으면 하한 × (1 + U(0, 0.2)), 없으면 전체 지터 0 ~ min(2초 × 2^(실패 수 − 1), 8초) */
  const delayOf = (e: Problem, failures: number): number => {
    const floor = retryAfterMs(typeof e.retryAfter === 'string' ? e.retryAfter : null, d.now(), typeof e.date === 'string' ? e.date : null);
    if (floor !== undefined) return Math.round(floor * (1 + d.random() * 0.2));
    return Math.round(d.random() * Math.min(2000 * 2 ** Math.max(0, failures - 1), 8000));
  };

  /** 오류 → 할 일(docs/frontend.md §4.2.1 8·9번) */
  const routeOf = (err: unknown, failures: number): Route => {
    const e = (err ?? {}) as Problem;
    const status = typeof e.status === 'number' ? e.status : null;
    const type = typeof e.type === 'string' ? e.type : '';
    const ext = e.extensions && typeof e.extensions === 'object' ? (e.extensions as Record<string, unknown>) : {};
    if (status === 401) return { kind: 'go', to: 'login' };
    if (status === 403 || status === 404) return { kind: 'go', to: 'event' };
    if (status === 409) return { kind: 'go', to: 'queue' };
    if (status === 410) return type === 'queue-ticket-removed' && ext.removeReason === 'BLOCKED' ? { kind: 'rejected' } : { kind: 'go', to: 'queue' };
    if (status === 429) return { kind: 'limited', delayMs: delayOf(e, failures) };
    if (status === null || status >= 500) return { kind: 'retry', delayMs: delayOf(e, failures) };
    return { kind: 'failed' };
  };

  const stopActivity = () => {
    challengeRun?.abort();
    challengeRun = null;
    for (const t of [submitTimer, appealTimer, pollTimer, loadTimer]) clear(t);
    submitTimer = appealTimer = pollTimer = loadTimer = null;
    pollWaiting = false;
  };

  /** 고정 경로로 옮긴다(오류·끝 상태). 다른 곳의 값을 받지 않는다 */
  const go = (to: 'event' | 'queue' | 'login') => {
    if (disposed) return;
    stopActivity();
    set({ phase: 'leaving' });
    d.navigate(paths[to]);
  };

  const rejected = () => {
    stopActivity();
    set({ phase: 'rejected' });
  };

  // ── 상태 읽기와 되살리기 ──
  function apply(body: unknown): void {
    const b = (body ?? {}) as Record<string, unknown>;
    const appeal = b.appeal as Record<string, unknown> | null | undefined;
    if (appeal && typeof appeal === 'object') {
      // 보낸 글은 서버 값(appeal.text, 본인에게만)으로 되살린다. 화면은 글 노드로만 그린다
      const text = typeof appeal.text === 'string' ? { appealText: appeal.text } : {};
      if (v.appeal !== 'received') {
        clear(appealTimer);
        appealTimer = null;
        set({ appeal: 'received', ...(str(appeal.receivedAt) ? { appealReceivedAt: appeal.receivedAt } : {}), ...text });
      } else if ('appealText' in text && text.appealText !== v.appealText) set(text);
    }
    const reason = reasonLabel(b.verificationReason);
    if (reason !== v.reason) set({ reason });
    if (b.state === 'VERIFYING') {
      if (v.phase !== 'verifying') set({ phase: 'verifying' });
      // 503 뒤 기다리는 동안·[다시 시도]를 기다리는 동안에는 위젯을 미리 돌리지 않는다(다시 보낼 때 새로 받는다)
      if (v.challenge === 'idle' && v.submit !== 'retry' && v.submit !== 'stalled') void runChallenge();
      schedulePoll(pollMs * (1 + d.random() * 0.2));
    } else if (b.state === 'PASSED') {
      // 문구는 passedVia로 고른다(이의를 냈어도 제출로 통과했으면 '통과'). 차례가 지났는지는 graceUntil로 가른다(ADR-0259 결정 12)
      passed(b.passedVia === 'APPEAL' ? 'accepted' : 'passed', passAtOf(b));
    } else if (b.state === 'BLOCKED') {
      rejected();
    } else if (v.phase === 'loading') {
      set({ phase: 'load-failed' });
    }
  }

  async function load(): Promise<void> {
    clear(loadTimer);
    loadTimer = null;
    try {
      const body = await d.read(all.signal);
      if (disposed) return;
      loadFailures = 0;
      apply(body);
    } catch (err) {
      if (disposed) return;
      const r = routeOf(err, ++loadFailures);
      if (r.kind === 'go') return go(r.to);
      set({ phase: 'load-failed' });
      loadTimer = d.setTimer(() => void load(), r.kind === 'retry' || r.kind === 'limited' ? r.delayMs : delayOf({}, loadFailures));
    }
  }

  function schedulePoll(ms: number): void {
    clear(pollTimer);
    pollTimer = d.setTimer(() => {
      pollTimer = null;
      if (!active()) return;
      // 숨긴 동안은 묻지 않고, 다시 보이면 바로 묻는다
      if (!d.visible()) {
        pollWaiting = true;
        return;
      }
      void poll();
    }, Math.max(0, Math.round(ms)));
  }

  async function poll(): Promise<void> {
    pollWaiting = false;
    try {
      const body = await d.read(all.signal);
      if (!active()) return;
      pollFailures = 0;
      apply(body);
    } catch (err) {
      if (!active()) return;
      const r = routeOf(err, ++pollFailures);
      if (r.kind === 'go') return go(r.to);
      if (r.kind === 'rejected') return rejected();
      schedulePoll(Math.max(pollMs, r.kind === 'retry' || r.kind === 'limited' ? r.delayMs : 0));
    }
  }

  const stopVisible = d.onVisible(() => {
    if (pollWaiting && active()) void poll();
  });

  // ── ② 사람 확인 ──
  async function runChallenge(): Promise<void> {
    challengeRun?.abort();
    const ac = new AbortController();
    challengeRun = ac;
    token = null;
    set({ challenge: 'checking' });
    let r: string | null | 'unavailable';
    try {
      r = await d.humanCheck(ac.signal);
    } catch {
      r = 'unavailable';
    }
    if (ac.signal.aborted || !active()) return;
    challengeRun = null;
    if (r === null || r === 'unavailable') return set({ challenge: r === null ? 'failed' : 'unavailable' });
    token = { value: r, at: d.now() };
    set({ challenge: 'ready' });
    trySubmit();
  }

  // ── 제출(본인확인을 마친 뒤 토큰과 함께) ──
  function trySubmit(): void {
    // 이 탭의 본인확인 기억에 기대지 않는다: 서버가 재통과를 찾지 못했다고 답한 뒤에만 ③을 기다린다
    if (!active() || sending || submitTimer !== null || v.submit === 'stalled') return;
    if (mustReverify && !v.reverified) return;
    if (!token) {
      if (v.challenge === 'idle') void runChallenge();
      return;
    }
    // 낡은 토큰은 보내지 않는다: 위젯을 다시 돌리고 토큰이 오면 이어서 보낸다
    if (d.now() - token.at > maxAge) {
      token = null;
      void runChallenge();
      return;
    }
    void send(token.value);
  }

  async function send(challengeToken: string): Promise<void> {
    sending = true;
    set({ submit: 'sending' });
    const id = d.deviceId();
    let res: { status: number; body: unknown };
    try {
      res = await d.submit({ challengeToken, ...(id ? { deviceId: id } : {}) }, all.signal);
    } catch (err) {
      sending = false;
      if (!active()) return;
      const r = routeOf(err, ++submitFailures);
      if (r.kind === 'go') return go(r.to);
      if (r.kind === 'rejected') return rejected();
      if (r.kind === 'retry') {
        // 503·연결 끊김: 서버가 토큰을 Turnstile에 이미 냈을 수 있다. 쓴 토큰은 버리고, 다시 보낼 때 위젯을 다시 돌린다
        token = null;
        if (autoRetried >= autoMax) return set({ submit: 'stalled', challenge: 'idle' });
        autoRetried++;
      }
      if (r.kind === 'retry' || r.kind === 'limited') {
        set({ submit: r.kind, retryAt: d.now() + r.delayMs, ...(r.kind === 'retry' ? { challenge: 'idle' as const } : {}) });
        submitTimer = d.setTimer(() => {
          submitTimer = null;
          if (!active()) return;
          set({ submit: 'idle' });
          trySubmit();
        }, r.delayMs);
        return;
      }
      // 본문 형식 오류(400 등): 토큰을 버리고 위젯 실패로 보인다([다시 시도])
      token = null;
      return set({ submit: 'idle', challenge: 'failed' });
    }
    sending = false;
    if (!active()) return;
    submitFailures = 0;
    autoRetried = 0;
    const b = (res.body ?? {}) as Record<string, unknown>;
    const result = res.status === 200 ? b.result : undefined;
    if (result === 'PASSED') {
      token = null;
      const at = passAtOf(b);
      // 제출 응답에는 통과 경로(passedVia)가 없다. 이 참여에 이의를 냈으면 CS 인정이 제출보다 먼저 반영됐을 수 있어
      // 상태 읽기로 '통과'와 '인정' 문구를 고른다(읽지 못하면 '통과', 실서버 대본 3에서 찾음)
      if (v.appeal === 'received' || v.appeal === 'sending' || v.appeal === 'retry') {
        void d.read(all.signal).then(
          (body) => {
            const r = (body ?? {}) as Record<string, unknown>;
            passed(r.state === 'PASSED' && r.passedVia === 'APPEAL' ? 'accepted' : 'passed', r.state === 'PASSED' ? passAtOf(r) : at);
          },
          () => passed('passed', at),
        );
        return;
      }
      return passed('passed', at);
    }
    if (result === 'REVERIFY_REQUIRED' || result === 'PERSON_MISMATCH') {
      // 서버는 trust-svc를 부르지 않았다(토큰을 태우지 않음): 토큰은 그대로 두고 ③으로 돌아간다(ADR-0259 결정 1)
      mustReverify = true;
      const again = v.reverified;
      set({ submit: result === 'REVERIFY_REQUIRED' ? 'reverify' : 'mismatch', reverified: false });
      if (result === 'REVERIFY_REQUIRED' && again) set({ reverifyAgain: true });
      return;
    }
    // CHALLENGE_FAILED(또는 모르는 답): 위젯 다시
    token = null;
    set({ submit: 'idle', challenge: 'failed' });
  }

  // ── 통과·인정 뒤 ──
  /** passAt: 차례가 지난 뒤 통과한 시각(유예의 시작), 'before'면 차례 전, null이면 모른다(상태 읽기: 입장 확정으로 고른다) */
  function passed(kind: 'passed' | 'accepted', passAt: number | 'before' | null): void {
    // 제출 응답·상태 읽기가 겹쳐 두 번 와도 한 번만(먼저 정한 문구와 이동을 지킨다)
    if (disposed || v.phase === 'passed' || v.phase === 'accepted') return;
    stopActivity();
    const startedAt = d.now();
    const leaveTo = (to: 'queue' | 'seats') => {
      clear(leaveTimer);
      leaveTimer = d.setTimer(() => {
        leaveTimer = null;
        if (!disposed) d.navigate(paths[to]);
      }, Math.max(0, leaveAfter - (d.now() - startedAt)));
    };
    if (passAt === 'before') {
      set({ phase: kind, turn: 'before' });
      return leaveTo('queue');
    }
    set({ phase: kind, turn: passAt === null ? 'deciding' : 'after' });
    const body = admissionBody(d.local, d.eventId);
    if (!body) {
      if (passAt === null) set({ turn: 'before' });
      return leaveTo('queue');
    }
    void d.admit(body, all.signal).then(
      (res) => {
        if (disposed) return;
        const b = (res.body ?? {}) as Record<string, unknown>;
        if (res.status === 200 && b.status === 'ADMITTED' && saveAdmission(d, b)) {
          set({ turn: 'after' });
          return leaveTo('seats');
        }
        // 곧 입장·차례 전·그 밖은 대기실이 이어 간다. 차례가 지난 뒤 통과했으면 유예를 통과 시각부터 보이게 차례 시각을 옮긴다
        if (typeof passAt === 'number') moveTurnToPass(d.local, d.eventId, passAt);
        set({ turn: b.status === 'SOON' || passAt !== null ? 'after' : 'before' });
        leaveTo('queue');
      },
      () => {
        if (disposed) return;
        if (typeof passAt === 'number') moveTurnToPass(d.local, d.eventId, passAt);
        if (passAt === null) set({ turn: 'before' });
        leaveTo('queue');
      },
    );
  }

  // ── ⑤ 이의 ──
  let appealText = '';
  async function postAppeal(): Promise<void> {
    set({ appeal: 'sending', appealText });
    let res: { status: number; body: unknown };
    try {
      res = await d.submit({ appeal: appealText }, all.signal);
    } catch (err) {
      if (!active()) return;
      const r = routeOf(err, ++appealFailures);
      if (r.kind === 'go') return go(r.to);
      if (r.kind === 'rejected') return rejected();
      if (r.kind === 'retry' || r.kind === 'limited') {
        set({ appeal: 'retry', appealRetryAt: d.now() + r.delayMs });
        appealTimer = d.setTimer(() => {
          appealTimer = null;
          if (active()) void postAppeal();
        }, r.delayMs);
        return;
      }
      return set({ appeal: 'failed' });
    }
    if (!active()) return;
    appealFailures = 0;
    const b = (res.body ?? {}) as Record<string, unknown>;
    if (res.status === 202) return set({ appeal: 'received', ...(str(b.receivedAt) ? { appealReceivedAt: b.receivedAt } : {}) });
    // 이미 통과한 대기 참여는 200 PASSED를 다시 받는다
    if (res.status === 200 && b.result === 'PASSED') return passed('passed', passAtOf(b));
    set({ appeal: 'failed' });
  }

  void load();

  return {
    reverified() {
      if (!active()) return;
      mustReverify = false;
      set({ reverified: true, ...(v.submit === 'reverify' || v.submit === 'mismatch' ? { submit: 'idle' as const } : {}) });
      trySubmit();
    },
    retrySubmit() {
      if (!active() || v.submit !== 'stalled') return;
      autoRetried = 0;
      token = null;
      set({ submit: 'idle', challenge: 'idle' });
      trySubmit();
    },
    retryChallenge() {
      if (!active() || v.challenge === 'checking' || v.challenge === 'ready') return;
      void runChallenge();
    },
    sendAppeal(text) {
      if (!active() || v.appeal === 'sending' || v.appeal === 'retry' || v.appeal === 'received') return 'busy';
      const t = text.normalize('NFC');
      if (appealHasForbidden(t)) return 'bad-chars';
      if (appealLength(t) > APPEAL_MAX) return 'too-long';
      appealText = t;
      void postAppeal();
      return 'sent';
    },
    retryLoad() {
      if (disposed || v.phase !== 'load-failed') return;
      void load();
    },
    dispose() {
      disposed = true;
      stopActivity();
      clear(leaveTimer);
      leaveTimer = null;
      stopVisible();
      all.abort();
    },
  };
}
