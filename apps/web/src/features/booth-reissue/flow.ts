// 월렛 부스 재발급 흐름(openapi createIdentityBoothReverification·createTicketBoothRequest·createTicketDeviceKey,
// docs/frontend.md §4.2.4 '부스 재발급 세부', docs/design/d5 §5.13, docs/review/plans/F-05-12.md §3 결정 8·§4).
// React를 모르는 순수 클래스다. 10초 재시도는 화면이 tick()을 부르고 online()은 즉시 한 번 시도한다.
// 토큰·코드 원문은 이 객체 밖으로(로그·저장소) 내보내지 않는다.
export type BoothPhase = 'idle' | 'consent' | 'verifying' | 'code' | 'waiting' | 'registered' | 'expired' | 'limit' | 'mismatch' | 'before-entry' | 'error';

/** 기관 창 값(openapi VerificationStart.window). 화면은 이 값으로 팝업에 양식을 보낸다 */
export interface BoothWindow {
  url: string;
  method: 'GET' | 'POST';
  fields: Record<string, string>;
  mode: 'POPUP' | 'REDIRECT';
}

export interface BoothStart {
  verificationId: string;
  window: BoothWindow;
  expiresAt: string;
}

/** `startVerification()`의 답: started면 기관 창을 열고, error면 onState가 이미 이유를 보인다 */
export type BoothStartAnswer = { kind: 'started'; id: string; window: BoothWindow } | { kind: 'error' };

export interface BoothState {
  phase: BoothPhase;
  boothCode?: string;
  expiresAtMs?: number;
  error?: string;
}

export interface BoothReissuePorts {
  start(i: { ticketId: string; consent: true }): Promise<BoothStart>;
  confirm(i: { verificationId: string; providerResult: Record<string, string> }): Promise<{ resultToken?: string }>;
  request(i: { ticketId: string; reverificationToken: string }): Promise<{ boothRequestId: string; boothCode: string; expiresAt: string }>;
  register(i: { ticketId: string; boothRequestId: string; reason: 'BOOTH'; publicKeyJwk: JsonWebKey }): Promise<{ keyId: string }>;
}

export interface BoothReissueDeps {
  ticketId: string;
  api: BoothReissuePorts;
  now(): number;
  retryEveryMs?: number;
  deviceKey: { publicKeyJwk: JsonWebKey };
  onState(s: BoothState): void;
}

function statusOf(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined;
}
function typeOf(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && typeof (e as { type?: unknown }).type === 'string' ? (e as { type: string }).type : undefined;
}

const DEFAULT_RETRY_MS = 10_000;

export class BoothReissueFlow {
  #state: BoothState = { phase: 'idle' };
  #token: string | undefined;
  #boothRequestId: string | undefined;
  #expiresAtMs: number | undefined;
  #lastAttemptMs: number | undefined;
  #retryEveryMs: number;
  readonly #d: BoothReissueDeps;

  constructor(d: BoothReissueDeps) {
    this.#d = d;
    this.#retryEveryMs = d.retryEveryMs ?? DEFAULT_RETRY_MS;
  }

