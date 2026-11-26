// F-04-18 후보 Worker. 정본: docs/features/forensic-replay.md §3.1·§3.3, 계획 §4.2.
// 메인이 넘긴 열 복사본으로 후보 모델을 계산하고, 응답 배열은 전송 목록으로 돌려준다.
import { candidateModel } from '../lib/replay/candidate.ts';
import {
  candidateDoneBuffers,
  decodeWorkerMessage,
  type CandidateDone,
} from '../lib/replay/chart-runtime.ts';

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent): void => {
  const message = decodeWorkerMessage(event.data);
  if (message === null || message.kind !== 'candidate') return;

  const model = candidateModel(message.columns, message.keep, message.source);
  const sessions = new Uint32Array(model.points.length);
  const points = new Float32Array(model.points.length * 2);
  const bots = new Uint8Array(model.points.length);
  for (let i = 0; i < model.points.length; i += 1) {
    const point = model.points[i];
    sessions[i] = point.session;
    points[i * 2] = point.x;
    points[i * 2 + 1] = point.y;
    bots[i] = point.bot ? 1 : 0;
  }
  const done: CandidateDone = {
    kind: 'candidate-done',
    version: message.version,
    panel: model.kind,
    points,
    sessions,
    bots,
    totalSessions: model.totalSessions,
    totalBots: model.totalBots,
    bursts: [...model.bursts],
    histogram:
      model.histogram === null
        ? null
        : { bins: Uint32Array.from(model.histogram.bins), edges: Float64Array.from(model.histogram.edges) },
  };
  scope.postMessage(done, candidateDoneBuffers(done));
};
