// 관제 SSE 흐름의 브라우저 쪽(docs/frontend.md §4.4.4·§4.4.5, ADR-0100 결정 2, ADR-0360 결정 11).
// 브라우저 EventSource는 주석 줄(: hb)을 화면에 알려 주지 않아 35초 무소식 감시를 할 수 없고, 다시 열 때 0~5초 무작위와 Last-Event-ID 머리를
// 직접 넣을 수 없다. 그래서 관제 흐름 둘은 fetch 스트림(자격 증명 포함)으로 받고, text/event-stream 해석은 표준(HTML Living Standard
// 'event stream interpretation')과 같은 규칙으로 여기서 한다. 시계·무작위·fetch를 넘겨받는 순수 모듈이라 Node 내장 시험 실행기로 그대로 읽는다.

export interface SseFrame {
  /** 사건 이름(event: 줄이 없으면 message) */
  event: string;
  /** data: 줄을 \n으로 이은 글 */
  data: string;
  /** 이 사건까지의 마지막 id(없으면 undefined) */
  lastEventId: string | undefined;
}

export interface SseParsed {
  frames: SseFrame[];
  /** retry: 줄의 값(ms). 없으면 undefined */
  retryMs?: number;
  /** 이 조각에서 주석 줄(:로 시작)을 본 수 */
  comments: number;
  /** data 없이 id만 있는 덩이로도 마지막 id가 바뀌었는가(서버가 첫 덩이에 커서만 둔다) */
  idChanged: boolean;
}

