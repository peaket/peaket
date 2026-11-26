// F-08-4(MSR-040) 정렬 설정 켬·끔 비교 시나리오. k6에서만 돈다.
//
// 계획: docs/review/plans/F-08-4.md §6.2·§6.3. 정본: queue-admission Q-T1·Q-T23.
// 셀은 ORDERING_CELL(hybrid·fifo·prequeue·none)로 받고, 서버에 심은 회차 설정
// (lobbyShuffle·openBatch)과 같은지 실행 전에 확인한다. `none`은 시험 기준선이며 운영이 아니다.
//
// 두 표본을 한 파일에서 만든다.
//  1) prep: 로비 셔플을 켠 셀은 로비 참가 토큰을 받고(오픈 전, 200/s), 끈 셀은 사전 검증 토큰을
//     측정 전에 파일로 만들어 둔다(TOKENS_FILE). 로비 참가의 tokenHash와 도착 시각을 남겨,
//     측정 도구가 게시된 shuffle-results/{앞 세 자리}.json에서 최종 순번을 채운다.
//  2) batch: T=0~T+2초에 사전 검증 토큰 1만 건을 5,000/s로 보내 201(즉시 순번) 또는
//     202 BATCHING(묶음)을 기록한다. 묶음 번호·최종 순번은 게시 뒤 batch-results와
//     shuffle-proof에서 채운다. 5,000/s가 발생기 한계로 무효면 Q-T23은 미측정/부분이다.
//  3) main(로비 끈 셀): T+2초 뒤 남은 사람들을 2,000/s로 진입시켜 10만 순번 표본을 만든다.
//
// 기록(records.ndjson) 한 줄: {type:"ordering_sample", cell, phase, stage, kind, i, arrivalMs,
//   tokenHash, result, sequence, batch, batchSeq}. 도착 시각은 서버 오픈 시각(OPENS_AT_MS) 기준 ms다.
// 환경 값: EVENT_ID ORDERING_CELL USERS BATCH_USERS BATCH_RATE ENTRY_RATE LOBBY_RATE PREP_MODE
//          MAIN_MODE OPENS_AT_MS WARM_S TOKENS_FILE (+ v1-common.js의 QUEUE_BASE·RUN_TAG·identity)
import exec from 'k6/execution';
import crypto from 'k6/crypto';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { baseOptions } from './common.js';
import { emit, envInt, envStr, jsonOf, markScenarios, vcall, writeSummary } from './v1-common.js';

export { markEnd, markStart } from './v1-common.js';

const EVENT_ID = envStr('EVENT_ID');
const ORDERING_CELL = envStr('ORDERING_CELL', 'hybrid');
const LOBBY_SHUFFLE = envInt('LOBBY_SHUFFLE', ORDERING_CELL === 'hybrid' || ORDERING_CELL === 'prequeue' ? 1 : 0) === 1;
const OPEN_BATCH = envInt('OPEN_BATCH', ORDERING_CELL === 'hybrid' || ORDERING_CELL === 'fifo' ? 1 : 0) === 1;
const USERS = envInt('USERS', 100000);
const BATCH_USERS = envInt('BATCH_USERS', 10000);
const BATCH_RATE = envInt('BATCH_RATE', 5000);
const ENTRY_RATE = envInt('ENTRY_RATE', 2000);
const LOBBY_RATE = envInt('LOBBY_RATE', 200);
const PREP_MODE = envStr('PREP_MODE', LOBBY_SHUFFLE ? 'lobby' : 'none');
const MAIN_MODE = envStr('MAIN_MODE', LOBBY_SHUFFLE ? 'none' : 'entries');
const OPENS_AT_MS = envInt('OPENS_AT_MS');
const WARM_S = envInt('WARM_S', 10);
const QUEUE = envStr('QUEUE_BASE', 'http://bundle.v1.svc.cluster.local:8080');
/** 측정 도구가 측정 전에 만든 사전 검증 토큰 파일(한 줄 = {i, token}). 없으면 묶음 표본을 보내지 못한다 */
const TOKENS_FILE = envStr('TOKENS_FILE', '/work/out/prep.ndjson');

