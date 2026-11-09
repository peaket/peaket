// SCR-019 화면 모델(d5 §5.19, ADR-0232): 셔플 검증 정보 API의 응답을 화면 값으로 옮긴다. 시각은 부르는 쪽이 준 형식 함수로 만든다.
import type { ShuffleProof } from '@/entities/shuffle-proof';
import { parseTime } from '../../../shared/lib/kst.ts';
import { EMERGENCY_BEACON_HEX } from './recompute.ts';

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
  /** ①·③에 보일 비상 셔플·다시 공시(로비). 묶음은 ⑧의 batchDisclosure */
  disclosure: DisclosureView;
  batchDisclosure: DisclosureView;
}

/** 화면에 보일 비상 셔플·다시 공시 값(ADR-0239 결정 13). 시각과 라운드는 글로 바꿔 둔다. 사유·한계는 받은 글 그대로이고 React 텍스트로만 넣는다 */
export interface DisclosureView {
  emergency: { at: string; reason: string; limitation: string } | null;
  redisclosures: readonly { at: string; previousRound: string; round: string; reason: string }[];
  /** 공시를 읽지 못했을 때의 정해진 글. 없으면 null */
  invalidNote: string | null;
}

export const NO_DISCLOSURE: DisclosureView = { emergency: null, redisclosures: [], invalidNote: null };

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
  stopped?: { reason: string; at: string; detail?: string };
  /** 비상 셔플 공시(RB-35). 있으면 비콘 값이 없다 */
  emergency?: ProofEmergencyDto;
  redisclosures?: ProofRedisclosureDto[];
  /** 기록이 있는데 읽지 못한 공시 칸. 있으면 그 구간의 공시를 믿지 않는다 */
  invalidDisclosures?: string[];
}

export interface ProofEmergencyDto {
  at: string;
  reason: string;
  stopReason: string;
  limitation: string;
}

export interface ProofRedisclosureDto {
  at: string;
  previousRound: number;
  round: number;
  reason: string;
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
  disclosure: NO_DISCLOSURE,
  batchDisclosure: NO_DISCLOSURE,
};

/** ③·⑧ 결과 칸: 게시한 값과 멈춤 사유를 함께 보인다(게시 뒤에 멈춘 구간도 사유를 건너뛰지 않는다, d5 §5.19 '멈춤') */
export function resultStep(g: { pub: boolean; rootOpen: boolean; stoppedNote: string | null; emergency?: boolean }): { showValues: boolean; note: string | null } {
  if (g.stoppedNote) return { showValues: g.pub, note: g.stoppedNote };
  if (g.pub) return { showValues: true, note: null };
  if (g.emergency) return { showValues: false, note: '비상 셔플로 순서를 계산 중입니다. 비콘을 기다리지 않고 결과를 게시합니다' };
  return { showValues: false, note: g.rootOpen ? '순서 계산 중입니다. 공시한 drand 라운드를 받은 뒤 결과를 게시합니다' : '공시한 drand 라운드를 받은 뒤 결과를 게시합니다' };
}

/** ⑤ 시드 칸의 안내: 멈춘 구간은 공개 예정이 아니다(ADR-0232 결정 7) */
export const seedNote = (stoppedNote: string | null, scheduled: string): string => (stoppedNote ? '이 구간은 순서 계산을 멈춰 원본 시드를 공개하지 않습니다' : scheduled);

/** 멈춘 구간은 다시 계산할 수 없다는 안내 */
export const STOPPED_NO_RECOMPUTE = '순서 계산을 멈춘 구간은 원본 시드를 공개하지 않아 다시 계산할 수 없습니다';

/** ⑥이 닫힌 이유. 열렸으면 null */
export function verifyDisabledReason(v: Pick<ProofFlags, 'verifyOpen' | 'allStopped'>, seedAt: string): string | null {
  if (v.verifyOpen) return null;
  return v.allStopped ? STOPPED_NO_RECOMPUTE : `원본 시드를 공개한 뒤(${seedAt}) 다시 계산할 수 있습니다`;
}

