// F-04-18 후보 Worker 연결. 정본: docs/features/forensic-replay.md §3.1·§3.3, 계획 §4.2·§4.4.
// 후보 계산은 복사본을 전송해 Worker에 맡기고, Worker가 없거나 실패하면 같은 순수 함수로 메인에서 계산한다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EventColumns, ForensicSource } from '../lib/forensics/events.ts';
import { candidateModel, type CandidateModel } from '../lib/replay/candidate.ts';
import {
  candidateRequest,
  decodeWorkerMessage,
  type CandidateDone,
} from '../lib/replay/chart-runtime.ts';

function modelFromDone(done: CandidateDone): CandidateModel {
  const points = [];
  for (let i = 0; i < done.sessions.length; i += 1) {
    points.push({
      session: done.sessions[i],
      x: done.points[i * 2],
      y: done.points[i * 2 + 1],
      bot: done.bots[i] === 1,
    });
  }
  const histogram =
    done.histogram === null
      ? null
      : {
          bins: [...done.histogram.bins],
          edges: [...done.histogram.edges],
          minMs: done.histogram.edges[0],
          maxMs: done.histogram.edges[done.histogram.edges.length - 1],
        };
  return {
    kind: done.panel,
    points,
    bursts: done.bursts,
    totalSessions: done.totalSessions,
    totalBots: done.totalBots,
    histogram,
  };
}

export function useCandidateWorker(
  columns: EventColumns,
  keep: Uint8Array,
  source: ForensicSource,
): CandidateModel {
  const fallback = useMemo(() => candidateModel(columns, keep, source), [columns, keep, source]);
  const versionRef = useRef(0);
  const [remote, setRemote] = useState<{ version: number; model: CandidateModel } | null>(null);

  useEffect(() => {
    const version = versionRef.current + 1;
    versionRef.current = version;
    setRemote(null);
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL('../workers/candidate.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return;
    }

    const onMessage = (event: MessageEvent): void => {
      const message = decodeWorkerMessage(event.data);
      if (message === null || message.kind !== 'candidate-done') return;
      if (message.version !== version) return;
      setRemote({ version, model: modelFromDone(message) });
    };
    worker.addEventListener('message', onMessage);

    const { message, transfer } = candidateRequest(version, source, columns, keep);
    try {
      worker.postMessage(message, transfer);
    } catch {
      worker.terminate();
      worker = null;
      return;
    }

    return () => {
      worker?.removeEventListener('message', onMessage);
      worker?.terminate();
    };
  }, [columns, keep, source]);

  return remote !== null && remote.version === versionRef.current ? remote.model : fallback;
}
