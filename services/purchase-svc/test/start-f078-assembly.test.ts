// F-07-8 시작 조립 시험(계획 §6 '시험 담당에게': 시작 파일 조립은 시험 조립과 따로 본다, 지시서 '자주 놓친 결함').
// 운영 조립(start.ts·relay-app.ts)에 결제사별 토큰 버킷(R-T52)·정산 다시 계산 알리기(J-T23 ①, ADR-0380)·배상 송금 결과 확정(R-T47 ③)이
// 실제로 꽂히는지 글 경계로 고정한다(start-refund-assembly.test.ts M46과 같은 방식). 실제 프로세스 동작은 bundle 시작 시험 몫이다.
// 기준 트리: 세 부품이 조립에 없어 실패한다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const source = (file: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('R-T52 ① relay-app.ts·start.ts는 일괄 환불 실행기에 결제사별 토큰 버킷을 만들어 넘긴다(설정 PEAKET_EVENT_REFUND_PG_RATE)', () => {
  for (const file of ['relay-app.ts', 'start.ts']) {
    const s = source(file);
    expect(s, `${file}: 토큰 버킷을 만든다`).toContain('new PgTokenBuckets(');
    expect(s, `${file}: 설정 이름`).toContain('PEAKET_EVENT_REFUND_PG_RATE');
  }
});

test('J-T23 ① relay-app.ts·start.ts는 정산 다시 계산 알리기 어댑터를 payment-svc 내부 HTTP 주소로 만든다', () => {
  for (const file of ['relay-app.ts', 'start.ts']) {
    const s = source(file);
    expect(s, `${file}: 정산 알리기 어댑터`).toContain('new HttpSettlementRecalculation(');
  }
});

test('R-T47 ③ relay-app.ts는 일괄 환불 실행기 틱에 배상 송금 결과 확정을 잇는다', () => {
  expect(source('relay-app.ts')).toContain('new RefreshCompensationTransfers(');
});
