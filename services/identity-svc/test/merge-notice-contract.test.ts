// F-06-1 N-T23 ⑤: POL-034 흡수 계정 이메일 계약(2026-11-28 소유자 결정)의 계약·비보관·실패 동작.
// identity는 주소를 저장하지 않고 병합 트랜잭션 안 gRPC 요청으로만 넘긴다. gRPC 실패는 merge_notice_failed만 올리고
// 병합을 막지 않는다. Kafka·표·작업·로그에 주소가 없어야 한다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const readRepo = (p: string): string => readFileSync(fileURLToPath(new URL(`../../../${p}`, import.meta.url)), 'utf8');
const repoPath = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

type AbsorbedInput = { mergeId: string; absorbedAccountId: string; absorbedEmail: string };
type AbsorbedSender = {
  send(input: AbsorbedInput): Promise<boolean>;
  failed(reason: string): void;
};

describe('N-T23 POL-034 흡수 계정 이메일 계약', () => {
  test('N-T23 ⑤ gRPC 요청에만 주소를 싣고 identity는 저장하지 않는다. 실패는 merge_notice_failed만 올리고 병합을 막지 않는다 [ASVS v5.0.0-6.8.1] [ASVS v5.0.0-14.3.2]', async () => {
    const core = readRepo('docs/api/proto/peaket/core/v1/core.proto');
    const serviceStart = core.indexOf('service MergeNoticeService');
    const serviceEnd = core.indexOf('\nservice ', serviceStart + 1);
    expect(serviceStart).toBeGreaterThanOrEqual(0);
    const service = core.slice(serviceStart, serviceEnd === -1 ? core.length : serviceEnd);
    expect(service).toContain('rpc SendAbsorbedNotice(');
    expect(service).not.toContain('expires_at');

    // 요청·응답 블록만 잘라 저장 필드가 없음을 본다(core.proto 전체에는 다른 서비스의 expires_at이 있다)
    const reqStart = core.indexOf('message SendAbsorbedNoticeRequest');
    const reqEnd = core.indexOf('\nmessage ', reqStart + 1);
    expect(reqStart).toBeGreaterThanOrEqual(0);
    const req = core.slice(reqStart, reqEnd === -1 ? core.length : reqEnd);
    expect(req).toMatch(/string merge_id = 1;[\s\S]*string absorbed_account_id = 2;[\s\S]*string absorbed_email = 3;/);
    expect(req.match(/^\s*(string|bool)\s/gm) ?? []).toHaveLength(3);
    expect(req).not.toContain('expires_at');
    expect(req).not.toContain('email_cipher');
    expect(req).not.toContain('created_at');

    const resStart = core.indexOf('message SendAbsorbedNoticeResponse');
    const resEnd = core.indexOf('\nmessage ', resStart + 1);
    expect(resStart).toBeGreaterThanOrEqual(0);
    const res = core.slice(resStart, resEnd === -1 ? core.length : resEnd);
    expect(res).toMatch(/bool accepted = 1;/);
    expect(res).not.toContain('expires_at');

    const confirmMerge = readRepo('services/identity-svc/src/modules/session/application/confirm-merge.ts');
    expect(confirmMerge).toMatch(/sendAbsorbedNoticeOnce/);
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

    // 실패 동작: gRPC 송신기가 던지면 failed('unavailable')만 부르고 false를 돌려준다(병합은 계속)
    const helperUrl = new URL('../../../services/identity-svc/src/modules/session/application/absorbed-notice.ts', import.meta.url).href;
    expect(existsSync(fileURLToPath(helperUrl))).toBe(true);
    if (!existsSync(fileURLToPath(helperUrl))) return;
    const mod = (await import(/* @vite-ignore */ helperUrl)) as { sendAbsorbedNoticeOnce?: (deps: AbsorbedSender, input: AbsorbedInput) => Promise<boolean> };
    expect(typeof mod.sendAbsorbedNoticeOnce).toBe('function');
    if (typeof mod.sendAbsorbedNoticeOnce !== 'function') return;

    const input: AbsorbedInput = { mergeId: '01900000-0000-7000-8000-0000000000b1', absorbedAccountId: '01900000-0000-7000-8000-0000000000a2', absorbedEmail: 'absorbed@example.com' };
    const failures: string[] = [];
    const failed = await mod.sendAbsorbedNoticeOnce({ send: async () => { throw new Error('unavailable'); }, failed: (reason) => failures.push(reason) }, input);
    expect(failed).toBe(false);
    expect(failures).toEqual(['unavailable']);

    const sent: AbsorbedInput[] = [];
    const ok = await mod.sendAbsorbedNoticeOnce({ send: async (i) => { sent.push(i); return true; }, failed: (reason) => failures.push(reason) }, input);
    expect(ok).toBe(true);
    expect(sent).toEqual([input]);
    expect(failures).toEqual(['unavailable']);
  });
});
