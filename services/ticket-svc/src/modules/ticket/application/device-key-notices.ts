// 입장 키 알림 보내기 반복(ADR-0363 결정 4, docs/features/notify.md §4.7, docs/data.md device_key_notice, offline-gate §10.1).
// 등록 트랜잭션이 적은 device_key_notice 행을 잡아 core-svc 알림 내부 입구(POST /internal/v1/notify/ticket-events)로 보낸다.
// - 2xx·422면 보낸 것으로 적는다(422는 다시 보내도 같은 답이라 붙잡지 않는다). 그 밖(연결 실패·시간 초과·5xx·401 등)은 1분·5분·30분 [가정] 뒤 다시 보낸다.
// - 알림이 실패해도 등록 응답(201)은 바뀌지 않는다(행은 이미 커밋됐다). core-svc는 noticeId를 중복 키에 넣어 두 번 받아도 작업을 하나만 만든다.
// - 보낸 행은 7일 [가정] 뒤 지운다. 연락처·키 값은 보내지 않는다(계정 ID·티켓 ID·종류·등록 시각만).
import type { Clock } from '@peaket/platform';
import type { DeviceKeyNotice, DeviceKeyNoticeEvent, DeviceKeyNoticeSendResult, DeviceKeyNoticeSink, DeviceKeyNoticeStore } from '../domain/ports.js';

export type { DeviceKeyNoticeEvent, DeviceKeyNoticeSendResult, DeviceKeyNoticeSink } from '../domain/ports.js';

/** 다시 보낼 간격(1분·5분·30분 [가정], 그 뒤는 30분마다). attempts는 이번까지 보낸 횟수다 */
export const DEVICE_KEY_NOTICE_RETRY_MS = [60_000, 300_000, 1_800_000] as const;
export const deviceKeyNoticeRetryDelayMs = (attempts: number): number =>
  DEVICE_KEY_NOTICE_RETRY_MS[Math.max(0, Math.min(DEVICE_KEY_NOTICE_RETRY_MS.length - 1, attempts - 1))]!;
/** 한 번 잡은 행을 다른 파드가 겹쳐 잡지 않게 미는 시간(보내기 시간 상한 2초 [가정]보다 넉넉히) */
export const DEVICE_KEY_NOTICE_LEASE_MS = 60_000;
/** 보낸 행을 지우는 때 7일 [가정](docs/data.md device_key_notice) */
export const DEVICE_KEY_NOTICE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** 반복 간격 5초 [가정](가장 오래된 행 5분 경보보다 충분히 짧다) */
export const DEVICE_KEY_NOTICE_EVERY_MS = 5_000;

export interface DeviceKeyNoticeRunResult {
  readonly attempted: number;
  readonly sent: number;
  readonly retried: number;
  readonly purged: number;
}

export interface DeviceKeyNoticeSenderDeps {
  readonly store: DeviceKeyNoticeStore;
  readonly sink: DeviceKeyNoticeSink;
  readonly clock: Clock;
  /** 한 바퀴에 잡는 행 수(기본 50 [가정]) */
  readonly batch?: number;
  /** 행마다 결과(지표 ticket_device_key_notice_sent_total{result}) */
  readonly observe?: (result: 'sent' | 'retry') => void;
}

export function deviceKeyNoticeEventOf(n: DeviceKeyNotice): DeviceKeyNoticeEvent {
  return { noticeId: n.id, type: n.type, accountId: n.accountId, ticketId: n.ticketId, registeredAtMs: n.registeredAtMs };
}

export class DeviceKeyNoticeSender {
  constructor(private readonly d: DeviceKeyNoticeSenderDeps) {}

  /** 한 바퀴: 보낼 때가 된 행을 잡아 보내고, 결과대로 보냄·다시 보낼 때를 적는다. 보낸 지 7일 지난 행을 지운다 */
  async runOnce(): Promise<DeviceKeyNoticeRunResult> {
    const now = this.d.clock.now();
    const due = await this.d.store.claimDue(now, this.d.batch ?? 50, DEVICE_KEY_NOTICE_LEASE_MS);
    let sent = 0;
    let retried = 0;
    for (const n of due) {
      let r: DeviceKeyNoticeSendResult;
      try {
        r = await this.d.sink.send(deviceKeyNoticeEventOf(n));
      } catch (e) {
        r = { kind: 'retry', reason: e instanceof Error ? e.name : 'unknown' };
      }
      if (r.kind === 'sent') {
        await this.d.store.markSent(n.id, this.d.clock.now());
        sent += 1;
        this.d.observe?.('sent');
      } else {
        await this.d.store.reschedule(n.id, now + deviceKeyNoticeRetryDelayMs(n.attempts));
        retried += 1;
        this.d.observe?.('retry');
      }
    }
    const purged = await this.d.store.purgeSent(now - DEVICE_KEY_NOTICE_RETENTION_MS);
    return { attempted: due.length, sent, retried, purged };
  }

  /** 지표용 밀림(보내지 않은 행 수, 가장 오래된 행의 나이 초) */
  async backlog(): Promise<{ count: number; oldestSeconds: number }> {
    const b = await this.d.store.backlog();
    const oldestSeconds = b.oldestCreatedAtMs === undefined ? 0 : Math.max(0, (this.d.clock.now() - b.oldestCreatedAtMs) / 1000);
    return { count: b.count, oldestSeconds };
  }
}
