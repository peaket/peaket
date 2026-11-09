// 셔플 검증 정보 만들기(POL-005, ADR-0232 결정 8): 공시 기록의 칸을 구간별 값으로 옮긴다. 응답은 계약 QueueShuffleProof다.
// 봉인 값(sealed:{구간})은 응답에 옮기지 않고(칸을 이름으로 골라 옮긴다), 시드는 공개 시각이 지났을 때만 낸다.
import { ALGORITHM, DRAND_CHAIN, drandRoundTimeMs, isEmergencyStopReason, SEED_REVEAL_AFTER_MS, type ShuffleGroup } from '@peaket/shuffle';

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
/** Date가 받는 범위 안의 정수 시각만 쓴다. 저장소 값이 깨져도 응답이 500이 되지 않게 한다 */
const MAX_DATE_MS = 8_640_000_000_000_000;
const isoOrNull = (ms: number): string | null => (Number.isSafeInteger(ms) && ms >= 0 && ms <= MAX_DATE_MS ? iso(ms) : null);
const intOf = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : undefined);
const STOP = /^(\d+):(beacon|stale_round|late_commit|no_commit|late_root|members_changed|unauthorized|seed_unavailable)$/;
/** 비상 셔플의 한계(고정 문장, ADR-0239 결정 13). 입력이 아니라 서버가 넣는다 */
export const EMERGENCY_LIMITATION = '이 경우 시드를 아는 내부자가 결과를 미리 알 수 있다';
/** 계약의 reason 목록을 늘리면 받는 쪽이 깨지므로 새 이유는 unknown + detail로 낸다(ADR-0239 결정 13) */
const DETAIL_ONLY = new Set(['unauthorized', 'seed_unavailable']);
const stoppedOf = (reason: string, atMs: number, nowMs: number): Record<string, unknown> => {
  const at = isoOrNull(atMs);
  if (at === null) return { reason: 'unknown', at: iso(nowMs) };
  return DETAIL_ONLY.has(reason) ? { reason: 'unknown', detail: reason, at } : { reason, at };
};
/** 공개 사유의 상한(openapi maxLength, 묶음의 REASON_MAX와 같다) */
const REASON_MAX = 200;
const isRound = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;

/** 표시 칸의 사유가 서명 묶음의 사유와 같은가. 서명 자체는 리더가 배포된 공개키로 확인하고, 여기서는 모양만 본다(ADR-0239 결정 15) */
const signedReasonIs = (signed: unknown, reason: unknown): boolean => {
  const b = (signed as { bundle?: { params?: { reason?: unknown } }; signatures?: unknown } | null | undefined) ?? undefined;
  return typeof reason === 'string' && reason !== '' && reason.length <= REASON_MAX && Array.isArray(b?.signatures) && b.signatures.length >= 2 && b.bundle?.params?.reason === reason;
};

/** RB-35 적용이 쓴 JSON 칸. 칸이 없으면 undefined, 있는데 모양이 틀리면 null(조용히 건너뛰지 않고 invalidDisclosures로 공시한다) */
function emergencyOf(raw: string | undefined): Record<string, unknown> | null | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as { at?: unknown; stop?: unknown; reason?: unknown; signed?: unknown };
    if (typeof v.at !== 'number' || typeof v.stop !== 'string' || !isEmergencyStopReason(v.stop) || !signedReasonIs(v.signed, v.reason)) return null;
    return { at: iso(v.at), reason: v.reason, stopReason: v.stop, limitation: EMERGENCY_LIMITATION };
  } catch {
    return null;
  }
}

function redisclosuresOf(raw: string | undefined): Record<string, unknown>[] | null | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v) || v.length === 0) return null;
    const out = v.flatMap((e: { at?: unknown; prev?: unknown; round?: unknown; reason?: unknown; signed?: unknown }) => (typeof e?.at === 'number' && isRound(e?.prev) && isRound(e?.round) && signedReasonIs(e?.signed, e?.reason) ? [{ at: iso(e.at), previousRound: e.prev, round: e.round, reason: e.reason }] : []));
    return out.length === v.length ? out : null;
  } catch {
    return null;
  }
}

export function groupProof(eventId: string, group: ShuffleGroup, fields: ProofFields, fixedAtMs: number, revealAtMs: number, nowMs: number): Record<string, unknown> {
  const { shuffle, done } = fields;
  const g = String(group);
  const opt = (k: string, v: unknown): Record<string, unknown> => (v === undefined || v === null ? {} : { [k]: v });
  const msOpt = (k: string, v: string | undefined): Record<string, unknown> => {
    const n = intOf(v);
    const at = n === undefined ? null : isoOrNull(n);
    return at === null ? {} : { [k]: at };
  };
  const round = intOf(shuffle[`round:${g}`]);
  const roundAt = round === undefined ? null : isoOrNull(drandRoundTimeMs(round));
  const marker = done[g] ? /^(\d+):(\d+):\d+$/.exec(done[g]!) : null;
  const seed = shuffle[`seed:${g}`];
  const stop = shuffle[`stop:${g}`];
  const stopMatch = stop ? STOP.exec(stop) : null;
  const emergency = emergencyOf(shuffle[`emergency:${g}`]);
  const redisclosures = redisclosuresOf(shuffle[`recommit:${g}`]);
  const invalidDisclosures = [...(emergency === null ? ['emergency'] : []), ...(redisclosures === null ? ['redisclosures'] : [])];
  return {
    chain: shuffle.chain ?? DRAND_CHAIN,
    algorithm: shuffle.algo ?? ALGORITHM,
    ...opt('commit', shuffle[`commit:${g}`]),
    ...msOpt('committedAt', shuffle[`at:${g}`]),
    fixedAt: iso(fixedAtMs),
    ...opt('round', round),
    ...(roundAt ? { roundAt } : {}),
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
      ? { stopped: stopMatch ? stoppedOf(stopMatch[2]!, Number(stopMatch[1]), nowMs) : { reason: 'unknown', at: iso(nowMs) } }
      : {}),
    ...(emergency ? { emergency } : {}),
    ...(redisclosures ? { redisclosures } : {}),
    ...(invalidDisclosures.length > 0 ? { invalidDisclosures } : {}),
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
