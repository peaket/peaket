// 시험용 Schema Registry 응답(BAT-220 계획 §11 4). Confluent Schema Registry REST `GET /schemas/ids/{id}`의 응답 모양만 낸다:
// 200 `{"schema": "<.avsc JSON 글>"}`(Avro는 schemaType을 싣지 않는다), 모르는 ID는 404 `{"error_code": 40403, "message": "Schema not found"}`
// (Confluent Schema Registry API 문서 'GET /schemas/ids/{int: id}'). 단위 시험은 fakeRegistryFetch를 레지스트리 조회(schemaRegistrySource)의
// fetch 자리에 끼우고, 통합 시험(test-int/batch-worker.int.test.ts)은 같은 registryReply를 실제 HTTP 서버로 낸다.
// 실제 레지스트리와의 짝 맞춤은 구간 5의 G-30(docs/observability.md)에서 한다.

export interface RegistryReply {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface RegistryState {
  /** 스키마 ID → .avsc JSON */
  schemas: Map<number, unknown>;
  /** 정하면 모든 요청에 이 상태 코드로 답한다(장애 흉내) */
  status?: number;
  /** 받은 요청 경로(순서대로) */
  requests: string[];
  /** 받은 요청의 authorization 머리(없으면 null) */
  authorization: (string | null)[];
}

export const registryState = (schemas: Record<number, unknown> = {}): RegistryState => ({
  schemas: new Map(Object.entries(schemas).map(([k, v]) => [Number(k), v])),
  requests: [],
  authorization: [],
});

const json = (status: number, body: unknown): RegistryReply => ({ status, body: JSON.stringify(body), headers: { 'content-type': 'application/vnd.schemaregistry.v1+json' } });

/** 경로 하나에 대한 레지스트리의 답 */
export function registryReply(state: RegistryState, path: string, authorization: string | null): RegistryReply {
  state.requests.push(path);
  state.authorization.push(authorization);
  if (state.status !== undefined) return json(state.status, { error_code: state.status * 100, message: 'unavailable' });
  const m = /\/schemas\/ids\/(\d+)$/.exec(path);
  const schema = m ? state.schemas.get(Number(m[1])) : undefined;
  if (schema === undefined) return json(404, { error_code: 40403, message: 'Schema not found' });
  return json(200, { schema: JSON.stringify(schema) });
}

/** undici fetch가 연결 거부 때 던지는 모양(TypeError 'fetch failed', cause.code = ECONNREFUSED) */
export function connectionRefused(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8081'), { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect' }) });
}

/**
 * fetch 자리에 끼우는 가짜 레지스트리. 받은 신호가 끊기면 그 이유로 거부한다(fetch와 같다).
 * down이 참이면 연결 거부처럼 던진다. delayMs가 있으면 그만큼(setTimeout, 가짜 시계로 진행) 뒤에 답한다
 */
export function fakeRegistryFetch(state: RegistryState, o: { down?: () => boolean; delayMs?: number; reply?: (r: RegistryReply) => Response | undefined } = {}): typeof fetch {
  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? undefined;
      if (signal?.aborted) return reject(signal.reason);
      if (o.down?.()) return reject(connectionRefused());
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      const answer = () => {
        const r = registryReply(state, url.pathname, headers.get('authorization'));
        resolve(o.reply?.(r) ?? new Response(r.body, { status: r.status, headers: r.headers }));
      };
      if (o.delayMs === undefined) return answer();
      const t = setTimeout(answer, o.delayMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(signal.reason);
      });
    });
}
