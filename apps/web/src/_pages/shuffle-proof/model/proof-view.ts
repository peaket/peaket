// SCR-019 화면 모델(d5 §5.19, ADR-0232): 셔플 검증 정보 API의 응답을 화면 값으로 옮긴다. 시각은 부르는 쪽이 준 형식 함수로 만든다.
import type { ShuffleProof } from '@/entities/shuffle-proof';

/** 화면을 고르는 값(미리보기 상태와 같은 이름) */
export interface ProofFlags {
  fifo: boolean;
  noFile: boolean;
  preT0: boolean;
  /** ① 커밋이 공시됐는가 */
  commitOpen: boolean;
  /** ② 머클 루트가 공시됐는가 */
  rootOpen: boolean;
  /** ③④ 결과를 게시했는가 */
  pub: boolean;
  /** ② 머클 루트를 비콘 라운드 뒤에 공시했다(주 구간) */
  rootLate: boolean;
  batchCommitOpen: boolean;
  batchRootOpen: boolean;
  batchPub: boolean;
  batchRootLate: boolean;
  seedOpen: boolean;
  batchSeedOpen: boolean;
  /** 어느 구간이든 시드가 열렸다(⑥ 다시 계산 가능) */
  verifyOpen: boolean;
  matched: boolean;
  /** 묶음 구간을 켠 회차인가 */
  hasBatch: boolean;
  /** 켠 구간이 모두 멈췄다(⑥을 열 수 없다) */
  allStopped: boolean;
  /** ③에 보일 멈춤 사유(정해진 글, 로비). 없으면 null */
  stoppedNote: string | null;
  /** ⑧에 보일 멈춤 사유(정해진 글, 묶음). 없으면 null */
  batchStoppedNote: string | null;
}

/** openapi QueueShuffleProofGroup의 화면에 쓰는 칸 */
export interface ProofGroupDto {
  chain: string;
  algorithm: string;
  resultPathPrefix: string;
  fileCount: number;
  fixedAt?: string;
  commit?: string;
  committedAt?: string;
  round?: number;
  roundAt?: string;
  merkleRoot?: string;
  rootAt?: string;
  firstSeq?: number;
  participantCount?: number;
  beacon?: string;
  beaconSignature?: string;
  publishedAt?: string;
  seed?: string;
  seedRevealedAt?: string;
  stopped?: { reason: string; at: string };
}

export interface ProofDto {
  eventId: string;
  opensAt: string;
  seedRevealAt: string;
  lobby: ProofGroupDto | null;
  batch: ProofGroupDto | null;
}

export interface ViewOptions {
  nowMs: number;
  /** 결과 파일 출처(queue-files). 개발 서버는 빈 값(같은 출처) */
  filesOrigin: string;
  /** 초까지 쓰는 칸은 묶음 구간·라운드·게시 시각이다(2초 묶음이 '03:52~03:52'로 보이지 않게) */
  fmt: { dateTime: (ms: number) => string; dateTimeSec: (ms: number) => string; timeSec: (ms: number) => string };
}

/** 파일 없음 화면의 머리: 배지·셔플 전 안내 없이 제목과 돌아가기만 보인다 */
export const NO_FILE_FLAGS: ProofFlags = {
  fifo: false,
  noFile: true,
  preT0: false,
  commitOpen: false,
  rootOpen: false,
  pub: false,
  rootLate: false,
  batchCommitOpen: false,
  batchRootOpen: false,
  batchPub: false,
  batchRootLate: false,
  seedOpen: false,
  batchSeedOpen: false,
  verifyOpen: false,
  matched: false,
  hasBatch: false,
  allStopped: false,
  stoppedNote: null,
  batchStoppedNote: null,
};

/** ③·⑧ 결과 칸: 게시한 값과 멈춤 사유를 함께 보인다(게시 뒤에 멈춘 구간도 사유를 건너뛰지 않는다, d5 §5.19 '멈춤') */
export function resultStep(g: { pub: boolean; rootOpen: boolean; stoppedNote: string | null }): { showValues: boolean; note: string | null } {
  if (g.stoppedNote) return { showValues: g.pub, note: g.stoppedNote };
  if (g.pub) return { showValues: true, note: null };
  return { showValues: false, note: g.rootOpen ? '순서 계산 중입니다. 공시한 drand 라운드를 받은 뒤 결과를 게시합니다' : '공시한 drand 라운드를 받은 뒤 결과를 게시합니다' };
}