const batch202 = new Counter('ordering_batch_202');
const batch201 = new Counter('ordering_batch_201');
const windowMiss = new Counter('ordering_window_miss');
const noToken = new Counter('ordering_no_token');
const entryFailed = new Counter('ordering_entry_failed');

const tokenRows = new SharedArray('orderingTokens', () => {
  const rows = [];
  for (const line of open(TOKENS_FILE).split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.token === 'string' && Number.isSafeInteger(row.i)) rows.push({ i: row.i, token: row.token });
    } catch {
      // 마지막 줄이 잘렸으면 버린다(토큰 수 검사는 실행 도구가 한다)
    }
  }
  // 토큰 파일은 여러 VU가 만든다. 반복 번호로 사람을 고르므로 사람 번호 순으로 정렬한다
  return rows.sort((a, b) => a.i - b.i);
});

const deviceId = (i) => `f084${String(i).padStart(18, '0')}`;
const now = () => Date.now();
const arrival = () => now() - OPENS_AT_MS;
const tokenHashOf = (token) => crypto.sha256(token, 'hex');

/** 로비 참가(오픈 전). tokenHash로 게시된 shuffle-results에서 최종 순번을 찾는다. */
function joinLobby(i) {
  const r = vcall(QUEUE, 'POST', `/v1/queues/${EVENT_ID}/lobby-participants`, {
    i,
    route: 'lobby',
    body: JSON.stringify({ deviceId: deviceId(i) }),
    expected: [201, 409, 404],
    phase: 'prep',
  });
  const body = r.status === 201 ? jsonOf(r) : undefined;
  const lobbyToken = body?.lobbyToken;
  if (r.status === 201 && typeof lobbyToken !== 'string') check(r, { '로비 참가 201 본문': () => false });
  emit({
    type: 'ordering_sample',
    cell: ORDERING_CELL,
    lobbyShuffle: LOBBY_SHUFFLE,
    openBatch: OPEN_BATCH,
    phase: 'prep',
    stage: 'lobby',
    kind: 'human',
    i,
    arrivalMs: arrival(),
    result: r.status,
    tokenHash: typeof lobbyToken === 'string' ? tokenHashOf(lobbyToken) : null,
    sequence: null,
    batch: false,
    batchSeq: null,
  });
}

/** 사전 검증 토큰 하나로 진입하고 순번·묶음 표시를 남긴다. */
function enter(i, token, stage) {
  const started = now();
  const r = vcall(QUEUE, 'POST', `/v1/queues/${EVENT_ID}/entries`, {
    i,
    route: 'entry',
    body: JSON.stringify({ preverifyToken: token }),
    expected: [201, 202],
    phase: 'main',
  });
  const ended = now();
  const body = jsonOf(r);
  const sequence = Number.isSafeInteger(body?.seq) ? body.seq : null;
  const batch = r.status === 202 || body?.status === 'BATCHING';
  if (r.status === 201) batch201.add(1);
  if (batch) batch202.add(1);
  if (![201, 202].includes(r.status)) entryFailed.add(1);
  emit({
    type: 'ordering_sample',
    cell: ORDERING_CELL,
    lobbyShuffle: LOBBY_SHUFFLE,
    openBatch: OPEN_BATCH,
    phase: 'main',
    stage,
    kind: 'human',
    i,
    arrivalMs: started - OPENS_AT_MS,
    startedMs: started,
    endedMs: ended,
    result: r.status,
    tokenHash: tokenHashOf(token),
    sequence,
    batch,
    batchSeq: batch ? (body?.batchSeq ?? null) : null,
    // 묶음 번호·최종 순번은 게시 뒤 batch-results/<앞 세 자리>.json과 shuffle-proof에서 채운다.
    batchResultsPath: `/queue/fallback/v1/queues/${EVENT_ID}/batch-results`,
    shuffleProofPath: `/v1/queues/${EVENT_ID}/shuffle-proof`,
  });
}

