// F-06-1 N-T23 ③: POL-034 계정 병합의 흡수 계정 이메일 완료 통지(2026-11-28 소유자 결정).
// identity는 주소를 저장하지 않고 병합 트랜잭션 안 gRPC 요청으로만 넘긴다. notify는 메모리 inbox에 둔 주소로
// ACCOUNT_MERGED_ABSORBED 작업 하나를 보내고, identity에 다시 묻지 않는다(재조회 없음).
// 정본: docs/features/identity.md §2.1·§22, docs/features/notify.md §4.1·§12·§16, POL-034.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  FakeMailTransport,
  FakePushTransport,
  FanNotificationWorker,
  MailTransportError,
  MemoryFanNotifyStore,
  NotificationIntake,
  type NotificationJob,
  type Recipient,
  type RecipientDirectory,
} from '../src/modules/notify/index.js';
import { NOW_MS } from './support.js';
import { OPTOUT_KEY, vapidKeys } from './fan-notify-support.js';

/** 프로세스 안의 흡수 계정 주소 inbox(디스크·DB·로그 없음). 계획 §4 `AbsorbedNoticeInbox`와 같은 모양 */
interface AbsorbedNoticeInboxPort {
  put(dedupKey: string, email: string): void;
  get(dedupKey: string): string | undefined;
  delete(dedupKey: string): void;
}

class MemoryAbsorbedInbox implements AbsorbedNoticeInboxPort {
  readonly rows = new Map<string, string>();
  put(dedupKey: string, email: string) {
    this.rows.set(dedupKey, email);
  }
  get(dedupKey: string) {
    return this.rows.get(dedupKey);
  }
  delete(dedupKey: string) {
    this.rows.delete(dedupKey);
  }
}

type AbsorbedInput = { mergeId: string; absorbedAccountId: string; absorbedEmail: string };
type AbsorbedIntake = NotificationIntake & { accountMergedAbsorbed?: (i: AbsorbedInput) => Promise<{ created: number; duplicate: number }> };

/** identity BatchGetRecipients 대역. 부른 횟수를 세어 흡수 계정 재조회가 없음을 본다 */
class RecordingRecipients implements RecipientDirectory {
  readonly rows = new Map<string, Recipient>();
  readonly calls: { ids: readonly string[]; includeEmail: boolean; includePhone: boolean | undefined }[] = [];
  async getMany(accountIds: readonly string[], includeEmail: boolean, includePhone?: boolean): Promise<Recipient[]> {
    this.calls.push({ ids: [...accountIds], includeEmail, includePhone });
    return accountIds.map((accountId) => {
      const r = this.rows.get(accountId);
      if (!r) return { accountId, status: 'NOT_FOUND', verified: false, locale: 'ko', ...(includeEmail ? { email: null } : {}) };
      return { ...r, ...(includeEmail ? { email: r.email ?? null } : {}) };
    });
  }
}

const harness = () => {
  const clock = fakeClock({ now: NOW_MS });
  const store = new MemoryFanNotifyStore();
  const mail = new FakeMailTransport();
  const push = new FakePushTransport();
  const recipients = new RecordingRecipients();
  const inbox = new MemoryAbsorbedInbox();
  const logs: string[] = [];
  // 새 칸(absorbedNotices)이 생겨도 기준 트리 타입 검사가 막지 않게 변수로 넘긴다
  const intakeDeps = { store, clock, optOutKey: OPTOUT_KEY, absorbedNotices: inbox };
  const intake = new NotificationIntake(intakeDeps);
  const workerDeps = { store, mail, push, recipients, clock, optOutKey: OPTOUT_KEY, vapid: vapidKeys(), absorbedNotices: inbox, log: (line: Record<string, unknown>) => logs.push(JSON.stringify(line)) };
  const worker = new FanNotificationWorker(workerDeps);
  return { store, mail, push, recipients, inbox, logs, intake, worker, planned: intake as AbsorbedIntake };
};

const job = (o: { mergeId: string; absorbedAccountId: string }): NotificationJob => ({
  dedupKey: `ACCOUNT_MERGED_ABSORBED:${o.mergeId}:${o.absorbedAccountId}:EMAIL`,
  kind: 'ACCOUNT_MERGED_ABSORBED',
  targetId: o.mergeId,
  accountId: o.absorbedAccountId,
  channel: 'EMAIL',
  vars: {},
  status: 'PENDING',
  attempts: 0,
  nextAttemptAt: new Date(NOW_MS),
  leaseUntil: null,
  expiresAt: new Date(NOW_MS + 24 * 60 * 60 * 1000),
  createdAt: new Date(NOW_MS),
});

