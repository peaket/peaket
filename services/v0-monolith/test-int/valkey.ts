// 통합 시험용 Valkey 컨테이너(packages/platform/test-int/containers.ts와 같은 방식: 라이브러리 없이 docker 명령).
// 운영과 같은 Valkey 8.1(docs/infra.md). Docker 엔진이 떠 있어야 한다.
import { execFileSync } from 'node:child_process';
import { createClient } from 'redis';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

const ids = new WeakMap<ValkeyContainer, string>();
const idOf = (c: ValkeyContainer): string => {
  const id = ids.get(c);
  if (!id) throw new Error('startValkey가 만든 컨테이너가 아니다');
  return id;
};

export async function startValkey(): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const url = `redis://127.0.0.1:${port}`;
  const end = Date.now() + 30_000;
  for (;;) {
    const c = createClient({ url });
    c.on('error', () => {});
    try {
      await c.connect();
      await c.ping();
      await c.quit();
      break;
    } catch (err) {
      await c.disconnect().catch(() => {});
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const container: ValkeyContainer = {
    url,
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
  ids.set(container, id);
  return container;
}

/** 컨테이너를 멈추고 다시 띄운다(응답 없이 사라진 노드 흉내, docker pause) */
export function pauseValkey(c: ValkeyContainer): void {
  docker(['pause', idOf(c)]);
}
export function unpauseValkey(c: ValkeyContainer): void {
  docker(['unpause', idOf(c)]);
}
