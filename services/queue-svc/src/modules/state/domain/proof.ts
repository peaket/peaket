// 셔플 검증 정보 만들기(POL-005, ADR-0232 결정 8): 공시 기록의 칸을 구간별 값으로 옮긴다. 응답은 계약 QueueShuffleProof다.
// 봉인 값(sealed:{구간})은 응답에 옮기지 않고(칸을 이름으로 골라 옮긴다), 시드는 공개 시각이 지났을 때만 낸다.
import { ALGORITHM, DRAND_CHAIN, drandRoundTimeMs, SEED_REVEAL_AFTER_MS, type ShuffleGroup } from '@peaket/shuffle';

export const RESULT_FILE_COUNT = 16 ** 3;

/** 공시 기록의 칸 원문(q:{event:E}:shuffle, batch_done). 없는 칸은 빠진다 */
export interface ProofFields {
  shuffle: Record<string, string>;
  done: Record<string, string>;
}

export interface ProofSchedule {
  opensAtMs: number;
  lobbyShuffle: boolean;
  openBatch: boolean;
  batchWindowMs?: number;
}

/** 묶음 구간 길이의 처음 값 2초 [가정](진입의 OPEN_BATCH_MS와 같다) */
const OPEN_BATCH_MS = 2_000;

const iso = (ms: number): string => new Date(ms).toISOString();
const intOf = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : undefined);
const STOP = /^(\d+):(beacon|stale_round|late_commit|no_commit|late_root|members_changed)$/;

export function groupProof(eventId: string, group: ShuffleGroup, fields: ProofFields, fixedAtMs: number, revealAtMs: number, nowMs: number): Record<string, unknown> {
  const { shuffle, done } = fields;
  const g = String(group);
  const opt = (k: string, v: unknown): Record<string, unknown> => (v === undefined || v === null ? {} : { [k]: v });
  const msOpt = (k: string, v: string | undefined): Record<string, unknown> => {
    const n = intOf(v);
    return n === undefined ? {} : { [k]: iso(n) };
  };
  const round = intOf(shuffle[`round:${g}`]);
  const marker = done[g] ? /^(\d+):(\d+):\d+$/.exec(done[g]!) : null;
  const seed = shuffle[`seed:${g}`];
  const stop = shuffle[`stop:${g}`];
  const stopMatch = stop ? STOP.exec(stop) : null;
  return {
    chain: shuffle.chain ?? DRAND_CHAIN,
    algorithm: shuffle.algo ?? ALGORITHM,
    ...opt('commit', shuffle[`commit:${g}`]),
    ...msOpt('committedAt', shuffle[`at:${g}`]),
    fixedAt: iso(fixedAtMs),
    ...opt('round', round),
    ...(round !== undefined ? { roundAt: iso(drandRoundTimeMs(round)) } : {}),
    ...opt('merkleRoot', done[`root:${g}`]),
    ...msOpt('rootAt', done[`rootAt:${g}`]),
    ...(marker ? { firstSeq: Number(marker[1]), participantCount: Number(marker[2]) } : {}),
    ...opt('beacon', shuffle[`beacon:${g}`]),
    ...opt('beaconSignature', shuffle[`sig:${g}`]),
    ...msOpt('publishedAt', done[`pub:${g}`]),
    resultPathPrefix: `/v1/queues/${eventId}/${group === 'lobby' ? 'shuffle-results' : 'batch-results'}/`,
    // 참가자 0명 구간은 공개할 결과가 없어 파일을 쓰지 않는다(ADR-0232 결정 3)
    fileCount: marker && Number(marker[2]) === 0 ? 0 : RESULT_FILE_COUNT,
    ...(seed && nowMs >= revealAtMs ? { seed, ...msOpt('seedRevealedAt', shuffle[`seedAt:${g}`]) } : {}),
    ...(stop
      ? { stopped: stopMatch ? { reason: stopMatch[2], at: iso(Number(stopMatch[1])) } : { reason: 'unknown', at: iso(nowMs) } }
      : {}),
  };
}

export function shuffleProof(eventId: string, schedule: ProofSchedule, fields: ProofFields, nowMs: number): Record<string, unknown> {
  const seedRevealAtMs = schedule.opensAtMs + SEED_REVEAL_AFTER_MS;
  return {
    eventId,
    opensAt: iso(schedule.opensAtMs),
    seedRevealAt: iso(seedRevealAtMs),
    lobby: schedule.lobbyShuffle ? groupProof(eventId, 'lobby', fields, schedule.opensAtMs, seedRevealAtMs, nowMs) : null,
    batch: schedule.openBatch ? groupProof(eventId, 1, fields, schedule.opensAtMs + (schedule.batchWindowMs ?? OPEN_BATCH_MS), seedRevealAtMs, nowMs) : null,
  };
}
