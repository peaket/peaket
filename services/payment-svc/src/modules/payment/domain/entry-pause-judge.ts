// 새 결제 진입 정지 판정의 값과 규칙(docs/features/payment.md §2 '정지 판정자의 첫 구현'·§9, ADR-0105·0250, BUILD_ORDER PRF-202). 프레임워크·저장소를 모른다(순수 값과 함수). 모든 숫자는 설정 객체 하나로 받아 시험에서 줄인다.
import { createHash } from 'node:crypto';
import { PaymentInputError } from './confirm-command.js';
import type { EntryPauseReason, EntryPauseStage } from './entry-pause.js';
import type { ConfirmResult, PgName, QueryResult } from './payment-gateway.js';
import { PG_NAMES } from './pg-call-guard.js';

/** 판정자를 뽑는 쿠버네티스 Lease 이름(ADR-0105 결정 8) */
export const ENTRY_PAUSE_LEASE_NAME = 'payment-entry-pause';
/** 자동 판정의 행위자(data.md payment_entry_pause.actor) */
export const ENTRY_PAUSE_ACTOR_SYSTEM = 'SYSTEM';
/** 시험 행을 지우는 나이 7일 [가정](admitted_at 기준) */
export const ENTRY_TRIAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 해제가 겨루어 졌을 때 더 해 보는 횟수 2회 [가정](ADR-0250) */
export const ENTRY_PAUSE_RELEASE_RETRIES = 2;
/** 해제 행위자 글자 수 상한 128자 [가정](ADR-0250) */
export const ENTRY_PAUSE_RELEASE_ACTOR_MAX = 128;
/** 해제 사유 글자 수 상한 500자 [가정](ADR-0250) */
export const ENTRY_PAUSE_RELEASE_REASON_MAX = 500;
/** 대기 건수를 세다 멈추는 수 10만 건 [가정](인덱스 범위 읽기의 상한) */
export const ENTRY_PAUSE_WAITING_COUNT_CAP = 100_000;

/** 판정 설정. 값은 모두 [가정]이고 정본은 docs/features/payment.md §9다 */
export interface EntryPauseJudgeConfig {
  /** 판정 틱 주기 */
  readonly tickMs: number;
  /** 시작: 준비된 파드 가운데 서킷이 닫혀 있지 않은 비율(%) */
  readonly startPodPercent: number;
  /** 시작: direct 확정 소요 p99(초) */
  readonly startP99Seconds: number;
  /** p99를 보는 창 */
  readonly p99WindowMs: number;
  /** 창 안 direct 표본이 이보다 적으면 p99는 표본 없음(5초 초과 1건으로 결제사 전체를 멈추지 않게) */
  readonly p99MinSamples: number;
  /** 사람이 푼 뒤 서킷 열림 시작 조건을 보지 않는 시간(서킷 지표 긁기 지연, ADR-0105 결정 7 보완) */
  readonly manualReleaseGraceMs: number;
  /** 제어 입력의 긁기 간격(창이 이 값의 2배보다 짧으면 p99는 표본 없음) */
  readonly scrapeIntervalMs: number;
  /** 입력이 이보다 낡으면 입력 없음 */
  readonly inputMaxAgeMs: number;
  /** 상한 정지 시작: 예상 대기(초)가 이 값을 넘음 */
  readonly channelStartWaitSeconds: number;
  /** 상한 정지 해제: 예상 대기(초)가 이 값 아래 */
  readonly channelOpenWaitSeconds: number;
  /** 상한 정지 해제: 그 상태가 이어져야 하는 시간 */
  readonly channelOpenHoldMs: number;
  /** 확인 호출 간격(기대 표본 수를 잰다) */
  readonly probeIntervalMs: number;
  /** 확인 호출 창 */
  readonly probeWindowMs: number;
  /** 확인 호출 성공률(%) */
  readonly probeSuccessPercent: number;
  /** 창 안 표본이 기대의 이 비율(%) 아래면 아직 아니다 */
  readonly probeMinSamplePercent: number;
  /** 시험 재개에서 받는 비율(%) */
  readonly trialAdmitPercent: number;
  /** 판정하는 첫 승인 수 */
  readonly trialSampleSize: number;
  /** 결론으로 치는 첫 승인 호출 시간 */
  readonly trialConclusionMs: number;
  /** 결론 비율(%) */
  readonly trialPassPercent: number;
  /** 실패가 이 수가 되면 바로 돌아간다 */
  readonly trialFailureLimit: number;
  /** 표본이 모자랄 때 판정하는 시간(시험 재개 시작부터) */
  readonly trialMaxMs: number;
}

