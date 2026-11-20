// BAT-425 시작 조립 시험(M46, 2026-11-20 732d2437).
// 운영 조립(start.ts·relay-app.ts)의 배상 송금 클라이언트·서킷 읽기·환급 재시도 반복이 실제로 꽂히는지 글 경계로 고정한다
// (start-fraud-grpc.test.ts·core-svc shop-start-assembly.test.ts와 같은 방식). 실제 프로세스 동작은
// services/bundle/test-int/start-files.int.test.ts의 M46 시험 몫이다(ci 닫힌 대역·staging/prod 시작 실패·경로 401).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('M46_start.ts는_배상_송금_gRPC_클라이언트와_서킷_HTTP_읽기를_조립하고_주소_없음_규칙을_지킨다', () => {
  const s = source('start.ts');
  expect(s, '배상 송금은 같은 payment-svc gRPC 주소로 만든다').toContain('new GrpcCompensationTransfer({ address: paymentGrpcAddr })');
  expect(s, '배상 송금 클라이언트를 환급 모듈 조립에 꽂는다').toContain('compensationTransfer: compensationTransfers');
  expect(s, '배상 행 저장소도 함께 꽂는다').toContain('compensationStore: new DrizzleCompensations(database)');
  expect(s, '계좌 다시 받기 쓰기는 같은 취소 쓰기를 쓴다').toContain('refundAccountWrites: cancellationWrites');
  expect(s, '서킷 읽기 클라이언트를 만든다').toContain('new HttpPgCircuits({');
  expect(s, '서킷 읽기를 회차 취소 실행기에 넘긴다').toContain('circuitOpen: (pg) => pgCircuits!.circuitOpen(pg)');
  expect(s, 'local·ci 밖에서 주소가 없으면 시작 실패다').toContain('PEAKET_PAYMENT_HTTP_URL이 없다(회차 취소 서킷 읽기, 운영 필수)');
  expect(s, '닫힌 대역을 받는 환경은 local·ci·demo뿐이다').toContain("envName !== 'local' && envName !== 'ci' && envName !== 'demo'");
});

test('M46_relay-app.ts는_환급_재시도_반복과_회차_취소_반복을_조립하고_서킷_읽기를_실행기에_넘긴다', () => {
  const r = source('relay-app.ts');
  expect(r, '마감 뒤 환급 재시도 반복을 만든다').toContain('new RefundRetryLoop({');
  expect(r, '회차 취소 일괄 환불 반복을 만든다').toContain('new EventRefundLoop({');
  expect(r, '서킷 읽기 클라이언트를 만든다').toContain('new HttpPgCircuits({');
  expect(r, '서킷 읽기를 회차 취소 실행기에 넘긴다').toContain('circuitOpen: (pg) => pgCircuits!.circuitOpen(pg)');
  expect(r, 'local·ci 밖에서 서킷 주소가 없으면 시작 실패다').toContain('PEAKET_PAYMENT_HTTP_URL이 없다(회차 취소 서킷 읽기, 운영 필수)');
});
