// 감사 체크포인트(BAT-465 GAT-310, docs/features/control-tower.md §7, ADR-0075, ADR-0348).
// 두 사슬이 있다.
// ① 공개 사슬(종류 DAILY·EVENT_CLOSE·MANUAL): 번호 no가 1부터 빈틈 없이 붙고, 루트는 잎 솔트를 섞은 RFC 9162 머클 루트(merkle.ts),
//    체크포인트 JSON은 RFC 8785 글(checkpoint-json.ts)을 그대로 저장한다. 직전 해시는 직전 공개 체크포인트의 체크포인트 해시이고 공개 사슬은 seq 1부터 덮는다.
//    서명·공개 타임스탬프·게시는 게시 작업(jobs/audit-anchor.ts, publisher.ts)만 한다. API 프로세스는 서명 키를 갖지 않는다(ADR-0348 결정 1·4).
// ② 내부 사슬(종류 EXECUTION과 0023 이전 옛 행): 명령 실행 앞뒤 체크포인트는 번호·JSON·서명·게시가 없고 공개 사슬에 들지 않는다.
//    루트는 같은 머클 함수, 직전 해시는 직전 내부 체크포인트의 루트다. 옛 행(kind 없음, legacy)은 'seq:해시' 줄의 SHA-256 루트로 검증한다.
// 수동 생성(MANUAL)과 실행 체크포인트(EXECUTION)는 AUDIT_CHECKPOINT_CREATED를 같은 트랜잭션에 남기고, 게시 작업이 만든 것은 체인에 기록을 더하지 않는다(ADR-0348 결정 11).
import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database, type DbTransaction, ProblemError } from '@peaket/platform';
import { sql, type SQL } from 'drizzle-orm';
import { appendAuditIn, auditHash, canonicalAuditRecord, type AuditChain, type AuditEntry, type AuditRecord } from './audit.js';
import { verificationBundleOf, type AuditVerificationBundle } from './bundle.js';
import { canonicalCheckpointJson, checkpointHashOf, parseCheckpointJson } from './checkpoint-json.js';
import { CHECKPOINT_SIGNATURE_ALG, spkiPem, verifyCheckpointSignature } from './checkpoint-signer.js';
import { inclusionProofOfLeafHashes, leafHash, leafInput, merkleRootOfLeafHashes } from './merkle.js';
import { parseOtsHeader } from './ots.js';
import { checkpointSignalSnapshotOf, type CheckpointSignalSnapshot } from './checkpoint-signals.js';

export interface AuditChainEntry {
  readonly seq: number;
  readonly hash: string;
  /** 직전 기록 해시(첫 기록은 빈 글자). 저장된 연쇄를 검증한다(B3-H03) */
  readonly prevHash?: string;
  /** 정규화 기록. 없으면(0012 이전 행) 기록 재계산 검증이 실패한다 */
  readonly record?: AuditRecord;
  /** 잎 솔트(16진 64자). 공개 체크포인트 잎에 섞는다(ADR-0348 결정 2). 기록 파기 뒤에는 없다 */
  readonly leafSalt?: string;
}

/** 감사 체인의 읽기 면. 체크포인트가 구간의 해시를 다시 모으는 데 쓴다 */
export interface AuditChainReader {
  headSeq(): Promise<number>;
  headHash(): Promise<string>;
  entriesBetween(fromSeq: number, toSeq: number): Promise<readonly AuditChainEntry[]>;
  /** 구간 첫 기록의 직전 해시를 경계에서 대조하기 위해 읽는다(seq 0은 빈 글자) */
  hashAt(seq: number): Promise<string | undefined>;
  /** 기록 종류·ID가 가리키는 원본 행이 아직 같은 내용인가. 저장소가 없으면 해당 없음(참) */
  sourceMatches?(entry: AuditChainEntry): Promise<boolean>;
  /** 한 대상(record_id)의 기록을 최근 순으로 읽는다(권한 변경 내역, ops 배치 2026-11-20 BOT-152). 커서는 seq다 */
  entriesOfRecord?(recordId: string, o: { cursor?: string; limit: number }): Promise<{ entries: AuditEntry[]; nextCursor: string | null }>;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 시스템 행위자의 가명 참조(운영 명령 모듈의 SYSTEM_ACTOR_REF와 같은 값, ADR-0340 결정 8) */
const SYSTEM_REF = '00000000-0000-0000-0000-000000000000';

const sortJson = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortJson);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortJson((v as Record<string, unknown>)[k])]));
  return v;
};
/** 키 차례에 흔들리지 않는 JSON의 SHA-256(16진). 운영 명령 모듈 recordDigest와 같은 규칙이다(dry-run 기록 지문 대조) */
const digestOf = (raw: unknown): string => {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  return createHash('sha256').update(JSON.stringify(sortJson(v ?? null))).digest('hex');
};

/** record_json(정규화 기록)을 해시 재계산용 AuditRecord로 되돌린다. 모양이 깨졌으면 undefined */
export function auditRecordFromJson(raw: unknown): AuditRecord | undefined {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!isObject(value)) return undefined;
  const { recordType, recordId, payload, at } = value;
  if (typeof recordType !== 'string' || typeof recordId !== 'string' || typeof at !== 'string' || !isObject(payload)) return undefined;
  const nowMs = Date.parse(at);
  if (!Number.isFinite(nowMs)) return undefined;
  return { recordType, recordId, payload, nowMs };
}

/** 체크포인트 종류(docs/data.md audit_checkpoint.kind). 없으면 0023 이전 옛 행이다 */
export const AUDIT_CHECKPOINT_KINDS = ['DAILY', 'EVENT_CLOSE', 'MANUAL', 'EXECUTION'] as const;
export type AuditCheckpointKind = (typeof AUDIT_CHECKPOINT_KINDS)[number];
/** 공개 사슬에 드는 종류 */
export const PUBLIC_CHECKPOINT_KINDS: readonly AuditCheckpointKind[] = ['DAILY', 'EVENT_CLOSE', 'MANUAL'];
export type OtsState = 'PENDING' | 'COMPLETE';

/** 회차 마감 체크포인트가 묶은 회차(DB closed_events. 공개 JSON에는 ID만 싣는다) */
export interface ClosedEvent {
  readonly eventId: string;
  /** 온세일 윈도우 끝(판매 시작 + 60분) */
  readonly closedAtMs: number;
}

export interface AuditCheckpoint {
  readonly checkpointId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  /** 새 행은 머클 루트, 옛 행은 'seq:해시' 줄의 SHA-256(16진) */
  readonly rootHash: string;
  /** 공개 행은 직전 공개 체크포인트 해시, 내부 행은 직전 내부 체크포인트 루트(첫 행은 빈 글자) */
  readonly prevCheckpointHash: string;
  readonly reason: string;
  readonly actorRef: string;
  readonly createdAtMs: number;
  /** 공개 행: 게시 작업이 채운 ECDSA P-256 서명(DER base64). 옛 행: Ed25519 서명(지금은 확인하지 않는다) */
  readonly signature?: string;
  readonly keyId?: string;
  /** 공개 행: 게시한 체크포인트 파일 이름(transparency/v1/…). 옛 행: local:<id> */
  readonly anchorRef?: string;
  readonly anchoredAtMs?: number;
  /** 종류. 없으면 옛 행(legacy) */
  readonly kind?: AuditCheckpointKind;
  /** 공개 번호(공개 행만) */
  readonly no?: number;
  readonly leafCount?: number;
  /** RFC 8785 체크포인트 JSON 글(공개 행만, 게시하는 값 그대로) */
  readonly checkpointJson?: string;
  /** SHA-256(checkpointJson) 16진(공개 행만) */
  readonly checkpointHash?: string;
  readonly accessLogDayAnchor?: string;
  readonly closedEvents?: readonly ClosedEvent[];
  readonly otsState?: OtsState;
  readonly otsProof?: Buffer;
  readonly otsUpgradedAtMs?: number;
  readonly publishedAtMs?: number;
}

