// 통합 시험용 Valkey 컨테이너(purchase-svc test-int/valkey.ts와 같은 방식: 라이브러리 없이 docker 명령, BUILD_ORDER HOT-090).
// 이름은 rtgw-it-로 시작해 이 시험이 띄운 것만 지운다(docker rm -f -v). 장애 주입(S-T42 ⑩)은 docker stop·docker start로 하고 docker restart는 쓰지 않는다.
// 답하지 않는 Valkey(S-T42 ⑲)는 docker pause·docker unpause로 만든다(연결은 열린 채 답이 없다). 지울 때는 unpause 뒤 rm -f -v 한다.
// 다시 띄운 뒤 같은 주소로 붙도록 호스트 포트를 시험이 골라 고정한다.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]): string => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

export interface ValkeyContainer {
  name: string;
  port: number;
  url: string;
  cli(...args: string[]): string;
  /** 컨테이너를 멈춘다(docker stop) */
  pause(): void;
  /** 멈춘 컨테이너를 다시 띄우고 PING을 기다린다(docker start) */
  resume(): Promise<void>;
  /** 프로세스를 얼린다(docker pause): TCP 연결은 열린 채 답이 없다 */
  freeze(): void;
  /** 얼린 것을 푼다(docker unpause) */
  thaw(): void;
  stop(): void;
}

/** 빈 호스트 포트 하나 */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** ok가 참이 될 때까지 0.2초마다 다시 본다. 30초 안에 안 되면 던진다 */
async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      if (ok()) return;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${what}이(가) 30초 안에 되지 않았다`);
}

export async function startValkey(): Promise<ValkeyContainer> {
  const name = `rtgw-it-${randomBytes(4).toString('hex')}`;
  const port = await freePort();
  docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:6379`, VALKEY_IMAGE]);
  let frozen = false;
  const stop = (): void => {
    if (frozen) {
      try {
        docker(['unpause', name]);
      } catch {
        // 이미 풀렸거나 없다
      }
      frozen = false;
    }
    try {
      docker(['rm', '-f', '-v', name]);
    } catch {
      // 이미 없다
    }
  };
  const cli = (...a: string[]): string => docker(['exec', name, 'valkey-cli', ...a]);
  try {
    await until(() => cli('PING') === 'PONG', 'Valkey 시작');
  } catch (err) {
    stop();
    throw err;
  }
  return {
    name,
    port,
    url: `redis://127.0.0.1:${port}`,
    cli,
    pause: () => void docker(['stop', '-t', '2', name]),
    resume: async () => {
      docker(['start', name]);
      await until(() => cli('PING') === 'PONG', 'Valkey 다시 시작');
    },
    freeze: () => {
      docker(['pause', name]);
      frozen = true;
    },
    thaw: () => {
      docker(['unpause', name]);
      frozen = false;
    },
    stop,
  };
}
