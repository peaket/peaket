// 통합 시험의 SSE 받는 쪽(F-03-3). SSE 표준 규칙대로 줄을 읽어 덩이(id·event·data)로 모은다. test-int/ops-live.int.test.ts의 받는 쪽과 같은 규칙이다.
export interface Frame {
  id?: string;
  event: string;
  data: unknown;
}

export class Sse {
  readonly frames: Frame[] = [];
  readonly openings: { retry?: number; id?: string }[] = [];
  ended = false;
  #buf = '';
  #block: { id?: string; event?: string; retry?: number; data: string[] } = { data: [] };

  private constructor(
    readonly status: number,
    readonly body: string | undefined,
    private readonly ac: AbortController,
  ) {}

  static async open(port: number, path: string, headers: Record<string, string>): Promise<Sse> {
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: 'text/event-stream', ...headers }, signal: ac.signal });
    if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return new Sse(res.status, await res.text(), ac);
    const s = new Sse(res.status, undefined, ac);
    void s.pump(res.body!);
    return s;
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        this.#buf += dec.decode(value, { stream: true });
        for (let i = this.#buf.indexOf('\n'); i >= 0; i = this.#buf.indexOf('\n')) {
          const line = this.#buf.slice(0, i);
          this.#buf = this.#buf.slice(i + 1);
          this.line(line);
        }
      }
    } catch {
      // 끊었다(시험이 닫음)
    } finally {
      this.ended = true;
    }
  }

  private line(l: string): void {
    const b = this.#block;
    if (l === '') {
      this.#block = { data: [] };
      if (b.data.length > 0) this.frames.push({ ...(b.id !== undefined ? { id: b.id } : {}), event: b.event ?? 'message', data: JSON.parse(b.data.join('\n')) as unknown });
      else if (b.id !== undefined || b.retry !== undefined) this.openings.push({ ...(b.retry !== undefined ? { retry: b.retry } : {}), ...(b.id !== undefined ? { id: b.id } : {}) });
      return;
    }
    if (l.startsWith(':')) return;
    const c = l.indexOf(':');
    const field = c < 0 ? l : l.slice(0, c);
    const value = c < 0 ? '' : l.slice(c + 1).replace(/^ /, '');
    if (field === 'id') b.id = value;
    else if (field === 'event') b.event = value;
    else if (field === 'data') b.data.push(value);
    else if (field === 'retry') b.retry = Number(value);
  }

  of(event: string): Frame[] {
    return this.frames.filter((f) => f.event === event);
  }

  close(): void {
    this.ac.abort();
  }
}
