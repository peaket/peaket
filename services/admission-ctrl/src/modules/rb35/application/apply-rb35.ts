// RB-35 적용(ADR-0239 결정 7~12). 리더(대상 서비스)가 배포된 공개키로 다시 검증하고, 지금 상태와 맞을 때만 적용한다. CLI는 전달만 한다.
import type { Clock } from '@peaket/platform';
import { BEACON_MIN_DELAY_MS, drandRoundAfter, drandRoundTimeMs, isEmergencyStopReason } from '@peaket/shuffle';
import { fixAtOf, type BatchSchedule, type ShuffleGroup } from '../../batch/index.js';
import { parseSigned, RECOMMIT_MIN_LEAD_MS, ROUND_PUBLIC_MARGIN_MS, type Rb35Bundle, type Rb35Command, type SignedBundle } from '../domain/bundle.js';
import { type Rb35Kind, type Rb35Store } from '../domain/ports.js';
import { type CommanderKey, verifySigned } from '../domain/verify.js';

const WAIT_REASONS = ['beacon', 'seed_unavailable'];
const RECOMMIT_REASONS = ['stale_round', 'late_commit', 'late_root'];
const STOP_REASON = /^\d+:([a-z_]+)$/;

export type Rb35Outcome = { status: 'applied'; commandId: string } | { status: 'rejected'; commandId: string | null; reason: string };

export interface Rb35Signals {
  applied(c: { command: Rb35Command; eventId: string; group: ShuffleGroup; commandId: string; signers: string[]; reason: string }): void;
  rejected(command: string, reason: string): void;
}
export const noRb35Signals: Rb35Signals = { applied: () => undefined, rejected: () => undefined };

const kindOf: Record<Rb35Command, Rb35Kind> = { 'rb35.wait': 'wait', 'rb35.emergency-shuffle': 'emergency', 'rb35.recommit': 'recommit' };

export class ApplyRb35 {
  constructor(
    private readonly store: Rb35Store,
    private readonly keys: ReadonlyMap<string, CommanderKey>,
    private readonly clock: Clock,
    private readonly signals: Rb35Signals = noRb35Signals,
  ) {}

  async run(eventId: string, group: ShuffleGroup, raw: string): Promise<Rb35Outcome> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const signed: SignedBundle | null = parseSigned(parsed);
    if (!signed) return this.#reject(eventId, group, null, raw, 'unknown', 'shape');
    const b = signed.bundle;
    const now = this.clock.now();
    const verified = verifySigned(signed, this.keys, now);
    if (!verified.ok) return this.#reject(eventId, group, b.commandId, raw, b.command, verified.reason);
    if (b.target.eventId !== eventId || b.target.group !== group) return this.#reject(eventId, group, b.commandId, raw, b.command, 'target');
    const schedule = await this.store.scheduleOf(eventId);
    if (!schedule) return this.#reject(eventId, group, b.commandId, raw, b.command, 'not_eligible');
    const refusal = this.#refusal(b, schedule, now);
    if (refusal) return this.#reject(eventId, group, b.commandId, raw, b.command, refusal);
    const stopReason = STOP_REASON.exec(b.params.stop ?? '')?.[1];
    const scheduled = drandRoundAfter(fixAtOf(schedule, group));
    const result = await this.store.apply({
      eventId,
      group,
      commandId: b.commandId,
      kind: kindOf[b.command],
      raw,
      expect: { stop: b.params.stop, commit: b.params.commit, round: b.params.round },
      expireAtMs: schedule.startsAtMs,
      reason: b.params.reason,
      signedJson: JSON.stringify(signed),
      ...(b.command === 'rb35.wait' ? { extendMs: b.params.extendSec! * 1_000 } : {}),
      ...(b.command === 'rb35.emergency-shuffle' ? { stopReason: stopReason! } : {}),
      ...(b.command === 'rb35.recommit'
        ? {
            newRound: b.params.newRound!,
            newRoundTimeMs: drandRoundTimeMs(b.params.newRound!),
            minLeadMs: RECOMMIT_MIN_LEAD_MS,
            minDelayMs: BEACON_MIN_DELAY_MS,
            currentRoundTimeMs: drandRoundTimeMs(b.params.round),
            publicMarginMs: ROUND_PUBLIC_MARGIN_MS,
            // 일정이 바뀌어서 하는 다시 공시만 일정 조건을 건다(늦은 커밋·늦은 루트는 일정과 상관없다)
            ...(b.params.stop === null || stopReason === 'stale_round' ? { scheduledRound: scheduled } : {}),
          }
        : {}),
    });
    if (result !== 'applied') {
      this.signals.rejected(b.command, result);
      return { status: 'rejected', commandId: b.commandId, reason: result };
    }
    this.signals.applied({ command: b.command, eventId, group, commandId: b.commandId, signers: signed.signatures.map((s) => s.signer), reason: b.params.reason });
    return { status: 'applied', commandId: b.commandId };
  }

  /** 멈춘 이유·일정·라운드가 이 명령을 받을 수 있는가(ADR-0239 결정 9). 받을 수 없으면 거절 이유 */
  #refusal(b: Rb35Bundle, schedule: BatchSchedule, nowMs: number): string | null {
    const reason = STOP_REASON.exec(b.params.stop ?? '')?.[1];
    if (b.command === 'rb35.wait') return reason !== undefined && WAIT_REASONS.includes(reason) ? null : 'not_eligible';
    // 비상 셔플은 비콘 지연에서만 받는다(ADR-0239 결정 9). 그 밖의 이유는 다시 공시로 비콘을 유지한다
    if (b.command === 'rb35.emergency-shuffle') return isEmergencyStopReason(reason) ? null : 'not_eligible';
    const fixAt = fixAtOf(schedule, b.target.group);
    const scheduled = drandRoundAfter(fixAt);
    if (b.params.stop === null) {
      if (b.params.round === scheduled) return 'not_eligible';
    } else if (reason === undefined || !RECOMMIT_REASONS.includes(reason)) {
      return 'not_eligible';
    }
    // 새 라운드는 ADR의 공식 그대로다: 고르는 사람이 더 뒤의 라운드를 골라 결과를 다시 뽑지 못하게 한다(ADR-0239 결정 12)
    const newRound = b.params.newRound!;
    if (newRound !== Math.max(scheduled, drandRoundAfter(b.expiresAt, RECOMMIT_MIN_LEAD_MS))) return 'not_eligible';
    if (drandRoundTimeMs(newRound) - nowMs < RECOMMIT_MIN_LEAD_MS) return 'too_late';
    return null;
  }

  async #reject(eventId: string, group: ShuffleGroup, commandId: string | null, raw: string, command: string, reason: string): Promise<Rb35Outcome> {
    await this.store.reject(eventId, group, commandId, raw, reason);
    this.signals.rejected(command, reason);
    return { status: 'rejected', commandId, reason };
  }
}
