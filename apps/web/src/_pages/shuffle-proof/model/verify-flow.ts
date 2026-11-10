// SCR-019 내 순번 검증 흐름(d5 §5.19 ⑥, ADR-0232 결정 9). 브라우저(Worker)에서만 돈다.
// 전체 토큰 해시는 서버로 보내지 않는다. 받을 파일을 고르는 앞 세 자리만 파일 주소로 나간다.
import type { VerifyConclusion } from '@peaket/ds/ShuffleProofPanel';
import { disclosureOf, invalidNoteOf, isInstant, MISMATCH_NOTE, type ProofDto, type ProofGroupDto, STOPPED_NO_RECOMPUTE, stoppedNoteOf } from './proof-view.ts';
import { collectEntries, type FetchFile, fileSeqOf, throwIfAborted, verifyEmergencyRank, verifyRank, type VerifyResult } from './recompute.ts';

const HASH = /^[0-9a-f]{64}$/;
/** 파일 한 줄의 어림(해시 64자 + 번호와 따옴표들) [가정] */
const BYTES_PER_ENTRY = 77;

/** 브라우저가 BLS 서명을 검증하지 않는 것은 ADR-0239 결정 3의 결정이다. 확인하지 않은 것을 그대로 적는다 */
const BLS_UNCHECKED = 'drand의 BLS 서명 자체는 이 화면에서 확인하지 않았습니다';
export const BLS_NOTE = `${BLS_UNCHECKED}. 서명의 해시가 비콘 값과 같은지만 확인했습니다`;

/** 비상 셔플의 한계. ⑥의 결론은 서버 글을 믿지 않고 이 고정 문장을 쓴다(서버 글이 '한계 없음'으로 바뀌어도 결론이 누그러지지 않게) */
const EMERGENCY_LIMITATION = '시드를 아는 내부자가 결과를 미리 알 수 있습니다';
const EMERGENCY_LACKS_BEACON = `비콘(외부 공개 난수) 없이 시드만으로 뽑은 구간입니다`;

/** 비상 셔플이 일치했을 때: 브라우저가 대조한 것과 대조하지 못한 것(비상 처리의 서명)을 그대로 적는다 */
export const EMERGENCY_NOTE = `${EMERGENCY_LACKS_BEACON}. 시드가 커밋과 같은지, 참가자 목록이 머클 루트와 같은지, 고정 비콘 값으로 같은 순서가 나오는지만 확인했습니다. 비상 처리를 허가한 서명은 이 화면에서 확인하지 않았습니다. 한계: ${EMERGENCY_LIMITATION}`;
/** 일치가 아닐 때는 확인했다고 적지 않고 한계만 낸다 */
const EMERGENCY_FAIL_NOTE = `${EMERGENCY_LACKS_BEACON}. 한계: ${EMERGENCY_LIMITATION}`;

/** 순번이 맞아도 '공개 난수로 검증됨'처럼 보이지 않게 하는 결론 */
export const EMERGENCY_CONCLUSION: VerifyConclusion = { tone: 'warning', title: '순번은 같지만, 비콘 없이 시드만으로 뽑은 구간입니다' };

/** 공시를 읽지 못한 구간의 결론과 '다시 계산한 순번' 자리 글 */
export const UNTRUSTED_CONCLUSION: VerifyConclusion = { tone: 'danger', title: '이 구간의 공시를 믿을 수 없어 확인됨으로 내지 않습니다' };
export const UNCONFIRMED_RANK = '확인하지 않음';

const REDISCLOSED_NOTE = '이 구간은 공시 뒤 라운드를 다시 공시했습니다(이력은 공개 기록에 있습니다)';

export type VerifyProgress = { phase: 'files'; done: number; total: number } | { phase: 'compute' };

export type VerifyOutcome = { fileRank: string; recomputedRank: string; matched: boolean; note: string; conclusion?: VerifyConclusion } | { error: string };

