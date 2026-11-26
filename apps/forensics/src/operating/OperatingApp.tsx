// F-04-16 운영 빌드 화면 + F-04-17 재생 연결. 연 길(?case=·?export=)로 원천을 정하고 replay-export를 fetch로만 받는다.
// 정본: docs/features/forensic-replay.md §2.2·§4.2·§6.3·§6.5·§6.8, docs/frontend.md §5.19.
import { useEffect, useState } from 'react';
import { ApiError, OPERATIONS, createApiClient, type Operation, type RequestOptions } from '@peaket/api-client';
import type { OpenTarget, OpenedSource } from '../lib/operating';
import { resolveOpen } from '../lib/operating';
import { decodeArrowIpc } from '../lib/replay/arrow-ipc';
import { prepareReplay, replayScreenState, type ReplaySession } from '../lib/replay/session';
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
import { ReplayMain } from './ReplayMain';

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
  const [session, setSession] = useState<ReplaySession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setFile(null);
    setProblem(null);
    setSession(null);
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

  // 받은 파일을 한 번 해독하고, F-04-16 경계로 원천·규칙을 검증한 뒤 재생 세션을 만든다.
  useEffect(() => {
    if (file === null) {
      setSession(null);
      return;
    }
    const decoded = decodeArrowIpc(file.bytes, file.envelope);
    if (!decoded.ok) {
      setProblem({ kind: 'error', message: decoded.reject.message, retry: false });
      setFile(null);
      setSession(null);
      return;
    }
    const validation = validateDecodedReplay(decoded.file, file.target);
    if (!validation.ok) {
      setProblem({ kind: 'error', message: validation.message, retry: false });
      setFile(null);
      setSession(null);
      return;
    }
    setSession(prepareReplay(decoded.file, validation, file.target));
    return () => setSession(null);
  }, [file]);

  const opened = resolveOpen(search);
  if (!opened.ok) return <ProblemMain problem={{ kind: 'error', message: opened.message, retry: false }} />;

  const view = replayScreenState({ file: file !== null, problem: problem !== null, session });
  return (
    <div className="col" style={{ minHeight: '100vh' }}>
      <OperatingHead target={opened.target} />
      {view === 'problem' && problem ? <ProblemMain problem={problem} /> : null}
      {view === 'receiving' ? file ? <ReadyMain target={file.target} byteLength={file.envelope.byteLength} /> : <ReceivingMain target={opened.target} /> : null}
      {view === 'replay' && session ? <ReplayMain session={session} /> : null}
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
