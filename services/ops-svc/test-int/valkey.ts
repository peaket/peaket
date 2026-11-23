// 통합 시험용 대기열 Redis(Valkey) 컨테이너(F-03-3). services/admission-ctrl/test-int/valkey.ts와 같은 방식이다(라이브러리 없이 docker 명령).
// ops-svc는 대기열 Redis를 읽기만 한다(docs/security/asvs/control-tower.md 13.2.2, 계획 '감독에게' 3 (나)). 그래서 읽기만 허락한 사용자를 하나 만들어
// 그 주소를 ops-svc에 주고, 시험은 기본 사용자로 리더가 쓰는 칸을 쓴다.
import { execFileSync } from 'node:child_process';

export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

export interface ValkeyContainer {
  /** 기본 사용자(모든 권한) 주소 */
  url: string;
  /** 읽기만 허락한 사용자 주소 */
  readOnlyUrl: string;
  readonly readOnlyUser: string;
  /** valkey-cli 한 줄(기본 사용자)의 답 */
  cli(args: string[]): string;
  stop(): void;
}

export async function startValkey(): Promise<ValkeyContainer> {
  const prefix = process.env.PEAKET_TEST_CONTAINER_PREFIX;
  const name = prefix ? `${prefix}valkey-${Math.random().toString(36).slice(2, 8)}` : undefined;
  const id = docker(['run', '-d', '--rm', ...(name ? ['--name', name] : []), '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  const mapped = docker(['port', id, '6379/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const cli = (args: string[]) => docker(['exec', id, 'valkey-cli', ...args]);
  // 시작 조건(시간이 아니라 PONG)
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      if (cli(['PING']) === 'PONG') break;
    } catch {
      // 아직 뜨는 중
    }
    if (Date.now() > deadline) throw new Error('Valkey가 뜨지 않았다');
    await new Promise((r) => setTimeout(r, 200));
  }
  const user = 'ops-ro';
  const password = 'ops-ro-test-password';
  // 읽기 범주와 연결 범주만(쓰기 범주는 없다). 키는 대기열 키 q:* 만
  cli(['ACL', 'SETUSER', user, 'reset', 'on', `>${password}`, '~q:*', 'resetchannels', '-@all', '+@read', '+@connection', '+select', '+client|setinfo', '+client|setname']);
  return {
    url: `redis://127.0.0.1:${port}`,
    readOnlyUrl: `redis://${user}:${password}@127.0.0.1:${port}`,
    readOnlyUser: user,
    cli,
    stop: () => {
      try {
        docker(['rm', '-f', '-v', id]);
      } catch {
        // 이미 없다
      }
    },
  };
}