export interface VerifyDeps {
  filesOrigin: string;
  fetchFile: FetchFile;
  onProgress?: (p: VerifyProgress) => void;
  signal?: AbortSignal;
  hasWebCrypto?: () => boolean;
}

const NOT_FOUND = '결과 파일에서 이 토큰 해시를 찾지 못했습니다';
const FILE_UNREADABLE = '결과 파일을 받지 못해 확인하지 못했습니다. 잠시 뒤 다시 시도해 주세요';
const SEED_PENDING = '이 구간은 원본 시드를 공개한 뒤 다시 계산할 수 있습니다';
const NO_RESULT_FILES = '이 회차에는 다시 계산할 결과 파일이 없습니다';
const STOPPED_CONCLUSION: VerifyConclusion = { tone: 'danger', title: '이 구간은 순서 계산을 멈춰 확인됨으로 내지 않습니다' };

/** 그 구간을 어떻게 볼 것인가. null이면 결과 파일이 없는 구간이라 건너뛴다(끈 구간, 참가자 0명) */
type GroupCheck =
  | { kind: 'untrusted'; note: string }
  | { kind: 'stopped'; note: string }
  | { kind: 'pending' }
  | { kind: 'recompute'; okNote: string; failNote: string; conclusion?: VerifyConclusion; rootTimeApplies: boolean; verify: (tokenHash: string, entries: Readonly<Record<string, number>>) => Promise<VerifyResult> };

function checkOf(eventId: string, g: ProofGroupDto | null): GroupCheck | null {
  if (g === null || !(g.fileCount > 0)) return null;
  const d = disclosureOf(g);
  // 공시를 읽지 못한 구간은 시드가 있어도 다시 계산하지 않는다. 비콘 없이 뽑았는지부터 알 수 없다
  const untrusted = invalidNoteOf(d.invalid);
  if (untrusted !== null) return { kind: 'untrusted', note: untrusted };
  if (g.stopped !== undefined) {
    const note = stoppedNoteOf(g) ?? '순서 계산을 멈췄습니다';
    return { kind: g.stopped?.detail === 'unauthorized' ? 'untrusted' : 'stopped', note };
  }
  const { seed, merkleRoot, commit, firstSeq, beacon, beaconSignature } = g;
  if (!seed) return { kind: 'pending' };
  // disclosureOf가 모양을 이미 봤다. 여기까지 왔는데 값이 없으면 어긋난 구간으로 친다
  if (!merkleRoot || !commit || firstSeq === undefined) return { kind: 'untrusted', note: MISMATCH_NOTE };
  const common = { eventId, seedHex: seed, commitHex: commit, merkleRootHex: merkleRoot, firstSeq };
  if (d.emergency) return { kind: 'recompute', okNote: EMERGENCY_NOTE, failNote: EMERGENCY_FAIL_NOTE, conclusion: EMERGENCY_CONCLUSION, rootTimeApplies: false, verify: (tokenHash, entries) => verifyEmergencyRank({ ...common, tokenHash, entries }) };
  if (!beacon || !beaconSignature) return { kind: 'untrusted', note: MISMATCH_NOTE };
  const redisclosed = d.redisclosures.length > 0 ? `. ${REDISCLOSED_NOTE}` : '';
  return { kind: 'recompute', okNote: `${BLS_NOTE}${redisclosed}`, failNote: `${BLS_UNCHECKED}${redisclosed}`, rootTimeApplies: true, verify: (tokenHash, entries) => verifyRank({ ...common, beaconHex: beacon, signatureHex: beaconSignature, tokenHash, entries }) };
}

const rank = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-US'));

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAbort = (e: unknown): boolean => (e as { name?: unknown } | null)?.name === 'AbortError';

/** 확인됨으로 낼 수 없는 결과. 결과 파일에서 내 번호를 읽지 못했으면 fileRank는 '—'다 */
const unconfirmed = (fileRank: string, note: string, conclusion: VerifyConclusion): VerifyOutcome => ({ fileRank, recomputedRank: UNCONFIRMED_RANK, matched: false, note, conclusion });

