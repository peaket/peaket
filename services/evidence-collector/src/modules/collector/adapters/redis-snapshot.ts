// 어댑터: Redis(Valkey·ElastiCache) 순간 상태 뜨기(docs/observability.md §5 '진단 증거' 뜨는 것, 시험 D-T51 ①⑤⑥).
// - INFO, SLOWLOG GET 128 [가정], CLIENT LIST 세 명령만 명령마다 5초 [가정] 안에 보낸다. 접속 계정은 이 세 명령만 허용한 사용자다(INF-020)
// - 그래서 붙을 때 보내는 다른 명령을 끈다: CLIENT SETINFO(disableClientInfo), HELLO(RESP3 대신 기본 RESP2 + AUTH)
// - 수집마다 연결 하나를 열고 닫는다(연결 시간 초과 5초 [가정], 다시 붙기 끔). 한 명령이 실패해도 나머지는 뜬다(partial)
// - 오류는 종류 이름만 남긴다(접속 주소·비밀번호가 섞인 오류 글은 버린다)
import { createClient } from 'redis';
import { errorCode, type EvidenceTarget, type Snapshot, type SnapshotError, type SnapshotFile, type SnapshotSource } from '../domain/snapshot.js';

/** 연결 시간 초과(ms, [가정]) */
export const REDIS_CONNECT_TIMEOUT_MS = 5_000;
/** 명령마다 시간 상한(ms, [가정]) */
export const REDIS_COMMAND_TIMEOUT_MS = 5_000;
/** SLOWLOG GET으로 읽는 항목 수 [가정] */
export const SLOWLOG_ENTRIES = 128;

const TEXT = 'text/plain; charset=utf-8';
const JSON_TYPE = 'application/json';
const COMMANDS: ReadonlyArray<{ file: string; args: string[]; contentType: string; render: (reply: unknown) => string }> = [
  { file: 'redis-info.txt', args: ['INFO'], contentType: TEXT, render: (r) => String(r) },
  { file: 'redis-slowlog.json', args: ['SLOWLOG', 'GET', String(SLOWLOG_ENTRIES)], contentType: JSON_TYPE, render: (r) => JSON.stringify(r, null, 2) },
  { file: 'redis-client-list.txt', args: ['CLIENT', 'LIST'], contentType: TEXT, render: (r) => String(r) },
];

const encoder = new TextEncoder();

class CommandTimeout extends Error {
  readonly code = 'timeout';
}

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CommandTimeout('명령 시간 초과')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class RedisSnapshotSource implements SnapshotSource {
  async snapshot(target: EvidenceTarget): Promise<Snapshot> {
    const client = createClient({
      url: target.url,
      disableClientInfo: true,
      disableOfflineQueue: true,
      socket: { connectTimeout: REDIS_CONNECT_TIMEOUT_MS, reconnectStrategy: false },
    });
    // 끊김·접속 실패 오류 사건이 프로세스를 멈추지 않게 받는다(connect·명령 쪽이 실패로 받는다)
    client.on('error', () => {});
    try {
      await within(client.connect(), REDIS_CONNECT_TIMEOUT_MS + 1_000);
    } catch (err) {
      const code = errorCode(err, 'connect_failed');
      client.destroy();
      return { connected: false, files: [], errors: COMMANDS.map((c) => ({ file: c.file, code })) };
    }
    const files: SnapshotFile[] = [];
    const errors: SnapshotError[] = [];
    try {
      for (const c of COMMANDS) {
        try {
          const reply = await within(client.sendCommand(c.args), REDIS_COMMAND_TIMEOUT_MS);
          files.push({ name: c.file, body: encoder.encode(c.render(reply)), contentType: c.contentType });
        } catch (err) {
          errors.push({ file: c.file, code: errorCode(err, 'command_failed') });
        }
      }
    } finally {
      client.destroy();
    }
    return { connected: true, files, errors };
  }
}