export interface SeedBadge {
  label: string;
  tone: 'success' | 'warning' | 'danger';
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

/** 머리의 공시 경고 배지. 비콘 없이 뽑은 구간과 공시를 읽지 못한 구간을 구간별로 알린다 */
export function disclosureBadgesOf(v: Pick<ProofFlags, 'disclosure' | 'batchDisclosure'>): SeedBadge[] {
  return [
    { name: '로비', d: v.disclosure },
    { name: '묶음', d: v.batchDisclosure },
  ].flatMap(({ name, d }): SeedBadge[] => [...(d.emergency ? [{ label: `${name} 비상 셔플(비콘 없음)`, tone: 'warning' as const }] : []), ...(d.invalidNote ? [{ label: `${name} 공시 확인 불가`, tone: 'danger' as const }] : [])]);
}

/** openapi의 사유 상한과 같다. 한계 문장은 서버가 넣는 고정 문장이라 같은 상한을 넘을 일이 없다 [가정] */
const DISCLOSURE_TEXT_MAX = 200;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HASH_HEX = /^[0-9a-f]{64}$/;
/** drand quicknet의 서명은 G1 48바이트다(ADR-0239 결정 3, admission-ctrl QuicknetBeaconVerifier와 같다) */
const SIGNATURE_HEX = /^[0-9a-f]{96}$/;
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= DISCLOSURE_TEXT_MAX;
/** ISO 형식의 시각인가(Date.parse는 '1' 같은 글도 받는다) */
export const isInstant = (v: unknown): v is string => typeof v === 'string' && ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v));
const isRound = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isHash = (v: unknown): v is string => typeof v === 'string' && HASH_HEX.test(v);

/** 비상 표시가 믿을 만한 모양인가. 비콘 기록이 함께 있으면 어긋난 기록이다(비상 구간은 비콘을 쓰지 않는다, ADR-0239 결정 11) */
function emergencyFits(raw: unknown, g: ProofGroupDto): raw is ProofEmergencyDto {
  const e = raw as Partial<ProofEmergencyDto> | null;
  return typeof e === 'object' && e !== null && isInstant(e.at) && isText(e.reason) && isText(e.limitation) && e.stopReason === 'beacon' && !g.beacon && !g.beaconSignature;
}

/** 다시 공시 이력이 믿을 만한 모양인가. 빈 이력과 라운드가 그대로인 줄은 잘못이고(서버 proof.ts와 같다), 앞 줄에서 이어져 마지막 라운드가 지금 공시한 라운드여야 한다(ADR-0239 결정 12·15) */
function redisclosuresFit(raw: unknown, g: ProofGroupDto): raw is ProofRedisclosureDto[] {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const rows = raw as (Partial<ProofRedisclosureDto> | null)[];
  const rowFits = (r: Partial<ProofRedisclosureDto> | null, i: number): boolean =>
    typeof r === 'object' && r !== null && isInstant(r.at) && isRound(r.previousRound) && isRound(r.round) && r.round !== r.previousRound && isText(r.reason) && (i === 0 || r.previousRound === rows[i - 1]?.round);
  return rows.every(rowFits) && rows.at(-1)?.round === g.round;
}

/**
 * 비콘 기록이 규격에 맞는가. 아직 없으면 맞다. 서명은 G1 48바이트(16진 96자)이고,
 * 고정 비콘 값이 일반 비콘 자리에 있으면 비상 셔플을 일반 구간으로 꾸민 것이다(고정값의 원문을 서명 자리에 넣으면 '서명의 해시 = 비콘'을 지난다)
 */
function beaconFits(g: ProofGroupDto): boolean {
  if (!g.beacon && !g.beaconSignature) return true;
  return isHash(g.beacon) && g.beacon !== EMERGENCY_BEACON_HEX && typeof g.beaconSignature === 'string' && SIGNATURE_HEX.test(g.beaconSignature);
}

export interface GroupDisclosure {
  /** 읽을 수 있는 비상 표시. 없거나 읽지 못하면 null */
  emergency: ProofEmergencyDto | null;
  redisclosures: readonly ProofRedisclosureDto[];
  /** 읽지 못했거나 믿을 수 없는 공시 칸. 하나라도 있으면 그 구간을 확인됨으로 내지 않는다(openapi invalidDisclosures, ADR-0239 결정 13). 화면에 옮기지 않는다 */
  invalid: readonly string[];
}

/** 구간의 비상 셔플·다시 공시를 읽는다. 응답을 믿지 않고 모양을 본다. 화면 표시와 다시 계산의 결론이 같은 판단을 쓴다 */
export function disclosureOf(g: ProofGroupDto | null): GroupDisclosure {
  if (g === null) return { emergency: null, redisclosures: [], invalid: [] };
  const listed: unknown = g.invalidDisclosures;
  const invalid = new Set<string>(Array.isArray(listed) ? listed.map((k: unknown) => (typeof k === 'string' ? k : 'unknown')) : listed === undefined ? [] : ['unknown']);
  if (g.emergency !== undefined && !emergencyFits(g.emergency, g)) invalid.add('emergency');
  if (g.redisclosures !== undefined && !redisclosuresFit(g.redisclosures, g)) invalid.add('redisclosures');
  if (!beaconFits(g)) invalid.add('beacon');
  if (g.round !== undefined && !isRound(g.round)) invalid.add('record');
  // 시드는 게시한 구간만 공개한다(ADR-0232 결정 7). 참가자 0명 구간은 공개할 결과가 없어 비콘 없이 게시한다(ADR-0231 결정 12)
  if (g.seed && g.fileCount > 0) {
    if (!isHash(g.seed) || !isHash(g.commit) || !isHash(g.merkleRoot) || !isRound(g.firstSeq)) invalid.add('record');
    if (!g.beacon && g.emergency === undefined) invalid.add('beacon');
  }
  return { emergency: invalid.has('emergency') ? null : (g.emergency ?? null), redisclosures: invalid.has('redisclosures') ? [] : (g.redisclosures ?? []), invalid: [...invalid] };
}