/** 앞자리 파일 하나를 읽는다. 받지 못했거나 표가 아니면 null(취소는 그대로 던진다) */
async function readTable(url: string, d: VerifyDeps): Promise<Record<string, unknown> | null> {
  try {
    const r = await d.fetchFile(url);
    return r.status === 200 && isTable(r.body) ? r.body : null;
  } catch (e) {
    if (isAbort(e)) throw e;
    return null;
  }
}

export async function verifyToken(api: ProofDto, rawHash: string, d: VerifyDeps): Promise<VerifyOutcome> {
  if (!(d.hasWebCrypto ?? (() => typeof crypto !== 'undefined' && Boolean(crypto.subtle)))()) return { error: '이 브라우저에서는 다시 계산할 수 없습니다(암호 기능을 쓸 수 없습니다)' };
  const tokenHash = rawHash.trim().toLowerCase();
  if (!HASH.test(tokenHash)) return { error: '토큰 해시는 16진수 64자입니다' };
  const missed: { unreadable: boolean; pending: boolean; stopped: boolean; readAny: boolean; untrustedNote: string | null } = { unreadable: false, pending: false, stopped: false, readAny: false, untrustedNote: null };
  for (const g of [api.lobby, api.batch]) {
    const check = checkOf(api.eventId, g);
    if (check === null || g === null) continue;
    throwIfAborted(d.signal);
    const base = `${d.filesOrigin}${g.resultPathPrefix}`;
    const table = await readTable(`${base}${tokenHash.slice(0, 3)}.json`, d);
    if (table === null) {
      // 시드 공개 전·멈춘 구간은 게시하지 않아 파일이 없는 것이 정상이다. 믿을 수 없는 구간은 다시 시도해도 풀리지 않는다(다른 구간에서 찾으면 그 결과를 낸다)
      if (check.kind === 'untrusted') missed.untrustedNote ??= check.note;
      else if (check.kind === 'pending') missed.pending = true;
      else if (check.kind === 'stopped') missed.stopped = true;
      else missed.unreadable = true;
      continue;
    }
    missed.readAny = true;
    if (!(tokenHash in table)) continue;
    if (check.kind === 'pending') return { error: SEED_PENDING };
    if (check.kind !== 'recompute') return unconfirmed(rank(fileSeqOf(table[tokenHash])), check.note, check.kind === 'stopped' ? STOPPED_CONCLUSION : UNTRUSTED_CONCLUSION);
    const total = g.fileCount;
    let entries: Record<string, number>;
    try {
      entries = await collectEntries(base, total, d.fetchFile, { ...(d.signal ? { signal: d.signal } : {}), onFile: (done) => d.onProgress?.({ phase: 'files', done, total }) });
    } catch (e) {
      if (isAbort(e)) throw e;
      return { error: FILE_UNREADABLE };
    }
    throwIfAborted(d.signal);
    d.onProgress?.({ phase: 'compute' });
    const r = await check.verify(tokenHash, entries);
    // d5 §5.19: 일반 구간은 머클 루트 공시 ≤ 라운드 예정 시각이 맞아야 일치다. 시각을 모르면 맞는다고 치지 않는다. 비상 구간은 비콘이 없어 이 비교에 뜻이 없다(게시도 late_root를 보지 않는다, 위험은 한계 문장이 말한다)
    const rootMs = isInstant(g.rootAt) ? Date.parse(g.rootAt) : null;
    const roundMs = isInstant(g.roundAt) ? Date.parse(g.roundAt) : null;
    const timesKnown = !check.rootTimeApplies || (rootMs !== null && roundMs !== null);
    const late = check.rootTimeApplies && rootMs !== null && roundMs !== null && rootMs > roundMs;
    const recomputedRank = !r.commitMatches ? '시드 커밋 불일치' : !r.beaconMatches ? '비콘 값 불일치' : !r.rootMatches ? '머클 루트 불일치' : !timesKnown ? '머클 루트 공시 시각을 확인할 수 없음' : late ? '머클 루트를 비콘 라운드 뒤에 공시함' : rank(r.recomputedSeq);
    const matched = r.commitMatches && r.beaconMatches && r.rootMatches && timesKnown && !late && r.fileSeq !== null && r.recomputedSeq !== null && r.fileSeq === r.recomputedSeq;
    return { fileRank: rank(r.fileSeq), recomputedRank, matched, note: matched ? check.okNote : check.failNote, ...(matched && check.conclusion ? { conclusion: check.conclusion } : {}) };
  }
  if (missed.untrustedNote !== null) return unconfirmed('—', missed.untrustedNote, UNTRUSTED_CONCLUSION);
  if (missed.unreadable) return { error: FILE_UNREADABLE };
  if (missed.pending) return { error: SEED_PENDING };
  if (missed.stopped) return { error: STOPPED_NO_RECOMPUTE };
  return { error: missed.readAny ? NOT_FOUND : NO_RESULT_FILES };
}