export const ENTRY_PAUSE_JUDGE_DEFAULTS: EntryPauseJudgeConfig = Object.freeze({
  tickMs: 1_000,
  startPodPercent: 50,
  startP99Seconds: 5,
  p99WindowMs: 60_000,
  p99MinSamples: 100,
  manualReleaseGraceMs: 15_000,
  scrapeIntervalMs: 5_000,
  inputMaxAgeMs: 30_000,
  channelStartWaitSeconds: 60,
  channelOpenWaitSeconds: 10,
  channelOpenHoldMs: 60_000,
  probeIntervalMs: 1_000,
  probeWindowMs: 180_000,
  probeSuccessPercent: 99,
  probeMinSamplePercent: 80,
  trialAdmitPercent: 5,
  trialSampleSize: 20,
  trialConclusionMs: 5_000,
  trialPassPercent: 95,
  trialFailureLimit: 2,
  trialMaxMs: 600_000,
});

/** payment_entry_pause 한 행 전체(판정자·해제가 읽는다) */
export interface EntryPauseRecord {
  readonly pg: PgName;
  readonly stage: EntryPauseStage;
  readonly reason: EntryPauseReason;
  readonly actor: string;
  readonly sinceMs: number;
  readonly trialStartedAtMs?: number;
  readonly reopenedAtMs?: number;
  readonly version: number;
}

/** 쓸 값(판 번호는 저장소가 올린다) */
export type EntryPauseWrite = Omit<EntryPauseRecord, 'version'>;

/** 클러스터 Prometheus에서 읽은 값 */
export interface ClusterPauseReading {
  /** 준비된 파드 가운데 서킷이 닫혀 있지 않은 수 */
  readonly openPods: number;
  /** 준비된 파드 수 */
  readonly readyPods: number;
  /** 서킷 지표의 마지막 표본 시각(epoch ms) */
  readonly sampledAtMs: number;
  /** direct 확정 소요 p99(초). 표본이 없으면 없다 */
  readonly p99Seconds?: number;
  /** 같은 창의 direct 표본 수(_count 증가량). 읽지 못했으면 없다(p99를 표본 없음으로 본다) */
  readonly p99Samples?: number;
}

/** 첫 승인 호출의 결과(data.md payment_entry_trial.first_result) */
export type EntryTrialFirstResult = 'APPROVED' | 'DECLINED' | 'FAILED' | 'UNKNOWN';

/** 판정에 쓰는 시험 행(첫 승인 호출을 시작한 행) */
export interface EntryTrialRow {
  /** 결과가 아직 없으면 없다 */
  readonly firstResult?: EntryTrialFirstResult;
  readonly firstCallMs?: number;
  /** 첫 승인 호출을 시작한 시각(epoch ms) */
  readonly firstCallAtMs: number;
}

/** 시험 행 묶음의 요약 */
export interface EntryTrialSummary {
  readonly counted: number;
  readonly conclusive: number;
  readonly failed: number;
}

