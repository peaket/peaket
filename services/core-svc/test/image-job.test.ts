// F-10-2 이미지 작업 원장의 상태 전이와 표 모양(계획 docs/review/plans/F-10-2.md §3·§5·§7,
// docs/data.md §2 image_job, HOT-200, ADR-0148 결정 8, ADR-0257 결정 2).
// 시험 먼저: 구현 전에는 모듈이 없어 이 파일이 실패한다(ADR-0372). 값은 계획·정본에서 가져오고 코드 상수를 쓰지 않는다.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';

const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
const now = new Date('2026-11-26T01:00:00.000Z');
let imageJob: Record<string, unknown> = {};
let startFailure: string | undefined;

beforeAll(async () => {
  try {
    // @ts-ignore 구현 전에는 이 모듈이 없다(시험 먼저, ADR-0372)
    imageJob = (await import('../src/modules/catalog/domain/image-job.js')) as Record<string, unknown>;
  } catch (e) {
    startFailure = e instanceof Error ? e.message : String(e);
  }
});

type Next = (input: { status: string; attempts: number; outcome: string; now: Date }) => {
  status: string;
  attempts: number;
  nextAttemptAt?: Date;
  resultStatus?: string;
};

const next = (): Next => {
  if (startFailure) throw new Error(startFailure);
  const fn = imageJob.nextImageJobState;
  expect(typeof fn).toBe('function');
  return fn as Next;
};

describe('F-10-2 이미지 작업 상태', () => {
  test('F-10-2 이미지 작업 상태: ACCEPTED는 DONE, SCAN_PENDING은 60초 뒤 RETRYING, 무응답은 5초 뒤 RETRYING, 10회면 DEAD다 [ASVS v5.0.0-16.5.3]', () => {
    const accepted = next()({ status: 'SCANNING', attempts: 1, outcome: 'ACCEPTED', now });
    expect(accepted).toMatchObject({ status: 'DONE', attempts: 1, resultStatus: 'ACCEPTED' });
    expect(accepted.nextAttemptAt).toBeUndefined();
    const rejected = next()({ status: 'SCANNING', attempts: 1, outcome: 'REJECTED', now });
    expect(rejected).toMatchObject({ status: 'DONE', attempts: 1, resultStatus: 'REJECTED' });
    expect(rejected.nextAttemptAt).toBeUndefined();
    const pending = next()({ status: 'SCANNING', attempts: 1, outcome: 'SCAN_PENDING', now });
    expect(pending.status).toBe('RETRYING');
    expect(pending.attempts).toBe(2);
    expect(pending.nextAttemptAt?.getTime()).toBe(now.getTime() + 60_000);
    const down = next()({ status: 'SCANNING', attempts: 1, outcome: 'UNAVAILABLE', now });
    expect(down.status).toBe('RETRYING');
    expect(down.attempts).toBe(2);
    expect(down.nextAttemptAt?.getTime()).toBe(now.getTime() + 5_000);
    // 열 번을 넘으면 더 맡기지 않는다(요청은 503, fail-closed). 무응답도 같은 상한이다.
    const scanDead = next()({ status: 'SCANNING', attempts: 10, outcome: 'SCAN_PENDING', now });
    expect(scanDead).toMatchObject({ status: 'DEAD', attempts: 10 });
    expect(scanDead.nextAttemptAt).toBeUndefined();
    expect(next()({ status: 'SCANNING', attempts: 9, outcome: 'SCAN_PENDING', now })).toMatchObject({ status: 'RETRYING', attempts: 10 });
    const downDead = next()({ status: 'SCANNING', attempts: 10, outcome: 'UNAVAILABLE', now });
    expect(downDead).toMatchObject({ status: 'DEAD', attempts: 10 });
    expect(downDead.nextAttemptAt).toBeUndefined();
    // 정리 작업은 지운 뒤 DONE·DELETED다
    expect(next()({ status: 'SCANNING', attempts: 1, outcome: 'CLEANUP_DONE', now })).toMatchObject({ status: 'DONE', attempts: 1, resultStatus: 'DELETED' });
  });

  test('F-10-2 이미지 작업 표는 0050에 source_key 유일·상태 검사·집기 인덱스를 둔다', () => {
    const file = `${dir}0050_image_job.sql`;
    expect(existsSync(file)).toBe(true);
    const sql = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    expect(sql).toMatch(/create table (?:if not exists )?"?image_job"?/i);
    for (const column of ['"id" uuid primary key', '"source_key" text not null', '"kind" text not null', '"status" text default \'pending\' not null', '"attempts" integer default 0 not null', '"next_attempt_at" timestamp with time zone', '"lease_until" timestamp with time zone', '"result_status" text', '"width" integer', '"height" integer', '"derivative_keys" jsonb', '"reject_reason" text', '"created_at" timestamp with time zone not null', '"updated_at" timestamp with time zone not null']) {
      expect(sql.toLowerCase(), `칸 ${column}`).toContain(column);
    }
    expect(sql).toMatch(/unique[^;]*source_key|source_key[^;]*unique/i);
    expect(sql).toMatch(/status[^;]*in \('PENDING', 'SCANNING', 'RETRYING', 'DONE', 'DEAD'\)/i);
    expect(sql).toMatch(/kind[^;]*in \('PRODUCTION', 'HOME_BANNER', 'REVIEW_PHOTO', 'CLEANUP'\)/i);
    expect(sql).toMatch(/result_status[^;]*in \('ACCEPTED', 'REJECTED', 'DELETED'\)/i);
    expect(sql).toMatch(/attempts[^;]*>= 0/i);
    expect(sql).toMatch(/create (?:unique )?index[^;]*image_job[^;]*next_attempt_at/i);
    expect(sql).toMatch(/grant select, insert, update, delete on "?image_job"? to core_app/i);
  });
});
