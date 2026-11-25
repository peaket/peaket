// F-05-12 ticket-svc 시작 파일 조립(TR-03·TR-05·TR-11). 정본: docs/review/plans/F-05-12.md §4·§5, architecture §8.6 4
// '시작 파일 조립을 따로 띄워 본다', docs/features/offline-gate.md §9.1, docs/observability.md §8.
//
// 시험 조립(단위·통합이 저장소를 직접 만드는 시험)은 start()가 그 저장소·포트를 실제로 꽂지 않아도 통과한다.
// 여기서는 start.ts의 조립 식을 소스 경계로 본다(ticket-svc/test/device-key-assembly.test.ts와 같은 방식).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const SOURCE = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
/** 주석을 뺀 코드(주석 속 이름에 속지 않게) */
const CODE = SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/**'))
  .join('\n');
const START = CODE.slice(CODE.indexOf('export async function start('));
const blockOf = (from: string): string => {
  const at = START.indexOf(from);
  expect(at, `${from}가 start()에 있다`).toBeGreaterThan(-1);
  return START.slice(at, START.indexOf('});', at));
};

describe('ticket-svc 시작 파일의 부스 재발급 조립 [O-T28 ③]', () => {
  test('O-T28 ③ 시작 파일이 DrizzleBoothStore·TicketBooth·identity gRPC 확인기를 조립하고 기기 키 저장소와 같은 트랜잭션에 잇는다', () => {
    expect(/new DrizzleBoothStore\(\{/.test(START), 'new DrizzleBoothStore({').toBe(true);
    // 부스 저장소를 기기 키 저장소에 넘긴다: BOOTH 사용 표시가 키 저장 트랜잭션 밖에서 불리면 안 된다(TR-03)
    expect(/\bbooth\b/.test(blockOf('new DrizzleDeviceKeyStore({')), 'DrizzleDeviceKeyStore에 booth').toBe(true);
    expect(/store:\s*boothStore\b/.test(blockOf('new TicketBooth({')), 'TicketBooth store: boothStore').toBe(true);
    // identity는 기존 PEAKET_IDENTITY_GRPC_URL을 그대로 쓰는 gRPC 확인기다(새 HTTP 주소를 만들지 않는다)
    expect(/new GrpcBoothReverificationVerifier\(\s*config\.identityGrpcUrl/.test(START), 'GrpcBoothReverificationVerifier(config.identityGrpcUrl)').toBe(true);
    // HTTP 조립: ticket·scanner 두 배선 모두에 booth를 꽂는다
    const registerAt = START.indexOf('AppModule.register({');
    expect(registerAt, 'AppModule.register({').toBeGreaterThan(-1);
    const registerBlock = START.slice(registerAt, registerAt + 2500);
    expect(/ticket:\s*\{[^}]*\bbooth\b/.test(registerBlock), 'ticket 배선에 booth').toBe(true);
    expect(/scanner:\s*\{[\s\S]*?\bbooth\b/.test(registerBlock), 'scanner 배선에 booth').toBe(true);
  });

  test('O-T28 ③ 부스 지표 이름·이름표는 result뿐이고 계정·티켓·코드·토큰을 싣지 않는다', () => {
    for (const name of ['ticket_booth_requests_total', 'ticket_booth_authorizations_total', 'ticket_booth_registrations_total']) {
      const at = CODE.indexOf(`name: '${name}'`);
      expect(at, `${name} 계수기가 start()에 있다`).toBeGreaterThan(-1);
      const counter = CODE.slice(at, CODE.indexOf('});', at));
      expect(/labelNames:\s*\[[^\]]*'result'/.test(counter), `${name}의 이름표는 result`).toBe(true);
      expect(/labelNames:\s*\[[^\]]*'(account|accountId|ticket|ticketId|code|boothCode|token)'/.test(counter), `${name}에 민감 이름표 없음`).toBe(false);
    }
    // 403 감사·접속기록에도 코드·토큰 원문을 남기지 않는다(요청 로그 줄은 본문을 싣지 않는다)
    expect(/logger\.(info|warn|error)\([^)]*boothCode/.test(CODE)).toBe(false);
    expect(/logger\.(info|warn|error)\([^)]*reverificationToken/.test(CODE)).toBe(false);
  });
});
