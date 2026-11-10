// seatmap-worker의 작업 스레드 하나(해석 하나, ADR-0257 결정 5). 다 실린 뒤 'ready'를 알리고, 받은 파일 하나를 해석해 답한 뒤 끝난다.
// 시간 상한(5초 [가정])은 부모가 'ready' 뒤부터 재고 넘으면 이 스레드를 끝낸다. 힙 상한은 부모가 스레드를 만들 때 건다.
import { parentPort } from 'node:worker_threads';
import type { SeatmapFormat } from '../modules/catalog/domain/seatmap-import.js';
import { parseSeatmapFile, toReply } from './parse.js';

export interface ThreadRequest {
  file: ArrayBuffer;
  format: SeatmapFormat;
}

export type ThreadReply =
  | { kind: 'ready' }
  | { kind: 'result'; status: 'PARSED'; layoutJson: string; errors: { line: number; field: string; code: string }[]; ignored: string[]; seats: number; sections: number }
  | { kind: 'result'; status: 'REJECTED'; errors: { line: number; field: string; code: string }[]; ignored: string[] }
  | { kind: 'failed' };

const port = parentPort;
if (port) {
  port.once('message', (m: ThreadRequest) => {
    let reply: ThreadReply;
    try {
      reply = { kind: 'result', ...toReply(parseSeatmapFile(new Uint8Array(m.file), m.format)) };
    } catch {
      // 예상 밖 오류의 글은 싣지 않는다(파일 내용이 섞일 수 있다)
      reply = { kind: 'failed' };
    }
    port.postMessage(reply);
  });
  port.postMessage({ kind: 'ready' } satisfies ThreadReply);
}
