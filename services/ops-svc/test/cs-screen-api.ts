// SCR-045 화면이 쓰는 생성 클라이언트를 실제 ops-svc에 잇는 도우미(F-06-2 GAT-280, R-T51 ①~⑤의 화면 ↔ 서버, 계획 §6). 시험 담당 lane3-f062-test.
// 화면(apps/console-host ConnectedPage)과 같은 것을 쓴다: packages/api-client의 createApiClient·setOrvalClient와 orval 생성 함수
// listOpsCases·getOpsCase·updateOpsCase(If-Match는 headers로 넘긴다), 그리고 화면의 값 해석(cs-inbox/model/live.ts).
// 게이트웨이(gw-ops)가 세션 쿠키를 관리 계정 머리(x-user-id 등)로 바꾸는 자리만 이 fetch가 맡는다. 서버 경로·가드·저장소는 진짜다.
// 생성 함수는 그 경로를 값으로 늦게 가져온다: api-client 원본은 확장자 없는 가져오기(번들러 해석)라 ops-svc의 NodeNext 타입 검사에 넣지 않는다.
import type { createService } from '@peaket/platform';

type Svc = Awaited<ReturnType<typeof createService>>;

export interface ScreenApiError {
  readonly status: number;
  readonly type: string;
}
export interface ScreenResponse {
  readonly data: unknown;
  readonly status: number;
  readonly headers: Headers;
}
export interface ScreenApi {
  listOpsCases(params?: Record<string, unknown>): Promise<ScreenResponse>;
  getOpsCase(caseId: string): Promise<ScreenResponse>;
  updateOpsCase(caseId: string, body: Record<string, unknown>, options?: { headers?: Record<string, string> }): Promise<ScreenResponse>;
  /** fetch로 나간 요청(메서드·경로·If-Match) */
  readonly sent: Array<{ method: string; path: string; ifMatch: string | null }>;
}

const API_CLIENT = new URL('../../../packages/api-client/src/index.ts', import.meta.url).href;
const OPS_ENDPOINTS = new URL('../../../packages/api-client/src/gen/endpoints/ops/ops.ts', import.meta.url).href;

/** session: 게이트웨이가 붙이는 관제 세션 머리(FakeIdentity.ops(role)) */
export async function screenApi(svc: Svc, session: () => Record<string, string>): Promise<ScreenApi> {
  // type-escape: api-client 원본은 NodeNext 타입 검사 밖이라 경로를 값으로 넣어 늦게 가져오고 쓰는 면만 위 인터페이스로 묶는다 F-06-2
  const client = (await import(/* @vite-ignore */ API_CLIENT)) as {
    createApiClient(o: { baseUrls: Record<string, string>; fetch: (u: string, i: RequestInit) => Promise<Response>; maxRetries: number }): unknown;
    setOrvalClient(c: unknown): void;
  };
  // type-escape: 위와 같은 까닭 F-06-2
  const ops = (await import(/* @vite-ignore */ OPS_ENDPOINTS)) as Omit<ScreenApi, 'sent'>;
  const sent: ScreenApi['sent'] = [];
  const viaGateway = async (u: string, init: RequestInit): Promise<Response> => {
    const url = new URL(u);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ method: init.method ?? 'GET', path: `${url.pathname}${url.search}`, ifMatch: headers['if-match'] ?? null });
    const r = await svc.http.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers: { ...headers, ...session() },
      ...(typeof init.body === 'string' ? { payload: init.body } : {}),
    });
    const out = new Headers();
    for (const [k, v] of Object.entries(r.headers)) if (typeof v === 'string') out.set(k, v);
    return new Response(r.statusCode === 204 ? null : r.payload, { status: r.statusCode, headers: out });
  };
  client.setOrvalClient(client.createApiClient({ baseUrls: { 'ops-api': 'https://ops-api.peaket.test' }, fetch: viaGateway, maxRetries: 0 }));
  return { listOpsCases: ops.listOpsCases, getOpsCase: ops.getOpsCase, updateOpsCase: ops.updateOpsCase, sent };
}

/** 생성 함수가 던진 오류(ApiError)를 화면의 errorOf가 읽는 모양으로 */
export async function caught(p: Promise<unknown>): Promise<ScreenApiError> {
  try {
    await p;
  } catch (e) {
    const x = e as { status?: unknown; type?: unknown };
    return { status: typeof x.status === 'number' ? x.status : 0, type: typeof x.type === 'string' ? x.type : '' };
  }
  throw new Error('거절되지 않았다');
}
