// 통합 시험용 Valkey 컨테이너(실제 Valkey 8.1, 무작위 포트, docker 명령). Docker 엔진이 없으면 실패한다.
import { execFileSync } from 'node:child_process';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface ValkeyContainer {
  url: string;
  stop(): void;
}

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

export async function startValkey(): Promise<ValkeyContainer> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
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
    const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
    const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
    return { url: `redis://127.0.0.1:${port}`, stop };
  } catch (err) {
    stop();
    throw err;
  }
}
