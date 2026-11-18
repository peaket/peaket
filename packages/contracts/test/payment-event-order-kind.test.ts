// 결제 사건(trade.payments PaymentEvent)의 주문 종류 칸과 회차 칸 풀기(P-T55 ⑥, ADR-0299 결정 4, docs/api/avro/README.md §3 '필수 칸을 null 허용으로 풀기는 소비자 먼저').
// 정본: eventId는 ["null","string"](기본 null), orderKind는 열거 PaymentEventOrderKind(UNRECOGNIZED·TICKET·MERCH, 열거 기본 UNRECOGNIZED, 칸 기본 TICKET).
// 옛 판(08120a67의 PaymentEvent.avsc, 픽스처로 박음)으로 쓴 사건을 새 판으로 읽을 수 있어야 하고(BACKWARD), 옛 티켓 사건은 TICKET으로 읽힌다.
// 지금 trade.payments의 값은 JSON 대역(Avro 바이너리 부호화는 BAS-030 뒤)이라, 바이트 왕복은 계약 zod(@peaket/contracts/asyncapi)로 보고,
// Avro 쪽은 저장소의 호환 검사기(tools/ci/avro-schema.mjs compareSchema)와 새 판의 기본값으로 본다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { PaymentEvent } from '@peaket/contracts/asyncapi';
import { compareSchema, validateFile } from '../../../tools/ci/avro-schema.mjs';

type Field = { name: string; type: unknown; default?: unknown };
type Avsc = { name: string; fields: Field[] };

const OLD = JSON.parse(readFileSync(new URL('./fixtures/PaymentEvent-08120a67.avsc', import.meta.url), 'utf8')) as Avsc;
const NEW_TEXT = readFileSync(new URL('../../../docs/api/avro/peaket/trade/PaymentEvent.avsc', import.meta.url), 'utf8');
const NEW = JSON.parse(NEW_TEXT) as Avsc;
const field = (s: Avsc, name: string) => s.fields.find((f) => f.name === name);

/** 옛 판 생산자가 내던 티켓 승인 사건(orderKind 칸 없음, eventId 회차) */
const OLD_TICKET = {
  eventId: '0190f3a1-7c2e-7c00-8000-0000000000c1',
  orderId: '0190f3a1-7c2e-7f00-8000-0000000000f2',
  pg: 'TOSS',
  type: 'APPROVED',
  amount: 308000,
  refMissing: false,
  attemptNo: 1,
  occurredAt: '2026-11-05T03:00:05.000Z',
  eventSeq: 3,
  eventKey: '0190f3a1-7c2e-7f00-8000-0000000000e7',
};
const { eventId: _drop, ...noEvent } = OLD_TICKET;
/** 새 판 생산자가 내는 굿즈 승인 사건(회차 없음) */
const MERCH = { ...noEvent, orderId: '0190f3a1-7c2e-7f00-8000-00000000b001', pg: 'SIMULATOR', amount: 47000, orderKind: 'MERCH' };

describe('Avro 스키마 판(옛 → 새)', () => {
  test('P-T55 ⑥ 옛 판으로 쓴 사건을 새 판이 읽을 수 있다(BACKWARD 호환 검사기가 깨짐 0개)', () => {
    expect(field(OLD, 'eventId')?.type).toBe('string');
    expect(field(OLD, 'orderKind')).toBeUndefined();
    expect(compareSchema(OLD, NEW)).toEqual([]);
    // 새 판 파일 자체의 규칙(열거 첫 기호·기본값 UNRECOGNIZED 등)도 지난다
    const root = fileURLToPath(new URL('../../../docs/api/avro/', import.meta.url));
    expect(validateFile(root, join(root, 'peaket', 'trade', 'PaymentEvent.avsc'), NEW_TEXT)).toEqual([]);
  });

  test('P-T55 ⑥ 새 판의 eventId는 null 갈래가 먼저인 ["null","string"]이고 기본값 null이다', () => {
    expect(field(NEW, 'eventId')).toMatchObject({ type: ['null', 'string'], default: null });
  });

  test('P-T55 ⑥ 새 판의 orderKind는 UNRECOGNIZED·TICKET·MERCH 열거(열거 기본 UNRECOGNIZED)이고 칸 기본값이 TICKET이라 옛 사건은 TICKET으로 읽힌다', () => {
    const f = field(NEW, 'orderKind');
    expect(f?.default).toBe('TICKET');
    expect(f?.type).toMatchObject({ type: 'enum', name: 'PaymentEventOrderKind', default: 'UNRECOGNIZED', symbols: ['UNRECOGNIZED', 'TICKET', 'MERCH'] });
  });

  test('P-T55 ⑥ 호환 검사기는 null을 받던 칸을 다시 필수로 좁히는 판을 깨짐으로 잡는다(검사가 비어 통과하지 않는다)', () => {
    const narrowed = { ...NEW, fields: NEW.fields.map((f) => (f.name === 'eventId' ? { name: 'eventId', type: 'string' } : f)) };
    expect(compareSchema(NEW, narrowed).length).toBeGreaterThan(0);
  });
});

describe('계약 zod(JSON 대역 값)', () => {
  test('P-T55 ⑥ 옛 판 티켓 사건 값(주문 종류 칸 없음)을 새 계약으로 읽으면 orderKind TICKET이고 eventId가 그대로다', () => {
    const r = PaymentEvent.parse(JSON.parse(JSON.stringify(OLD_TICKET)));
    expect(r.orderKind).toBe('TICKET');
    expect(r.eventId).toBe(OLD_TICKET.eventId);
  });

  test('P-T55 ⑥ 회차 칸이 없는 굿즈 사건(orderKind MERCH)을 JSON으로 왕복하면 같은 값이고 eventId가 없다', () => {
    const bytes = Buffer.from(JSON.stringify(MERCH), 'utf8');
    const r = PaymentEvent.parse(JSON.parse(bytes.toString('utf8')));
    expect(r.orderKind).toBe('MERCH');
    expect(r.eventId).toBeUndefined();
    expect(r).toMatchObject(MERCH);
  });

  test('P-T55 ⑥ 주문 종류가 열거 밖이면(UNRECOGNIZED·소문자·새 이름) 계약 검사를 지나지 않는다(소비자가 모양 검사 전에 건너뛴다)', () => {
    for (const orderKind of ['UNRECOGNIZED', 'merch', 'VIP', '']) expect(PaymentEvent.safeParse({ ...OLD_TICKET, orderKind }).success, orderKind).toBe(false);
  });
});
