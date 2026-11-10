// 결제사 호출 대역(wbs 2.7.6, BUILD_ORDER PRF-210): 결제사 어댑터에 넣는 fetch로, 승인 호출 하나를 명세의 걸음 넷으로 쪼갠다.
// send(실행기가 부른 승인 요청이 여기서 붙든다) → pgProcess(붙든 요청을 시뮬레이터로 넘겨 처리하고 답을 붙든다) → respond(붙든 답을 실행기에 돌려준다).
// timeout·restart는 기다리던 실행기의 호출을 끊는다(요청은 남아 결제사가 나중에 처리할 수 있다. 명세 req).
// 승인 아닌 호출(조회 GET, 승인 200 뒤의 포트원 조회, 취소)은 붙들지 않고 그대로 넘긴다. 결제사로 간 호출을 주문마다 적어 ② 결제사 고정을 센다.
// 하네스가 걸음마다 보는 것(코드 리뷰 M3·L1·L3·H3): 주문을 풀지 못한 호출(unknown), 같은 주문의 승인 요청이 겹친 것(overlaps), 승인 요청의 멱등키(idemKeys),
// 취소 요청을 받은 주문(cancels, 불변식 ④), 실행기가 답을 기다리는 승인 호출 수(waitingCount, 채널 상한의 하네스 쪽 셈).
/** 승인 요청 하나 */
interface Held {
  readonly input: string;
  readonly init: RequestInit | undefined;
  /** 결제사가 아직 처리하지 않았다(명세 req) */
  pending: boolean;
  /** 실행기가 아직 답을 기다린다 */
  waiting: boolean;
  /** 처리한 답(실행기가 기다리는 동안만 둔다) */
  answer?: Response;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

/** 승인 POST에서 주문 ID를 읽는다(토스형 본문 orderId, 포트원형 경로 /payments/pay-{주문}/confirm) */
function confirmOrderOf(url: string, init: RequestInit | undefined): string | undefined {
  if (init?.method !== 'POST') return undefined;
  const path = new URL(url).pathname;
  if (path === '/v1/payments/confirm') return (JSON.parse(String(init.body)) as { orderId?: string }).orderId;
  const m = /^\/payments\/pay-([^/]+)\/confirm$/.exec(path);
  return m?.[1];
}
/** 그 밖의 호출이 가리키는 주문(조회·취소). 포트원형은 경로의 pay-{주문}, 토스형은 주문 ID 조회 경로 또는 하네스가 알려 준 결제 키 표로 푼다 */
function otherOrderOf(url: string, byKey: ReadonlyMap<string, string>): string | undefined {
  const path = decodeURIComponent(new URL(url).pathname);
  const portone = /^\/payments\/pay-([0-9a-f-]{36})(?:\/|$)/.exec(path);
  if (portone) return portone[1];
  const byOrder = /^\/v1\/payments\/orders\/([0-9a-f-]{36})$/.exec(path);
  if (byOrder) return byOrder[1];
  const toss = /^\/v1\/payments\/([^/]+)(?:\/cancel)?$/.exec(path);
  return toss ? byKey.get(toss[1]!) : undefined;
}
const isCancel = (url: string, init: RequestInit | undefined) => init?.method === 'POST' && /\/cancel$/.test(new URL(url).pathname);

export class PgProxy {
  readonly #held = new Map<string, Held>();
  /** 결제사로 간 호출의 주문(승인·조회·취소, ② 결제사 고정을 센다) */
  readonly calls: string[] = [];
  /** 토스형 결제 키 → 주문(조회 경로를 주문으로 푼다) */
  readonly keys = new Map<string, string>();
  /** 주문을 풀지 못한 호출의 경로(있으면 하네스가 위반으로 센다, 코드 리뷰 M3) */
  readonly unknown: string[] = [];
  /** 앞 승인 호출이 아직 답을 기다리는데 같은 주문의 승인 요청이 또 온 주문(위반, 코드 리뷰 L3) */
  readonly overlaps: string[] = [];
  /** 주문 → 승인 요청에 실린 멱등키들(하나뿐이어야 한다, 코드 리뷰 H3) */
  readonly idemKeys = new Map<string, Set<string>>();
  /** 취소 요청(POST …/cancel)을 받은 주문(불변식 ④를 결제사로 간 요청으로 센다, 코드 리뷰 L1) */
  readonly cancels: string[] = [];

