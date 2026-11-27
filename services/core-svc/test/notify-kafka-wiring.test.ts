// F-06-1 N-T19 ⑨·N-T23 ④·N-T24 ②: notify Kafka 소비자 배선과 identity 계약의 정적 대조.
// Kafka·Docker를 이번 턴에 쓰지 않으므로, 배선(주제·처리기·조립)과 계약 모양을 파일에서 확인한다.
// 동작(중복·재시도·보류)은 인테이크·워커 시험과 구현 뒤 통합 시험이 본다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CORE_TOPICS } from '../src/consumers/index.js';

const readService = (p: string): string => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const readRepo = (p: string): string => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');
const handlerPath = fileURLToPath(new URL('../src/modules/notify/inbound/notify-events.handler.ts', import.meta.url));

/** `이름({`부터 균형 잡힌 닫는 `}`까지 잘라 낸다(조립 인자 검사, core-consumers.test.ts와 같은 방식) */
const callArgs = (source: string, needle: string): string => {
  const call = source.indexOf(needle);
  expect(call, needle).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', call);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${needle}의 인자 객체를 찾지 못했다`);
};

describe('N-T19 Kafka trade.orders 소비자 배선', () => {
  test('N-T19 ⑨ 소비자 그룹이 네 주제를 읽고, trade.orders 처리기는 알림 네 종류만 인테이크로 넘긴다', () => {
    expect([...CORE_TOPICS]).toEqual(['identity.accounts-withdrawn', 'identity.accounts-merged', 'identity.login-methods-changed', 'trade.orders']);

    expect(existsSync(handlerPath)).toBe(true);
    if (!existsSync(handlerPath)) return;
    const handler = readFileSync(handlerPath, 'utf8');
    expect(handler).toContain("'trade.orders'");
    for (const type of ['EVENT_CANCELLATION_CONFIRMED', 'EVENT_POSTPONED', 'REFUNDED', 'REFUND_FAILED']) expect(handler).toContain(type);
    expect(handler).toContain('tradeEvent(');

    const start = readService('src/consumers/start.ts');
    expect(start).toContain('NotifyEventHandler');
    expect(start).toMatch(/topics:\s*\[\.\.\.CORE_TOPICS\]/);

    const main = readService('src/main.ts');
    expect(main).toContain('new NotifyEventHandler(');
    expect(main).toContain('service.app.get(NotificationIntake)');
    expect(callArgs(main, 'startCoreConsumers(')).toMatch(/\bnotify\b/);
  });
});

describe('N-T23 identity 사건 소비자와 계약', () => {
  test('N-T23 ④ 처리기가 identity 두 사건을 인테이크로 넘기고, AccountMerged에는 주소 칸이 없다', () => {
    expect(existsSync(handlerPath)).toBe(true);
    if (!existsSync(handlerPath)) return;
    const handler = readFileSync(handlerPath, 'utf8');
    expect(handler).toContain("'identity.accounts-merged'");
    expect(handler).toContain("'identity.login-methods-changed'");
    expect(handler).toContain('accountMerged(');
    expect(handler).toContain('loginMethodChanged(');
    // 병합 업무 키는 mergeId, 로그인 수단 업무 키는 accountId다(docs/streaming.md §2.6)
    expect(handler).toMatch(/keyOf[\s\S]*mergeId/);
    expect(handler).toMatch(/keyOf[\s\S]*accountId/);

    const asyncapi = readRepo('docs/api/asyncapi.yaml');
    const start = asyncapi.indexOf('    AccountMerged:');
    const end = asyncapi.indexOf('    AccountWithdrawn:');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = asyncapi.slice(start, end);
    expect(block).toContain('required: [mergeId, primaryAccountId, mergedAccountId, confirmedAt]');
    expect(block).not.toContain('email');
    expect(block).not.toContain('phone');
  });
});

describe('N-T24 받는 사람 묶음의 전화번호', () => {
  test('N-T24 ② includePhone일 때만 전화번호를 주는 계약이 proto·identity 조회에 있다 [ASVS v5.0.0-14.3.2]', () => {
    const proto = readRepo('docs/api/proto/peaket/identity/v1/identity.proto');
    expect(proto).toContain('bool include_phone = 3;');
    expect(proto).toMatch(/message Recipient \{[\s\S]*string phone = 6;/);

    const getRecipients = readRepo('services/identity-svc/src/modules/session/application/get-recipients.ts');
    expect(getRecipients).toContain('includePhone');
    const grpc = readRepo('services/identity-svc/src/modules/session/inbound/recipient-query.grpc.ts');
    expect(grpc).toContain('include_phone');
    expect(grpc).toContain('phone');
  });
});