/**
 * Worker 쪽 파일 받기. Worker가 직접 fetch하면 페이지 CSP의 connect-src가 걸리지 않으므로(Worker는 자기 스크립트 응답의 CSP를 따르고, 정적 자산에는 CSP 머리가 없다),
 * 요청을 화면 쪽에 맡긴다. 받은 글은 transfer로 넘겨 JSON 풀기는 여기(Worker)에서 한다
 */
/** 200이어도 JSON이 아니면 받지 못한 파일로 친다(Worker 밖 경로의 readTable과 같게) */
function parsedFile(buffer: ArrayBuffer): { status: number; body?: unknown } {
  try {
    return { status: 200, body: JSON.parse(new TextDecoder().decode(buffer)) as unknown };
  } catch {
    return { status: 0 };
  }
}

export function createWorkerFetch(post: (m: { fetch: { id: number; url: string } }) => void): { fetchFile: FetchFile; receive: (r: { id: number; status: number; buffer?: ArrayBuffer }) => void } {
  let nextId = 0;
  const waiting = new Map<number, (r: { status: number; body?: unknown }) => void>();
  return {
    fetchFile: (url) =>
      new Promise((resolve) => {
        const id = (nextId += 1);
        waiting.set(id, resolve);
        post({ fetch: { id, url } });
      }),
    receive: ({ id, status, buffer }) => {
      // 받은 id는 숫자만 받는다(문자열·큰 수가 Map 조회와 호출로 새지 않게, CodeQL js/unvalidated-dynamic-method-call)
      const key = typeof id === 'number' && Number.isSafeInteger(id) ? id : -1;
      const resolve = waiting.get(key);
      if (typeof resolve !== 'function') return;
      waiting.delete(key);
      resolve(status === 200 && buffer ? parsedFile(buffer) : { status });
    },
  };
}

/** 받을 크기 안내. 참가자 수를 모르면 null */
export function estimateDownload(g: { participantCount?: number; fileCount: number }): string | null {
  if (g.participantCount === undefined) return null;
  const mb = (g.participantCount * BYTES_PER_ENTRY) / 1_000_000;
  return `결과 파일 ${g.fileCount.toLocaleString('en-US')}개, 약 ${mb < 1 ? '1MB 미만을' : `${Math.round(mb)}MB를`} 받습니다`;
}

/** 대기실이 둔 회차 저장값(docs/frontend.md §3.12)에서 실제로 보낸 토큰을 고른다 */
export function pickStoredToken(raw: unknown, fifo: boolean): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as { lobby?: { lobbyToken?: unknown }; entry?: { token?: unknown }; preverifyToken?: unknown };
  const order = fifo ? [r.entry?.token, r.preverifyToken] : [r.lobby?.lobbyToken, r.entry?.token, r.preverifyToken];
  const token = order.find((t): t is string => typeof t === 'string' && t.length > 0);
  return token;
}
