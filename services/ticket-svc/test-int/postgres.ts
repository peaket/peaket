// 통합 시험용 PostgreSQL 컨테이너(실제 PostgreSQL 18, 무작위 포트, docker 명령). testcontainers 없이 docker를 쓴다.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const POSTGRES_IMAGE = 'postgres:18-alpine';

export interface PostgresContainer {
  url: string;
  host: string;
  port: number;
  stop(): void;
}

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export async function startPostgres(): Promise<PostgresContainer> {
  const id = docker(['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=peaket-test', '-e', 'POSTGRES_DB=peaket', '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  const mapped = docker(['port', id, '5432/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const host = '127.0.0.1';
  const url = `postgres://postgres:peaket-test@${host}:${port}/peaket`;
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 멈췄다
    }
  };
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
  return { url, host, port, stop };
}