export const isLegacyCheckpoint = (c: Pick<AuditCheckpoint, 'kind'>): boolean => c.kind === undefined;
export const isPublicCheckpoint = (c: Pick<AuditCheckpoint, 'kind'>): boolean => c.kind !== undefined && PUBLIC_CHECKPOINT_KINDS.includes(c.kind);

export interface NewAuditCheckpoint {
  readonly checkpointId: string;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly rootHash: string;
  readonly prevCheckpointHash: string;
  readonly reason: string;
  readonly actorRef: string;
  readonly nowMs: number;
  readonly signature?: string;
  readonly keyId?: string;
  readonly anchorRef?: string;
  readonly anchoredAtMs?: number;
  readonly kind?: AuditCheckpointKind;
  readonly no?: number;
  readonly leafCount?: number;
  readonly checkpointJson?: string;
  readonly checkpointHash?: string;
  readonly accessLogDayAnchor?: string;
  readonly closedEvents?: readonly ClosedEvent[];
}

/** 서명 키 행(audit_signing_key) */
export interface AuditSigningKey {
  readonly keyId: string;
  /** 공개키 SPKI(DER) */
  readonly publicKeySpki: Buffer;
  readonly alg: string;
  readonly firstUsedAtMs: number;
}

/** 다른 쪽이 먼저 공개 체크포인트를 만들어 이 입력의 번호·구간이 맞지 않는다(다시 계산해 한 번 더) */
export class CheckpointRaceLost extends Error {
  constructor() {
    super('checkpoint-race-lost');
    this.name = 'CheckpointRaceLost';
  }
}

export interface AuditCheckpointStore {
  /** 행 하나를 쓴다. 공개 행은 번호·직전 해시가 지금 마지막 공개 행과 이어질 때만 쓰고(아니면 CheckpointRaceLost), 같은 번호·시작 seq가 이미 있으면 그것을 돌려준다 */
  create(input: NewAuditCheckpoint): Promise<AuditCheckpoint>;
  /**
   * 체크포인트 행과 AUDIT_CHECKPOINT_CREATED 체인 기록을 한 트랜잭션에 쓴다(OPS-04). 겹침 규칙은 create와 같다.
   */
  createWithAudit?(input: NewAuditCheckpoint, record: AuditRecord): Promise<AuditCheckpoint>;
  list(limit: number): Promise<readonly AuditCheckpoint[]>;
  find(checkpointId: string): Promise<AuditCheckpoint | undefined>;
  /** to_seq가 가장 큰 행(종류 무관) */
  head(): Promise<AuditCheckpoint | undefined>;
  /** 내부 사슬(EXECUTION·옛 행)에서 to_seq가 fromSeq보다 작은 마지막 행 */
  findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined>;
  /** 번호가 가장 큰 공개 행 */
  lastPublic(): Promise<AuditCheckpoint | undefined>;
  /** to_seq가 가장 큰 내부 행(EXECUTION·옛 행) */
  lastInternal(): Promise<AuditCheckpoint | undefined>;
  findByNo(no: number): Promise<AuditCheckpoint | undefined>;
  signingKey(keyId: string): Promise<AuditSigningKey | undefined>;
}

export interface AuditCheckpointVerification {
  readonly checkpointId: string;
  readonly valid: boolean;
  readonly rootValid: boolean;
  readonly prevValid: boolean;
  /** 공개 행: 서명이 있으면 저장된 공개키로 맞는가(서명 전이면 참, signed 거짓). 내부·옛 행은 해당 없음(참) */
  readonly signatureValid: boolean;
  /** 공개 행: 게시했으면 증명 파일의 대상 해시가 체크포인트 해시와 같은가(게시 전이면 참). 옛 행: 앵커 참조가 남았는가. 내부 행은 해당 없음(참) */
  readonly anchorValid: boolean;
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly checkedAtMs: number;
  readonly no?: number;
  readonly kind?: AuditCheckpointKind;
  readonly legacy: boolean;
  readonly signed: boolean;
  readonly checkpointHash?: string;
  readonly otsState?: OtsState;
  readonly publishedAtMs?: number;
}

