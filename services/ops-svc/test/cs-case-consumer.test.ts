// CS 처리함 건 요청의 Kafka 소비자 처리기(F-06-2 GAT-280, R-T48 ④) 단위 시험. 시험 담당 lane3-f062-test.
// 정본: ADR-0364 결정 4(ops-svc는 support.cases-requested를 지금 소비자 그룹에서 읽고 내부 HTTP와 같은 처리기를 부른다, 받지 않는 종류는 보류하지 않고 넘기며 지표로 센다),
// docs/features/transfer-refund.md §11 R-T48 ④(HTTP로 보낸 것과 합쳐 건 하나, 받지 않는 종류도 보류 행 0).
// 실제 Kafka·held_event 표는 test-int/cs-cases-kafka.int.test.ts가 본다. 여기서는 main.ts와 같은 조립(svc.app.get(ReceiveCaseRequested))으로 처리기를 만든다.
import type { ConsumedMessage } from '@peaket/platform';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CS_CASES_REQUESTED_TOPIC, CaseRequestsHandler, OpsCommandEventsHandler, OpsTopicsHandler } from '../src/consumers/index.js';
import { ReceiveCaseRequested } from '../src/modules/cases/index.js';
import { MemoryAuditChain } from '../src/modules/audit/index.js';
import { CreateCommand, HandleCommandEvent, MemoryCommandStore } from '../src/modules/commands/index.js';
import { BD10, BD3, caseRequest, csHarness, type CsHarness } from './cs-support.js';

let h: CsHarness;
let offset = 0n;
beforeEach(async () => {
  h = await csHarness();
});
afterEach(async () => {
  await h.close();
});

const message = (value: unknown, topic = CS_CASES_REQUESTED_TOPIC): ConsumedMessage => ({
  topic,
  partition: 0,
  offset: ++offset,
  key: null,
  value: value === null ? null : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8'),
  headers: {},
  timestamp: Date.parse('2026-11-20T14:30:00.000Z'),
});

/** main.ts의 startOpsConsumers와 같은 꼴: 토픽 나눔 처리기에 HTTP와 같은 건 요청 처리기를 꽂는다 */
// 명령 사건 처리기는 이 시험의 대상이 아니라 command-events-kafka.test.ts와 같은 조립으로 둔다
const commandEvents = () => {
  const store = new MemoryCommandStore(new MemoryAuditChain());
  return new OpsCommandEventsHandler(new HandleCommandEvent({ createCommand: new CreateCommand(store), store }), h.clock);
};
const topicsHandler = () => new OpsTopicsHandler(commandEvents(), new CaseRequestsHandler(h.svc.app.get(ReceiveCaseRequested), h.clock));

const consume = async (handler: OpsTopicsHandler, m: ConsumedMessage) => {
  const decoded = await handler.decode(m);
  await handler.handle(decoded);
  return decoded;
};

describe('R-T48 ④ support.cases-requested 소비자', () => {
  test('R-T48 ④ HTTP로 보낸 본문과 같은 본문을 Kafka로 받으면 건 하나이고 같은 기한이다', async () => {
    const body = caseRequest('DISPUTE', { category: 'INQUIRY_DISPUTE' });
    const viaHttp = await h.intake(body);
    expect(viaHttp.body.accepted).toBe(true);
    const handler = topicsHandler();
    await consume(handler, message(body));
    // 같은 대상의 다른 사건도 열린 건 하나로 모인다
    await consume(handler, message({ ...body, eventKey: crypto.randomUUID() }));

    const items = (await h.list(h.as('cs_lead'), 'limit=100')).body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => ({ caseId: i.caseId, kind: i.kind, progressDueAt: i.progressDueAt, resultDueAt: i.resultDueAt }))).toEqual([
      { caseId: viaHttp.body.caseId, kind: 'DISPUTE', progressDueAt: BD3, resultDueAt: BD10 },
    ]);
    expect([await h.requests('DISPUTE', 'opened'), await h.requests('DISPUTE', 'duplicate'), await h.requests('DISPUTE', 'existing')]).toEqual([1, 1, 1]);
  });

  test('R-T48 ④ Kafka로 먼저 온 추가 검증 이의(queue-svc는 Kafka로만 보낸다)도 건이 되고 업무 키는 (종류, 대상)이다', async () => {
    const body = caseRequest('VERIFICATION_APPEAL', { category: 'EXPLANATION' });
    const handler = topicsHandler();
    const decoded = await consume(handler, message(body));
    expect(handler.keyOf(decoded)).toBe(`case:VERIFICATION_APPEAL:${body.sourceId}`);
    expect(handler.eventKeyOf(decoded)).toBe(body.eventKey);
    const items = (await h.list(h.as('cs_agent'), 'kind=VERIFICATION_APPEAL')).body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => ({ targetRef: i.targetRef, status: i.status, resultDueAt: i.resultDueAt }))).toEqual([{ targetRef: body.sourceId, status: 'OPEN', resultDueAt: BD10 }]);
  });

  test('R-T48 ④ 받지 않는 종류와 계약 모양이 아닌 메시지는 던지지 않고(보류 없이) 넘기며 ignored로 센다', async () => {
    const handler = topicsHandler();
    const values: unknown[] = [caseRequest('INQUIRY'), caseRequest('CONTENT_REPORT'), '{not json', null, [1, 2], { ...caseRequest('DISPUTE'), extra: 'x' }];
    for (const v of values) await expect(consume(handler, message(v))).resolves.toBeDefined();
    expect([await h.requests('INQUIRY', 'ignored'), await h.requests('CONTENT_REPORT', 'ignored'), await h.requests('UNKNOWN', 'ignored'), await h.requests('DISPUTE', 'ignored')]).toEqual([1, 1, 3, 1]);
    // 넘긴 메시지마다 업무 키가 달라 한 줄에 막히지 않는다
    const keys = await Promise.all(values.map(async (v) => handler.keyOf(await handler.decode(message(v)))));
    expect(new Set(keys).size).toBe(values.length);
    for (const role of ['cs_lead', 'operator'] as const) expect((await h.list(h.as(role), 'limit=100')).body.items, role).toEqual([]);
  });

  test('R-T48 ④ 관제 명령 토픽(ops.command-events)의 메시지는 CS 처리기로 가지 않는다', async () => {
    const handler = topicsHandler();
    const decoded = await handler.decode(message(caseRequest('DISPUTE'), 'ops.command-events'));
    expect(decoded.topic).toBe('command');
    expect((await h.list(h.as('cs_lead'), 'limit=100')).body.items).toEqual([]);
  });
});
