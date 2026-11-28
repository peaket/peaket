// F-06-1 N-T23 ⑤: POL-034 흡수 계정 이메일 계약(2026-11-28 소유자 결정)의 정적 대조.
// identity는 주소를 저장하지 않고 병합 트랜잭션 안 gRPC 요청으로만 넘긴다. Kafka에도 주소가 없다.
// 보관 표·암호화·TTL·키가 없어야 하고, gRPC 실패는 `merge_notice_failed` 지표로만 남긴다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const readRepo = (p: string): string => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');
const repoPath = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

describe('N-T23 POL-034 흡수 계정 이메일 계약', () => {
  test('N-T23 ⑤ gRPC 요청에만 주소를 싣고 identity는 저장하지 않는다. 보관 표·키·TTL이 없고 실패는 지표로만 남긴다 [ASVS v5.0.0-6.8.1] [ASVS v5.0.0-14.3.2]', () => {
    const core = readRepo('docs/api/proto/peaket/core/v1/core.proto');
    expect(core).toContain('service MergeNoticeService');
    expect(core).toContain('rpc SendAbsorbedNotice(');
    expect(core).toMatch(/message SendAbsorbedNoticeRequest \{[\s\S]*string merge_id = 1;[\s\S]*string absorbed_account_id = 2;[\s\S]*string absorbed_email = 3;/);
    expect(core).toMatch(/message SendAbsorbedNoticeResponse \{[\s\S]*bool accepted = 1;/);
    expect(core).not.toContain('FetchAbsorbedEmail');
    expect(core).not.toContain('expires_at');

    const confirmMerge = readRepo('services/identity-svc/src/modules/session/application/confirm-merge.ts');
    expect(confirmMerge).toMatch(/sendAbsorbedNotice|mergeNotice\.send/);
    expect(confirmMerge).toContain('merge_notice_failed');
    expect(confirmMerge).not.toContain('account_merge_notice');
    expect(confirmMerge).not.toContain('email_cipher');
    expect(confirmMerge).not.toContain('PEAKET_MERGE_NOTICE_KEY');

    // 저장 표·칸·키·마이그레이션이 없다(identity 저장소 어댑터도 포함)
    expect(existsSync(repoPath('services/identity-svc/migrations/0039_merge_notice.sql'))).toBe(false);
    for (const p of ['services/identity-svc/src/modules/session/adapters/db/drizzle-session-store.ts', 'services/identity-svc/src/modules/session/adapters/memory-session-store.ts']) {
      const store = readRepo(p);
      expect(store).not.toContain('account_merge_notice');
      expect(store).not.toContain('email_cipher');
    }
    expect(readRepo('docs/data.md')).not.toContain('account_merge_notice');
    expect(readRepo('docs/security/data-classification.md')).not.toContain('account_merge_notice');
    expect(readRepo('docs/security/secrets-and-keys.md')).not.toContain('PEAKET_MERGE_NOTICE_KEY');

    // asyncapi components.messages.AccountMerged 전체(채널의 한 줄 참조가 아니다)
    const asyncapi = readRepo('docs/api/asyncapi.yaml');
    const start = asyncapi.indexOf('\n    AccountMerged:\n');
    const end = asyncapi.indexOf('\n    AccountWithdrawn:\n', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const block = asyncapi.slice(start, end);
    expect(block).toContain('required: [mergeId, primaryAccountId, mergedAccountId, confirmedAt]');
    expect(block).not.toContain('email');
    expect(block).not.toContain('phone');
  });
});
