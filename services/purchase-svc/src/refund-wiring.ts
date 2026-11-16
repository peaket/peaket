// 환급 실행기의 입장 기록 대조 조립(BAT-420 GAT-090 A6, 빈 뼈대). relay-app.ts·start.ts가 부르고, 시험이 시작 조립 규칙을 따로 띄워 본다
// (architecture §8.6 '자주 놓친 결함': 시작 파일 조립은 시험 조립과 따로).
// ticket-svc 주소(GrpcTicketCancellations)가 있으면 그것을 쓰고, 없으면 local·ci만 대역(모든 표 found 참·entered 거짓)이며 그 밖 환경은 시작 실패다.
import type { EntryRecords } from './modules/refund/index.js';

export function entryRecordsFromEnv(_o: { readonly env: Readonly<Record<string, string | undefined>>; readonly tickets?: EntryRecords }): EntryRecords {
  throw new Error('아직 없음');
}