/** 한 틱의 판정 입력 */
export interface EntryPauseFacts {
  readonly nowMs: number;
  /** 클러스터 입력. 없으면 입력 없음 */
  readonly cluster: ClusterPauseReading | undefined;
  /** 판정자 파드의 서킷이 닫혀 있는가 */
  readonly localCircuitClosed: boolean;
  /** 예상 대기(초)와 해제 기준 아래로 들어온 시각. 읽지 못했으면 없다 */
  readonly channel: { readonly waitSeconds: number; readonly belowSinceMs?: number } | undefined;
  /** 확인 호출 창 조건이 참인가 */
  readonly probeHealthy: boolean;
  /** 확인 호출 창이 아직 차는 중인가(판정자가 바뀐 뒤처럼 판단할 표본이 모자란다, 건강하지 않다는 뜻이 아니다) */
  readonly probeFilling: boolean;
  /** 이번 시험의 요약(TRIAL이 아니거나, 읽지 못했거나, 앞 표본에 답을 기다리는 호출이 있으면 없다) */
  readonly trial: EntryTrialSummary | undefined;
}

export type EntryPauseDecision = { readonly kind: 'STAY' } | { readonly kind: 'PAUSE'; readonly reason: EntryPauseReason } | { readonly kind: 'TRIAL' } | { readonly kind: 'PROBING' } | { readonly kind: 'OPEN' };

export type EntryPauseProbeOutcome = 'ok' | 'fail' | 'skipped';

/** 확인 호출 창의 상태. FILLING은 3분이 안 됐거나 표본이 기대의 80% [가정] 아래다 */
export type EntryPauseProbeWindowStatus = 'FILLING' | 'HEALTHY' | 'UNHEALTHY';

const STAY: EntryPauseDecision = Object.freeze({ kind: 'STAY' });
const OPEN: EntryPauseDecision = Object.freeze({ kind: 'OPEN' });
const BACK_TO_PROBING: EntryPauseDecision = Object.freeze({ kind: 'PROBING' });
const TO_TRIAL: EntryPauseDecision = Object.freeze({ kind: 'TRIAL' });

/** 모든 분기가 여기에 있다. 입력이 없으면 앞으로 가지 않는다(뒤로는 간다, ADR-0069·0105 결정 8) */
export function decideEntryPause(row: EntryPauseRecord | undefined, facts: EntryPauseFacts, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): EntryPauseDecision {
  if (row === undefined || row.stage === 'OPEN') return decideOpen(row, facts, config);
  if (row.stage === 'PROBING') return row.reason === 'CHANNEL_WAIT' ? decideChannelRelease(facts, config) : decideProbing(facts);
  return decideTrial(row, facts, config);
}

function decideOpen(row: EntryPauseRecord | undefined, facts: EntryPauseFacts, config: EntryPauseJudgeConfig): EntryPauseDecision {
  const { cluster, channel } = facts;
  const circuitCounts = !inManualReleaseGrace(row, facts.nowMs, config);
  // 입력이 없으면 판정자 자기 파드의 서킷만으로 정한다(ADR-0105 결정 8)
  if (cluster === undefined) return facts.localCircuitClosed || !circuitCounts ? STAY : { kind: 'PAUSE', reason: 'PG_FAILURE' };
  if ((circuitCounts && circuitsFailing(cluster, config)) || p99Failing(cluster, config)) return { kind: 'PAUSE', reason: 'PG_FAILURE' };
  return channel !== undefined && channel.waitSeconds > config.channelStartWaitSeconds ? { kind: 'PAUSE', reason: 'CHANNEL_WAIT' } : STAY;
}

/** 사람이 푼 뒤 15초 [가정] 안인가(서킷 지표가 긁히는 지연 동안 옛 열림으로 되돌리지 않는다, ADR-0105 결정 7 보완) */
function inManualReleaseGrace(row: EntryPauseRecord | undefined, nowMs: number, config: EntryPauseJudgeConfig): boolean {
  return row?.reopenedAtMs !== undefined && row.actor !== ENTRY_PAUSE_ACTOR_SYSTEM && nowMs - row.reopenedAtMs < config.manualReleaseGraceMs;
}