export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #lastId: string | undefined;
  #pendingId: string | undefined;

  constructor(lastEventId?: string) {
    this.#lastId = lastEventId;
    this.#pendingId = lastEventId;
  }

  /** 지금까지의 마지막 id(다시 붙을 때 Last-Event-ID로 보낸다) */
  get lastEventId(): string | undefined {
    return this.#lastId;
  }

  /** 받은 글 조각을 넣는다. 끝나지 않은 줄은 다음 조각과 잇는다 */
  feed(chunk: string): SseParsed {
    const out: SseParsed = { frames: [], comments: 0, idChanged: false };
    this.#buffer += chunk;
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.#buffer);
      if (!m) break;
      // 끝의 \r 하나는 다음 조각의 \n과 짝일 수 있어 기다린다
      if (m[0] === '\r' && m.index === this.#buffer.length - 1) break;
      const line = this.#buffer.slice(0, m.index);
      this.#buffer = this.#buffer.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }

  private line(line: string, out: SseParsed): void {
    if (line === '') {
      this.dispatch(out);
      return;
    }
    if (line.startsWith(':')) {
      out.comments += 1;
      return;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#event = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) this.#pendingId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) out.retryMs = Number(value);
        break;
      default:
        break;
    }
  }

  private dispatch(out: SseParsed): void {
    // 표준처럼 마지막 id는 data가 없어도 바뀐다
    if (this.#pendingId !== this.#lastId) {
      this.#lastId = this.#pendingId;
      out.idChanged = true;
    }
    if (this.#data.length > 0) out.frames.push({ event: this.#event === '' ? 'message' : this.#event, data: this.#data.join('\n'), lastEventId: this.#lastId });
    this.#event = '';
    this.#data = [];
  }
}

/** 35초 [가정] 동안 아무것도(주석 줄 포함) 오지 않으면 끊고 다시 연다(ADR-0100 결정 2) */
export const LIVE_SILENCE_MS = 35_000;
/** 다시 열기 기본 간격(서버 retry가 오면 그 값) 10초 */
export const LIVE_RETRY_MS = 10_000;
/** 다시 열기에 더하는 무작위 0~5초 [가정](frontend §4.4.4 '하트비트') */
export const LIVE_JITTER_MS = 5_000;
/** 서버가 닫은 뒤(토큰 만료·세션 종료·쌓임 상한) 토큰을 갱신하고 다시 열 때의 가장 짧은 간격 1초 [가정](닫힘이 되풀이될 때 몰리지 않게) */
export const LIVE_REOPEN_MIN_MS = 1_000;

export type StreamStatus = 'connecting' | 'open' | 'retrying' | 'stopped' | 'unauthorized';

/** 토큰 갱신 결과: ok면 다시 붙고, unauthorized(갱신 401)면 로그인 화면으로 간다 */
export type RefreshResult = 'ok' | 'unauthorized' | 'failed';

export interface StreamTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

export type StreamFetch = (
  url: string,
  init: { credentials: 'include'; headers: Record<string, string>; signal: AbortSignal; cache: 'no-store' },
) => Promise<{ ok: boolean; status: number; body: { getReader(): StreamReader } | null }>;

export interface ManagedStreamDeps {
  /** 열 주소(열 때마다 부른다. 위젯 흐름은 그때의 위젯 목록으로 만든다) */
  url: () => string;
  fetch: StreamFetch;
  timers: StreamTimers;
  /** 0 이상 1 미만 */
  random: () => number;
  /** 액세스 토큰 갱신(POST /v1/ops/auth/access-tokens) */
  refresh: () => Promise<RefreshResult>;
  /** 갱신이 401: 로그인 화면으로 */
  onUnauthorized: () => void;
  onFrame: (f: SseFrame) => void;
  onStatus?: (s: StreamStatus) => void;
  /** 연결이 열렸다(reconnect면 다시 연 것. 화면이 REST로 다시 읽을지 정한다) */
  onOpen?: (info: { reconnect: boolean }) => void;
  /** Last-Event-ID를 쓰는가(늘 여는 흐름만. 위젯 흐름은 지금 값부터 받는다) */
  resume?: boolean;
}

/**
 * 끊기면 다시 여는 SSE 흐름 하나.
 * - 열 때 Last-Event-ID(resume일 때)를 머리로 보낸다
 * - 받은 조각(주석 줄 포함)마다 35초 감시를 다시 건다. 넘으면 끊고 retry(10초) + 0~5초 뒤 다시 연다
 * - 네트워크 오류·5xx도 retry + 0~5초 뒤 다시 연다
 * - 서버가 닫거나 401이면 토큰을 갱신한 뒤 다시 연다. 갱신이 401이면 onUnauthorized
 */
export class ManagedStream {
  #abort: AbortController | undefined;
  #silence: unknown;
  #retryTimer: unknown;
  #retryMs = LIVE_RETRY_MS;
  #parser = new SseParser();
  #stopped = true;
  #opened = 0;
  #generation = 0;

  constructor(private readonly deps: ManagedStreamDeps) {}

  get lastEventId(): string | undefined {
    return this.#parser.lastEventId;
  }

  get running(): boolean {
    return !this.#stopped;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.connect();
  }

  /** 닫고 다시 열지 않는다 */
  stop(): void {
    this.#stopped = true;
    this.#generation += 1;
    this.clearTimers();
    this.#abort?.abort();
    this.#abort = undefined;
    this.deps.onStatus?.('stopped');
  }

  /** 지금 연결을 끊고 바로 다시 연다(위젯 목록이 바뀔 때) */
  restart(): void {
    this.stop();
    this.start();
  }

  private clearTimers(): void {
    if (this.#silence !== undefined) this.deps.timers.clearTimeout(this.#silence);
    if (this.#retryTimer !== undefined) this.deps.timers.clearTimeout(this.#retryTimer);
    this.#silence = undefined;
    this.#retryTimer = undefined;
  }

  private jittered(base: number): number {
    return base + this.deps.random() * LIVE_JITTER_MS;
  }

  private armSilence(gen: number): void {
    if (this.#silence !== undefined) this.deps.timers.clearTimeout(this.#silence);
    this.#silence = this.deps.timers.setTimeout(() => {
      if (gen !== this.#generation) return;
      // 35초 무소식: 끊고 retry + 무작위 뒤 다시 연다
      this.#abort?.abort();
      this.schedule(gen, this.jittered(this.#retryMs));
    }, LIVE_SILENCE_MS);
  }

  private schedule(gen: number, ms: number): void {
    if (this.#stopped || gen !== this.#generation) return;
    this.#generation += 1;
    const next = this.#generation;
    this.clearTimers();
    this.deps.onStatus?.('retrying');
    this.#retryTimer = this.deps.timers.setTimeout(() => {
      if (next !== this.#generation || this.#stopped) return;
      void this.connect();
    }, ms);
  }

  private async afterClose(gen: number): Promise<void> {
    if (this.#stopped || gen !== this.#generation) return;
    if (this.#silence !== undefined) this.deps.timers.clearTimeout(this.#silence);
    this.#silence = undefined;
    let r: RefreshResult;
    try {
      r = await this.deps.refresh();
    } catch {
      r = 'failed';
    }
    if (this.#stopped || gen !== this.#generation) return;
    if (r === 'unauthorized') {
      this.#stopped = true;
      this.clearTimers();
      this.deps.onStatus?.('unauthorized');
      this.deps.onUnauthorized();
      return;
    }
    this.schedule(gen, this.jittered(r === 'ok' ? LIVE_REOPEN_MIN_MS : this.#retryMs));
  }

  private async connect(): Promise<void> {
    if (this.#stopped) return;
    const gen = this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.deps.onStatus?.('connecting');
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    const last = this.#parser.lastEventId;
    if (this.deps.resume && last !== undefined && last !== '') headers['last-event-id'] = last;
    // 새 연결마다 해석기를 새로 둔다(끊긴 조각은 버린다). 마지막 id는 이어 간다
    this.#parser = new SseParser(this.deps.resume ? last : undefined);
    this.armSilence(gen);
    let res: Awaited<ReturnType<StreamFetch>>;
    try {
      res = await this.deps.fetch(this.deps.url(), { credentials: 'include', headers, signal: abort.signal, cache: 'no-store' });
    } catch {
      this.schedule(gen, this.jittered(this.#retryMs));
      return;
    }
    if (gen !== this.#generation) return;
    if (res.status === 401) {
      await this.afterClose(gen);
      return;
    }
    if (!res.ok || !res.body) {
      this.schedule(gen, this.jittered(this.#retryMs));
      return;
    }
    this.deps.onStatus?.('open');
    this.deps.onOpen?.({ reconnect: this.#opened > 0 });
    this.#opened += 1;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (gen !== this.#generation) {
          await reader.cancel().catch(() => undefined);
          return;
        }
        if (done) break;
        this.armSilence(gen);
        const parsed = this.#parser.feed(decoder.decode(value, { stream: true }));
        if (parsed.retryMs !== undefined) this.#retryMs = parsed.retryMs;
        for (const f of parsed.frames) this.deps.onFrame(f);
      }
    } catch {
      // 네트워크가 끊겼다(또는 감시가 끊었다)
      if (gen === this.#generation) this.schedule(gen, this.jittered(this.#retryMs));
      return;
    }
    // 서버가 흐름을 닫았다(토큰 만료·세션 종료·쌓임 상한): 토큰을 갱신하고 다시 붙는다
    await this.afterClose(gen);
  }
}

/** 받은 사건의 data를 JSON으로 읽는다. JSON이 아니면 undefined */
export function frameData(f: SseFrame): unknown {
  try {
    return JSON.parse(f.data) as unknown;
  } catch {
    return undefined;
  }
}