/** 옛 행의 루트: 구간 기록의 (seq, hash)를 순서대로 이어 붙인 SHA-256(16진). 0023 이전 행 검증에만 쓴다 */
export function auditCheckpointRoot(entries: readonly Pick<AuditChainEntry, 'seq' | 'hash'>[]): string {
  const h = createHash('sha256');
  for (const e of entries) h.update(`${e.seq}:${e.hash}\n`);
  return h.digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/** 구간 기록의 잎 해시들. 잎 솔트나 기록 해시가 없으면 undefined(기록 파기 뒤 등) */
export function checkpointLeafHashes(entries: readonly AuditChainEntry[]): Buffer[] | undefined {
  const out: Buffer[] = [];
  for (const e of entries) {
    if (!e.leafSalt || !HEX64.test(e.leafSalt) || !HEX64.test(e.hash)) return undefined;
    out.push(leafHash(leafInput(e.seq, e.hash, e.leafSalt)));
  }
  return out;
}

/** 새 행의 루트: 잎 솔트를 섞은 RFC 9162 머클 루트(16진). 잎을 만들 수 없으면 undefined */
export function checkpointMerkleRoot(entries: readonly AuditChainEntry[]): string | undefined {
  const leaves = checkpointLeafHashes(entries);
  if (!leaves || leaves.length === 0) return undefined;
  return merkleRootOfLeafHashes(leaves).toString('hex');
}

export interface BuiltPublicCheckpoint {
  readonly rootHash: string;
  readonly leafCount: number;
  readonly checkpointJson: string;
  readonly checkpointHash: string;
}

/**
 * 공개 체크포인트의 루트·JSON·해시를 만든다(공개 행을 만드는 쪽이 모두 쓴다: 수동 생성과 게시 작업).
 * @throws ProblemError 409 audit-chain-broken: 구간이 비었거나 잎 솔트가 없음
 */
export function buildPublicCheckpoint(
  entries: readonly AuditChainEntry[],
  c: { readonly no: number; readonly fromSeq: number; readonly toSeq: number; readonly prevCheckpointHash: string; readonly createdAtMs: number; readonly accessLogDayAnchor?: string; readonly closedEventIds?: readonly string[] },
): BuiltPublicCheckpoint {
  if (entries.length !== c.toSeq - c.fromSeq + 1 || entries.some((e, i) => e.seq !== c.fromSeq + i)) throw chainBroken();
  const rootHash = checkpointMerkleRoot(entries);
  if (rootHash === undefined) throw chainBroken();
  const checkpointJson = canonicalCheckpointJson({
    no: c.no,
    firstSeq: c.fromSeq,
    lastSeq: c.toSeq,
    leafCount: entries.length,
    merkleRoot: rootHash,
    prevCheckpointHash: c.prevCheckpointHash,
    ...(c.accessLogDayAnchor !== undefined ? { accessLogDayAnchor: c.accessLogDayAnchor } : {}),
    ...(c.closedEventIds !== undefined ? { closedEvents: c.closedEventIds } : {}),
    createdAtMs: c.createdAtMs,
  });
  return { rootHash, leafCount: entries.length, checkpointJson, checkpointHash: checkpointHashOf(checkpointJson) };
}

const chainBroken = (): ProblemError => new ProblemError({ type: 'audit-chain-broken', status: 409, title: '감사 체인 구간이 비었습니다' });

/** 저장된 공개 JSON이 행의 칸과 같은가(번호·구간·건수·루트·직전 해시·시각) */
function publicJsonMatches(c: AuditCheckpoint): boolean {
  if (!c.checkpointJson || !c.checkpointHash || c.no === undefined) return false;
  if (checkpointHashOf(c.checkpointJson) !== c.checkpointHash) return false;
  const body = parseCheckpointJson(c.checkpointJson);
  if (!body) return false;
  return (
    body.no === c.no &&
    body.firstSeq === c.fromSeq &&
    body.lastSeq === c.toSeq &&
    body.leafCount === c.leafCount &&
    body.merkleRoot === c.rootHash &&
    body.prevCheckpointHash === c.prevCheckpointHash &&
    body.createdAt === new Date(c.createdAtMs).toISOString() &&
    (body.accessLogDayAnchor ?? undefined) === c.accessLogDayAnchor
  );
}

/**
 * 공개 행 겹침 규칙. 지금 마지막 공개 행(last) 뒤에 input이 이어지면 'OK', 같은 번호·시작 seq가 이미 있으면 그 행, 그 밖은 'RACE'
 */
export function publicCheckpointFits(last: AuditCheckpoint | undefined, input: NewAuditCheckpoint): 'OK' | 'RACE' | { readonly existing: AuditCheckpoint } {
  if (input.no === undefined) return 'OK';
  if (last?.no !== undefined && last.no >= input.no) return last.no === input.no && last.fromSeq === input.fromSeq ? { existing: last } : 'RACE';
  if ((last?.no ?? 0) !== input.no - 1) return 'RACE';
  if (!last) return input.fromSeq === 1 && input.prevCheckpointHash === '' ? 'OK' : 'RACE';
  return last.toSeq === input.fromSeq - 1 && last.checkpointHash === input.prevCheckpointHash ? 'OK' : 'RACE';
}

/** AUDIT_BUNDLE_EXPORTED: 검증 묶음 내보내기 기록(ADR-0348 결정 8) */
export const AUDIT_BUNDLE_EXPORTED = 'AUDIT_BUNDLE_EXPORTED';

export class MemoryAuditCheckpointStore implements AuditCheckpointStore {
  readonly entries: AuditCheckpoint[] = [];
  readonly keys = new Map<string, AuditSigningKey>();

  #row(input: NewAuditCheckpoint): AuditCheckpoint {
    return {
      checkpointId: input.checkpointId,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      rootHash: input.rootHash,
      prevCheckpointHash: input.prevCheckpointHash,
      reason: input.reason,
      actorRef: input.actorRef,
      createdAtMs: input.nowMs,
      ...(input.signature !== undefined ? { signature: input.signature } : {}),
      ...(input.keyId !== undefined ? { keyId: input.keyId } : {}),
      ...(input.anchorRef !== undefined ? { anchorRef: input.anchorRef } : {}),
      ...(input.anchoredAtMs !== undefined ? { anchoredAtMs: input.anchoredAtMs } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.no !== undefined ? { no: input.no } : {}),
      ...(input.leafCount !== undefined ? { leafCount: input.leafCount } : {}),
      ...(input.checkpointJson !== undefined ? { checkpointJson: input.checkpointJson } : {}),
      ...(input.checkpointHash !== undefined ? { checkpointHash: input.checkpointHash } : {}),
      ...(input.accessLogDayAnchor !== undefined ? { accessLogDayAnchor: input.accessLogDayAnchor } : {}),
      ...(input.closedEvents !== undefined ? { closedEvents: input.closedEvents } : {}),
    };
  }

  /** 같은 구간(내부 행은 시작 seq, 공개 행은 번호 규칙)이면 있는 행, 이어지지 않으면 던진다 */
  #existingOrCheck(input: NewAuditCheckpoint): AuditCheckpoint | undefined {
    if (input.no !== undefined) {
      const fit = publicCheckpointFits(this.#lastPublic(), input);
      if (fit === 'RACE') throw new CheckpointRaceLost();
      return fit === 'OK' ? undefined : fit.existing;
    }
    if (input.kind === 'EXECUTION') return this.entries.find((c) => !isPublicCheckpoint(c) && c.fromSeq === input.fromSeq);
    return undefined;
  }

  #lastPublic(): AuditCheckpoint | undefined {
    return this.entries.filter((c) => c.no !== undefined).sort((a, b) => b.no! - a.no!)[0];
  }

  async create(input: NewAuditCheckpoint): Promise<AuditCheckpoint> {
    const existing = this.#existingOrCheck(input);
    if (existing) return existing;
    const checkpoint = this.#row(input);
    this.entries.push(checkpoint);
    return checkpoint;
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    return [...this.entries].sort((a, b) => b.createdAtMs - a.createdAtMs || b.toSeq - a.toSeq).slice(0, limit);
  }

  async find(checkpointId: string): Promise<AuditCheckpoint | undefined> {
    return this.entries.find((c) => c.checkpointId === checkpointId);
  }

  async head(): Promise<AuditCheckpoint | undefined> {
    return [...this.entries].sort((a, b) => b.toSeq - a.toSeq || b.createdAtMs - a.createdAtMs)[0];
  }

  async findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined> {
    return [...this.entries].filter((c) => !isPublicCheckpoint(c) && c.toSeq < fromSeq).sort((a, b) => b.toSeq - a.toSeq)[0];
  }

  async lastPublic(): Promise<AuditCheckpoint | undefined> {
    return this.#lastPublic();
  }

  async lastInternal(): Promise<AuditCheckpoint | undefined> {
    return [...this.entries].filter((c) => !isPublicCheckpoint(c)).sort((a, b) => b.toSeq - a.toSeq || b.createdAtMs - a.createdAtMs)[0];
  }

  async findByNo(no: number): Promise<AuditCheckpoint | undefined> {
    return this.entries.find((c) => c.no === no);
  }

  async signingKey(keyId: string): Promise<AuditSigningKey | undefined> {
    return this.keys.get(keyId);
  }

  /** 서명 전 공개 행(번호 차례) */
  async unsignedPublic(limit: number): Promise<readonly AuditCheckpoint[]> {
    return this.entries.filter((c) => c.no !== undefined && c.signature === undefined).sort((a, b) => a.no! - b.no!).slice(0, limit);
  }

  /** 신호 요약(checkpoint-signals.ts) */
  async snapshot(): Promise<CheckpointSignalSnapshot> {
    return checkpointSignalSnapshotOf(this.entries);
  }

  /** 게시 작업 면(publisher.ts AuditPublishStore)이 쓰는 고치기. 행 객체를 바꿔 끼운다 */
  patch(checkpointId: string, change: Partial<Omit<AuditCheckpoint, 'checkpointId'>>): AuditCheckpoint | undefined {
    const i = this.entries.findIndex((c) => c.checkpointId === checkpointId);
    if (i < 0) return undefined;
    const next = { ...this.entries[i]!, ...change } as AuditCheckpoint;
    this.entries[i] = next;
    return next;
  }
}

/** 체크포인트를 만들고 검증한다. 수동·실행 체크포인트는 만든 사실을 감사 체인에 덧붙인다 */
export class AuditCheckpointService {
  constructor(
    private readonly store: AuditCheckpointStore,
    private readonly chain: AuditChain & AuditChainReader,
    private readonly nowMs: () => number,
  ) {}

