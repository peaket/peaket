// 운영 조립(start.ts)의 부정 예매 운영자 취소 gRPC(BUILD_ORDER GAT-080, BAT-415 몫 F, docs/features/transfer-refund.md §7.4 '호출자').
// 통합 시험(test-int/fraud-cancellation.int.test.ts)은 서버를 직접 띄우므로 시작 파일의 조립을 보지 못한다(자주 놓친 결함 '시작 파일의 조립은 따로 본다').
// start-shutdown.test.ts와 같은 방식으로 시작 파일 글을 읽어 서비스 등록과 내부 토큰 검사 목록을 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const source = (): string =>
  readFileSync(fileURLToPath(new URL('../src/start.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

test('GAT-080 F18 start.ts는 FraudCancellationService를 gRPC 서비스 목록에 올리고 내부 토큰을 처리기에 넘긴다', () => {
  const s = source();
  const push = s.indexOf('fraudCancellationPackage().FraudCancellationService.service');
  expect(push, 'FraudCancellationService 정의를 gRPC 서비스로 올린다').toBeGreaterThan(-1);
  const before = s.lastIndexOf('grpcServices.push(', push);
  expect(before, 'grpcServices.push 안에서 올린다').toBeGreaterThan(-1);
  expect(push - before, '같은 push 호출 안').toBeLessThan(200);
  const handlersAt = s.indexOf('fraudCancellationHandlers(', push);
  expect(handlersAt, '처리기를 fraudCancellationHandlers로 만든다').toBeGreaterThan(-1);
  const handlerCall = s.slice(handlersAt, handlersAt + 600);
  expect(handlerCall, '처리기에 내부 토큰을 넘긴다').toMatch(/internalToken\s*:\s*internalGrpcToken|internalGrpcToken\s*\?\s*\{\s*internalToken\s*:\s*internalGrpcToken/);
  // 서버를 여는 grpcServices 목록이 FraudCancellationService보다 뒤에서 쓰인다(올린 뒤에 서버를 연다)
  expect(s.indexOf('services: grpcServices', push), '올린 뒤에 서버를 연다').toBeGreaterThan(push);
});

test('GAT-080 F18 start.ts의 내부 토큰 인터셉터 목록에 peaket.purchase.v1.FraudCancellationService가 있다', () => {
  const s = source();
  const internal = s.slice(s.indexOf('internal: {'), s.indexOf('}', s.indexOf('services: [', s.indexOf('internal: {'))) + 1);
  expect(internal).toContain("'peaket.purchase.v1.EventRefundService'");
  expect(internal).toContain("'peaket.purchase.v1.FraudCancellationService'");
});
