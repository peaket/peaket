// C-T7 ③: ack 시간 초과로 FAILED가 된 명령을 비상 런북 CLI 한 줄로 채운다(F-02-7, 계획 6.7).
// 런북 사유는 200자까지라 명령 사유(2,000자)가 넘으면 한 줄을 만들지 않는다.
import type { Command } from './command.js';

const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const MAX_REASON = 200;

const quote = (s: string): string => `"${s.replace(/[\\`"$]/g, (m) => `\\${m}`)}"`;

export function runbookCommandLine(c: Pick<Command, 'state' | 'type' | 'commandId' | 'reason' | 'eventId' | 'params'>): string | undefined {
  if (c.state !== 'FAILED') return undefined;
  if (c.reason.length === 0 || c.reason.length > MAX_REASON || CONTROL.test(c.reason)) return undefined;
  const commandId = c.commandId;
  const out = `--out runbook-${commandId}.json`;
  switch (c.type) {
    case 'KILL_SWITCH': {
      const platform = c.params.scope === 'PLATFORM' || c.eventId === undefined;
      const scope = platform ? '--scope platform' : `--event ${c.eventId}`;
      return `peaket-runbook draft sale-pause ${scope} --reason ${quote(c.reason)} --command-id ${commandId} ${out}`;
    }
    case 'ADMISSION_PAUSE': {
      if (c.eventId === undefined) return undefined;
      return `peaket-runbook draft admission-pause --event ${c.eventId} --reason ${quote(c.reason)} --param expiresInSec=600 --command-id ${commandId} ${out}`;
    }
    case 'AUTOMATION_STOP':
      return `peaket-runbook draft automation-stop --scope platform --reason ${quote(c.reason)} --command-id ${commandId} ${out}`;
    default:
      return undefined;
  }
}