  /**
   * 체크포인트를 만든다. 기본은 commander의 수동 공개 체크포인트(MANUAL), 명령 실행 앞뒤는 EXECUTION(내부)이다.
   * 묶을 새 기록이 없으면 같은 사슬의 마지막 행을 돌려주고, 행이 하나도 없으면 409 checkpoint-empty다.
   */
  async create(q: { reason: string; actorRef: string; kind?: 'MANUAL' | 'EXECUTION' }): Promise<AuditCheckpoint> {
    const kind = q.kind ?? 'MANUAL';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return kind === 'EXECUTION' ? await this.#createInternal(q) : await this.#createManual(q);
      } catch (e) {
        if (!(e instanceof CheckpointRaceLost)) throw e;
      }
    }
    throw new Error('감사 체크포인트 번호를 세 번 다투어 잃었다(다시 시도)');
  }

  async #range(last: AuditCheckpoint | undefined): Promise<{ fromSeq: number; toSeq: number; entries: readonly AuditChainEntry[] } | undefined> {
    const fromSeq = (last?.toSeq ?? 0) + 1;
    const toSeq = await this.chain.headSeq();
    if (toSeq < fromSeq) return undefined;
    const entries = await this.chain.entriesBetween(fromSeq, toSeq);
    if (entries.length !== toSeq - fromSeq + 1) throw chainBroken();
    return { fromSeq, toSeq, entries };
  }

  async #write(input: NewAuditCheckpoint, record: AuditRecord): Promise<AuditCheckpoint> {
    if (this.store.createWithAudit) return this.store.createWithAudit(input, record);
    const before = input.no !== undefined ? await this.store.findByNo(input.no) : undefined;
    const checkpoint = await this.store.create(input);
    // 이미 있던 행을 돌려받았으면 기록을 더하지 않는다
    if (before?.checkpointId !== checkpoint.checkpointId && checkpoint.checkpointId === input.checkpointId) await this.chain.append(record);
    return checkpoint;
  }

  async #createManual(q: { reason: string; actorRef: string }): Promise<AuditCheckpoint> {
    const last = await this.store.lastPublic();
    const range = await this.#range(last);
    if (!range) {
      if (last) return last;
      throw new ProblemError({ type: 'checkpoint-empty', status: 409, title: '묶을 감사 기록이 없습니다' });
    }
    const checkpointId = randomUUID();
    const nowMs = this.nowMs();
    const no = (last?.no ?? 0) + 1;
    const prevCheckpointHash = last?.checkpointHash ?? '';
    const built = buildPublicCheckpoint(range.entries, { no, fromSeq: range.fromSeq, toSeq: range.toSeq, prevCheckpointHash, createdAtMs: nowMs });
    const input: NewAuditCheckpoint = {
      checkpointId,
      fromSeq: range.fromSeq,
      toSeq: range.toSeq,
      rootHash: built.rootHash,
      prevCheckpointHash,
      reason: q.reason,
      actorRef: q.actorRef,
      nowMs,
      kind: 'MANUAL',
      no,
      leafCount: built.leafCount,
      checkpointJson: built.checkpointJson,
      checkpointHash: built.checkpointHash,
    };
    const record: AuditRecord = {
      recordType: 'AUDIT_CHECKPOINT_CREATED',
      recordId: checkpointId,
      payload: { kind: 'MANUAL', no, fromSeq: range.fromSeq, toSeq: range.toSeq, leafCount: built.leafCount, rootHash: built.rootHash, prevCheckpointHash, checkpointHash: built.checkpointHash },
      nowMs,
    };
    return this.#write(input, record);
  }

  async #createInternal(q: { reason: string; actorRef: string }): Promise<AuditCheckpoint> {
    const last = await this.store.lastInternal();
    const range = await this.#range(last);
    if (!range) {
      if (last) return last;
      throw new ProblemError({ type: 'checkpoint-empty', status: 409, title: '묶을 감사 기록이 없습니다' });
    }
    const rootHash = checkpointMerkleRoot(range.entries);
    if (rootHash === undefined) throw chainBroken();
    const checkpointId = randomUUID();
    const nowMs = this.nowMs();
    const prevCheckpointHash = last?.rootHash ?? '';
    const input: NewAuditCheckpoint = {
      checkpointId,
      fromSeq: range.fromSeq,
      toSeq: range.toSeq,
      rootHash,
      prevCheckpointHash,
      reason: q.reason,
      actorRef: q.actorRef,
      nowMs,
      kind: 'EXECUTION',
      leafCount: range.entries.length,
    };
    const record: AuditRecord = {
      recordType: 'AUDIT_CHECKPOINT_CREATED',
      recordId: checkpointId,
      payload: { kind: 'EXECUTION', fromSeq: range.fromSeq, toSeq: range.toSeq, rootHash, prevCheckpointHash },
      nowMs,
    };
    return this.#write(input, record);
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    return this.store.list(limit);
  }

  async get(checkpointId: string): Promise<AuditCheckpoint> {
    const checkpoint = await this.store.find(checkpointId);
    if (!checkpoint) throw new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
    return checkpoint;
  }

  /** 공개 행의 서명 키 PEM(서명 전·옛 행이면 undefined) */
  async publicKeyPemOf(c: AuditCheckpoint): Promise<string | undefined> {
    if (!isPublicCheckpoint(c) || c.keyId === undefined) return undefined;
    const key = await this.store.signingKey(c.keyId);
    return key ? spkiPem(key.publicKeySpki) : undefined;
  }

  async verify(checkpointId: string): Promise<AuditCheckpointVerification> {
    const checkpoint = await this.get(checkpointId);
    const legacy = isLegacyCheckpoint(checkpoint);
    const isPublic = isPublicCheckpoint(checkpoint);
    const entries = await this.chain.entriesBetween(checkpoint.fromSeq, checkpoint.toSeq);
    const lengthValid = entries.length === checkpoint.toSeq - checkpoint.fromSeq + 1;
    const rootMatches =
      lengthValid &&
      (legacy
        ? auditCheckpointRoot(entries) === checkpoint.rootHash
        : checkpointMerkleRoot(entries) === checkpoint.rootHash && (checkpoint.leafCount === undefined || checkpoint.leafCount === entries.length));
    // 저장된 해시만 모으는 것으로는 원본 행 변조를 잡지 못한다. record_json으로 해시를 다시 계산하고
    // prev_hash 연쇄를 경계까지 확인하며, 가능하면 ops_command·command_event 원본과도 대조한다(B3-H03).
    const recordsValid = entries.every((e) => e.record !== undefined && auditHash(e.prevHash ?? '', e.record) === e.hash);
    const boundaryHash = checkpoint.fromSeq > 1 ? await this.chain.hashAt(checkpoint.fromSeq - 1) : '';
    const boundaryValid = checkpoint.fromSeq === 1 ? true : boundaryHash !== undefined;
    const linksValid =
      boundaryValid && entries.every((e, i) => e.prevHash === (i === 0 ? (checkpoint.fromSeq === 1 ? '' : boundaryHash!) : entries[i - 1]!.hash));
    const sourceValid = this.chain.sourceMatches ? (await Promise.all(entries.map((e) => this.chain.sourceMatches!(e)))).every(Boolean) : true;
    const jsonValid = isPublic ? publicJsonMatches(checkpoint) : true;
    const rootValid = rootMatches && recordsValid && linksValid && sourceValid && jsonValid;
    let prevValid: boolean;
    if (isPublic) {
      const no = checkpoint.no!;
      const previous = no > 1 ? await this.store.findByNo(no - 1) : undefined;
      prevValid =
        no === 1
          ? checkpoint.prevCheckpointHash === '' && checkpoint.fromSeq === 1
          : previous !== undefined && checkpoint.prevCheckpointHash === previous.checkpointHash && previous.toSeq === checkpoint.fromSeq - 1;
    } else {
      const previous = await this.store.findPrevious(checkpoint.fromSeq);
      prevValid = checkpoint.prevCheckpointHash === (previous?.rootHash ?? '');
    }
    let signatureValid = true;
    if (isPublic && checkpoint.signature !== undefined) {
      const key = checkpoint.keyId !== undefined ? await this.store.signingKey(checkpoint.keyId) : undefined;
      signatureValid = key !== undefined && checkpoint.checkpointJson !== undefined && verifyCheckpointSignature(key.publicKeySpki, Buffer.from(checkpoint.checkpointJson, 'utf8'), checkpoint.signature);
    }
    let anchorValid = true;
    if (legacy) anchorValid = checkpoint.anchorRef !== undefined && checkpoint.anchorRef !== '';
    else if (isPublic && checkpoint.publishedAtMs !== undefined) {
      try {
        anchorValid = checkpoint.otsProof !== undefined && parseOtsHeader(checkpoint.otsProof).digest.toString('hex') === checkpoint.checkpointHash;
      } catch {
        anchorValid = false;
      }
    }
    return {
      checkpointId: checkpoint.checkpointId,
      valid: rootValid && prevValid && signatureValid && anchorValid,
      rootValid,
      prevValid,
      signatureValid,
      anchorValid,
      fromSeq: checkpoint.fromSeq,
      toSeq: checkpoint.toSeq,
      checkedAtMs: this.nowMs(),
      ...(checkpoint.no !== undefined ? { no: checkpoint.no } : {}),
      ...(checkpoint.kind !== undefined ? { kind: checkpoint.kind } : {}),
      legacy,
      signed: isPublic && checkpoint.signature !== undefined,
      ...(checkpoint.checkpointHash !== undefined ? { checkpointHash: checkpoint.checkpointHash } : {}),
      ...(checkpoint.otsState !== undefined ? { otsState: checkpoint.otsState } : {}),
      ...(checkpoint.publishedAtMs !== undefined ? { publishedAtMs: checkpoint.publishedAtMs } : {}),
    };
  }

  /**
   * 검증 묶음을 만들고 내보낸 사실(AUDIT_BUNDLE_EXPORTED, seq·사유)을 감사 체인에 남긴다(ADR-0348 결정 8). 기록을 남기지 못하면 묶음을 주지 않는다.
   * @throws ProblemError 404 not-found, 409 checkpoint-not-ready(서명 전·옛 행·내부 행), 422 seq-not-in-checkpoint, 409 audit-chain-broken(구간을 다시 모은 루트가 다름)
   */
  async exportBundle(q: { checkpointId: string; seq: number; reason: string; actorAdminAccountId: string; actorRole: string }): Promise<AuditVerificationBundle> {
    const c = await this.get(q.checkpointId);
    if (!isPublicCheckpoint(c) || c.signature === undefined || c.keyId === undefined || c.checkpointJson === undefined || c.no === undefined) {
      throw new ProblemError({ type: 'checkpoint-not-ready', status: 409, title: '아직 서명하지 않았거나 옛 체크포인트입니다' });
    }
    if (!Number.isSafeInteger(q.seq) || q.seq < c.fromSeq || q.seq > c.toSeq) throw new ProblemError({ type: 'seq-not-in-checkpoint', status: 422, title: '그 체크포인트가 덮지 않는 기록입니다' });
    const entries = await this.chain.entriesBetween(c.fromSeq, c.toSeq);
    const leaves = entries.length === c.toSeq - c.fromSeq + 1 ? checkpointLeafHashes(entries) : undefined;
    if (!leaves || merkleRootOfLeafHashes(leaves).toString('hex') !== c.rootHash) throw chainBroken();
    const index = q.seq - c.fromSeq;
    const entry = entries[index]!;
    if (!entry.record || entry.prevHash === undefined || auditHash(entry.prevHash, entry.record) !== entry.hash || !entry.leafSalt) throw chainBroken();
    const key = await this.store.signingKey(c.keyId);
    if (!key) throw new ProblemError({ type: 'checkpoint-not-ready', status: 409, title: '아직 서명하지 않았거나 옛 체크포인트입니다' });
    const bundle = verificationBundleOf({
      checkpoint: c,
      publicKeyPem: spkiPem(key.publicKeySpki),
      alg: CHECKPOINT_SIGNATURE_ALG,
      seq: q.seq,
      recordJson: canonicalAuditRecord(entry.record),
      prevHash: entry.prevHash,
      recordSha256: entry.hash,
      leafSalt: entry.leafSalt,
      leafIndex: index,
      treeSize: leaves.length,
      path: inclusionProofOfLeafHashes(leaves, index).map((b) => b.toString('hex')),
    });
    await this.chain.append({
      recordType: AUDIT_BUNDLE_EXPORTED,
      recordId: c.checkpointId,
      payload: { checkpointId: c.checkpointId, no: c.no, seq: q.seq, reason: q.reason, actorAdminAccountId: q.actorAdminAccountId, actorRole: q.actorRole },
      nowMs: this.nowMs(),
    });
    return bundle;
  }
}

