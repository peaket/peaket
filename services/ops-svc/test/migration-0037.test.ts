// F-04-13 마이그레이션 0037의 정적 검사(동결 로컬, LCH-270·LCH-280, FX-T12).
// 정본: docs/data.md approval_summary_view·booking_restriction, docs/features/forensic-replay.md §6.7.5.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const sql = () => readFileSync(new URL('../migrations/0037_fraud_action.sql', import.meta.url), 'utf8');

describe('F-04-13 마이그레이션 0037', () => {
  test('FX-T12 67 [ASVS v5.0.0-2.1.2] 마이그레이션 0037은 approval_summary_view와 booking_restriction을 만든다', () => {
    const text = sql();
    expect(text).toMatch(/CREATE TABLE IF NOT EXISTS approval_summary_view/i);
    expect(text).toMatch(/approval_id uuid NOT NULL REFERENCES approval_request\(id\)/i);
    expect(text).toMatch(/admin_account_id uuid NOT NULL/i);
    expect(text).toMatch(/first_viewed_at timestamptz NOT NULL/i);
    expect(text).toMatch(/PRIMARY KEY \(approval_id, admin_account_id\)/i);
    expect(text).toMatch(/CREATE TABLE IF NOT EXISTS booking_restriction/i);
    expect(text).toMatch(/account_id uuid NOT NULL/i);
    expect(text).toMatch(/reason_code text NOT NULL/i);
    expect(text).toMatch(/reason_code IN \([^)]*'FRAUD'/i);
    expect(text).toMatch(/fraud_case_id uuid/i);
    expect(text).toMatch(/confirmed_by uuid/i);
    expect(text).toMatch(/starts_at timestamptz NOT NULL/i);
    expect(text).toMatch(/ends_at timestamptz NOT NULL/i);
    expect(text).toMatch(/appeal_due_at timestamptz NOT NULL/i);
    expect(text).toMatch(/status text NOT NULL/i);
    expect(text).toMatch(/CHECK \(status IN \('ACTIVE', 'LIFTED', 'EXPIRED'\)\)/i);
    expect(text).toMatch(/version bigint NOT NULL/i);
    expect(text).toMatch(/CREATE INDEX IF NOT EXISTS booking_restriction_account_status_idx/i);
    expect(text).toMatch(/\(account_id, status\)/i);
    expect(text).toMatch(/CREATE INDEX IF NOT EXISTS booking_restriction_case_idx/i);
    expect(text).toMatch(/\(fraud_case_id\)/i);
    expect(text).toMatch(/GRANT (SELECT, INSERT, UPDATE|ALL) ON approval_summary_view TO ops_app/i);
    expect(text).toMatch(/GRANT (SELECT, INSERT, UPDATE|ALL) ON booking_restriction TO ops_app/i);
  });
});