/** ⑤ 시드 칸의 안내: 멈춘 구간은 공개 예정이 아니다(ADR-0232 결정 7) */
export const seedNote = (stoppedNote: string | null, scheduled: string): string => (stoppedNote ? '이 구간은 순서 계산을 멈춰 원본 시드를 공개하지 않습니다' : scheduled);

/** ⑥이 닫힌 이유. 열렸으면 null */
export function verifyDisabledReason(v: Pick<ProofFlags, 'verifyOpen' | 'allStopped'>, seedAt: string): string | null {
  if (v.verifyOpen) return null;
  return v.allStopped ? '순서 계산을 멈춘 구간은 원본 시드를 공개하지 않아 다시 계산할 수 없습니다' : `원본 시드를 공개한 뒤(${seedAt}) 다시 계산할 수 있습니다`;
}

export interface SeedBadge {
  label: string;
  tone: 'success' | 'warning';
}

/** 머리의 시드 공개 배지. 구간의 상태가 서로 다르면 구간별로 나눠 보인다 */
export function seedBadgesOf(v: Pick<ProofFlags, 'fifo' | 'hasBatch' | 'seedOpen' | 'batchSeedOpen' | 'stoppedNote' | 'batchStoppedNote'>): SeedBadge[] {
  const stateOf = (open: boolean, note: string | null): 'open' | 'stopped' | 'pending' => (open ? 'open' : note ? 'stopped' : 'pending');
  const groups = [...(v.fifo ? [] : [{ name: '로비', state: stateOf(v.seedOpen, v.stoppedNote) }]), ...(v.hasBatch ? [{ name: '묶음', state: stateOf(v.batchSeedOpen, v.batchStoppedNote) }] : [])];
  const badge = (prefix: string, state: 'open' | 'stopped' | 'pending'): SeedBadge =>
    state === 'open' ? { label: `${prefix}시드 공개됨`, tone: 'success' } : state === 'stopped' ? { label: `${prefix}시드 공개 안 함(멈춤)`, tone: 'warning' } : { label: `${prefix}시드 공개 전`, tone: 'warning' };
  if (groups.every((g) => g.state === groups[0]?.state)) return groups[0] ? [badge('원본 ', groups[0].state)] : [];
  return groups.map((g) => badge(`${g.name} `, g.state));
}

/** 멈춤 사유는 정해진 글로만 낸다(받은 값을 화면에 옮기지 않는다, ASVS v5.0.0-3.2.2) */
function stoppedNoteOf(group: ProofGroupDto | null): string | null {
  const reason = group?.stopped?.reason;
  if (!reason) return null;
  if (reason === 'beacon') return '순서 계산을 멈췄습니다. 공시한 비콘을 제때 받지 못했습니다';
  if (reason === 'stale_round' || reason === 'late_commit' || reason === 'no_commit') return '순서 계산을 멈췄습니다. 공시 내용이 일정과 맞지 않습니다';
  if (reason === 'late_root') return '순서 계산을 멈췄습니다. 참가자 머클 루트를 비콘 라운드 뒤에 공시했습니다';
  if (reason === 'members_changed') return '순서 계산을 멈췄습니다. 공시한 참가자 목록과 게시할 목록이 다릅니다';
  return '순서 계산을 멈췄습니다';
}

const rootLateOf = (g: ProofGroupDto | null): boolean => Boolean(g?.rootAt && g.roundAt && Date.parse(g.rootAt) > Date.parse(g.roundAt));

/** 결과 파일 주소: 파일은 토큰 해시 앞 세 자리로 고른다 */
export const resultFileHref = (fileBase: string, tokenHash: string): string => `${fileBase}${tokenHash.slice(0, 3)}.json`;

/** 켠 구간에서 정렬 이름을 정한다 */
export function sortModeOf(api: Pick<ProofDto, 'lobby' | 'batch'>): 'HYBRID' | 'FIFO' | 'PREQUEUE_SHUFFLE' {
  if (api.lobby === null) return 'FIFO';
  return api.batch === null ? 'PREQUEUE_SHUFFLE' : 'HYBRID';
}