export interface CheckpointRow {
  id: string;
  from_seq: number | string;
  to_seq: number | string;
  root_hash: string;
  prev_hash: string;
  reason: string;
  actor_ref: string;
  created_at: Date | string;
  signature: string | null;
  key_id: string | null;
  anchor_ref: string | null;
  anchored_at: Date | string | null;
  no: number | string | null;
  leaf_count: number | string | null;
  kind: string | null;
  access_log_day_anchor: string | null;
  closed_events: unknown;
  checkpoint_json: string | null;
  checkpoint_hash: string | null;
  ots_state: string | null;
  ots_proof: Buffer | null;
  ots_upgraded_at: Date | string | null;
  published_at: Date | string | null;
}

/** 체크포인트 행을 읽는 칸(모든 읽기가 같은 꼴로 받는다) */
export const CHECKPOINT_COLUMNS = sql`id, from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash, reason, actor_ref, created_at,
  signature, key_id, anchor_ref, anchored_at, no, leaf_count, kind, encode(access_log_day_anchor, 'hex') as access_log_day_anchor, closed_events,
  checkpoint_json, encode(checkpoint_hash, 'hex') as checkpoint_hash, ots_state, ots_proof, ots_upgraded_at, published_at`;

const closedEventsOf = (raw: unknown): ClosedEvent[] | undefined => {
  const v = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((x) => (isObject(x) && typeof x.eventId === 'string' && typeof x.closedAt === 'string' ? [{ eventId: x.eventId, closedAtMs: Date.parse(x.closedAt) }] : []));
};
const kindOf = (v: string | null): AuditCheckpointKind | undefined => (v !== null && (AUDIT_CHECKPOINT_KINDS as readonly string[]).includes(v) ? (v as AuditCheckpointKind) : undefined);

