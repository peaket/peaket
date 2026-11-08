// SCR-019 내 순번 검증 흐름(d5 §5.19 ⑥, ADR-0232 결정 9). 브라우저(Worker)에서만 돈다.
// 전체 토큰 해시는 서버로 보내지 않는다. 받을 파일을 고르는 앞 세 자리만 파일 주소로 나간다.
import type { ProofDto, ProofGroupDto } from './proof-view.ts';
import { collectEntries, type FetchFile, throwIfAborted, verifyRank } from './recompute.ts';

const HASH = /^[0-9a-f]{64}$/;
/** 파일 한 줄의 어림(해시 64자 + 번호와 따옴표들) [가정] */
const BYTES_PER_ENTRY = 77;

/** BLS 서명 검증 라이브러리는 아직 없다(OPEN[27]). 확인하지 않은 것을 그대로 적는다 */
export const BLS_NOTE = 'drand의 BLS 서명 자체는 이 화면에서 확인하지 않았습니다. 서명의 해시가 비콘 값과 같은지만 확인했습니다';

export type VerifyProgress = { phase: 'files'; done: number; total: number } | { phase: 'compute' };

export type VerifyOutcome = { fileRank: string; recomputedRank: string; note: string } | { error: string };

export interface VerifyDeps {
  filesOrigin: string;
  fetchFile: FetchFile;
  onProgress?: (p: VerifyProgress) => void;
  signal?: AbortSignal;
  hasWebCrypto?: () => boolean;
}

const ready = (g: ProofGroupDto | null): g is ProofGroupDto & { seed: string; beacon: string; beaconSignature: string; merkleRoot: string; commit: string; firstSeq: number } =>
  g !== null && Boolean(g.seed && g.beacon && g.beaconSignature && g.merkleRoot && g.commit) && g.firstSeq !== undefined && g.fileCount > 0;

const rank = (n: number | null): string => (n === null ? '—' : n.toLocaleString('en-US'));

export async function verifyToken(api: ProofDto, rawHash: string, d: VerifyDeps): Promise<VerifyOutcome> {
  if (!(d.hasWebCrypto ?? (() => typeof crypto !== 'undefined' && Boolean(crypto.subtle)))()) return { error: '이 브라우저에서는 다시 계산할 수 없습니다(암호 기능을 쓸 수 없습니다)' };
  const tokenHash = rawHash.trim().toLowerCase();
  if (!HASH.test(tokenHash)) return { error: '토큰 해시는 16진수 64자입니다' };
  for (const g of [api.lobby, api.batch]) {
    if (!ready(g)) continue;
    throwIfAborted(d.signal);
    const base = `${d.filesOrigin}${g.resultPathPrefix}`;
    const mine = await d.fetchFile(`${base}${tokenHash.slice(0, 3)}.json`);
    if (mine.status !== 200 || !(tokenHash in (mine.body as Record<string, number>))) continue;
    const total = g.fileCount;
    const entries = await collectEntries(base, total, d.fetchFile, { ...(d.signal ? { signal: d.signal } : {}), onFile: (done) => d.onProgress?.({ phase: 'files', done, total }) });
    throwIfAborted(d.signal);
    d.onProgress?.({ phase: 'compute' });
    const r = await verifyRank({ eventId: api.eventId, seedHex: g.seed, commitHex: g.commit, beaconHex: g.beacon, signatureHex: g.beaconSignature, merkleRootHex: g.merkleRoot, firstSeq: g.firstSeq, tokenHash, entries });
    const fileRank = rank(r.fileSeq);
    const late = g.rootAt && g.roundAt && Date.parse(g.rootAt) > Date.parse(g.roundAt);
    const recomputedRank = !r.commitMatches ? '시드 커밋 불일치' : !r.beaconMatches ? '비콘 값 불일치' : !r.rootMatches ? '머클 루트 불일치' : late ? '머클 루트를 비콘 라운드 뒤에 공시함' : rank(r.recomputedSeq);
    return { fileRank, recomputedRank, note: BLS_NOTE };
  }
  return { error: '결과 파일에서 이 토큰 해시를 찾지 못했습니다' };
}

/**
 * Worker 쪽 파일 받기. Worker가 직접 fetch하면 페이지 CSP의 connect-src가 걸리지 않으므로(Worker는 자기 스크립트 응답의 CSP를 따르고, 정적 자산에는 CSP 머리가 없다),
 * 요청을 화면 쪽에 맡긴다. 받은 글은 transfer로 넘겨 JSON 풀기는 여기(Worker)에서 한다
 */
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
      const resolve = waiting.get(id);
      waiting.delete(id);
      resolve?.(status === 200 && buffer ? { status, body: JSON.parse(new TextDecoder().decode(buffer)) as unknown } : { status });
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
