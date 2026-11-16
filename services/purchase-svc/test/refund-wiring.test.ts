// 시작 파일 조립의 환급 몫(BAT-420 GAT-090 A6·GAT-110 E9). 시험 조립과 따로 시작 파일의 규칙을 띄워 본다(architecture §8.6 '자주 놓친 결함').
// ① 입장 기록 대조: ticket-svc 주소가 없으면 local·ci만 대역(모든 표 found 참·entered 거짓)이고 그 밖 환경은 시작 실패다.
// ② relay-app.ts·start.ts가 환급 실행기에 입장 조회·집기·이상 표시를, 일괄 환불에 갈래(회차 취소 전용 취소기·연기 Saga)·쓸어 담기 포트를 꽂는지 글로 본다.
// 시험 담당이 구현 전에 썼다(ADR-0270).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { EntryRecords } from '../src/modules/refund/index.js';
import { entryRecordsFromEnv } from '../src/refund-wiring.js';

const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

describe('환급 시작 조립 [BAT-420]', () => {
  test('GAT-090 A6 ticket-svc 주소가 없으면 local·ci만 입장 없음 대역이고 운영·스테이징은 시작 실패다', async () => {
    for (const PEAKET_ENV of ['production', 'staging']) {
      expect(() => entryRecordsFromEnv({ env: { PEAKET_ENV } }), PEAKET_ENV).toThrow();
    }
    for (const PEAKET_ENV of ['local', 'ci']) {
      const stub = entryRecordsFromEnv({ env: { PEAKET_ENV } });
      const got = await stub.lookup(['0194c500-0000-7000-8000-000000000001', '0194c500-0000-7000-8000-000000000002'], 2_000);
      expect([...got.entries()], PEAKET_ENV).toEqual([
        ['0194c500-0000-7000-8000-000000000001', { found: true, entered: false }],
        ['0194c500-0000-7000-8000-000000000002', { found: true, entered: false }],
      ]);
    }
  });

  test('GAT-090 A6 ticket-svc 클라이언트가 있으면 환경과 무관하게 그것을 쓴다', () => {
    const tickets: EntryRecords = { lookup: async () => new Map() };
    for (const PEAKET_ENV of ['production', 'ci']) expect(entryRecordsFromEnv({ env: { PEAKET_ENV }, tickets })).toBe(tickets);
  });

  test('GAT-090 A6 relay-app.ts의 환급 실행기는 입장 조회·조건부 집기·이상 표시를 꽂는다', () => {
    const relay = source('relay-app.ts');
    expect(relay).toContain('entryRecordsFromEnv(');
    const block = relay.slice(relay.indexOf('new RefundAfterEntry('), relay.indexOf('new RefundAfterEntry(') + 600);
    expect(block).toMatch(/\bentries\s*:/);
    expect(block).toMatch(/\bclaims\s*:/);
    expect(block).toMatch(/\bflags\s*:/);
  });

  test('GAT-110 E9 start.ts·relay-app.ts의 일괄 환불은 갈래(회차 취소 전용 취소기·연기 Saga)와 쓸어 담기·끝나지 않은 주문 포트를 꽂는다', () => {
    for (const file of ['start.ts', 'relay-app.ts']) {
      const text = source(file);
      expect(text, file).toContain('new EventRefundCancellerRouter(');
      expect(text, file).toContain('new EventTicketCanceller(');
      expect(text, file).toContain('new DrizzleEventOpenOrders(');
      const block = text.slice(text.indexOf('new EventRefundService('), text.indexOf('new EventRefundService(') + 1_500);
      expect(block, file).toMatch(/\bitems\s*:/);
      expect(block, file).toMatch(/\bopenOrders\s*:/);
    }
  });

  // BAT-420 몫 D(OPEN[45]): 미룸 저장소·차액 건 조립. 빠지면 단위 시험은 지나도 운영에서 미룸이 없다
  test('R-T38 ⑤ relay-app.ts의 환급 실행기는 미룸 저장소(holds)를 꽂는다(기한 지난 미룸 풀기)', () => {
    const relay = source('relay-app.ts');
    expect(relay).toContain('new DrizzleEventRefundHolds(');
    const block = relay.slice(relay.indexOf('new RefundAfterEntry('), relay.indexOf('new RefundAfterEntry(') + 800);
    expect(block).toMatch(/\bholds\s*[:,}]/);
  });

  test('R-T38 ④ start.ts·relay-app.ts의 일괄 환불은 차액 대상 찾기(gaps)·차액 건(gapNotice)·판매 설정(configs, 입장 시작)을 꽂고, start.ts는 미룸(holds)도 꽂는다', () => {
    for (const file of ['start.ts', 'relay-app.ts']) {
      const text = source(file);
      expect(text, file).toContain('new DrizzleDeductionGapCancellations(');
      expect(text, file).toContain('new HttpDeductionGapNotice(');
      const block = text.slice(text.indexOf('new EventRefundService('), text.indexOf('new EventRefundService(') + 1_800);
      // 이름: 값 꼴과 줄임 꼴(gaps,) 둘 다 받는다
      expect(block, file).toMatch(/\bgaps\s*[:,}]/);
      expect(block, file).toMatch(/\bgapNotice\s*[:,}]/);
      expect(block, file).toMatch(/\bconfigs\s*[:,}]/);
      if (file === 'start.ts') expect(block, file).toMatch(/\bholds\s*[:,}]/);
    }
  });

  test('GAT-110 D3 [ASVS v5.0.0-8.2.1] start.ts는 일괄 환불 gRPC 처리기에 내부 gRPC 토큰을 넘겨 SetEventRefundHold가 호출자 ops-svc만 받게 한다', () => {
    const start = source('start.ts');
    const at = start.indexOf('new EventRefundGrpcController(');
    expect(at).toBeGreaterThan(-1);
    expect(start.slice(at, at + 300)).toMatch(/internalToken/);
  });
});