export const toCheckpoint = (r: CheckpointRow): AuditCheckpoint => {
  const kind = kindOf(r.kind);
  const closed = r.closed_events === null || r.closed_events === undefined ? undefined : closedEventsOf(r.closed_events);
  return {
    checkpointId: r.id,
    fromSeq: Number(r.from_seq),
    toSeq: Number(r.to_seq),
    rootHash: r.root_hash,
    prevCheckpointHash: r.prev_hash,
    reason: r.reason,
    actorRef: r.actor_ref,
    createdAtMs: new Date(r.created_at).getTime(),
    ...(r.signature !== null ? { signature: r.signature } : {}),
    ...(r.key_id !== null ? { keyId: r.key_id } : {}),
    ...(r.anchor_ref !== null ? { anchorRef: r.anchor_ref } : {}),
    ...(r.anchored_at !== null ? { anchoredAtMs: new Date(r.anchored_at).getTime() } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(r.no !== null && r.no !== undefined ? { no: Number(r.no) } : {}),
    ...(r.leaf_count !== null && r.leaf_count !== undefined ? { leafCount: Number(r.leaf_count) } : {}),
    ...(r.checkpoint_json !== null && r.checkpoint_json !== undefined ? { checkpointJson: r.checkpoint_json } : {}),
    ...(r.checkpoint_hash !== null && r.checkpoint_hash !== undefined ? { checkpointHash: r.checkpoint_hash } : {}),
    ...(r.access_log_day_anchor !== null && r.access_log_day_anchor !== undefined ? { accessLogDayAnchor: r.access_log_day_anchor } : {}),
    ...(closed !== undefined ? { closedEvents: closed } : {}),
    ...(r.ots_state === 'PENDING' || r.ots_state === 'COMPLETE' ? { otsState: r.ots_state } : {}),
    ...(r.ots_proof !== null && r.ots_proof !== undefined ? { otsProof: Buffer.from(r.ots_proof) } : {}),
    ...(r.ots_upgraded_at !== null && r.ots_upgraded_at !== undefined ? { otsUpgradedAtMs: new Date(r.ots_upgraded_at).getTime() } : {}),
    ...(r.published_at !== null && r.published_at !== undefined ? { publishedAtMs: new Date(r.published_at).getTime() } : {}),
  };
};

/** PostgreSQL 감사 체인 읽기·쓰기. 체크포인트 표와 같은 DB를 쓴다. 게시 작업 역할(ops_audit_anchor)은 읽기만 부른다 */
@Injectable()
export class DrizzleAuditChain implements AuditChain, AuditChainReader {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async append(record: AuditRecord): Promise<void> {
    await this.database.transaction((tx) => appendAuditIn(tx, record));
  }

  async headSeq(): Promise<number> {
    const [row] = (await this.database.db.execute(sql`select last_seq from audit_chain_head where id = 1`)).rows as { last_seq: number | string }[];
    if (!row) throw new Error('audit_chain_head 행이 없다(마이그레이션 0000)');
    return Number(row.last_seq);
  }

  async headHash(): Promise<string> {
    const [row] = (await this.database.db.execute(sql`select encode(last_hash, 'hex') as last_hash from audit_chain_head where id = 1`)).rows as { last_hash: string }[];
    if (!row) throw new Error('audit_chain_head 행이 없다(마이그레이션 0000)');
    return row.last_hash;
  }

  async entriesBetween(fromSeq: number, toSeq: number): Promise<readonly AuditChainEntry[]> {
    if (toSeq < fromSeq) return [];
    const rows = (await this.database.db.execute(sql`
      select seq, encode(record_sha256, 'hex') as hash, encode(prev_hash, 'hex') as prev_hash, record_json, encode(leaf_salt, 'hex') as leaf_salt from audit_chain
      where seq between ${fromSeq}::bigint and ${toSeq}::bigint order by seq`)).rows as {
      seq: number | string;
      hash: string;
      prev_hash: string | null;
      record_json: unknown;
      leaf_salt: string | null;
    }[];
    return rows.map((r) => {
      const record = r.record_json === null ? undefined : auditRecordFromJson(r.record_json);
      return { seq: Number(r.seq), hash: r.hash, prevHash: r.prev_hash ?? '', ...(record !== undefined ? { record } : {}), ...(r.leaf_salt ? { leafSalt: r.leaf_salt } : {}) };
    });
  }

  async hashAt(seq: number): Promise<string | undefined> {
    if (seq <= 0) return '';
    const [row] = (await this.database.db.execute(sql`select encode(record_sha256, 'hex') as hash from audit_chain where seq = ${seq}::bigint`)).rows as { hash: string }[];
    return row?.hash;
  }

  /** 한 대상의 기록을 최근 순으로(권한 변경 내역). audit_chain(record_id, seq desc) 색인을 쓴다 */
  async entriesOfRecord(recordId: string, o: { cursor?: string; limit: number }): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
    const after = o.cursor && /^\d+$/.test(o.cursor) ? Number(o.cursor) : null;
    const rows = (
      await this.database.db.execute(sql`
        select seq, record_type, record_id, encode(record_sha256, 'hex') as hash, encode(prev_hash, 'hex') as prev_hash, record_json, created_at
        from audit_chain
        where record_id = ${recordId}::uuid and (${after}::bigint is null or seq < ${after}::bigint)
        order by seq desc limit ${o.limit + 1}`)
    ).rows as { seq: number | string; record_type: string; record_id: string; hash: string; prev_hash: string | null; record_json: unknown; created_at: Date | string }[];
    const page = rows.slice(0, o.limit);
    const entries = page.flatMap((r) => {
      const record = r.record_json === null ? undefined : auditRecordFromJson(r.record_json);
      return record === undefined
        ? []
        : [{ seq: Number(r.seq), recordType: r.record_type, recordId: r.record_id, hash: r.hash, prevHash: r.prev_hash ?? '', createdAtMs: new Date(r.created_at).getTime(), record }];
    });
    return { entries, nextCursor: rows.length > o.limit ? String(page[page.length - 1]!.seq) : null };
  }

  /**
   * record_json과 원본 행을 대조한다(B3-H03). 명령 기록은 ops_command·command_event·command_approval,
   * 체크포인트 기록은 audit_checkpoint를 다시 읽는다. 그 밖의 기록 종류는 원본 대조 대상이 아니다.
   */
  async sourceMatches(entry: AuditChainEntry): Promise<boolean> {
    const record = entry.record;
    if (!record) return false;
    const p = record.payload;
    const id = record.recordId;
    const exists = async (query: SQL): Promise<boolean> => (await this.database.db.execute(query)).rows.length > 0;
    switch (record.recordType) {
      case 'COMMAND_CREATED': {
        const [row] = (await this.database.db.execute(sql`
          select type, reason, requested_by, requested_role from ops_command where id = ${id}::uuid`)).rows as {
          type: string;
          reason: string;
          requested_by: string;
          requested_role: string;
        }[];
        if (!row || row.type !== p.type || row.reason !== p.reason || row.requested_by !== p.requestedBy) return false;
        const by = sql`actor_ref = ${row.requested_by} and actor_role = ${row.requested_role} and reason = ${row.reason}`;
        if (!(await exists(sql`select 1 from command_event where command_id = ${id}::uuid and seq = 1 and type = 'CREATED' and ${by}`))) return false;
        // 0021 이전 기록은 dry-run 사건 없이 두 번째 사건이 첫 상태다
        if (p.dryRunSha256 === undefined) return exists(sql`select 1 from command_event where command_id = ${id}::uuid and seq = 2 and type = ${String(p.state)} and ${by}`);
        const [dry] = (await this.database.db.execute(sql`select dry_run from command_event where command_id = ${id}::uuid and seq = 2 and type = 'DRY_RUN' and ${by}`)).rows as { dry_run: unknown }[];
        if (!dry || digestOf(dry.dry_run) !== p.dryRunSha256) return false;
        return exists(sql`select 1 from command_event where command_id = ${id}::uuid and seq = 3 and type = ${String(p.state)} and ${by}`);
      }
      case 'COMMAND_AUTO_ACTION': {
        const [row] = (await this.database.db.execute(sql`select type, reason, requested_by from ops_command where id = ${id}::uuid`)).rows as { type: string; reason: string; requested_by: string }[];
        if (!row || row.type !== p.type || row.reason !== p.reason || row.requested_by !== SYSTEM_REF || p.requestedBy !== SYSTEM_REF) return false;
        const [ev] = (await this.database.db.execute(sql`select dry_run from command_event where command_id = ${id}::uuid and seq = 1 and type = 'DISPATCHED' and actor_ref = ${SYSTEM_REF}`)).rows as { dry_run: unknown }[];
        return ev !== undefined && digestOf(ev.dry_run) === p.dryRunSha256;
      }
      case 'COMMAND_APPROVED':
      case 'COMMAND_REJECTED': {
        const decision = record.recordType === 'COMMAND_APPROVED' ? 'APPROVED' : 'REJECTED';
        // 승인 기한이 지나 시스템이 닫은 거부는 승인 행 없이 사건만 있다(ADR-0340 결정 4)
        if (p.approverRef === SYSTEM_REF) {
          return decision === 'REJECTED' && exists(sql`select 1 from command_event where command_id = ${id}::uuid and type = 'REJECTED' and actor_ref = ${SYSTEM_REF} and reason = 'approval-expired'`);
        }
        const [row] = (await this.database.db.execute(sql`
          select decision, approver_role, reason from command_approval where command_id = ${id}::uuid and approver_ref = ${String(p.approverRef)}`)).rows as {
          decision: string;
          approver_role: string;
          reason: string | null;
        }[];
        if (!row || row.decision !== decision || row.approver_role !== p.approverRole) return false;
        if ((row.reason ?? undefined) !== p.reason) return false;
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = ${decision}
            and actor_ref = ${String(p.approverRef)} and actor_role = ${String(p.approverRole)}`);
      }
      case 'COMMAND_EXECUTION_STARTED': {
        const [row] = (await this.database.db.execute(sql`select attempts from ops_command where id = ${id}::uuid`)).rows as { attempts: number | string }[];
        if (!row || Number(row.attempts) < Number(p.attempt)) return false;
        // 행위자는 시스템(처음 실행) 또는 다시 한 사람의 가명 참조다. 0021 이전 기록은 'system'
        const actor = typeof p.actorRef === 'string' ? p.actorRef : 'system';
        return exists(sql`select 1 from command_event where command_id = ${id}::uuid and type = 'DISPATCHED' and actor_ref = ${actor}`);
      }
      case 'COMMAND_EXECUTION_FAILED':
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = 'FAILED' and actor_ref in ('system', ${SYSTEM_REF}) and reason = ${String(p.reason)}`);
      case 'COMMAND_SUCCEEDED':
        return exists(sql`
          select 1 from command_event where command_id = ${id}::uuid and type = 'SUCCEEDED' and actor_ref in ('system', ${SYSTEM_REF}) and actor_role = 'system'`);
      case 'COMMAND_ACKED':
        return exists(sql`select 1 from command_event where command_id = ${id}::uuid and type = 'ACKED' and actor_ref = ${SYSTEM_REF}`);
      case 'EVENT_CANCELLATION_REQUESTED':
      case 'EVENT_CANCELLATION_JUDGED':
      case 'EVENT_CANCELLATION_APPROVED':
      case 'EVENT_CANCELLATION_REJECTED':
      case 'EVENT_CANCELLATION_PAUSED':
      case 'EVENT_CANCELLATION_RESUMED': {
        const [row] = (await this.database.db.execute(sql`
          select event_id, kind, reason, requested_by from event_cancellation_request where request_id = ${id}::uuid`)).rows as {
          event_id: string;
          kind: string;
          reason: string;
          requested_by: string;
        }[];
        if (!row) return false;
        return row.event_id === p.eventId && row.kind === p.kind && row.reason === p.requestReason && row.requested_by === p.requestedBy;
      }
      case 'PAYOUT_APPROVAL_REQUESTED':
      case 'PAYOUT_BATCH_EXECUTING':
      case 'PAYOUT_BATCH_DONE':
      case 'PAYOUT_BATCH_FAILED':
      case 'PAYOUT_APPROVAL_REJECTED': {
        const [row] = (await this.database.db.execute(sql`
          select batch_id, pg, pg_store, payout_date, amount, statement_count, requester_id from payout_approval where id = ${id}::uuid`)).rows as {
          batch_id: string;
          pg: string;
          pg_store: string;
          payout_date: string;
          amount: number | string;
          statement_count: number | string;
          requester_id: string;
        }[];
        if (!row) return false;
        return (
          row.batch_id === p.batchId &&
          row.pg === p.pg &&
          row.pg_store === p.pgStore &&
          row.payout_date === p.payoutDate &&
          Number(row.amount) === Number(p.amount) &&
          Number(row.statement_count) === Number(p.statementCount) &&
          row.requester_id === p.requesterId
        );
      }
      case 'PAYOUT_PORTONE_EXECUTION': {
        const [row] = (await this.database.db.execute(sql`
          select amount from payout_approval where batch_id = ${String(p.batchId)}::uuid limit 1`)).rows as { amount: number | string }[];
        return !row || Number(row.amount) === Number(p.amount);
      }
      case 'AUDIT_CHECKPOINT_CREATED': {
        const [row] = (await this.database.db.execute(sql`
          select from_seq, to_seq, encode(root_hash, 'hex') as root_hash, encode(prev_hash, 'hex') as prev_hash,
                 anchor_ref, signature, no, kind, encode(checkpoint_hash, 'hex') as checkpoint_hash
          from audit_checkpoint where id = ${id}::uuid`)).rows as {
          from_seq: number | string;
          to_seq: number | string;
          root_hash: string;
          prev_hash: string;
          anchor_ref: string | null;
          signature: string | null;
          no: number | string | null;
          kind: string | null;
          checkpoint_hash: string | null;
        }[];
        if (!row) return false;
        const base = Number(row.from_seq) === Number(p.fromSeq) && Number(row.to_seq) === Number(p.toSeq) && row.root_hash === p.rootHash && row.prev_hash === p.prevCheckpointHash;
        if (!base) return false;
        // 0023 뒤 기록(kind 있음)은 만들 때의 값만 대조한다(서명·게시 칸은 게시 작업이 나중에 채운다)
        if (p.kind !== undefined) {
          if (row.kind !== p.kind) return false;
          if (p.kind === 'EXECUTION') return row.no === null;
          return row.no !== null && Number(row.no) === Number(p.no) && row.checkpoint_hash === p.checkpointHash;
        }
        return (row.anchor_ref ?? undefined) === p.anchorRef && (row.signature ?? undefined) === p.signature;
      }
      default:
        return true;
    }
  }
}

