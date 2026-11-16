// export 저장·원천·재인증 포트. 메모리(단위 시험)와 Drizzle(운영)이 같은 모양을 쓴다.
import type { AttendeeRecord } from '../../shop/index.js';
import type { AttendeeExportRecord, ExportFormat } from './export.js';

/** 명단 보기 한 페이지의 LIST 접속기록(W7-audit A2-19, docs/features/settlement.md §9) */
export interface AttendeeViewRecord {
  /** uuidv7(clock) */
  auditId: string;
  promoterId: string;
  eventId: string;
  actorAccountId: string;
  actorDisplayName: string;
  actorRole: string;
  /** 이 페이지에 보인 행 수(items.length) */
  count: number;
  /** 받은 cursor가 없으면 키를 두지 않는다 */
  filter: { limit: number; cursor?: string };
  createdAt: Date;
  /** 접속지 정보(요청의 클라이언트 IP 원문, 리뷰 R2) → source_ip */
  clientIp: string;
}

/** 이력과 접속기록을 따로 쓰는 길은 두지 않는다(W7-audit A2-19: 접속기록이 실패하면 이력도 남지 않아야 한다) */
export interface AttendeeExportStore {
  /** 내려받기 이력(attendee_export)과 DOWNLOAD 접속기록을 한 트랜잭션에 쓴다. 하나라도 실패하면 둘 다 남지 않고 오류를 던진다 */
  /** 둘째 인자의 접속지는 DOWNLOAD 접속기록에만 쓴다(attendee_export 이력·exportView에는 싣지 않는다, 리뷰 R2) */
  recordExport(record: AttendeeExportRecord, access: { clientIp: string }): Promise<void>;
  /** 명단 보기 LIST 접속기록. 실패하면 오류를 던진다 */
  recordView(view: AttendeeViewRecord): Promise<void>;
  list(promoterId: string, eventId: string, limit: number): Promise<AttendeeExportRecord[]>;
}

/** 명단 원천 한 페이지. nextCursor가 null일 때만 끝이다. items가 limit보다 적거나 0건이어도 nextCursor가 있으면 다음이 있다(W7-audit A2-17) */
export interface AttendeeSourcePage {
  items: AttendeeRecord[];
  nextCursor: string | null;
}

export interface AttendeeSource {
  list(promoterId: string, eventId: string, limit: number, cursor?: string): Promise<AttendeeSourcePage>;
  count(promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }>;
}

export interface PartnerEventLookup {
  /** 소속 파트너의 회차만. 없거나 다른 파트너 회차면 undefined */
  find(promoterId: string, eventId: string): Promise<{ eventId: string; title: string; endsAt: Date } | undefined>;
}

export interface BookersReauth {
  /** 없거나 틀리면 ExportProblem('reauth-required', 403). act는 BOOKER_EXPORT 고정 */
  verify(token: string | undefined, o: { sessionId: string; promoterId: string }): Promise<{ accountId: string; factors: string[] }>;
}

export interface ActorNameResolver {
  displayName(accountId: string): Promise<string | undefined>;
}

export interface ExportFileRequest {
  eventLabel: string;
  format: ExportFormat;
  rows: readonly AttendeeRecord[];
}

export const ATTENDEE_EXPORT_STORE = Symbol.for('peaket.export.store');
export const ATTENDEE_SOURCE = Symbol.for('peaket.export.attendee-source');
export const PARTNER_EVENT_LOOKUP = Symbol.for('peaket.export.event-lookup');
export const BOOKERS_REAUTH = Symbol.for('peaket.export.reauth');
