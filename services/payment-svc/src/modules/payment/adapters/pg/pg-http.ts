// 결제사 HTTP 연결 묶음(docs/features/payment.md §2 '결제사 호출 보호의 첫 구현', docs/architecture.md §5 시간 초과 기본값, BUILD_ORDER PRF-183).
// 외부 호출 클라이언트(packages/platform http-client)의 fetch 주입으로 건다. 서버 쪽 전용이다(v0 모놀리스의 공개 파일 index.ts는 이 파일을 가져오지 않는다).
// 구현에서 정한 것(정본·설계에 없다):
// - Node에 든 fetch에 npm undici의 Agent를 dispatcher로 준다(Node 24의 내장 undici와 같은 7판이라 맞는다). 내장 fetch를 그대로 써서 추적 계측이 그대로 돈다.
// - 읽기 시간 초과는 호출마다 AbortSignal이 맡는다(60초 [가정]. undici의 headersTimeout·bodyTimeout 기본 300초는 그보다 길어 먼저 끊지 않는다).
// - Agent의 연결 수는 만든 뒤 바꿀 수 없다. 상한을 낮춘 뒤에도 묶음의 연결 수는 처음 값이고, 동시 승인 호출 수는 낮춘 벌크헤드가 묶는다(코드 리뷰).
import { Agent } from 'undici';
import { PG_CONNECT_TIMEOUT_MS } from '../../domain/pg-call-guard.js';

export interface PgHttpOptions {
  /** 이 묶음이 여는 연결 수 상한. 승인 묶음은 처음의 파드당 벌크헤드, 조회 묶음은 파드의 동시 조회 수다 */
  readonly connections: number;
  /** 연결 시간 초과(ms). 기본 PG_CONNECT_TIMEOUT_MS 3초 [가정] */
  readonly connectTimeoutMs?: number;
}

export interface PgHttp {
  /** 어댑터의 fetch 옵션에 넘긴다 */
  readonly fetch: typeof fetch;
  /** 연결을 닫는다(종료 때) */
  close(): Promise<void>;
}

/**
 * 결제사 하나의 연결 묶음을 만든다(어댑터마다 하나).
 * @throws RangeError connections가 1 이상의 정수가 아님
 */
export function createPgHttp(o: PgHttpOptions): PgHttp {
  if (!(Number.isSafeInteger(o.connections) && o.connections >= 1)) throw new RangeError(`연결 수는 1 이상의 정수다: ${String(o.connections)}`);
  const agent = new Agent({ connections: o.connections, connect: { timeout: o.connectTimeoutMs ?? PG_CONNECT_TIMEOUT_MS } });
  const dispatched = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, { ...init, dispatcher: agent } as RequestInit)) as typeof fetch;
  return { fetch: dispatched, close: () => agent.close() };
}