const DISTRUST = '위조나 손상일 수 있어 이 구간의 공시를 믿지 않습니다';
/** 공시한 값끼리 어긋나거나 규격과 다른 구간의 안내 */
export const MISMATCH_NOTE = `공시한 값이 규격과 맞지 않습니다. ${DISTRUST}`;

/** 읽지 못한 공시의 안내. 받은 칸 이름은 옮기지 않고 정해진 글만 낸다(ASVS v5.0.0-3.2.2) */
export function invalidNoteOf(invalid: readonly string[]): string | null {
  if (invalid.length === 0) return null;
  if (invalid.every((k) => k === 'beacon' || k === 'record')) return MISMATCH_NOTE;
  const only = invalid.length === 1 ? invalid[0] : undefined;
  const what = only === 'emergency' ? '비상 셔플 기록을' : only === 'redisclosures' ? '라운드 다시 공시 기록을' : '비상 셔플·다시 공시 기록을';
  return `${what} 읽지 못했습니다. ${DISTRUST}`;
}

/** 멈춤 이유 unknown의 자세한 이유(ADR-0239 결정 13). 아는 값만 정해진 글로 낸다 */
function stoppedDetailNote(detail: unknown): string {
  if (detail === 'unauthorized') return '순서 계산을 멈췄습니다. 비상 처리 기록의 서명을 확인하지 못했습니다';
  if (detail === 'seed_unavailable') return '순서 계산을 멈췄습니다. 원본 시드를 꺼내지 못했습니다';
  return '순서 계산을 멈췄습니다';
}

/** 멈춤 사유는 정해진 글로만 낸다(받은 값을 화면에 옮기지 않는다, ASVS v5.0.0-3.2.2) */
export function stoppedNoteOf(group: ProofGroupDto | null): string | null {
  const reason = group?.stopped?.reason;
  if (!reason) return null;
  if (reason === 'unknown') return stoppedDetailNote(group?.stopped?.detail);
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
  /** 표시용 시각: 없는 칸은 비우고, 깨진 값은 '—'로 낸다('NaN/NaN'이 찍히지 않게) */
  const timeOf = (iso: unknown, format: (ms: number) => string): string => {
    if (iso === undefined) return '';
    const ms = typeof iso === 'string' ? parseTime(iso) : undefined;
    return ms === undefined ? '—' : format(ms);
  };
  const dt = (iso: string | undefined): string => timeOf(iso, fmt.dateTime);
  const lobby = api.lobby;
  const batch = api.batch;
  const dtSec = (iso: string | undefined): string => timeOf(iso, fmt.dateTimeSec);
  const timeSec = (iso: string | undefined): string => timeOf(iso, fmt.timeSec);
  const roundText = (g: ProofGroupDto | null): string => (isRound(g?.round) ? `${g.round.toLocaleString('en-US')} · ${timeSec(g.roundAt)}` : '');
  const fileBase = (g: ProofGroupDto | null): string => (g ? `${filesOrigin}${g.resultPathPrefix}` : '');
  const main = lobby ?? batch;
  const disclosureView = (g: ProofGroupDto | null): DisclosureView => {
    const d = disclosureOf(g);
    return {
      emergency: d.emergency ? { at: dtSec(d.emergency.at), reason: d.emergency.reason, limitation: d.emergency.limitation } : null,
      redisclosures: d.redisclosures.map((r) => ({ at: dtSec(r.at), previousRound: r.previousRound.toLocaleString('en-US'), round: r.round.toLocaleString('en-US'), reason: r.reason })),
      invalidNote: invalidNoteOf(d.invalid),
    };
  };
  const proof: ShuffleProof = {
    eventId: api.eventId,
    fifo: lobby === null,
    lobby: { at: dt(lobby?.committedAt), seedHash: lobby?.commit ?? '', chain: lobby?.chain ?? '', round: roundText(lobby), algorithm: lobby?.algorithm ?? '' },
    open: { at: dt(api.opensAt), merkleRoot: lobby?.merkleRoot ?? '' },
    result: {
      roundLabel: isRound(lobby?.round) ? `drand ${lobby.round.toLocaleString('en-US')}` : '',
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
    disclosure: lobby ? disclosureView(lobby) : NO_DISCLOSURE,
    batchDisclosure: disclosureView(batch),
  };
  return { proof, flags };
}
