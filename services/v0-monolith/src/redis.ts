// 대기열 Redis(Valkey) 연결. node-redis를 이 파일 하나에 가둔다(Redis 클라이언트는 OPEN[11]에서 정한다).
// 시간 초과 기본값(docs/architecture.md §5 시간 초과 표 Redis 행, 기술 검토 중간-026, docs/features/queue-admission.md §13
// '연결과 시간 초과'): 대기열 경로는 핫패스라
// - 연결이 끊긴 동안 명령을 쌓지 않는다(disableOfflineQueue). 소켓에 쓰지 못한 명령은 결과가 없으니 잠깐 뒤 한 번만 다시 보낸다
// - 명령 시간 초과(commandOptions.timeout)는 소켓에 쓰기 전까지만 든다. 응답 없이 사라진 노드는 어댑터의 호출 쪽 마감이 끊는다
// - 시작은 정한 시간 안에 붙지 못하면 실패한다. connectTimeout은 TCP 연결까지만 들고, 연결 뒤 첫 인사(HELLO)에는
//   시간 초과가 없어 연결만 받고 답하지 않는 노드에 매달린다(새 맥락 리뷰). 그래서 시작 전체에 마감을 건다
// - 닫기는 남은 응답을 기다리므로, 응답 없는 노드에 매달리지 않게 잠깐 기다린 뒤 끊는다
import type { RedisCommander } from '@peaket/platform';
import { ClientOfflineError, createClient } from 'redis';

/** 핫패스 명령 시간 초과(밀리초, 시간 초과 표의 Redis 핫패스 값) */
export const REDIS_COMMAND_TIMEOUT_MS = 100;
/** 시작할 때 붙기까지 기다리는 시간. 넘으면 시작하지 않는다 [가정] */
export const REDIS_STARTUP_TIMEOUT_MS = 5_000;
/** 연결 시도 하나의 시간 초과 [가정] */
const CONNECT_TIMEOUT_MS = 1_000;
/** 소켓에 쓰지 못한 명령을 다시 보내기 전 기다리는 시간 [가정] */
const RESEND_DELAY_MS = 50;
/** 닫을 때 남은 응답을 기다리는 시간. 넘으면 끊는다 [가정] */
const CLOSE_GRACE_MS = 1_000;
/** 다시 연결 간격의 상한 [가정] */
const RECONNECT_MAX_DELAY_MS = 1_000;

export interface V0Redis extends RedisCommander {
  close(): Promise<void>;
}

export class RedisConnectError extends Error {
  constructor() {
    // 주소(비밀번호가 들 수 있다)를 싣지 않는다
    super('대기열 Redis에 연결하지 못했다');
    this.name = 'RedisConnectError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function createV0Redis(url: string, o: { startupTimeoutMs?: number } = {}): Promise<V0Redis> {
  const startupTimeoutMs = o.startupTimeoutMs ?? REDIS_STARTUP_TIMEOUT_MS;
  let started = false;
  let gaveUp = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => {
        if (!started && gaveUp) return new RedisConnectError();
        return Math.min(50 * 2 ** Math.min(retries, 5), RECONNECT_MAX_DELAY_MS);
      },
    },
  });
  client.on('error', () => {
    // 연결 오류는 명령 실패로 드러난다(요청은 500, 입장 루프는 기록). 주소가 든 오류 문구를 따로 찍지 않는다
  });

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'deadline'>((r) => (timer = setTimeout(() => r('deadline'), startupTimeoutMs)));
  try {
    const connecting = client.connect().then(() => 'connected' as const);
    connecting.catch(() => {}); // 마감으로 포기한 뒤에 오는 거부를 처리된 것으로 둔다
    const first = await Promise.race([connecting, deadline]);
    if (first === 'deadline') throw new RedisConnectError();
  } catch {
    gaveUp = true;
    client.destroy();
    throw new RedisConnectError();
  } finally {
    clearTimeout(timer);
  }
  started = true;

  return {
    async sendCommand(args) {
      try {
        return await client.sendCommand(args);
      } catch (err) {
        // 연결이 끊겨 소켓에 쓰지 못한 명령만(결과가 없다) 잠깐 뒤 한 번 다시. 쓴 뒤의 실패는 결과를 모르므로 다시 보내지 않는다
        if (!(err instanceof ClientOfflineError)) throw err;
        await sleep(RESEND_DELAY_MS);
        return client.sendCommand(args);
      }
    },
    async close() {
      const closed = client.close().then(
        () => 'closed' as const,
        () => 'closed' as const,
      );
      await Promise.race([closed, sleep(CLOSE_GRACE_MS)]);
      client.destroy(); // 이미 닫혔으면 아무 일도 하지 않는다
    },
  };
}