  constructor(private readonly real: typeof fetch = fetch) {}

  /** 어댑터에 넣는 fetch */
  readonly fetch: typeof fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const order = confirmOrderOf(url, init);
    if (order === undefined) {
      const o = otherOrderOf(url, this.keys);
      if (o === undefined) this.unknown.push(new URL(url).pathname);
      else {
        this.calls.push(o);
        if (isCancel(url, init)) this.cancels.push(o);
      }
      return this.real(input, init);
    }
    this.calls.push(order);
    const key = new Headers(init?.headers).get('idempotency-key');
    if (key !== null) this.idemKeys.set(order, (this.idemKeys.get(order) ?? new Set()).add(key.replace(/^"|"$/g, '')));
    return new Promise<Response>((resolve, reject) => {
      const old = this.#held.get(order);
      // 같은 주문의 앞 요청이 아직 답을 기다리면 겹친 것이다(명세는 주문마다 요청 하나다): 위반으로 적고 앞 호출을 끊는다
      if (old?.waiting) {
        this.overlaps.push(order);
        old.reject(new TypeError('fetch failed'));
      }
      this.#held.set(order, { input: url, init, pending: true, waiting: true, resolve, reject });
    });
  };

  /** 실행기가 답을 기다리는 승인 호출 수(하네스가 센 채널 동시 호출, 코드 리뷰 H3) */
  waitingCount(): number {
    return [...this.#held.values()].filter((h) => h.waiting).length;
  }

  /** 결제사가 아직 처리하지 않은 승인 요청이 있는가(명세 req) */
  hasRequest(order: string): boolean {
    return this.#held.get(order)?.pending === true;
  }
  /** 실행기가 그 주문의 승인 답을 기다리는가 */
  isWaiting(order: string): boolean {
    return this.#held.get(order)?.waiting === true;
  }

  /** pgProcess: 붙든 요청을 시뮬레이터로 넘겨 처리한다. 실행기가 기다리면 답을 붙들고, 아니면 버린다 */
  async process(order: string): Promise<void> {
    const h = this.#held.get(order);
    if (!h?.pending) throw new Error(`pgProcess: 주문 ${order}에 처리할 승인 요청이 없다`);
    h.pending = false;
    const r = await this.real(h.input, h.init);
    const body = await r.arrayBuffer();
    if (h.waiting) h.answer = new Response(body, { status: r.status, headers: r.headers });
  }

  /** respond: 처리한 답을 기다리던 실행기에 돌려준다 */
  respond(order: string): void {
    const h = this.#held.get(order);
    if (!h?.waiting || h.answer === undefined) throw new Error(`respond: 주문 ${order}에 돌려줄 답이 없다`);
    h.waiting = false;
    h.resolve(h.answer);
    if (!h.pending) this.#held.delete(order);
  }

  /** timeout: 기다리던 호출을 끊는다(읽기 시간 초과와 같은 연결 오류). 아직 처리하지 않은 요청은 남는다 */
  timeout(order: string): void {
    const h = this.#held.get(order);
    if (!h?.waiting) throw new Error(`timeout: 주문 ${order}에 기다리는 호출이 없다`);
    h.waiting = false;
    h.answer = undefined;
    h.reject(new TypeError('fetch failed'));
    if (!h.pending) this.#held.delete(order);
  }

  /** restart: 기다리던 호출을 모두 끊는다 */
  cutAll(): void {
    for (const [order, h] of this.#held) {
      if (!h.waiting) continue;
      h.waiting = false;
      h.answer = undefined;
      h.reject(new TypeError('fetch failed'));
      if (!h.pending) this.#held.delete(order);
    }
  }
}