const prepS = PREP_MODE === 'lobby' ? Math.ceil(USERS / LOBBY_RATE) : 0;
const mainDurS = MAIN_MODE === 'entries' ? Math.ceil((USERS - BATCH_USERS) / ENTRY_RATE) : 0;
const openAtS = Math.max(0, (OPENS_AT_MS - now()) / 1000);
// 표시 창은 본구간(묶음 2초 + 남은 진입)에 10초 여유를 더한다. 발생기 cgroup 표본은 창의 양 끝 1초를 빼고 세므로
// 2초 창만 두면 표본이 0개가 된다(2026-11-27 스모크에서 확인)
const mainEndS = openAtS + 2 + mainDurS + 10;
const vu = (rate, factor) => Math.min(2000, Math.max(100, Math.ceil(rate * factor)));

export const options = baseOptions(
  {
    ...(PREP_MODE === 'lobby'
      ? {
          prep: {
            executor: 'constant-arrival-rate',
            rate: LOBBY_RATE,
            timeUnit: '1s',
            duration: `${prepS}s`,
            preAllocatedVUs: vu(LOBBY_RATE, 1),
            maxVUs: vu(LOBBY_RATE, 4),
            exec: 'prep',
            tags: { phase: 'prep' },
          },
        }
      : {}),
    batch: {
      executor: 'constant-arrival-rate',
      rate: BATCH_RATE,
      timeUnit: '1s',
      duration: '2s',
      startTime: `${openAtS}s`,
      preAllocatedVUs: vu(BATCH_RATE, 0.05),
      maxVUs: vu(BATCH_RATE, 0.2),
      exec: 'batch',
      tags: { phase: 'main' },
    },
    ...(MAIN_MODE === 'entries'
      ? {
          main: {
            executor: 'constant-arrival-rate',
            rate: ENTRY_RATE,
            timeUnit: '1s',
            duration: `${mainDurS}s`,
            startTime: `${openAtS + 2}s`,
            preAllocatedVUs: vu(ENTRY_RATE, 0.05),
            maxVUs: vu(ENTRY_RATE, 0.2),
            exec: 'main',
            tags: { phase: 'main' },
          },
        }
      : {}),
    ...markScenarios(openAtS, mainEndS),
  },
  ['lobby', 'entry'],
);
options.thresholds['ordering_window_miss'] = ['count>=0'];
options.thresholds['ordering_no_token'] = ['count>=0'];
options.thresholds['ordering_entry_failed'] = ['count>=0'];
options.thresholds['ordering_batch_201'] = ['count>=0'];
options.thresholds['ordering_batch_202'] = ['count>=0'];

/** 오픈 전 준비: 로비 참가(로비 셀)뿐이다. 로비를 끈 셀의 사전 검증 토큰은 측정 전에 파일로 만든다. */
export function prep() {
  const it = exec.scenario.iterationInTest;
  if (it >= USERS) return;
  joinLobby(it);
}

/** T=0~T+2초 묶음 표본. 201이면 바로 순번, 202면 묶음으로 기록한다. */
export function batch() {
  const it = exec.scenario.iterationInTest;
  if (it >= BATCH_USERS) return;
  const at = arrival();
  if (at < 0 || at > 2000) {
    windowMiss.add(1);
    return;
  }
  const row = tokenRows[it];
  if (!row) {
    noToken.add(1);
    return;
  }
  enter(row.i, row.token, 'batch');
}

/** 오픈 직후 묶음 구간이 지난 뒤 남은 사람들의 진입(로비를 끈 셀). */
export function main() {
  const it = exec.scenario.iterationInTest;
  if (it >= USERS - BATCH_USERS) return;
  const row = tokenRows[BATCH_USERS + it];
  if (!row) {
    noToken.add(1);
    return;
  }
  enter(row.i, row.token, 'main');
}

export function handleSummary(data) {
  // 본구간은 T=0부터 진입이 끝날 때까지다(묶음 2초 + 남은 진입)
  return writeSummary(data, Math.max(1, Math.round(2 + mainDurS + WARM_S * 0)));
}
