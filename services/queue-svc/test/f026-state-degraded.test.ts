// F-02-6(동결 로컬) 명령 6 상태 조회 Degraded: queue-svc notice의 stateDegraded 쓰기 계약.
// 구현 전 트리에서 의미 있게 실패한다(새 종류·칸이 없어 QueueNoticeRejected).
// 정본: docs/features/control-tower.md §3 명령 6, §5 '제어 상태', docs/features/queue-admission.md §4 '폴링 힌트',
// docs/data.md §3 q:{event:E}:notice, ADR-0223 결정 8, ADR-0365 결정 2·6.
// 수치 주장 없음: 이 파일은 처리량·인원·K1/K2/K7 수치를 새로 주장하지 않는다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryQueueNotices } from '../src/modules/sale/adapters/memory-queue-notices.js';
import { SetQueueNotice } from '../src/modules/sale/application/set-queue-notice.js';
import { QUEUE_NOTICE_FIELDS, QUEUE_NOTICE_KINDS, noticeValueOf, type QueueNoticeKind } from '../src/modules/sale/domain/queue-notice.js';

const STATE_KIND = 'CONTROL_KIND_STATE_DEGRADED' as QueueNoticeKind;
const FIELDS = QUEUE_NOTICE_FIELDS as unknown as Record<string, { value: string; rev: string; cmd: string }>;

describe('F026-STATE 상태 조회 Degraded notice 계약', () => {
  test('F026-STATE ① STATE_DEGRADED는 회차·전체 범위의 notice stateDegraded를 1과 0으로 쓰고 낮은 판은 쓰지 않는다', async () => {
    // 받는 종류·칸 이름
    expect(QUEUE_NOTICE_KINDS).toContain(STATE_KIND);
    expect(FIELDS[STATE_KIND]).toEqual({ value: 'stateDegraded', rev: 'stateDegradedRev', cmd: 'stateDegradedCmd' });
    // 바라는 상태 꼴: {"on": bool}만. 모르는 칸·틀린 꼴은 undefined(받는 층 INVALID_ARGUMENT)
    expect(noticeValueOf(STATE_KIND, '{"on":true}')).toEqual({ value: '1' });
    expect(noticeValueOf(STATE_KIND, '{"on":false}')).toEqual({ value: '0' });
    expect(noticeValueOf(STATE_KIND, '{"on":1}')).toBeUndefined();
    expect(noticeValueOf(STATE_KIND, '{"stateDegraded":true}')).toBeUndefined();

    const notices = new MemoryQueueNotices();
    const set = new SetQueueNotice(notices);
    const platformCommand = randomUUID();
    // 전체 범위 켜기: 판 10
    expect(await set.run({ kind: STATE_KIND, scope: 'PLATFORM', desiredStateJson: '{"on":true}', commandId: platformCommand, version: 10 })).toBe(10);
    expect(notices.written.get('PLATFORM')).toMatchObject({
      stateDegraded: '1',
      stateDegradedRev: '10',
      stateDegradedCmd: platformCommand,
    });
    // 낮은 판 9는 쓰지 않고 지금 판 10을 돌려준다
    expect(await set.run({ kind: STATE_KIND, scope: 'PLATFORM', desiredStateJson: '{"on":false}', commandId: randomUUID(), version: 9 })).toBe(10);
    expect(notices.written.get('PLATFORM')).toMatchObject({ stateDegraded: '1', stateDegradedRev: '10', stateDegradedCmd: platformCommand });
    // 같은 판 10도 쓰지 않는다
    expect(await set.run({ kind: STATE_KIND, scope: 'PLATFORM', desiredStateJson: '{"on":false}', commandId: randomUUID(), version: 10 })).toBe(10);

    // 회차 범위는 회차 키에 따로 쓴다
    const eventId = randomUUID();
    const eventCommand = randomUUID();
    expect(await set.run({ kind: STATE_KIND, scope: eventId, desiredStateJson: '{"on":true}', commandId: eventCommand, version: 11 })).toBe(11);
    expect(notices.written.get(eventId)).toMatchObject({ stateDegraded: '1', stateDegradedRev: '11', stateDegradedCmd: eventCommand });
    // 끄기는 0을 쓴다(칸을 지우지 않는다: 파일 생성이 0을 읽어 힌트를 끈다)
    expect(await set.run({ kind: STATE_KIND, scope: eventId, desiredStateJson: '{"on":false}', commandId: randomUUID(), version: 12 })).toBe(12);
    expect(notices.written.get(eventId)).toMatchObject({ stateDegraded: '0', stateDegradedRev: '12' });
  });

  test('F026-STATE ① STATE_DEGRADED는 회차 범위 글자가 틀리면 아무것도 쓰지 않는다', async () => {
    const notices = new MemoryQueueNotices();
    const set = new SetQueueNotice(notices);
    await expect(
      set.run({ kind: STATE_KIND, scope: 'NOT-A-UUID', desiredStateJson: '{"on":true}', commandId: randomUUID(), version: 1 }),
    ).rejects.toThrow();
    expect(notices.written.size).toBe(0);
  });
});
