// 통합 시험용 Valkey 컨테이너(packages/platform/test-int/containers.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

/** ok가 참이 될 때까지 0.2초마다 다시 본다(컨테이너가 뜨는 동안 docker exec가 실패해도 다시 본다). 20초 안에 안 되면 던진다 */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if (ok()) return;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what}이(가) 20초 안에 되지 않았다`);
}

/**
 * cluster: 노드 하나짜리 클러스터 모드(모든 슬롯을 맡는다). 스크립트의 CLUSTER MYID·cluster_my_epoch를 시험할 때 쓴다(ADR-0181).
 * configEpoch를 주면 빈 노드의 설정 세대를 그 값으로 둔다(CLUSTER SET-CONFIG-EPOCH).
 * 준비(PING, 클러스터는 cluster_state:ok)를 기다린 뒤 돌려주고, 준비되지 않으면 컨테이너를 지우고 던진다
 */
export async function startValkey(o: { cluster?: boolean; configEpoch?: number } = {}): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE, ...(o.cluster ? ['valkey-server', '--cluster-enabled', 'yes'] : [])]);
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 없다
    }
  };
  try {
    const cli = (...a: string[]) => docker(['exec', id, 'valkey-cli', ...a]);
    await until(() => cli('PING') === 'PONG', 'Valkey 시작');
    if (o.cluster) {
      if (o.configEpoch !== undefined) cli('CLUSTER', 'SET-CONFIG-EPOCH', String(o.configEpoch));
      cli('CLUSTER', 'ADDSLOTSRANGE', '0', '16383');
      await until(() => cli('CLUSTER', 'INFO').includes('cluster_state:ok'), '클러스터 준비');
    }
    const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
    const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
    return { url: `redis://127.0.0.1:${port}`, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

/** 샤드 Pub/Sub 받은 글 하나 */
export interface ShardMessage {
  channel: string;
  message: string;
}

/**
 * 샤드 Pub/Sub(SSUBSCRIBE) 구독 연결 하나. 홀드 Lua의 SPUBLISH를 실제 Valkey에서 받아 보려고 둔다(HotRedis에는 구독이 없다).
 * RESP2 구독 모드의 답(배열)만 읽는 작은 해석기다. sync()는 이 연결로 PING을 보내 답을 받을 때까지 기다린다: Valkey는 한 연결의 출력을
 * 차례대로 보내므로, 홀드 호출이 끝난 뒤 sync()를 마치면 그 홀드가 보낸 글은 이미 messages에 있다(고정 sleep 없음)
 */
export interface ShardSubscriber {
  /** 받은 글(받은 차례) */
  readonly messages: ShardMessage[];
  /** 채널들을 구독하고 구독 확인까지 기다린다 */
  subscribe(channels: readonly string[]): Promise<void>;
  /** 지금까지 보낸 글이 모두 도착할 때까지 기다린다 */
  sync(): Promise<void>;
  close(): void;
}

type Resp = string | number | null | Resp[] | Error;

/** buf[pos]부터 RESP2 값 하나를 읽는다. 아직 다 오지 않았으면 undefined */
function parseResp(buf: Buffer, pos: number): [Resp, number] | undefined {
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return undefined;
  const head = buf.toString('utf8', pos + 1, eol);
  const next = eol + 2;
  switch (String.fromCharCode(buf[pos]!)) {
    case '+':
      return [head, next];
    case '-':
      return [new Error(head), next];
    case ':':
      return [Number(head), next];
    case '$': {
      const n = Number(head);
      if (n < 0) return [null, next];
      if (buf.length < next + n + 2) return undefined;
      return [buf.toString('utf8', next, next + n), next + n + 2];
    }
    case '*': {
      const n = Number(head);
      if (n < 0) return [null, next];
      const out: Resp[] = [];
      let p = next;
      for (let i = 0; i < n; i++) {
        const r = parseResp(buf, p);
        if (!r) return undefined;
        out.push(r[0]);
        p = r[1];
      }
      return [out, p];
    }
    default:
      throw new Error(`모르는 RESP 머리: ${buf.toString('utf8', pos, eol)}`);
  }
}

const encode = (args: readonly string[]) => args.reduce((s, a) => `${s}$${Buffer.byteLength(a)}\r\n${a}\r\n`, `*${args.length}\r\n`);

export async function shardSubscriber(url: string): Promise<ShardSubscriber> {
  const u = new URL(url);
  const sock = connect(Number(u.port), u.hostname);
  await once(sock, 'connect');
  const messages: ShardMessage[] = [];
  /** PING 답(pong)을 기다리는 쪽(보낸 차례) */
  const pongs: { ok: () => void; fail: (e: Error) => void }[] = [];
  let buf = Buffer.alloc(0);
  let broken: Error | undefined;
  const failAll = (e: Error) => {
    broken = e;
    for (const w of pongs.splice(0)) w.fail(e);
  };
  sock.on('error', failAll);
  sock.on('close', () => failAll(new Error('구독 연결이 닫혔다')));
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const r = parseResp(buf, 0);
      if (!r) break;
      buf = buf.subarray(r[1]);
      const v = r[0];
      if (v instanceof Error) {
        failAll(v);
        continue;
      }
      if (!Array.isArray(v)) continue;
      const kind = String(v[0]).toLowerCase();
      if (kind === 'smessage') messages.push({ channel: String(v[1]), message: String(v[2]) });
      else if (kind === 'pong') pongs.shift()?.ok();
    }
  });
  const sync = () =>
    new Promise<void>((ok, fail) => {
      if (broken) return fail(broken);
      pongs.push({ ok, fail });
      sock.write(encode(['PING']));
    });
  return {
    messages,
    subscribe: async (channels) => {
      // 구독 모드에 들어간 뒤의 PING 답은 배열 ['pong', '']이다. 처음 구독 전에 보내면 '+PONG'이라 SSUBSCRIBE를 먼저 보낸다
      sock.write(encode(['SSUBSCRIBE', ...channels]));
      await sync();
    },
    sync,
    close: () => sock.destroy(),
  };
}
