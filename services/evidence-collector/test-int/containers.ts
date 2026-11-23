// 증거 수집기 통합 시험의 수집 대상 컨테이너(기능 F-01-1, 시험 D-T51). packages/platform/test-int/containers.ts·postgres.ts와 같은 꼴로
// 라이브러리 없이 docker 명령으로 띄운다(다른 패키지의 시험 도우미를 상대 경로로 가져오지 않는다). Docker 엔진이 없으면 실패한다.
// PostgreSQL 18(운영 판), Valkey 8.1(docs/infra.md). 수집기에는 제한 사용자를 준다(PostgreSQL pg_monitor, Valkey 세 명령만).
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const POSTGRES_IMAGE = 'postgres:18-alpine';
export const VALKEY_IMAGE = 'valkey/valkey:8.1-alpine';

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();

function mappedPort(id: string, inner: string): number {
  const mapped = docker(['port', id, inner]).split('\n')[0]!;
  return Number(mapped.slice(mapped.lastIndexOf(':') + 1));
}

function remover(id: string): () => void {
  return () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 없다
    }
  };
}

/** 조건이 될 때까지 다시 해 본다(고정 대기가 아니라 조건 기다림) */
async function until(ok: () => Promise<boolean> | boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await ok()) return;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Error(`${what}이(가) ${ms / 1000}초 안에 되지 않았다: ${String(last)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export interface PostgresTarget {
  /** 슈퍼유저 주소(시험 준비용) */
  adminUrl: string;
  /** pg_monitor 역할만 받은 수집기 사용자 주소 */
  monitorUrl: string;
  stop(): void;
}

export async function startPostgres(monitor: { user: string; password: string }): Promise<PostgresTarget> {
  const id = docker(['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=peaket-test', '-e', 'POSTGRES_DB=peaket', '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  const stop = remover(id);
  try {
    const port = mappedPort(id, '5432/tcp');
    const adminUrl = `postgres://postgres:peaket-test@127.0.0.1:${port}/peaket`;
    // 이미지의 초기화 스크립트가 서버를 한 번 다시 띄우므로 질의가 될 때까지 기다린다
    await until(async () => {
      const c = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 });
      try {
        await c.connect();
        await c.query('select 1');
        return true;
      } finally {
        await c.end().catch(() => {});
      }
    }, 'PostgreSQL 시작');
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(`create role ${monitor.user} login password '${monitor.password}'`);
      await c.query(`grant pg_monitor to ${monitor.user}`);
    } finally {
      await c.end();
    }
    return { adminUrl, monitorUrl: `postgres://${monitor.user}:${monitor.password}@127.0.0.1:${port}/peaket`, stop };
  } catch (err) {
    stop();
    throw err;
  }
}

export interface ValkeyTarget {
  /** 기본 사용자(제한 없음, 시험 준비용) 주소 */
  adminUrl: string;
  /** INFO·SLOWLOG GET·CLIENT LIST만 허용한 수집기 사용자 주소 */
  restrictedUrl: string;
  /** 컨테이너 안 valkey-cli(기본 사용자) */
  cli(...args: string[]): string;
  stop(): void;
}

export async function startValkey(restricted: { user: string; password: string }): Promise<ValkeyTarget> {
  const id = docker(['run', '-d', '--rm', '-p', '127.0.0.1::6379', VALKEY_IMAGE]);
  const stop = remover(id);
  try {
    const port = mappedPort(id, '6379/tcp');
    const cli = (...args: string[]) => docker(['exec', id, 'valkey-cli', ...args]);
    await until(() => cli('PING') === 'PONG', 'Valkey 시작');
    // 세 명령 말고는 모두 막는다(docs/devops.md D-T51). 그 밖의 명령을 보내면 NOPERM으로 실패한다
    const acl = cli('ACL', 'SETUSER', restricted.user, 'reset', 'on', `>${restricted.password}`, '-@all', '+info', '+slowlog|get', '+client|list');
    if (acl !== 'OK') throw new Error(`ACL SETUSER 실패: ${acl}`);
    return {
      adminUrl: `redis://127.0.0.1:${port}`,
      restrictedUrl: `redis://${restricted.user}:${restricted.password}@127.0.0.1:${port}`,
      cli,
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}