/** 준비된 파드의 절반 이상에서 서킷이 닫혀 있지 않음 */
function circuitsFailing(cluster: ClusterPauseReading, config: EntryPauseJudgeConfig): boolean {
  return cluster.openPods * 100 >= cluster.readyPods * config.startPodPercent;
}

/** p99가 기준을 넘음. p99가 없거나 표본이 100건 [가정] 미만이면(표본 없음) 거짓이다 */
function p99Failing(cluster: ClusterPauseReading, config: EntryPauseJudgeConfig): boolean {
  return cluster.p99Seconds !== undefined && cluster.p99Samples !== undefined && cluster.p99Samples >= config.p99MinSamples && cluster.p99Seconds > config.startP99Seconds;
}

function decideProbing(facts: EntryPauseFacts): EntryPauseDecision {
  return facts.cluster !== undefined && facts.localCircuitClosed && facts.probeHealthy ? TO_TRIAL : STAY;
}

function decideChannelRelease(facts: EntryPauseFacts, config: EntryPauseJudgeConfig): EntryPauseDecision {
  const belowSinceMs = facts.channel?.belowSinceMs;
  return facts.cluster !== undefined && belowSinceMs !== undefined && facts.nowMs - belowSinceMs >= config.channelOpenHoldMs ? OPEN : STAY;
}

function decideTrial(row: EntryPauseRecord, facts: EntryPauseFacts, config: EntryPauseJudgeConfig): EntryPauseDecision {
  if (row.trialStartedAtMs === undefined) return BACK_TO_PROBING;
  const { trial } = facts;
  if (trial === undefined) return STAY;
  if (trial.failed >= config.trialFailureLimit) return BACK_TO_PROBING;
  const forward = facts.cluster === undefined ? STAY : OPEN;
  if (trial.counted >= config.trialSampleSize) return trial.conclusive * 100 >= trial.counted * config.trialPassPercent ? forward : BACK_TO_PROBING;
  if (facts.nowMs - row.trialStartedAtMs < config.trialMaxMs) return STAY;
  if (facts.probeHealthy) return forward;
  // 창이 덜 찬 것(판정자가 바뀐 뒤)은 건강하지 않은 것이 아니다. 서킷이 닫혀 있지 않아 창을 비운 것은 덜 찬 것으로 보지 않는다
  return facts.probeFilling && facts.localCircuitClosed ? STAY : BACK_TO_PROBING;
}

/** 판정 결과로 쓸 행. since는 새 정지를 시작할 때만 바꾼다(data.md, 다시 열어도 마지막 값을 둔다) */
export function nextPauseRecord(pg: PgName, row: EntryPauseRecord | undefined, decision: Exclude<EntryPauseDecision, { kind: 'STAY' }>, nowMs: number): EntryPauseWrite {
  const reopened = row?.reopenedAtMs === undefined ? {} : { reopenedAtMs: row.reopenedAtMs };
  if (decision.kind === 'PAUSE') return { pg, stage: 'PROBING', reason: decision.reason, actor: ENTRY_PAUSE_ACTOR_SYSTEM, sinceMs: nowMs, ...reopened };
  const kept = { pg, reason: row?.reason ?? 'PG_FAILURE', actor: ENTRY_PAUSE_ACTOR_SYSTEM, sinceMs: row?.sinceMs ?? nowMs };
  switch (decision.kind) {
    case 'TRIAL':
      return { ...kept, stage: 'TRIAL', trialStartedAtMs: nowMs, ...reopened };
    case 'PROBING':
      return { ...kept, stage: 'PROBING', ...reopened };
    case 'OPEN':
      return { ...kept, stage: 'OPEN', reopenedAtMs: nowMs };
  }
}

/** p99를 보는 창(ms). 연 뒤에는 연 시각 뒤의 표본만 본다(ADR-0105 결정 6). 창이 긁기 간격의 2배보다 짧으면 표본이 없다고 보아 undefined다 */
export function p99WindowOf(row: Pick<EntryPauseRecord, 'reopenedAtMs'> | undefined, nowMs: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): number | undefined {
  const windowMs = row?.reopenedAtMs === undefined ? config.p99WindowMs : Math.min(config.p99WindowMs, nowMs - row.reopenedAtMs);
  return windowMs < 2 * config.scrapeIntervalMs ? undefined : windowMs;
}

