// 대기실 저장소(docs/frontend.md §3.12 표, ADR-0207 결정 3·8). 표에 없는 값은 두지 않는다.
// - localStorage peaket.queue.{eventId}: 사전 검증 토큰·발급 시각, 진행 중 진입(요청 ID, 그때 보낸 토큰, 202 본문), 대기표·순번·구간, 처음 예상 대기, 저장 시각
// - sessionStorage peaket.queue.{eventId}.firstAhead: 처음 앞 인원
// - sessionStorage peaket.admission.{eventId}: 입장 토큰·서버 ECDH 공개키·좌석맵 경로·구매 세션 만료·받은 시각
// - localStorage peaket.device: deviceId(CSPRNG 128비트, base64url 22자)

export interface Batching {
  entryRequestId: string;
  resultPath: string;
  resultAtMs: number;
  spreadSec: number;
}

export interface Ticket {
  queueTicket: string;
  seq: number;
  generation: number;
  segment: number;
}

export interface QueueRecord {
  preverifyToken?: string;
  preverifyIssuedAt?: number;
  /** 진행 중인 진입. 보내기 전에 요청 ID와 보낼 토큰을 두고, 202를 받으면 batching을 더한다 */
  entry?: { entryRequestId: string; token: string; batching?: Batching };
  ticket?: Ticket;
  firstEta?: { sec: number; atMs: number };
  savedAt: number;
}

export interface Admission {
  admissionToken: string;
  serverEcdhPublicKey?: Record<string, string>;
  seatmapLayoutPath?: string;
  purchaseSessionExpiresAt?: string;
  receivedAt: number;
}

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

/** 앱 시작 때 지우는 나이(2일 [가정]) */
const STALE_MS = 2 * 24 * 3600_000;
const queueKey = (eventId: string) => `peaket.queue.${eventId}`;
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096;
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function parseRecord(raw: string | null): QueueRecord | null {
  if (!raw) return null;
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof r !== 'object' || r === null || !nat(r.savedAt)) return null;
  const out: QueueRecord = { savedAt: r.savedAt };
  if (str(r.preverifyToken)) {
    out.preverifyToken = r.preverifyToken;
    if (nat(r.preverifyIssuedAt)) out.preverifyIssuedAt = r.preverifyIssuedAt;
  }
  const e = r.entry as Record<string, unknown> | undefined;
  if (e && str(e.entryRequestId) && str(e.token)) {
    out.entry = { entryRequestId: e.entryRequestId, token: e.token };
    const b = e.batching as Record<string, unknown> | undefined;
    if (b && str(b.entryRequestId) && str(b.resultPath) && b.resultPath.startsWith('/v1/queues/') && nat(b.resultAtMs) && nat(b.spreadSec)) {
      out.entry.batching = { entryRequestId: b.entryRequestId, resultPath: b.resultPath, resultAtMs: b.resultAtMs, spreadSec: b.spreadSec };
    }
  }
  const t = r.ticket as Record<string, unknown> | undefined;
  if (t && str(t.queueTicket) && nat(t.seq) && t.seq >= 1 && nat(t.generation) && nat(t.segment)) out.ticket = { queueTicket: t.queueTicket, seq: t.seq, generation: t.generation, segment: t.segment };
  const f = r.firstEta as Record<string, unknown> | undefined;
  if (f && typeof f.sec === 'number' && f.sec > 0 && nat(f.atMs)) out.firstEta = { sec: f.sec, atMs: f.atMs };
  return out;
}

export interface Store {
  read(): QueueRecord | null;
  write(patch: Partial<Omit<QueueRecord, 'savedAt'>>): QueueRecord;
  /** 진입·대기표 값만 지운다(입장 뒤, 다시 줄 서기) */
  clearEntry(): void;
  /** 이 회차의 키를 모두 지운다(대기 취소, 판매 종료, 410) */
  clearAll(): void;
  firstAhead(): number | null;
  setFirstAhead(n: number): void;
  saveAdmission(a: Admission): void;
  /** 이 탭의 입장 값(입장 토큰·구매 세션 만료). 없거나 꼴이 틀리면 null */
  readAdmission(): Admission | null;
  deviceId(): string | undefined;
}

export function createStore(eventId: string, local: KV | null, session: KV | null, now: () => number, randomBytes: (n: number) => Uint8Array): Store {
  const key = queueKey(eventId);
  const safe = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  const read = (): QueueRecord | null => {
    const rec = safe(() => parseRecord(local?.getItem(key) ?? null), null);
    if (rec && now() - rec.savedAt > STALE_MS) {
      safe(() => local?.removeItem(key), undefined);
      return null;
    }
    return rec;
  };
  const put = (rec: QueueRecord) => safe(() => local?.setItem(key, JSON.stringify(rec)), undefined);
  return {
    read,
    write(patch) {
      const rec: QueueRecord = { ...(read() ?? { savedAt: now() }), ...patch, savedAt: now() };
      for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined) delete rec[k];
      put(rec);
      return rec;
    },
    clearEntry() {
      const rec = read();
      if (!rec) return;
      delete rec.entry;
      delete rec.ticket;
      delete rec.firstEta;
      rec.savedAt = now();
      put(rec);
      safe(() => session?.removeItem(`${key}.firstAhead`), undefined);
    },
    clearAll() {
      safe(() => local?.removeItem(key), undefined);
      safe(() => session?.removeItem(`${key}.firstAhead`), undefined);
    },
    firstAhead() {
      const v = safe(() => session?.getItem(`${key}.firstAhead`) ?? null, null);
      const n = v === null ? NaN : Number(v);
      return Number.isInteger(n) && n >= 0 ? n : null;
    },
    setFirstAhead(n) {
      safe(() => session?.setItem(`${key}.firstAhead`, String(n)), undefined);
    },
    saveAdmission(a) {
      safe(() => session?.setItem(`peaket.admission.${eventId}`, JSON.stringify(a)), undefined);
    },
    readAdmission() {
      return safe(() => {
        const v = JSON.parse(session?.getItem(`peaket.admission.${eventId}`) ?? 'null') as Admission | null;
        return v && typeof v.admissionToken === 'string' && typeof v.receivedAt === 'number' ? v : null;
      }, null);
    },
    deviceId() {
      const v = safe(() => local?.getItem('peaket.device') ?? null, null);
      if (v && /^[A-Za-z0-9_-]{22}$/.test(v)) return v;
      const bytes = randomBytes(16);
      const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      safe(() => local?.setItem('peaket.device', id), undefined);
      return safe(() => (local?.getItem('peaket.device') === id ? id : undefined), undefined);
    },
  };
}
