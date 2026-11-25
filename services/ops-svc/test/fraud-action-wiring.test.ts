// F-04-13 구현 리뷰 IR-01·IR-02: 운영 조립이 승인자·이용 제한·라벨·사본·우선 구매·알림 수신자를 실제 어댑터로 붙이는지 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = () => readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

describe('F-04-13 운영 조립(IR-01·IR-02)', () => {
  test('IR-01 fraudApproverIdentity·fraudRestrictions를 시작 조립에 넘긴다', () => {
    const text = source();
    expect(text).toMatch(/fraudApproverIdentity/);
    expect(text).toMatch(/fraudRestrictions/);
    expect(text).toMatch(/GrpcFraudRestrictions/);
    expect(text).toMatch(/AuditFraudApproverIdentity|FraudApproverIdentity/);
  });

  test('IR-02 라벨·사본·우선 구매·승인자 목록을 시작 조립에 넘긴다', () => {
    const text = source();
    expect(text).toMatch(/GrpcFraudLabels/);
    expect(text).toMatch(/fraudCopies/);
    expect(text).toMatch(/fraudPriority/);
    expect(text).toMatch(/fraudApproverDirectory/);
    expect(text).toMatch(/GrpcFraudAppealCopies|HttpFraudAppealCopies/);
  });
});
