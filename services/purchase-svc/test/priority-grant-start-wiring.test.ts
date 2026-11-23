// F-05-3 IR-01 ③ 우선 구매 권리 대조의 시작 조립 시험(ADR-0385, GAT-135).
// 시작 파일을 소스로 읽어 gRPC 클라이언트·대조·환경 값 분기·종료 차례가 있는지 본다(기존 control-sync-wiring.test.ts와 같은 방식).
// 이 시험은 구현 a4cfd9e46에서도 통과한다(조립은 있었고 배포 값·메시 허용 목록이 빠졌던 것이 IR-01 ①·②다).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const SOURCE = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
/** 주석을 뺀 코드(주석에 이름이 있어도 통과하지 않게) */
const CODE = SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

describe('F-05-3 IR-01 우선 구매 권리 대조 시작 조립', () => {
  test('IR-01 ③ start.ts가 PEAKET_QUEUE_GRPC_ADDR로 GrpcQueuePriorityGrants와 PriorityGrantSync를 조립하고, 값이 없으면 local·ci·demo는 끄고 그 밖은 시작을 세운다', () => {
    expect(CODE).toContain('env.PEAKET_QUEUE_GRPC_ADDR');
    expect(CODE).toContain('new GrpcQueuePriorityGrants(queueGrpcAddr)');
    expect(CODE).toContain('new PriorityGrantSync({ grants: priority.grants, copies: priorityCopies');
    expect(CODE).toContain('prioritySync?.start()');
    expect(CODE).toContain("envName === 'local' || envName === 'ci' || envName === 'demo'");
    expect(CODE).toContain('PEAKET_QUEUE_GRPC_ADDR가 없어 우선 구매 권리 상태 대조를 끈다');
    expect(CODE).toContain('PEAKET_QUEUE_GRPC_ADDR가 없다(우선 구매 권리 상태 대조, 운영 필수)');
    expect(CODE).toContain('prioritySync?.stop()');
    expect(CODE).toContain('priorityCopies?.close()');
  });
});
