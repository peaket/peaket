// F-04-16 운영 빌드 화면. 연 길(?case=·?export=)로 원천을 정하고 replay-export를 fetch로만 받는다.
// 정본: docs/features/forensic-replay.md §2.2·§4.2·§6.3·§6.5·§6.8, docs/frontend.md §5.19.
import { useEffect, useState } from 'react';
import { ApiError, OPERATIONS, createApiClient, type Operation, type RequestOptions } from '@peaket/api-client';
import type { OpenTarget, OpenedSource } from '../lib/operating';
import { resolveOpen } from '../lib/operating';
import {
  replayEnvelopeOf,
  replayFileIssue,
  replayFileValidation,
  replayHeadersIssue,
  replayOperation,
  replayProblem,
  type ReplayEnvelope,
  type ReplayFileInput,
  type ReplayProblem,
} from '../lib/replay-export';
import { useSearch } from '../lib/url';
import { OperatingHead } from './OperatingHead';
import { ProblemMain } from './ProblemMain';
import { ReadyMain } from './ReadyMain';
import { ReceivingMain } from './ReceivingMain';

const OPS_ORIGIN: string =
  import.meta.env.VITE_OPS_API_ORIGIN || (import.meta.env.DEV ? 'http://localhost:8080' : 'https://ops-api.peaket.example');

interface Received {
  bytes: Uint8Array;
  envelope: ReplayEnvelope;
  source: OpenedSource;
  target: OpenTarget;
}

export function OperatingApp() {
  const search = useSearch();
  const [file, setFile] = useState<Received | null>(null);
  const [problem, setProblem] = useState<ReplayProblem | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFile(null);
    setProblem(null);
    const opened = resolveOpen(search);
    if (!opened.ok) {
      setProblem({ kind: 'error', message: opened.message, retry: false });
      return () => {
        controller.abort();
        setFile(null);
      };
    }
    const target = opened.target;
    const op = replayOperation(target);
    const api = createApiClient({ baseUrls: { 'ops-api': OPS_ORIGIN } });
    const raw = { request: (operation: Operation, options: RequestOptions) => api.send(operation, options) };

    raw
      .request(OPERATIONS[op.operationId], { params: op.params, query: op.query, signal: controller.signal })
      .then(async (response) => {
        const issue = replayHeadersIssue(response.status, response.headers);
        if (issue) throw new Error(issue);
        const bytes = new Uint8Array(await (response.data as Blob).arrayBuffer());
        const envelope = replayEnvelopeOf(bytes);
        const fileIssue = replayFileIssue(envelope);
        if (fileIssue) throw new Error(fileIssue);
        setFile({ bytes, envelope, source: target.source, target });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError) setProblem(replayProblem(err.status, err.type, target.source));
        else setProblem({ kind: 'error', message: err instanceof Error ? err.message : '기록을 받지 못했습니다', retry: false });
      });

    return () => {
      controller.abort();
      setFile(null);
    };
  }, [search]);

  const opened = resolveOpen(search);
  if (!opened.ok) return <ProblemMain problem={{ kind: 'error', message: opened.message, retry: false }} />;
  return (
    <div className="col" style={{ minHeight: '100vh' }}>
      <OperatingHead target={opened.target} />
      {problem ? <ProblemMain problem={problem} /> : null}
      {!problem && !file ? <ReceivingMain target={opened.target} /> : null}
      {!problem && file ? <ReadyMain target={file.target} byteLength={file.envelope.byteLength} /> : null}
    </div>
  );
}

/**
 * F-04-17이 Arrow 열을 해독해 넘길 때 쓰는 경계. F-04-16은 봉투·원천 대조까지 받고,
 * 해독 결과가 오면 이 함수가 `replayFileValidation`으로 스키마·원천을 다시 본다.
 */
export function validateDecodedReplay(file: ReplayFileInput, target: OpenTarget) {
  return replayFileValidation(file, target);
}
