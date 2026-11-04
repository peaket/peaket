// 통합 시험용 Valkey 컨테이너(services/queue-svc/test-int/valkey.ts와 같은 방식: 라이브러리 없이 docker 명령, 무작위 포트). 세션·캐시 Redis 자리다.
import { execFileSync } from 'node:child_process';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

export async function startValkey(): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  const cli = (...a: string[]) => docker(['exec', id, 'valkey-cli', ...a]);
  for (let i = 0; i < 50; i++) {
    try {
      if (cli('PING') === 'PONG') break;
    } catch {
      // 아직 뜨는 중
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: () => {
      try {
        docker(['rm', '-f', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}