  #set(s: BoothState): void {
    this.#state = s;
    this.#d.onState(s);
  }

  begin(): void {
    if (this.#state.phase === 'idle') this.#set({ phase: 'consent' });
  }

  async consent(): Promise<void> {
    await this.startVerification();
  }

  /**
   * 대조 목적 동의 뒤 본인확인 건을 만들고 기관 창 값을 돌려준다. 화면은 이 값으로 팝업을 열고,
   * 결과 확정(resultToken)은 복귀 화면이 보내는 값(BroadcastChannel)을 받아 acceptResultToken으로 넣는다.
   * 시작이 거절되면 이 객체의 phase가 mismatch·error로 바뀐다(호출한 화면은 startCallerFlow의 onDone도 본다).
   */
  async startVerification(): Promise<BoothStartAnswer> {
    if (this.#state.phase !== 'consent') return { kind: 'error' };
    this.#set({ phase: 'verifying' });
    try {
      const r = await this.#d.api.start({ ticketId: this.#d.ticketId, consent: true });
      return { kind: 'started', id: r.verificationId, window: r.window };
    } catch (e) {
      if (statusOf(e) === 409 || typeOf(e) === 'booth-mismatch') this.#set({ phase: 'mismatch' });
      else this.#fail(e);
      return { kind: 'error' };
    }
  }

  /** 복귀 화면이 확인 응답으로 받은 reverificationToken. 원문은 로그·저장소에 남기지 않는다 */
  acceptResultToken(token: string): void {
    if (this.#state.phase !== 'verifying') return;
    this.#token = token;
  }

  async verified(i: { verificationId: string; providerResult: Record<string, string> }): Promise<void> {
    if (this.#state.phase !== 'verifying') return;
    try {
      const r = await this.#d.api.confirm(i);
      if (!r.resultToken) throw Object.assign(new Error('부스 대조 토큰이 없다'), { status: 409, type: 'booth-mismatch' });
      this.#token = r.resultToken;
    } catch (e) {
      if (statusOf(e) === 409 || typeOf(e) === 'booth-mismatch') this.#set({ phase: 'mismatch' });
      else this.#fail(e);
      throw e;
    }
  }

  async request(): Promise<void> {
    if (this.#token === undefined) return;
    try {
      const r = await this.#d.api.request({ ticketId: this.#d.ticketId, reverificationToken: this.#token });
      this.#boothRequestId = r.boothRequestId;
      this.#expiresAtMs = Date.parse(r.expiresAt);
      this.#lastAttemptMs = undefined;
      this.#set({ phase: 'code', boothCode: r.boothCode, expiresAtMs: this.#expiresAtMs });
    } catch (e) {
      if (statusOf(e) === 429) this.#set({ phase: 'limit' });
      else if (statusOf(e) === 409 && typeOf(e) === 'booth-mismatch') this.#set({ phase: 'mismatch' });
      else if (statusOf(e) === 409 && typeOf(e) === 'booth-before-entry') this.#set({ phase: 'before-entry' });
      else this.#fail(e);
    }
  }

  /** 10초 [가정]마다 한 번. 같은 now에서 여러 번 불러도 한 번만 시도한다 */
  async tick(): Promise<void> {
    if (this.#state.phase !== 'code' && this.#state.phase !== 'waiting') return;
    if (this.#expiresAtMs !== undefined && this.#d.now() >= this.#expiresAtMs) {
      this.#set({ phase: 'expired' });
      return;
    }
    if (this.#lastAttemptMs !== undefined && this.#d.now() - this.#lastAttemptMs < this.#retryEveryMs) return;
    await this.#attempt();
  }

  /** online 사건: 10초를 기다리지 않고 바로 한 번 시도한다 */
  async online(): Promise<void> {
    if (this.#state.phase !== 'code' && this.#state.phase !== 'waiting') return;
    if (this.#expiresAtMs !== undefined && this.#d.now() >= this.#expiresAtMs) {
      this.#set({ phase: 'expired' });
      return;
    }
    this.#lastAttemptMs = undefined;
    await this.#attempt();
  }

  async #attempt(): Promise<void> {
    if (this.#boothRequestId === undefined) return;
    this.#lastAttemptMs = this.#d.now();
    try {
      await this.#d.api.register({
        ticketId: this.#d.ticketId,
        boothRequestId: this.#boothRequestId,
        reason: 'BOOTH',
        publicKeyJwk: this.#d.deviceKey.publicKeyJwk,
      });
      this.#set({ phase: 'registered' });
    } catch (e) {
      if (statusOf(e) === 403 && typeOf(e) === 'booth-not-authorized') {
        this.#set({ phase: 'waiting' });
        return;
      }
      this.#fail(e);
    }
  }

  #fail(e: unknown): void {
    this.#set({ phase: 'error', ...(e instanceof Error ? { error: e.message } : {}) });
  }
}
