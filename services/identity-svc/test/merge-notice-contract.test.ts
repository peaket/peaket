// F-06-1 N-T23 ⑤: POL-034 흡수 계정 이메일 계약의 정적 대조.
// 주소를 Kafka에 싣지 않고, 병합 트랜잭션이 남기는 짧은 암호문 사본을 내부 gRPC로 읽는다(계획 §3.1).
// 구현 동작(암호화·TTL·정비)은 구현 뒤 단위·통합 시험이 본다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const readRepo = (p: string): string => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');

describe('N-T23 POL-034 흡수 계정 이메일 계약', () => {
  test('N-T23 ⑤ 병합 통지 gRPC·암호문 표·키·TTL이 정본에 있고 AccountMerged에는 주소가 없다 [ASVS v5.0.0-6.8.1] [ASVS v5.0.0-14.3.2]', () => {
    const proto = readRepo('docs/api/proto/peaket/identity/v1/identity.proto');
    expect(proto).toContain('service MergeNoticeService');
    expect(proto).toContain('rpc FetchAbsorbedEmail(');
    expect(proto).toMatch(/message FetchAbsorbedEmailRequest \{[\s\S]*string merge_id = 1;/);
    expect(proto).toMatch(/message FetchAbsorbedEmailResponse \{[\s\S]*string email = 1;[\s\S]*string expires_at = 2;/);

    const data = readRepo('docs/data.md');
    expect(data).toContain('account_merge_notice');
    expect(data).toContain('email_cipher');
    expect(data).toContain('expires_at');

    const classification = readRepo('docs/security/data-classification.md');
    expect(classification).toContain('병합 통지');
    expect(classification).toContain('account_merge_notice');

    const secrets = readRepo('docs/security/secrets-and-keys.md');
    expect(secrets).toContain('PEAKET_MERGE_NOTICE_KEY');

    const asyncapi = readRepo('docs/api/asyncapi.yaml');
    const start = asyncapi.indexOf('    AccountMerged:');
    const end = asyncapi.indexOf('    AccountWithdrawn:');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = asyncapi.slice(start, end);
    expect(block).not.toContain('email');
    expect(block).not.toContain('phone');
  });
});
