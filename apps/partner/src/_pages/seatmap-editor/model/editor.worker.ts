// 좌석맵 에디터 Worker 진입점(ADR-0264 결정 5). 같은 출처 파일이라 CSP worker-src 'self'로 받는다(seat-hold ASVS 3.4.3).
// 계산은 worker-jobs.ts가 하고 여기서는 메시지를 받고 답만 한다. 요청은 동기 계산이라 cancel은 답을 버리는 표시일 뿐이다(받은 쪽이 지난 답을 버린다).
import { runJob } from './worker-jobs.ts';

// 메시지 수신기는 별칭 없이 self.onmessage로 달고, 뿌리 화면 보안 린트의 허용 목록(packages/config/eslint/web-security.mjs)에 까닭과 함께 둔다(ADR-0264 결정 2, ASVS 3.5.5).
// 계산을 마친 답을 보내는 쪽만 형을 적는다(Worker의 self는 DOM Window 형과 다르다).
const post = self as unknown as { postMessage(m: unknown, transfer: Transferable[]): void };

self.onmessage = (e: MessageEvent) => {
  const out = runJob(e.data);
  if (out) post.postMessage(out.reply, out.transfer);
};