/** 공개 번호를 고르는 트랜잭션 잠금(수동 생성과 게시 작업이 같은 값을 쓴다) */
export const PUBLIC_CHECKPOINT_LOCK = sql`pg_advisory_xact_lock(hashtextextended('ops.audit-checkpoint.public', 0))`;

const insertCheckpoint = async (tx: DbTransaction, input: NewAuditCheckpoint): Promise<AuditCheckpoint> => {
  const closed = input.closedEvents ? JSON.stringify(input.closedEvents.map((e) => ({ eventId: e.eventId, closedAt: new Date(e.closedAtMs).toISOString() }))) : null;
  // 서명·게시 칸은 게시 작업만 쓴다(ADR-0348 결정 1·4, 리뷰 RV-01). API 역할(ops_app)에는 그 칸의 INSERT 권한이 없고,
  // PostgreSQL은 값이 NULL이어도 문장에 이름을 대면 칸 권한을 보므로, 값이 있을 때만 문장에 넣는다(제품 경로는 늘 비운다).
  const anchored = input.signature !== undefined || input.keyId !== undefined || input.anchorRef !== undefined || input.anchoredAtMs !== undefined;
  const anchorColumns = anchored ? sql`, signature, key_id, anchor_ref, anchored_at` : sql``;
  const anchorValues = anchored
    ? sql`, ${input.signature ?? null}, ${input.keyId ?? null}, ${input.anchorRef ?? null}, ${
        input.anchoredAtMs !== undefined ? sql`${new Date(input.anchoredAtMs)}::timestamptz` : sql`null`
      }`
    : sql``;
  const [row] = (await tx.execute(sql`
    insert into audit_checkpoint (id, from_seq, to_seq, root_hash, prev_hash, reason, actor_ref, created_at,
                                  no, leaf_count, kind, access_log_day_anchor, closed_events, checkpoint_json, checkpoint_hash${anchorColumns})
    values (${input.checkpointId}::uuid, ${input.fromSeq}::bigint, ${input.toSeq}::bigint, decode(${input.rootHash}, 'hex'), decode(${input.prevCheckpointHash || ''}, 'hex'),
            ${input.reason}, ${input.actorRef}, ${new Date(input.nowMs)}::timestamptz,
            ${input.no ?? null}::bigint, ${input.leafCount ?? null}::int, ${input.kind ?? null},
            ${input.accessLogDayAnchor !== undefined ? sql`decode(${input.accessLogDayAnchor}, 'hex')` : sql`null`},
            ${closed}::jsonb, ${input.checkpointJson ?? null},
            ${input.checkpointHash !== undefined ? sql`decode(${input.checkpointHash}, 'hex')` : sql`null`})${anchorValues}
    returning ${CHECKPOINT_COLUMNS}`)).rows as unknown as CheckpointRow[];
  if (!row) throw new Error('감사 체크포인트를 쓰지 못했다');
  return toCheckpoint(row);
};

