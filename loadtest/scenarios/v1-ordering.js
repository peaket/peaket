// F-08-4(MSR-040) 정렬 설정 켬·끔 비교 시나리오. k6에서만 돈다.
//
// 계획: docs/review/plans/F-08-4.md §6.2·§6.3. 정본: queue-admission Q-T1·Q-T23.
// 셀은 ORDERING_CELL(hybrid·fifo·prequeue·none)로 받고, 서버에 심은 회차 설정
// (lobbyShuffle·openBatch)과 같은지 실행 전에 확인한다. `none`은 시험 기준선이며 운영이 아니다.
//
// 두 표본을 한 파일에서 만든다.
//  1) prep: 로비 셔플을 켠 셀은 로비 참가 토큰을 받고(오픈 전), 끈 셀은 사전 검증 토큰만 받는다.
//  2) batch: T=0~T+2초에 사전 검증 토큰 1만 건을 5,000/s로 보내 201(즉시 순번) 또는
//     202 BATCHING(묶음)을 기록한다. 묶음 번호·최종 순번은 게시 뒤 batch-results와
//     shuffle-proof에서 채운다. 5,000/s가 발생기 한계로 무효면 Q-T23은 미측정/부분이다.
//
// 기록(records.ndjson) 한 줄: {type:"ordering_sample", cell, kind, arrivalMs, result, sequence, batch, batchSeq, phase}.
// 환경 값: EVENT_ID ORDERING_CELL USERS LOBBY_RATE BATCH_USERS BATCH_RATE WARM_S MAIN_S
//          (+ v1-common.js의 QUEUE_BASE STATE_BASE RUN_TAG)
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { emit, envInt, envStr, jsonOf, vcall, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const ORDERING_CELL = envStr('ORDERING_CELL', 'hybrid');
const LOBBY_SHUFFLE = envInt('LOBBY_SHUFFLE', ORDERING_CELL === 'hybrid' || ORDERING_CELL === 'prequeue' ? 1 : 0) === 1;
const OPEN_BATCH = envInt('OPEN_BATCH', ORDERING_CELL === 'hybrid' || ORDERING_CELL === 'fifo' ? 1 : 0) === 1;
const USERS = envInt('USERS', 100000);
const LOBBY_RATE = envInt('LOBBY_RATE', 200);
const BATCH_USERS = envInt('BATCH_USERS', 10000);
const BATCH_RATE = envInt('BATCH_RATE', 5000);
const WARM_S = envInt('WARM_S', 10);
const MAIN_S = envInt('MAIN_S', 30);
const QUEUE = envStr('QUEUE_BASE', 'http://bundle.v1.svc.cluster.local:8080');

const batch202 = new Counter('ordering_batch_202');
const batch201 = new Counter('ordering_batch_201');
const windowMiss = new Counter('ordering_window_miss');

const deviceId = (i) => `f084${String(i).padStart(18, '0')}`;
const now = () => Date.now();

/** 로비 참가(오픈 전). 로컬에서는 사람 확인 서버 검증이 없어도 hd 표시로 이어 간다. */
function joinLobby(i, o = {}) {
  const r = vcall(QUEUE, 'POST', `/v1/queues/${EVENT_ID}/lobby-participants`, {
    i,
    route: 'lobby',
    body: JSON.stringify({ deviceId: deviceId(i) }),
    expected: [201, 409, 404],
    phase: o.phase ?? 'prep',
  });
  const body = r.status === 201 ? jsonOf(r) : undefined;
  check(r, { '로비 참가 201/409/404': (x) => [201, 409, 404].includes(x.status) });
  return body?.lobbyToken;
}

/** 사전 검증 토큰. 이미 토큰이 있으면 그대로 쓴다. */
function preverify(i, o = {}) {
  const r = vcall(QUEUE, 'POST', `/v1/queues/${EVENT_ID}/pre-verifications`, {
    i,
    route: 'preverify',
    body: '{}',
    expected: [201],
    phase: o.phase ?? 'prep',
  });
  const body = r.status === 201 ? jsonOf(r) : undefined;
  check(r, { '사전 검증 201': (x) => typeof body?.preverifyToken === 'string' });
  return body?.preverifyToken;
}

export const options = {
  scenarios: {
    prep: {
      executor: 'constant-arrival-rate',
      rate: LOBBY_RATE,
      timeUnit: '1s',
      duration: `${Math.ceil(USERS / LOBBY_RATE)}s`,
      preAllocatedVUs: Math.min(500, Math.max(50, Math.ceil(LOBBY_RATE / 20))),
      maxVUs: Math.min(2000, Math.max(100, Math.ceil(LOBBY_RATE / 5))),
      exec: 'prep',
      tags: { phase: 'prep' },
    },
    batch: {
      executor: 'constant-arrival-rate',
      startTime: `${Math.ceil(USERS / LOBBY_RATE) + WARM_S}s`,
      rate: BATCH_RATE,
      timeUnit: '1s',
      duration: '2s',
      preAllocatedVUs: Math.min(4000, Math.max(200, BATCH_RATE)),
      maxVUs: Math.min(20000, Math.max(1000, BATCH_RATE * 2)),
      exec: 'batch',
      tags: { phase: 'main' },
    },
  },
  thresholds: {
    'ordering_window_miss': ['count>=0'],
    'ordering_batch_201': ['count>=0'],
    'ordering_batch_202': ['count>=0'],
  },
};

const tokens = new Map();

/** 오픈 전 준비: 로비 참가 또는 사전 검증. */
export function prep() {
  const it = exec.scenario.iterationInTest;
  if (it >= USERS) return;
  if (LOBBY_SHUFFLE) joinLobby(it, { phase: 'prep' });
  else {
    const t = preverify(it, { phase: 'prep' });
    if (t) tokens.set(it, t);
  }
}

/** T=0~T+2초 묶음 표본. 201이면 바로 순번, 202면 묶음으로 기록한다. */
export function batch() {
  const it = exec.scenario.iterationInTest;
  if (it >= BATCH_USERS) return;
  const arrivalMs = now() - exec.scenario.startTime;
  if (arrivalMs < 0 || arrivalMs > 2000) {
    windowMiss.add(1);
    return;
  }
  const preverifyToken = tokens.get(it) ?? preverify(it, { phase: 'main' });
  if (!preverifyToken) return;
  const started = now();
  const r = vcall(QUEUE, 'POST', `/v1/queues/${EVENT_ID}/entries`, {
    i: it,
    route: 'entry',
    body: JSON.stringify({ preverifyToken }),
    expected: [201, 202],
    phase: 'main',
  });
  const body = jsonOf(r);
  const sequence = Number.isSafeInteger(body?.seq) ? body.seq : null;
  const batch = r.status === 202 || body?.status === 'BATCHING';
  if (r.status === 201) batch201.add(1);
  if (batch) batch202.add(1);
  emit({
    type: 'ordering_sample',
    cell: ORDERING_CELL,
    lobbyShuffle: LOBBY_SHUFFLE,
    openBatch: OPEN_BATCH,
    kind: 'human',
    arrivalMs,
    result: r.status,
    sequence,
    batch,
    batchSeq: batch ? (body?.batchSeq ?? body?.seq ?? null) : null,
    startedMs: started,
    endedMs: now(),
    // 묶음 번호·최종 순번은 게시 뒤 batch-results/<앞 세 자리>.json과 shuffle-proof에서 채운다.
    batchResultsPath: `/queue/fallback/v1/queues/${EVENT_ID}/batch-results`,
    shuffleProofPath: `/v1/queues/${EVENT_ID}/shuffle-proof`,
  });
}

export function handleSummary(data) {
  return writeSummary(data, MAIN_S);
}