/** 합성 값 미리보기는 개발 서버에서 아는 상태 이름일 때만 연다(운영에서 ?state=로 합성 '일치' 화면이 열리지 않게) */
export function previewStateOf<T extends string>(raw: string | undefined, nodeEnv: string | undefined, states: readonly T[]): T | null {
  if (nodeEnv !== 'development' || raw === undefined) return null;
  return states.includes(raw as T) ? (raw as T) : null;
}

export function buildProofView(api: ProofDto, o: ViewOptions): { proof: ShuffleProof; flags: ProofFlags } {
  const { fmt, nowMs, filesOrigin } = o;
  const atMs = (iso: string | undefined): number | undefined => (iso ? Date.parse(iso) : undefined);
  const dt = (iso: string | undefined): string => {
    const ms = atMs(iso);
    return ms === undefined ? '' : fmt.dateTime(ms);
  };
  const lobby = api.lobby;
  const batch = api.batch;
  const dtSec = (iso: string | undefined): string => {
    const ms = atMs(iso);
    return ms === undefined ? '' : fmt.dateTimeSec(ms);
  };
  const timeSec = (iso: string | undefined): string => {
    const ms = atMs(iso);
    return ms === undefined ? '' : fmt.timeSec(ms);
  };
  const roundText = (g: ProofGroupDto | null): string => (g?.round !== undefined ? `${g.round.toLocaleString('en-US')} · ${timeSec(g.roundAt)}` : '');
  const fileBase = (g: ProofGroupDto | null): string => (g ? `${filesOrigin}${g.resultPathPrefix}` : '');
  const main = lobby ?? batch;
  const proof: ShuffleProof = {
    eventId: api.eventId,
    fifo: lobby === null,
    lobby: { at: dt(lobby?.committedAt), seedHash: lobby?.commit ?? '', chain: lobby?.chain ?? '', round: roundText(lobby), algorithm: lobby?.algorithm ?? '' },
    open: { at: dt(api.opensAt), merkleRoot: lobby?.merkleRoot ?? '' },
    result: {
      roundLabel: lobby?.round !== undefined ? `drand ${lobby.round.toLocaleString('en-US')}` : '',
      beacon: lobby?.beacon ?? '',
      signature: lobby?.beaconSignature ?? '',
      fileBase: fileBase(lobby),
      publishedAt: dtSec(lobby?.publishedAt),
    },
    seed: { at: dt(api.seedRevealAt), value: main?.seed ?? '' },
    batch: {
      window: batch ? `${dtSec(api.opensAt)}~${timeSec(batch.fixedAt)}` : '',
      committedAt: dt(batch?.committedAt),
      seedHash: batch?.commit ?? '',
      merkleRoot: batch?.merkleRoot ?? '',
      round: roundText(batch),
      beacon: batch?.beacon ?? '',
      signature: batch?.beaconSignature ?? '',
      fileBase: fileBase(batch),
      seed: batch?.seed ?? '',
    },
    myToken: '',
    myRank: '',
  };
  const flags: ProofFlags = {
    fifo: lobby === null,
    noFile: false,
    preT0: nowMs < Date.parse(api.opensAt) && !main?.merkleRoot,
    commitOpen: Boolean(main?.commit),
    rootOpen: Boolean(main?.merkleRoot),
    pub: Boolean(main?.publishedAt),
    rootLate: rootLateOf(main),
    batchCommitOpen: Boolean(batch?.commit),
    batchRootOpen: Boolean(batch?.merkleRoot),
    batchPub: Boolean(batch?.publishedAt),
    batchRootLate: rootLateOf(batch),
    seedOpen: Boolean(main?.seed),
    batchSeedOpen: Boolean(batch?.seed),
    verifyOpen: Boolean(lobby?.seed || batch?.seed),
    matched: false,
    hasBatch: batch !== null,
    allStopped: [lobby, batch].filter((g) => g !== null).every((g) => Boolean(g.stopped)),
    stoppedNote: lobby ? stoppedNoteOf(lobby) : null,
    batchStoppedNote: stoppedNoteOf(batch),
  };
  return { proof, flags };
}
