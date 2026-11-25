// F-04-13 ticket-svc 마이그레이션 0022의 정적 검사(동결 로컬, LCH-270·LCH-280, FX-T15).
// lane3 F-05-12가 0021_booth_reissue_and_seat_label.sql을 쓰므로 이 기능은 0022_fraud_lock_sweep.sql을 쓴다(MIG-01).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = () => readFileSync(new URL('../migrations/0022_fraud_lock_sweep.sql', import.meta.url), 'utf8');

describe('F-04-13 ticket-svc 마이그레이션 0022', () => {
  test('FX-T15 ⑱ [ASVS v5.0.0-15.4.2] 마이그레이션 0022는 잠금 만료 정비 인덱스를 만든다', () => {
    const text = sql();
    expect(text).toMatch(/CREATE INDEX IF NOT EXISTS fraud_transfer_lock_expires_idx/i);
    expect(text).toMatch(/ON fraud_transfer_lock \(expires_at\)/i);
    expect(text).toMatch(/WHERE locked/i);
    expect(text).toMatch(/CREATE INDEX IF NOT EXISTS ticket_fraud_lock_idx/i);
    expect(text).toMatch(/ON ticket \(event_id, payer_account_id\)/i);
    expect(text).toMatch(/WHERE fraud_lock_case_id IS NOT NULL/i);
  });
});
