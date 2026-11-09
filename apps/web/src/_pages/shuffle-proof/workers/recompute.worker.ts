// 내 순번 다시 계산 Worker(ADR-0232 결정 9, CSP worker-src 'self'). 큰 회차의 정렬·해시 계산이 화면을 막지 않게 따로 돈다. 취소는 부르는 쪽이 terminate한다.
// 파일은 직접 받지 않고 화면 쪽에 맡긴다(페이지 CSP의 connect-src 안에 두려는 것이다, createWorkerFetch).
import type { ProofDto } from '../model/proof-view.ts';
import { createWorkerFetch, verifyToken } from '../model/verify-flow.ts';

interface Start {
  start: { api: ProofDto; tokenHash: string; filesOrigin: string };
}
interface Fetched {
  fetched: { id: number; status: number; buffer?: ArrayBuffer };
}

const scope = globalThis as unknown as { onmessage: ((e: { data: Start | Fetched }) => void) | null; postMessage(m: unknown): void };
const files = createWorkerFetch((m) => scope.postMessage(m));

scope.onmessage = (e) => {
  if ('fetched' in e.data) {
    files.receive(e.data.fetched);
    return;
  }
  const { api, tokenHash, filesOrigin } = e.data.start;
  void verifyToken(api, tokenHash, {
    filesOrigin,
    fetchFile: files.fetchFile,
    onProgress: (progress) => scope.postMessage({ progress }),
  }).then(
    (outcome) => scope.postMessage({ outcome }),
    () => scope.postMessage({ failed: true }),
  );
};
