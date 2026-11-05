// 통합 시험용 Valkey 컨테이너(packages/platform/test-int/containers.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
import { execFileSync } from 'node:child_process';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

export async function startValkey(): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  return {
    url: `redis://127.0.0.1:${port}`,
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}
