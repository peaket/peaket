'use client';
// 내 순번 다시 계산을 Worker로 돌리고, 진행률을 글로 바꾸고, 취소하면 Worker를 끝낸다. Worker를 만들 수 없는 브라우저에서는 같은 함수를 화면 쪽에서 돌린다.
// 파일은 화면 쪽 fetch로 받아 넘긴다(Worker의 요청에는 페이지 CSP의 connect-src가 걸리지 않는다, docs/frontend.md §5.14.1).
import type { ProofDto } from './proof-view.ts';
import { type VerifyDeps, type VerifyOutcome, type VerifyProgress, verifyToken } from './verify-flow.ts';

const progressText = (p: VerifyProgress): string => (p.phase === 'files' ? `결과 파일을 받는 중입니다 (${p.done.toLocaleString('en-US')}/${p.total.toLocaleString('en-US')}개)` : '머클 루트와 순서를 다시 계산하는 중입니다');

const aborted = (): DOMException => new DOMException('취소했습니다', 'AbortError');

// 게시 전에 받은 404가 브라우저 캐시에 남지 않게 다시 묻는다
const request = (url: string, signal?: AbortSignal): Promise<Response> => fetch(url, { cache: 'no-cache', credentials: 'omit', ...(signal ? { signal } : {}) });

const fetchFile: VerifyDeps['fetchFile'] = async (url) => {
  const res = await request(url);
  return res.status === 200 ? { status: 200, body: (await res.json()) as unknown } : { status: res.status };
};

interface FromWorker {
  fetch?: { id: number; url: string };
  progress?: VerifyProgress;
  outcome?: VerifyOutcome;
  failed?: boolean;
}

export async function runVerification(api: ProofDto, tokenHash: string, filesOrigin: string, ctx: { signal: AbortSignal; onProgress: (text: string) => void }): Promise<VerifyOutcome> {
  if (ctx.signal.aborted) throw aborted();
  let worker: Worker | null = null;
  try {
    worker = typeof Worker === 'undefined' ? null : new Worker(new URL('../workers/recompute.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  if (!worker) return verifyToken(api, tokenHash, { filesOrigin, fetchFile, signal: ctx.signal, onProgress: (p) => ctx.onProgress(progressText(p)) });
  const w = worker;
  const reply = async ({ id, url }: { id: number; url: string }): Promise<void> => {
    try {
      const res = await request(url, ctx.signal);
      if (res.status !== 200) {
        w.postMessage({ fetched: { id, status: res.status } });
        return;
      }
      const buffer = await res.arrayBuffer();
      w.postMessage({ fetched: { id, status: 200, buffer } }, [buffer]);
    } catch {
      // 망 오류는 파일을 받지 못한 것으로 넘긴다(취소면 Worker가 이미 끝났다)
      w.postMessage({ fetched: { id, status: 0 } });
    }
  };
  return new Promise<VerifyOutcome>((resolve, reject) => {
    ctx.signal.addEventListener('abort', () => {
      w.terminate();
      reject(aborted());
    });
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      if (e.data.fetch) void reply(e.data.fetch);
      if (e.data.progress) ctx.onProgress(progressText(e.data.progress));
      if (e.data.outcome) {
        w.terminate();
        resolve(e.data.outcome);
      }
      if (e.data.failed) {
        w.terminate();
        reject(new Error('다시 계산하지 못했습니다'));
      }
    };
    w.onerror = () => {
      w.terminate();
      reject(new Error('다시 계산하지 못했습니다'));
    };
    w.postMessage({ start: { api, tokenHash, filesOrigin } });
  });
}
