// 결제 결과 long polling의 purchase DB 읽기(PaymentStatusReads, docs/features/payment.md §2 '결제 결과 long polling의 첫 구현', BUILD_ORDER PRF-166).
// 트랜잭션 밖 한 질의로 주문 행(id·account_id·status·failure_reason) + ACCEPTED 결제 시도의 결제사(payment_attempt.pg)
// + 발권 재시도 큐 행의 created_at·attempts·last_error(ticket_issue_job, 0007. issueDelayed 판정, 리뷰 고침 M1)를 기본 키로 읽는다. readMany는 같은 질의를 id = any(배열)로 한 번에 읽는다
// (파드 안 기다림 표의 200ms [가정] 묶음 조회, 한 번에 최대 500건 [가정]). 쓰기 인스턴스(시작 파일이 넘기는 핫패스 풀)로 읽는다(payment §2 '알림 길').
// 아무것도 쓰지 않는다(주문 상태 SQL 검사 test/order-status-sql.test.ts에 걸리지 않는다).
// 소문자 UUID가 아닌 ID는 DB에 가지 않는다(drizzle-payment-results.ts의 read와 같다).
import type { Database, DatabaseOptions } from '@peaket/platform';
import { type SQL, sql } from 'drizzle-orm';
import type { OrderStatus } from '../../domain/order.js';
import { PAYMENT_STATUS_BATCH_MAX, type PaymentStatusView } from '../../domain/payment-status.js';
import type { PaymentPg, PaymentStatusReads } from '../../domain/ports.js';

export interface DrizzlePaymentStatusOptions {
  /** purchase DB(쓰기 인스턴스). 기다리는 동안에는 연결을 쥐지 않는다: 질의 하나마다 풀에서 빌려 곧바로 돌려준다 */
  database: Database;
}

/** 기다림 표 묶음 조회 전용 풀의 연결 수 2개 [가정](BAT-029) */
const PAYMENT_STATUS_WAIT_DB_MAX = 2;

/**
 * 기다림 표의 200ms 묶음 조회 전용 purchase DB 풀(BAT-029). 핫패스 풀과 따로 두어, 기다리는 주문이 많을 때
 * 묶음 조회가 홀드·주문·결제 상태 단건 읽기의 연결을 빼앗지 않게 한다. 요청 경로의 단건 읽기는 핫패스 풀 그대로다
 */
export function paymentStatusWaitTableDatabaseOptions(url: string): DatabaseOptions {
  return { url, profile: 'general', max: PAYMENT_STATUS_WAIT_DB_MAX, applicationName: 'purchase-svc-payment-status' };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** 질의 한 줄(아래 select의 칸) */
interface Row {
  id: string;
  account_id: string;
  status: string;
  failure_reason: string | null;
  accepted_pg: string | null;
  issue_job_created_at: Date | string | null;
  issue_job_attempts: number | null;
  issue_job_last_error: string | null;
}

/** 주문 행 + ACCEPTED 결제 시도의 결제사 + 발권 재시도 큐 행 created_at·attempts·last_error. where는 부르는 쪽이 준다(기본 키 하나·배열) */
const select = (where: SQL) => sql`
  select o.id, o.account_id, o.status, o.failure_reason,
         a.pg as accepted_pg,
         j.created_at as issue_job_created_at, j.attempts as issue_job_attempts, j.last_error as issue_job_last_error
  from purchase_order o
  left join payment_attempt a on a.order_id = o.id and a.status = 'ACCEPTED'
  left join ticket_issue_job j on j.order_id = o.id
  where ${where}`;

/** 줄 → 모습(값 없는 칸은 싣지 않는다. 큐 행이 있으면 시도 수는 늘 싣는다) */
function viewOf(r: Row): PaymentStatusView {
  const job =
    r.issue_job_created_at !== null
      ? {
          issueJobCreatedAtMs: new Date(r.issue_job_created_at).getTime(),
          issueJobAttempts: Number(r.issue_job_attempts ?? 0),
          ...(r.issue_job_last_error !== null ? { issueJobLastError: r.issue_job_last_error } : {}),
        }
      : {};
  return {
    orderId: r.id,
    accountId: r.account_id,
    status: r.status as OrderStatus,
    ...(r.failure_reason !== null ? { failureReason: r.failure_reason } : {}),
    ...(r.accepted_pg !== null ? { pg: r.accepted_pg as PaymentPg } : {}),
    ...job,
  };
}

/** long polling 읽기의 purchase DB 구현(위 머리 주석) */
export class DrizzlePaymentStatus implements PaymentStatusReads {
  constructor(private readonly o: DrizzlePaymentStatusOptions) {}

  /** PaymentStatusReads.read(포트 설명). 소문자 UUID가 아니면 DB에 가지 않고 undefined */
  async read(orderId: string): Promise<PaymentStatusView | undefined> {
    if (!isUuid(orderId)) return undefined;
    const r = await this.o.database.db.execute(select(sql`o.id = ${orderId}::uuid`));
    const row = r.rows[0] as unknown as Row | undefined;
    return row ? viewOf(row) : undefined;
  }

  /**
   * PaymentStatusReads.readMany(포트 설명). 소문자 UUID가 아닌 ID는 빼고 묻는다(남은 것이 없으면 DB에 가지 않고 []).
   * @throws RangeError PAYMENT_STATUS_BATCH_MAX(500)건을 넘음
   */
  async readMany(orderIds: readonly string[]): Promise<PaymentStatusView[]> {
    if (orderIds.length > PAYMENT_STATUS_BATCH_MAX) throw new RangeError(`한 번에 읽는 주문은 ${PAYMENT_STATUS_BATCH_MAX}건까지다: ${orderIds.length}`);
    const ids = [...new Set(orderIds.filter(isUuid))];
    if (ids.length === 0) return [];
    // 모두 소문자 UUID로 확인했으므로 배열 글 하나(매개변수 하나)로 넘긴다
    const r = await this.o.database.db.execute(select(sql`o.id = any(${`{${ids.join(',')}}`}::uuid[])`));
    return (r.rows as unknown as Row[]).map(viewOf);
  }
}
