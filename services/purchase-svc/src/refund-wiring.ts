// 환급 실행기의 입장 기록 대조 조립(BAT-420 GAT-090 A6). relay-app.ts·start.ts가 부르고, 시험이 시작 조립 규칙을 따로 띄워 본다
// (architecture §8.6 '자주 놓친 결함': 시작 파일 조립은 시험 조립과 따로).
// ticket-svc 주소(GrpcTicketCancellations)가 있으면 그것을 쓰고, 없으면 local·ci만 대역(모든 표 found 참·entered 거짓)이며 그 밖 환경은 시작 실패다.
import type { EntryRecords, EntryRecordView } from './modules/refund/index.js';

/** 대역을 받는 환경(ticket-svc 없이 도는 로컬·CI). PEAKET_ENV가 없으면 운영으로 보고 대역을 쓰지 않는다(identity 조립과 같은 fail-closed) */
const STUB_ENVS: ReadonlySet<string> = new Set(['local', 'ci']);

export function entryRecordsFromEnv(o: { readonly env: Readonly<Record<string, string | undefined>>; readonly tickets?: EntryRecords }): EntryRecords {
  if (o.tickets) return o.tickets;
  const envName = o.env.PEAKET_ENV;
  if (envName === undefined || !STUB_ENVS.has(envName)) throw new Error('PEAKET_TICKET_GRPC_ADDR가 없다(마감 뒤 환급 전 입장 기록 대조, 운영 필수)');
  return {
    lookup: async (ticketIds) => new Map<string, EntryRecordView>(ticketIds.map((id) => [id, { found: true, entered: false }])),
  };
}
