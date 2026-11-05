// 통합 시험용 PostgreSQL 18 컨테이너(packages/platform/test-int/postgres.ts와 같은 방식: 라이브러리 없이 docker 명령). Docker 엔진이 떠 있어야 한다.
// 원본 DB 셋(purchase·payment·ticket)과 표가 없는 bare를 한 서버에 만든다. 표 칸은 docs/data.md의 정본 칸이고, 검사기가 읽지 않아야 할 칸(개인정보)도 둔다.
import { execFileSync } from 'node:child_process';
import pg from 'pg';

export const POSTGRES_IMAGE = 'postgres:18-alpine';
export const DATABASES = ['purchase', 'payment', 'ticket', 'bare'] as const;
export type DbName = (typeof DATABASES)[number];

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export interface PostgresServer {
  url(db: DbName): string;
  stop(): void;
}

export async function startPostgres(): Promise<PostgresServer> {
  const id = docker(['run', '-d', '--rm', '-e', 'POSTGRES_PASSWORD=peaket-test', '-e', 'POSTGRES_DB=postgres', '-p', '127.0.0.1::5432', POSTGRES_IMAGE]);
  const mapped = docker(['port', id, '5432/tcp']).split('\n')[0]!;
  const port = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  const url = (db: string) => `postgres://postgres:peaket-test@127.0.0.1:${port}/${db}`;
  const stop = () => {
    try {
      docker(['rm', '-f', '-v', id]);
    } catch {
      // 이미 멈췄다
    }
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const c = new pg.Client({ connectionString: url('postgres'), connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query('select 1');
      for (const db of DATABASES) await c.query(`CREATE DATABASE ${db}`);
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
  for (const [db, ddl] of Object.entries(SCHEMA)) {
    const c = new pg.Client({ connectionString: url(db) });
    await c.connect();
    await c.query(ddl);
    await c.end();
  }
  return { url, stop };
}

// 시험이 위반을 넣을 수 있게 정본의 유일 제약(좌석 활성 판매 부분 유니크, payment.order_id UNIQUE)은 일부러 걸지 않는다
export const SCHEMA: Record<'purchase' | 'payment' | 'ticket', string> = {
  purchase: `
    CREATE TABLE purchase_order (id uuid PRIMARY KEY, account_id uuid NOT NULL, event_id uuid NOT NULL, status text NOT NULL, amount int NOT NULL, event_seq int NOT NULL DEFAULT 0,
      buyer_name text, buyer_phone text, idempotency_key text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE order_event (order_id uuid, seq int, from_status text, to_status text NOT NULL, cause text, actor text, occurred_at timestamptz NOT NULL, PRIMARY KEY (order_id, seq));
    CREATE TABLE order_item (order_id uuid, line_no int, seat_id uuid, tier text, unit_price int, ticket_id uuid, PRIMARY KEY (order_id, line_no));
    CREATE TABLE order_cancellation (id uuid PRIMARY KEY, order_id uuid NOT NULL, ticket_id uuid, reason text, refund_amount int, status text NOT NULL);
    CREATE TABLE seat_sale (event_id uuid, seat_id uuid, order_id uuid, status text NOT NULL, reserved_at timestamptz, pending_until timestamptz, PRIMARY KEY (event_id, seat_id, order_id));
    CREATE TABLE purchase_quota (account_id uuid, event_id uuid, used int NOT NULL, limit_count int NOT NULL, PRIMARY KEY (account_id, event_id));
    CREATE TABLE event_sale (event_id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'ON_SALE', version bigint NOT NULL DEFAULT 1, sellable_seats int NOT NULL);
    CREATE TABLE ticket_issue_job (order_id uuid PRIMARY KEY, event_id uuid NOT NULL, attempts int NOT NULL DEFAULT 0, next_attempt_at timestamptz, issue_due_at timestamptz NOT NULL, last_error text, created_at timestamptz NOT NULL);
  `,
  payment: `
    CREATE TABLE payment (id uuid PRIMARY KEY, order_id uuid NOT NULL, event_id uuid NOT NULL, attempt_id uuid, pg text NOT NULL, pg_payment_ref text, pg_confirm_token text, amount int NOT NULL,
      status text NOT NULL, virtual_account_no text, idempotency_key text, card_bin text, created_at timestamptz NOT NULL DEFAULT now(), approved_at timestamptz, status_changed_at timestamptz);
    CREATE TABLE payment_cancel (id uuid PRIMARY KEY, payment_id uuid NOT NULL, amount int NOT NULL, idempotency_key text, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), canceled_at timestamptz);
    CREATE TABLE settlement_statement (id uuid PRIMARY KEY, promoter_id uuid NOT NULL, kind text NOT NULL, event_id uuid, pg text NOT NULL, pg_store text, period_start date, period_end date,
      gross_amount bigint NOT NULL, refund_amount bigint NOT NULL, commission_amount bigint NOT NULL, commission_vat bigint NOT NULL, offset_amount bigint NOT NULL, payout_amount bigint NOT NULL,
      revision int NOT NULL DEFAULT 1, supersedes_id uuid, excluded_payments jsonb NOT NULL DEFAULT '[]', status text NOT NULL, hold_reason text, dispute_due_at timestamptz, payout_date date);
    CREATE TABLE statement_source (statement_id uuid, source_id uuid, kind text NOT NULL, payment_id uuid NOT NULL, amount bigint NOT NULL, PRIMARY KEY (statement_id, source_id));
    CREATE TABLE payout (id uuid PRIMARY KEY, batch_id uuid, statement_id uuid NOT NULL, seq int NOT NULL, amount bigint NOT NULL, ref_payout_id text UNIQUE, pg_payout_id text, status text NOT NULL);
    CREATE TABLE partner_receivable (id uuid PRIMARY KEY, promoter_id uuid NOT NULL, cause text NOT NULL, pg text, amount bigint NOT NULL, remaining bigint NOT NULL, status text NOT NULL, source_ref text);
    CREATE TABLE receivable_movement (id uuid PRIMARY KEY, receivable_id uuid NOT NULL, statement_id uuid, kind text NOT NULL, amount bigint NOT NULL, reverses_id uuid, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE reconciliation_run (id uuid PRIMARY KEY, pg text NOT NULL, recon_date date NOT NULL, status text NOT NULL, matched_count int, mismatch_count int, finished_at timestamptz);
  `,
  ticket: `
    CREATE TABLE ticket (id uuid PRIMARY KEY, account_id uuid NOT NULL, payer_account_id uuid NOT NULL, event_id uuid NOT NULL, seat_id uuid, gate_zone text, status text NOT NULL, version int NOT NULL DEFAULT 0);
  `,
};

export const TABLES: Record<'purchase' | 'payment' | 'ticket', string[]> = {
  purchase: ['purchase_order', 'order_event', 'order_item', 'order_cancellation', 'seat_sale', 'purchase_quota', 'event_sale', 'ticket_issue_job'],
  payment: ['payment', 'payment_cancel', 'settlement_statement', 'statement_source', 'payout', 'partner_receivable', 'receivable_movement', 'reconciliation_run'],
  ticket: ['ticket'],
};
