// 장애 주입용 TCP 중계(시험 도구). 서비스의 Redis 연결을 이 중계로 보내고, 실제 연결을 끊거나(cut) 답만 잃게(dropReplies) 한다.
// cut: 열린 연결을 모두 끊고 restore 전까지 새 연결을 바로 닫는다. 끊긴 뒤 보낸 명령은 Valkey에 닿지 않는다.
// dropReplies: 서비스 → Valkey 쪽은 그대로 보내고 Valkey → 서비스 쪽 답만 버린다(명령은 Valkey에서 실행되고 답을 잃는다).
// restore: 답을 버리던 연결은 RESP 차례가 어긋나므로 끊어 서비스가 새로 붙게 하고, 새 연결을 다시 받는다. 데이터는 Valkey에 그대로 남아 시험이 직접 연결로 본다.
import { connect, createServer, type Socket } from 'node:net';

export interface TcpProxy {
  url: string;
  /** 지금 열린 연결을 모두 끊고, restore 전까지 새 연결을 받지 않는다 */
  cut(): void;
  /** 이제부터 Valkey의 답을 서비스에 건네지 않고 버린다 */
  dropReplies(): void;
  /** 버린 답 바이트 수(답을 실제로 잃었는지 본다) */
  readonly dropped: number;
  restore(): void;
  /** cut을 부른 수 */
  readonly cuts: number;
  close(): Promise<void>;
}

export async function startTcpProxy(target: string): Promise<TcpProxy> {
  const u = new URL(target);
  const targetPort = Number(u.port);
  const sockets = new Set<Socket>();
  let down = false;
  let dropping = false;
  let dropped = 0;
  let cuts = 0;
  const destroyAll = () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
  };
  const server = createServer((client) => {
    if (down) {
      client.destroy();
      return;
    }
    const upstream = connect(targetPort, u.hostname);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
    }
    client.on('data', (b) => upstream.write(b));
    upstream.on('data', (b) => {
      if (dropping) {
        dropped += b.length;
        return;
      }
      client.write(b);
    });
    client.on('end', () => upstream.end());
    upstream.on('end', () => client.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `redis://127.0.0.1:${port}`,
    cut: () => {
      down = true;
      cuts += 1;
      destroyAll();
    },
    dropReplies: () => {
      dropping = true;
    },
    get dropped() {
      return dropped;
    },
    restore: () => {
      // 답을 버린 연결은 차례가 어긋났다. 끊어 새로 붙게 한다
      if (dropping) destroyAll();
      dropping = false;
      down = false;
    },
    get cuts() {
      return cuts;
    },
    close: () =>
      new Promise<void>((r) => {
        down = true;
        destroyAll();
        server.close(() => r());
      }),
  };
}
