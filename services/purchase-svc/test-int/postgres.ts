// 통합 시험용 PostgreSQL 컨테이너(services/identity-svc/test-int/postgres.ts를 옮김: 실제 PostgreSQL 18, 무작위 포트, docker 명령).
// testcontainers 같은 라이브러리 없이 docker 명령으로 띄운다(설치 스크립트가 있는 의존성을 늘리지 않으려고).
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const POSTGRES_IMAGE = 'postgres:18-alpine';

export interface PostgresContainer {
  /** 슈퍼유저 접속 주소 */
  url: string;
  host: string;
  port: number;
  /** 같은 서버의 다른 사용자 주소 */
  urlFor(user: string, password: string): string;
  stop(): void;
}

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export async function startPostgres(): Promise<PostgresContainer> {
  const id = docker(['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=peaket-test', '-e', 'POSTGRES_DB=peaket', '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  const mapped = docker(['port', id, '5432/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const host = '127.0.0.1';
  const urlFor = (user: string, password: string) => `postgres://${user}:${password}@${host}:${port}/peaket`;
  const url = urlFor('postgres', 'peaket-test');
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 멈췄다
    }
  };
  // 이미지의 초기화 스크립트가 서버를 한 번 다시 띄우므로 질의가 될 때까지 기다린다
  const deadline = Date.now() + 60_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query('select 1');
      await c.end();
      break;
    } catch (err) {
      await c.end().catch(() => {});
      if (Date.now() > deadline) {
        stop();
        throw err;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return { url, host, port, urlFor, stop };
}