/** 쓸 수 있는 입력. 없거나 30초 [가정]보다 낡았거나 준비된 파드가 없으면 undefined다(제어 입력 없음, ADR-0069) */
export function freshClusterReading(reading: ClusterPauseReading | undefined, nowMs: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): ClusterPauseReading | undefined {
  if (reading === undefined || !(reading.readyPods >= 1) || nowMs - reading.sampledAtMs > config.inputMaxAgeMs) return undefined;
  return reading;
}

/** 확인 호출 답 분류: 결제 없음만 성공이다. 결제가 돌아오면 고정 번호가 실제 결제와 겹친 것이라 실패로 세고 알린다(ADR-0105 결정 2) */
export function classifyProbeAnswer(answer: QueryResult): { readonly outcome: 'ok' | 'fail'; readonly found: boolean } {
  if (answer.kind === 'NOT_FOUND') return { outcome: 'ok', found: false };
  return { outcome: 'fail', found: answer.kind === 'FOUND' };
}

/** 확인 호출 창. 판정자 메모리에만 있고 판정자가 바뀌면 처음부터다(ADR-0105 남는 한계) */
export class EntryPauseProbeWindow {
  #samples: { readonly atMs: number; readonly ok: boolean }[] = [];
  /** 비운 뒤 첫 표본의 시각. 창을 다 채웠는지 잰다 */
  #startedAtMs: number | undefined;

  add(atMs: number, ok: boolean): void {
    this.#startedAtMs ??= atMs;
    this.#samples.push({ atMs, ok });
  }

  clear(): void {
    this.#samples = [];
    this.#startedAtMs = undefined;
  }

  /** 창을 다 채웠고, 창 안 표본이 기대의 80% [가정] 이상이고, 성공률이 99% [가정] 이상인가 */
  healthy(nowMs: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): boolean {
    return this.status(nowMs, config) === 'HEALTHY';
  }