const selectOne = async (tx: { execute: DbTransaction['execute'] }, where: SQL): Promise<AuditCheckpoint | undefined> => {
  const [row] = (await tx.execute(sql`select ${CHECKPOINT_COLUMNS} from audit_checkpoint ${where} limit 1`)).rows as unknown as CheckpointRow[];
  return row ? toCheckpoint(row) : undefined;
};

/** 공개 행의 겹침 규칙(잠금 안). 쓸 수 있으면 undefined, 있는 행이면 그 행 */
async function checkPublicIn(tx: DbTransaction, input: NewAuditCheckpoint): Promise<AuditCheckpoint | undefined> {
  await tx.execute(sql`select ${PUBLIC_CHECKPOINT_LOCK}`);
  const last = await selectOne(tx, sql`where no is not null order by no desc`);
  const fit = publicCheckpointFits(last, input);
  if (fit === 'RACE') throw new CheckpointRaceLost();
  return fit === 'OK' ? undefined : fit.existing;
}

@Injectable()
export class DrizzleAuditCheckpointStore implements AuditCheckpointStore {
  constructor(@Inject(DATABASE) protected readonly database: Database) {}

  /** 체크포인트 행과 AUDIT_CHECKPOINT_CREATED를 한 트랜잭션에 쓴다. 공개 행은 번호 잠금, 내부 행은 audit_chain_head 행 잠금으로 같은 구간 중복을 막는다 */
  async createWithAudit(input: NewAuditCheckpoint, record: AuditRecord): Promise<AuditCheckpoint> {
    return this.database.transaction(async (tx) => {
      if (input.no !== undefined) {
        const existing = await checkPublicIn(tx, input);
        if (existing) return existing;
      } else {
        await tx.execute(sql`select 1 from audit_chain_head where id = 1 for update`);
        const existing = await selectOne(tx, sql`where from_seq = ${input.fromSeq}::bigint and (kind is null or kind = 'EXECUTION')`);
        if (existing) return existing;
      }
      const row = await insertCheckpoint(tx, input);
      await appendAuditIn(tx, record);
      return row;
    });
  }

  /** 기록 없이 쓴다(게시 작업의 일·회차 마감 체크포인트). 공개 행은 번호 잠금 안에서 이어지는지 본다 */
  async create(input: NewAuditCheckpoint): Promise<AuditCheckpoint> {
    return this.database.transaction(async (tx) => {
      if (input.no !== undefined) {
        const existing = await checkPublicIn(tx, input);
        if (existing) return existing;
      }
      return insertCheckpoint(tx, input);
    });
  }

  async list(limit: number): Promise<readonly AuditCheckpoint[]> {
    const rows = (await this.database.db.execute(sql`select ${CHECKPOINT_COLUMNS} from audit_checkpoint order by created_at desc, to_seq desc limit ${limit}`)).rows as unknown as CheckpointRow[];
    return rows.map(toCheckpoint);
  }

  async find(checkpointId: string): Promise<AuditCheckpoint | undefined> {
    return selectOne(this.database.db, sql`where id = ${checkpointId}::uuid`);
  }

  async head(): Promise<AuditCheckpoint | undefined> {
    return selectOne(this.database.db, sql`order by to_seq desc, created_at desc`);
  }

  async findPrevious(fromSeq: number): Promise<AuditCheckpoint | undefined> {
    return selectOne(this.database.db, sql`where (kind is null or kind = 'EXECUTION') and to_seq < ${fromSeq}::bigint order by to_seq desc`);
  }

  async lastPublic(): Promise<AuditCheckpoint | undefined> {
    return selectOne(this.database.db, sql`where no is not null order by no desc`);
  }

  async lastInternal(): Promise<AuditCheckpoint | undefined> {
    return selectOne(this.database.db, sql`where kind is null or kind = 'EXECUTION' order by to_seq desc, created_at desc`);
  }

  async findByNo(no: number): Promise<AuditCheckpoint | undefined> {
    return selectOne(this.database.db, sql`where no = ${no}::bigint`);
  }

  /** 서명 전 공개 행(번호 차례) */
  async unsignedPublic(limit: number): Promise<readonly AuditCheckpoint[]> {
    const rows = (await this.database.db.execute(sql`select ${CHECKPOINT_COLUMNS} from audit_checkpoint where no is not null and signature is null order by no limit ${limit}`)).rows as unknown as CheckpointRow[];
    return rows.map(toCheckpoint);
  }

  /** 신호 요약(checkpoint-signals.ts): 마지막 게시 시각, PENDING 수, 가장 오래된 미게시·PENDING 행 */
  async snapshot(): Promise<CheckpointSignalSnapshot> {
    const [row] = (
      await this.database.db.execute(sql`
        select (select max(published_at) from audit_checkpoint where no is not null) as last_published,
               (select count(*) from audit_checkpoint where ots_state = 'PENDING') as pending,
               (select no from audit_checkpoint where no is not null and published_at is null order by created_at, no limit 1) as unpub_no,
               (select created_at from audit_checkpoint where no is not null and published_at is null order by created_at, no limit 1) as unpub_at,
               (select no from audit_checkpoint where ots_state = 'PENDING' order by created_at, no limit 1) as pend_no,
               (select created_at from audit_checkpoint where ots_state = 'PENDING' order by created_at, no limit 1) as pend_at`)
    ).rows as { last_published: Date | string | null; pending: number | string; unpub_no: number | string | null; unpub_at: Date | string | null; pend_no: number | string | null; pend_at: Date | string | null }[];
    if (!row) return { pendingOts: 0 };
    return {
      ...(row.last_published !== null ? { lastPublishedAtMs: new Date(row.last_published).getTime() } : {}),
      pendingOts: Number(row.pending),
      ...(row.unpub_no !== null && row.unpub_at !== null ? { oldestUnpublished: { no: Number(row.unpub_no), createdAtMs: new Date(row.unpub_at).getTime() } } : {}),
      ...(row.pend_no !== null && row.pend_at !== null ? { oldestPending: { no: Number(row.pend_no), createdAtMs: new Date(row.pend_at).getTime() } } : {}),
    };
  }

  async signingKey(keyId: string): Promise<AuditSigningKey | undefined> {
    const [row] = (await this.database.db.execute(sql`select key_id, public_key_spki, alg, first_used_at from audit_signing_key where key_id = ${keyId}`)).rows as {
      key_id: string;
      public_key_spki: Buffer;
      alg: string;
      first_used_at: Date | string;
    }[];
    return row ? { keyId: row.key_id, publicKeySpki: Buffer.from(row.public_key_spki), alg: row.alg, firstUsedAtMs: new Date(row.first_used_at).getTime() } : undefined;
  }
}
