// 공시 기록의 RB-35 표시를 서명으로 다시 확인한다(ADR-0239 결정 15). 게시 직전에 부른다.
// 표시 칸에는 적용한 서명 묶음 원문이 함께 있다. 배포된 공개키로 서명을 다시 보고(만료는 적용 때만 본다) 회차·구간·커밋·라운드 묶임을 확인한다.
import { isEmergencyStopReason } from '@peaket/shuffle';
import type { RunbookAuth, ShuffleGroup, ShuffleRecord } from '../../batch/index.js';
import { parseSigned, type Rb35Bundle, type Rb35Command } from '../domain/bundle.js';
import { type CommanderKey, verifySignatures } from '../domain/verify.js';

const STOP_REASON = /^\d+:([a-z_]+)$/;

export class SignedMarkAuth implements RunbookAuth {
  constructor(private readonly keys: ReadonlyMap<string, CommanderKey>) {}

  authorized(eventId: string, group: ShuffleGroup, rec: ShuffleRecord): boolean {
    if (rec.emergency && !this.#emergency(eventId, group, rec)) return false;
    if (rec.recommits && !this.#recommits(eventId, group, rec)) return false;
    return true;
  }

  /** 서명이 맞고 이 구간·커밋의 묶음이면 묶음을 돌려준다 */
  #bundleOf(signed: unknown, eventId: string, group: ShuffleGroup, command: Rb35Command, commit: string): Rb35Bundle | null {
    const s = parseSigned(signed);
    if (!s) return null;
    const b = s.bundle;
    if (b.command !== command || b.target.eventId !== eventId || b.target.group !== group || b.params.commit !== commit) return null;
    return verifySignatures(s, this.keys).ok ? b : null;
  }

  #emergency(eventId: string, group: ShuffleGroup, rec: ShuffleRecord): boolean {
    const m = rec.emergency!;
    if (!isEmergencyStopReason(m.stopReason)) return false;
    const b = this.#bundleOf(m.signed, eventId, group, 'rb35.emergency-shuffle', rec.commit);
    if (!b || b.params.round !== rec.round || b.params.reason !== m.reason) return false;
    return STOP_REASON.exec(b.params.stop ?? '')?.[1] === m.stopReason;
  }

  /** 이력 전체를 본다: 줄마다 서명이 맞고, 이전 라운드와 새 라운드가 묶음과 같고, 앞 줄의 새 라운드에서 이어진다 */
  #recommits(eventId: string, group: ShuffleGroup, rec: ShuffleRecord): boolean {
    const list = rec.recommits!;
    return list.every((m, i) => {
      const b = this.#bundleOf(m.signed, eventId, group, 'rb35.recommit', rec.commit);
      if (!b || b.params.round !== m.prev || b.params.newRound !== m.round || b.params.reason !== m.reason) return false;
      return i === 0 || m.prev === list[i - 1]!.round;
    });
  }
}