  /** 창이 아직 차는 중인지, 찼다면 건강한지 */
  status(nowMs: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): EntryPauseProbeWindowStatus {
    this.#samples = this.#samples.filter((s) => s.atMs > nowMs - config.probeWindowMs);
    if (this.#startedAtMs === undefined || nowMs - this.#startedAtMs < config.probeWindowMs) return 'FILLING';
    const total = this.#samples.length;
    const expected = Math.floor(config.probeWindowMs / config.probeIntervalMs);
    if (total === 0 || total * 100 < expected * config.probeMinSamplePercent) return 'FILLING';
    return this.#samples.filter((s) => s.ok).length * 100 >= total * config.probeSuccessPercent ? 'HEALTHY' : 'UNHEALTHY';
  }
}

/**
 * 호출을 시작한 순서로 앞 표본 수까지만 센다(결과가 먼저 난 순서로 세면 느린 호출이 표본에서 빠진다).
 * 결과가 없는 행은 시작 뒤 5초 [가정]가 지났으면 실패다(결론이 5초 안에 없었다). 안 지났으면 undefined를 돌려 이 틱의 판정을 미룬다.
 */
export function summarizeEntryTrial(rows: readonly EntryTrialRow[], nowMs: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): EntryTrialSummary | undefined {
  const counted = rows.slice(0, config.trialSampleSize);
  if (counted.some((row) => row.firstResult === undefined && nowMs - row.firstCallAtMs <= config.trialConclusionMs)) return undefined;
  const conclusive = counted.filter((row) => isEntryTrialConclusion(row, config)).length;
  return { counted: counted.length, conclusive, failed: counted.length - conclusive };
}

/** 결제사가 5초 [가정] 안에 승인·거절로 답했는가 */
export function isEntryTrialConclusion(row: Pick<EntryTrialRow, 'firstResult' | 'firstCallMs'>, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): boolean {
  return (row.firstResult === 'APPROVED' || row.firstResult === 'DECLINED') && row.firstCallMs !== undefined && row.firstCallMs <= config.trialConclusionMs;
}

/** 첫 승인 호출의 결과. 답을 받지 못했거나(던짐) 일시 장애 표시 없는 결과 모름은 UNKNOWN이고, 일시 장애·처리 중·429·결제사 오류는 FAILED다(결론이 아니다) */
export function firstResultOf(answer: ConfirmResult | undefined): EntryTrialFirstResult {
  if (answer === undefined) return 'UNKNOWN';
  switch (answer.outcome) {
    case 'APPROVED':
    case 'ALREADY_APPROVED':
    case 'WAITING_FOR_DEPOSIT':
      return 'APPROVED';
    case 'DECLINED':
      return answer.failureCategory === 'THROTTLED' || answer.failureCategory === 'PG_ERROR' ? 'FAILED' : 'DECLINED';
    case 'IN_PROGRESS':
      return 'FAILED';
    default:
      return answer.outage === true ? 'FAILED' : 'UNKNOWN';
  }
}

/** 추첨값(0~9999)이 받는 비율 안인가 */
export function admitsEntryTrial(draw: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): boolean {
  return draw < config.trialAdmitPercent * 100;
}

/**
 * 시험 재개 추첨값 0~9999: sha256(주문 ID:판 번호)의 앞 4바이트를 10000으로 나눈 나머지다.
 * 같은 주문은 같은 시험 안에서 답이 같고(재호출마다 다시 뽑으면 Retry-After 5초 [가정]로 1분에 46%가 들어와 5% [가정]가 뚫린다) 판 번호가 바뀌는 다음 시험에서 다시 뽑힌다.
 */
export function entryTrialDraw(orderId: string, version: number): number {
  return createHash('sha256').update(`${orderId}:${version}`).digest().readUInt32BE(0) % 10_000;
}

/** 예상 대기(초) = 대기 건수 ÷ 초당 승인 수 */
export function channelWaitSeconds(waiting: number, approvalsPerSecond: number): number {
  return waiting / approvalsPerSecond;
}

/** 상한 정지의 해제 기준 아래로 들어온 시각. 읽지 못했거나 기준에 닿으면 처음부터 다시 잰다 */
export function nextChannelBelowSince(prev: number | undefined, waitSeconds: number | undefined, nowMs: number, config: EntryPauseJudgeConfig = ENTRY_PAUSE_JUDGE_DEFAULTS): number | undefined {
  if (waitSeconds === undefined || waitSeconds >= config.channelOpenWaitSeconds) return undefined;
  return prev ?? nowMs;
}

/** 해제 입력 */
export interface ReleaseEntryPauseCommand {
  readonly pg: PgName;
  readonly actor: string;
  readonly reason: string;
}

const CONTROL_CHARS = /\p{Cc}/u;

function checkedText(value: string, max: number, field: string): string {
  if (value.trim() === '' || [...value].length > max || CONTROL_CHARS.test(value)) throw new PaymentInputError(field);
  return value;
}

/**
 * 해제 입력 검사(ADR-0250).
 * @throws PaymentInputError 결제사가 허용 목록 밖, 행위자·사유가 비었거나 상한을 넘거나 제어 문자가 있음
 */
export function parseReleaseEntryPause(input: { readonly pg: string; readonly actor: string; readonly reason: string }): ReleaseEntryPauseCommand {
  if (!(PG_NAMES as readonly string[]).includes(input.pg)) throw new PaymentInputError('pg');
  return { pg: input.pg as PgName, actor: checkedText(input.actor, ENTRY_PAUSE_RELEASE_ACTOR_MAX, 'actor'), reason: checkedText(input.reason, ENTRY_PAUSE_RELEASE_REASON_MAX, 'reason') };
}