describe('N-T23 계정 병합 흡수 계정 이메일', () => {
  test('N-T23 ③ gRPC로 받은 주소로 한 번 보내고, 흡수 계정이 MERGED여도 받는 사람 조회 없이 보낸다 [ASVS v5.0.0-6.8.1] [ASVS v5.0.0-14.3.2]', async () => {
    const t = harness();
    const absorbed = randomUUID();
    // 실제 병합 뒤 모양: MERGED이고 이메일·전화번호가 지워졌다
    const mergedRow = { accountId: absorbed, status: 'MERGED' as const, verified: true, locale: 'ko', email: null, phone: null };
    t.recipients.rows.set(absorbed, mergedRow);
    const mergeId = randomUUID();

    expect(typeof t.planned.accountMergedAbsorbed).toBe('function');
    if (typeof t.planned.accountMergedAbsorbed !== 'function') return;
    const created = await t.planned.accountMergedAbsorbed({ mergeId, absorbedAccountId: absorbed, absorbedEmail: 'absorbed@example.com' });
    expect(created).toEqual({ created: 1, duplicate: 0 });

    const key = `ACCOUNT_MERGED_ABSORBED:${mergeId}:${absorbed}:EMAIL`;
    expect(t.store.jobs.has(key)).toBe(true);
    expect(t.inbox.rows.get(key)).toBe('absorbed@example.com');
    expect(JSON.stringify([...t.store.jobs.values()])).not.toContain('absorbed@example.com');

    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, sent: 1, failed: 0, dead: 0 });
    expect(t.mail.sent).toHaveLength(1);
    expect(t.mail.sent[0]).toMatchObject({ to: 'absorbed@example.com', subject: '계정을 합쳤습니다' });
    expect(t.mail.sent[0]!.headers['list-unsubscribe']).toBeUndefined();
    expect(t.recipients.calls).toEqual([]); // identity 재조회 없음
    expect(t.inbox.rows.size).toBe(0);
    expect(t.store.deliveries[0]).toMatchObject({ channel: 'EMAIL', status: 'SENT', accountId: absorbed });

    for (const text of [JSON.stringify([...t.store.jobs.values()]), JSON.stringify(t.store.deliveries), t.logs.join('\n')]) {
      expect(text).not.toContain('absorbed@example.com');
    }

    // 같은 gRPC가 다시 와도 작업은 하나다
    expect(await t.planned.accountMergedAbsorbed({ mergeId, absorbedAccountId: absorbed, absorbedEmail: 'absorbed@example.com' })).toEqual({ created: 0, duplicate: 1 });
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 0 });
    expect(t.mail.sent).toHaveLength(1);

    // 발송 실패 로그에도 주소가 없다(재시도 로그는 중복 키만 남긴다)
    const failMerge = randomUUID();
    expect(await t.planned.accountMergedAbsorbed({ mergeId: failMerge, absorbedAccountId: absorbed, absorbedEmail: 'fail@example.com' })).toEqual({ created: 1, duplicate: 0 });
    t.mail.fail.push(new MailTransportError('RETRYABLE', '503', 503));
    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, retrying: 1 });
    expect(t.logs.join('\n')).not.toContain('fail@example.com');
  });

  test('N-T23 ③ 전달된 주소가 없는 작업은 identity 재조회 없이 FAILED다', async () => {
    const t = harness();
    const absorbed = randomUUID();
    const mergedRow = { accountId: absorbed, status: 'MERGED' as const, verified: true, locale: 'ko', email: null, phone: null };
    t.recipients.rows.set(absorbed, mergedRow);
    const mergeId = randomUUID();
    await t.store.enqueue(job({ mergeId, absorbedAccountId: absorbed }), new Date(NOW_MS));

    expect(await t.worker.processDue(new Date(NOW_MS))).toMatchObject({ attempted: 1, sent: 0, failed: 1, retrying: 0 });
    expect(t.mail.sent).toHaveLength(0);
    expect(t.recipients.calls).toEqual([]); // 주소를 다시 묻지 않는다
    expect(t.store.deliveries[0]).toMatchObject({ channel: 'EMAIL', status: 'FAILED' });
    expect(t.logs.join('\n')).not.toContain('absorbed@example.com');
  });
});
