// 시험 기록(NDJSON) 읽기(docs/verification.md §2.5 '기록'). 한 줄에 사건 하나, 종류는 넷이다.
// - queue_entry(대기표 발급)·queue_admit(입장 확정): 요청 하나의 시작·끝 시각과 결과(ok·fail·unknown), 받은·가진 순번과 세대
// - queue_serving: serving 값과 그 값을 본 시각(admission-ctrl의 전진 기록이나 서버가 낸 대기 상태 파일에서 온다)
// - pg_charge: PG 시뮬레이터 원장 한 건(`GET /sim/ledger`가 이 형식으로 낸다)
// 모르는 종류·칸·값은 그 줄 번호와 함께 거절한다(ASVS v5.0.0-2.2.1).
export type OpResult = 'ok' | 'fail' | 'unknown';

export interface QueueOpRecord {
  event_id: string;
  account_ref: string;
  request_id: string;
  result: OpResult;
  seq: number | null;
  generation: number | null;
  started_at: string;
  ended_at: string;
}

export interface QueueServingRecord {
  event_id: string;
  serving: number;
  observed_at: string;
}

export interface PgChargeRecord {
  pg: 'TOSS' | 'PORTONE' | 'SIMULATOR';
  payment_ref: string;
  order_ref: string;
  amount: number;
  status: string;
  approved_at: string | null;
  canceled_amount: number;
}

export interface TestRecords {
  queue_entry: QueueOpRecord[];
  queue_admit: QueueOpRecord[];
  queue_serving: QueueServingRecord[];
  pg_charge: PgChargeRecord[];
}

export class RecordFormatError extends Error {
  override name = 'RecordFormatError';
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(`시험 기록 ${line}번째 줄: ${message}`);
  }
}

export const emptyRecords = (): TestRecords => ({ queue_entry: [], queue_admit: [], queue_serving: [], pg_charge: [] });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const REF = /^[\x21-\x7e]{1,200}$/;
const PGS = new Set(['TOSS', 'PORTONE', 'SIMULATOR']);
const RESULTS = new Set(['ok', 'fail', 'unknown']);

const FIELDS: Record<keyof TestRecords, readonly string[]> = {
  queue_entry: ['event_id', 'account_ref', 'request_id', 'result', 'seq', 'generation', 'started_at', 'ended_at'],
  queue_admit: ['event_id', 'account_ref', 'request_id', 'result', 'seq', 'generation', 'started_at', 'ended_at'],
  queue_serving: ['event_id', 'serving', 'observed_at'],
  pg_charge: ['pg', 'payment_ref', 'order_ref', 'amount', 'status', 'approved_at', 'canceled_amount'],
};

export function parseRecords(text: string): TestRecords {
  const out = emptyRecords();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw) continue;
    const n = i + 1;
    const fail = (m: string): never => {
      throw new RecordFormatError(n, m);
    };
    let o: Record<string, unknown>;
    try {
      const v: unknown = JSON.parse(raw);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) fail('JSON 객체가 아니다');
      o = v as Record<string, unknown>;
    } catch (e) {
      if (e instanceof RecordFormatError) throw e;
      return fail('JSON으로 읽을 수 없다');
    }
    const kind = o.kind as keyof TestRecords;
    // in은 객체가 원래 가진 이름(toString·__proto__)도 통과시킨다. 자기 칸인지로 본다
    if (typeof kind !== 'string' || !Object.hasOwn(FIELDS, kind)) fail(`모르는 종류: ${String(o.kind)}`);
    for (const k of Object.keys(o)) if (k !== 'kind' && !FIELDS[kind].includes(k)) fail(`${kind}에 없는 칸: ${k}`);

    const uuid = (k: string) => (typeof o[k] === 'string' && UUID.test(o[k] as string) ? (o[k] as string).toLowerCase() : fail(`${k}가 UUID가 아니다`));
    const ref = (k: string) => (typeof o[k] === 'string' && REF.test(o[k] as string) ? (o[k] as string) : fail(`${k}가 1~200자 출력 가능 ASCII가 아니다`));
    const iso = (k: string) => (typeof o[k] === 'string' && ISO.test(o[k] as string) && !Number.isNaN(Date.parse(o[k] as string)) ? (o[k] as string) : fail(`${k}가 오프셋 있는 ISO 8601 시각이 아니다`));
    const int = (k: string, min: number) => (Number.isSafeInteger(o[k]) && (o[k] as number) >= min ? (o[k] as number) : fail(`${k}가 ${min} 이상 정수가 아니다`));
    const optInt = (k: string) => (o[k] === undefined || o[k] === null ? null : int(k, 0));

    if (kind === 'queue_entry' || kind === 'queue_admit') {
      const result = RESULTS.has(o.result as string) ? (o.result as OpResult) : fail(`result는 ok·fail·unknown 가운데 하나다: ${String(o.result)}`);
      const seq = optInt('seq');
      const generation = optInt('generation');
      if (result === 'ok' && (seq === null || generation === null)) fail('result가 ok면 seq와 generation이 있어야 한다');
      const started_at = iso('started_at');
      const ended_at = iso('ended_at');
      if (Date.parse(ended_at) < Date.parse(started_at)) fail('ended_at이 started_at보다 앞이다');
      out[kind].push({ event_id: uuid('event_id'), account_ref: ref('account_ref'), request_id: ref('request_id'), result, seq, generation, started_at, ended_at });
    } else if (kind === 'queue_serving') {
      out.queue_serving.push({ event_id: uuid('event_id'), serving: int('serving', 0), observed_at: iso('observed_at') });
    } else {
      const pg = PGS.has(o.pg as string) ? (o.pg as PgChargeRecord['pg']) : fail(`pg는 TOSS·PORTONE·SIMULATOR 가운데 하나다: ${String(o.pg)}`);
      const amount = int('amount', 1);
      const canceled = int('canceled_amount', 0);
      if (canceled > amount) fail('canceled_amount가 amount보다 크다');
      out.pg_charge.push({
        pg,
        payment_ref: ref('payment_ref'),
        order_ref: ref('order_ref'),
        amount,
        status: ref('status'),
        approved_at: o.approved_at === null ? null : iso('approved_at'),
        canceled_amount: canceled,
      });
    }
  }
  return out;
}
