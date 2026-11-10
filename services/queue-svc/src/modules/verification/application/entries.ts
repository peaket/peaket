// 추가 검증 유스케이스가 함께 쓰는 길: 회차 일정·판매 종료 확인, 사람 키로 대기 참여 찾기, 통과 응답 만들기.
// 대기 참여는 본문이 아니라 이 계정의 q:dup:{pid}:E가 가리키는 대기표로 찾는다(대기 취소와 같은 길, ADR-0233).
// pid 키 전환 기간에는 옛 pid → 새 pid 차례로 읽는다(입장 확정·대기 취소와 같은 차례, queue-admission §3 'pid 키 전환 기간'의 첫 구현).
import { type EventSchedule, type EventSchedules, saleEndOf } from '../../entry/index.js';
import type { VerificationStore } from '../domain/ports.js';
import { type EntryRef, entryRefOf, parseVerify, type VerifyValue } from '../domain/verification.js';
import { VerificationError } from './verification-error.js';

/** 대기 참여를 부르는 사람 */
export interface Caller {
  eventId: string;
  pid: string;
  /** pid 키 전환 기간의 옛 pid(X-User-Pid-Prev). 있고 pid와 다르면 두 키를 본다 */
  pidPrev?: string;
}

export interface FoundEntry {
  /** 이 기록이 있던 사람 키의 pid */
  pid: string;
  ref: EntryRef;
  /** verify 칸 필드(번호 기록에 대기표 해시가 없으면 없다) */
  fieldHash?: string;
  verify: VerifyValue | null;
}

/** 옛 pid부터 읽는 사람 키 차례 */
export const personsOf = (c: Caller): string[] => (c.pidPrev && c.pidPrev !== c.pid ? [c.pidPrev, c.pid] : [c.pid]);

export async function scheduleOf(schedules: EventSchedules, eventId: string): Promise<EventSchedule> {
  const s = await schedules.get(eventId);
  if (!s) throw new VerificationError('NOT_FOUND', '이 회차의 대기열이 열리지 않았다');
  return s;
}

/** 판매 종료 뒤의 제출·이의는 410 sale-ended다 */
export async function openScheduleOf(schedules: EventSchedules, eventId: string, now: number): Promise<EventSchedule> {
  const s = await scheduleOf(schedules, eventId);
  if (now >= saleEndOf(s)) throw new VerificationError('SALE_ENDED', '판매 종료 뒤의 추가 검증');
  return s;
}

export async function findEntry(store: VerificationStore, c: Caller): Promise<FoundEntry> {
  for (const pid of personsOf(c)) {
    const ref = entryRefOf(await store.readDup(pid, c.eventId));
    if (!ref) continue;
    const fieldHash = ref.fieldHash;
    const verify = fieldHash ? parseVerify(await store.readVerify(c.eventId, fieldHash)) : null;
    return { pid, ref, ...(fieldHash ? { fieldHash } : {}), verify };
  }
  throw new VerificationError('ENTRY_NOT_FOUND', '이 계정의 이 회차 대기 참여가 없다');
}

/** 원래 번호: 번호 기록은 그 번호, 로비 참가는 셔플 결과(게시 전이면 없다), 묶음 기록은 아직 없다 */
export async function seqOf(store: VerificationStore, e: FoundEntry): Promise<number | undefined> {
  if (e.ref.kind === 'NUMBER') return e.ref.seq;
  if (e.ref.kind === 'LOBBY') return (await store.lobbySeq(e.ref.fieldHash)) ?? undefined;
  return undefined;
}

/**
 * 유예 마감: 차례가 이미 왔을 때만 '차례와 통과 가운데 늦은 때 + 유예'(queue-admission §7, ADR-0259 결정 12). 차례 전이면 null이고 원래 번호의 차례에 입장한다.
 * 차례 시각 기록(serving_log)이 없으면 통과 시각으로 센다. 이미 통과한 참여에 다시 보낸 제출·이의·상태 읽기가 같은 계산을 쓴다
 */
export async function graceUntilOf(store: VerificationStore, eventId: string, seq: number | undefined, passedAtMs: number, graceMs: number): Promise<string | null> {
  if (seq === undefined) return null;
  const turn = await store.turnOf(eventId, seq);
  if (seq > turn.serving) return null;
  return new Date(Math.max(turn.turnAtMs ?? passedAtMs, passedAtMs) + graceMs).toISOString();
}

/** 200 PASSED 본문: 원래 번호와 유예 마감 */
export async function passedBody(store: VerificationStore, eventId: string, entry: FoundEntry, passedAtMs: number, graceMs: number): Promise<{ result: 'PASSED'; queueNumber?: number; graceUntil: string | null }> {
  const seq = await seqOf(store, entry);
  return { result: 'PASSED', ...(seq !== undefined ? { queueNumber: seq } : {}), graceUntil: await graceUntilOf(store, eventId, seq, passedAtMs, graceMs) };
}
