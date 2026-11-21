// 셔플 커밋 공시를 ops 감사 체인의 SYSTEM 기록으로 보내는 어댑터(BAT-355 OPS-270, ADR-0341 결정 7, ADR-0232 결정 10,
// docs/features/queue-admission.md §2 '공시 감사 기록'). 조립(start.ts의 opsAudit 칸)은 BAT-059 뒤라 어댑터를 바깥 경계(HTTP 클라이언트 포트)에서 본다.
// 정본: POST /internal/v1/ops/audit-records, recordType SHUFFLE_COMMIT_DISCLOSED, 사건 키 shuffle-commit:{회차}:{구간}:{커밋},
// 공시를 막지 않고 한 번 2초 [가정], 실패하면 같은 사건 키로 3번 [가정](0.5·1·2초 [가정] 뒤) 다시 보낸 뒤 정규 로그 줄, 본문 거절(400)은 다시 보내지 않는다.
import { Writable } from 'node:stream';
import { createPlatformLogger, fakeClock, type ExternalHttpClient, type ExternalRequest } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { OpsAuditShuffleDisclosures } from '../src/modules/entry/adapters/ops-audit-disclosures.js';
import type { ShuffleDisclosure } from '../src/modules/entry/domain/ports.js';

const AT = Date.parse('2026-11-22T08:00:00.000Z');
const EVENT = '0194b355-0000-7000-8000-0000000000e1';
const COMMIT = 'c0'.repeat(32);
const disclosure = (over: Partial<ShuffleDisclosure> = {}): ShuffleDisclosure => ({ eventId: EVENT, group: 'lobby', commit: COMMIT, chain: 'quicknet', round: 7_654_321, algorithm: 'shuffle-v1', atMs: AT, ...over });

/** ops 내부 HTTP 대역: 받은 요청을 적고, 차례로 정한 답(상태 코드 또는 던질 오류)을 준다 */
function opsDouble(answers: Array<number | Error>) {
  const requests: ExternalRequest[] = [];
  const request = vi.fn<ExternalHttpClient['request']>(async (r) => {
    requests.push(r);
    const a = answers.shift() ?? 202;
    if (a instanceof Error) throw a;
    return new Response(a === 202 ? JSON.stringify({ accepted: true, seq: 1 }) : '{}', { status: a, headers: { 'content-type': 'application/json' } });
  });
  return { ops: { request } satisfies Pick<ExternalHttpClient, 'request'>, requests };
}
function logLines() {
  const lines: Array<Record<string, unknown>> = [];
  const dest = new Writable({
    write(chunk, _e, cb) {
      for (const l of String(chunk).split('\n').filter(Boolean)) lines.push(JSON.parse(l) as Record<string, unknown>);
      cb();
    },
  });
  return { logger: createPlatformLogger({ service: 'queue-svc', env: 'ci', version: 'test', clock: fakeClock({ now: AT }), level: 'info', destination: dest }), lines };
}

describe('OPS-270 셔플 커밋 공시의 ops 감사 기록', () => {
  test('OPS-270 공시는 POST /internal/v1/ops/audit-records에 SHUFFLE_COMMIT_DISCLOSED·사건 키 shuffle-commit:{회차}:{구간}:{커밋}·내부 토큰·2초 상한으로 한 번 보내고 로그 줄을 남기지 않는다', async () => {
    const d = opsDouble([202]);
    const log = logLines();
    const sleeps: number[] = [];
    const a = new OpsAuditShuffleDisclosures({ ops: d.ops, internalToken: 'queue-to-ops', logger: log.logger, sleep: async (ms) => void sleeps.push(ms) });
    expect(await a.send(disclosure())).toBe(true);
    expect(d.requests).toHaveLength(1);
    const r = d.requests[0]!;
    expect({ method: r.method, path: r.path, timeoutCapMs: r.timeoutCapMs, headers: r.headers }).toEqual({
      method: 'POST',
      path: '/internal/v1/ops/audit-records',
      timeoutCapMs: 2_000,
      headers: { 'content-type': 'application/json', 'x-peaket-internal-token': 'queue-to-ops' },
    });
    expect(JSON.parse(String(r.body))).toEqual({
      eventKey: `shuffle-commit:${EVENT}:lobby:${COMMIT}`,
      recordType: 'SHUFFLE_COMMIT_DISCLOSED',
      recordId: EVENT,
      payload: { eventId: EVENT, group: 'lobby', commit: COMMIT, chain: 'quicknet', round: 7_654_321, algorithm: 'shuffle-v1' },
      occurredAt: new Date(AT).toISOString(),
    });
    expect(sleeps).toEqual([]);
    expect(log.lines.filter((l) => l.audit === 'shuffle_commit_disclosed')).toEqual([]);
    // 묶음 번호 구간은 사건 키에 그 번호가 들어간다
    const b = opsDouble([202]);
    await new OpsAuditShuffleDisclosures({ ops: b.ops }).send(disclosure({ group: 12, commit: 'd1'.repeat(32) }));
    expect(JSON.parse(String(b.requests[0]!.body))).toMatchObject({ eventKey: `shuffle-commit:${EVENT}:12:${'d1'.repeat(32)}`, payload: { group: 12 } });
  });

  test('OPS-270 연결 실패·5xx는 같은 사건 키로 3번(0.5·1·2초 뒤) 다시 보내고, 모두 실패하면 정규 로그 줄 shuffle_commit_disclosed를 남긴다', async () => {
    const d = opsDouble([new Error('ECONNREFUSED'), 503, new Error('timeout'), 500]);
    const log = logLines();
    const sleeps: number[] = [];
    const a = new OpsAuditShuffleDisclosures({ ops: d.ops, internalToken: 't', logger: log.logger, sleep: async (ms) => void sleeps.push(ms) });
    expect(await a.send(disclosure())).toBe(false);
    expect(d.requests).toHaveLength(4);
    expect(new Set(d.requests.map((r) => JSON.parse(String(r.body)).eventKey))).toEqual(new Set([`shuffle-commit:${EVENT}:lobby:${COMMIT}`]));
    expect(sleeps).toEqual([500, 1_000, 2_000]);
    expect(log.lines.filter((l) => l.audit === 'shuffle_commit_disclosed')).toEqual([
      expect.objectContaining({ audit: 'shuffle_commit_disclosed', eventId: EVENT, group: 'lobby', commit: COMMIT, chain: 'quicknet', round: 7_654_321, algorithm: 'shuffle-v1', atMs: AT }),
    ]);
    // 두 번째 시도에 받으면 거기서 멈추고 로그 줄이 없다
    const e = opsDouble([503, 202]);
    const log2 = logLines();
    const sleeps2: number[] = [];
    expect(await new OpsAuditShuffleDisclosures({ ops: e.ops, logger: log2.logger, sleep: async (ms) => void sleeps2.push(ms) }).send(disclosure())).toBe(true);
    expect([e.requests.length, sleeps2]).toEqual([2, [500]]);
    expect(log2.lines.filter((l) => l.audit === 'shuffle_commit_disclosed')).toEqual([]);
  });

  test('OPS-270 본문 거절(400)은 다시 보내지 않고 로그 줄을 남기며, committed()는 보내기를 기다리지 않는다(공시를 막지 않는다)', async () => {
    const d = opsDouble([400]);
    const log = logLines();
    const sleeps: number[] = [];
    expect(await new OpsAuditShuffleDisclosures({ ops: d.ops, logger: log.logger, sleep: async (ms) => void sleeps.push(ms) }).send(disclosure())).toBe(false);
    expect([d.requests.length, sleeps]).toEqual([1, []]);
    expect(log.lines.filter((l) => l.audit === 'shuffle_commit_disclosed')).toHaveLength(1);

    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => (resolve = r));
    const request = vi.fn<ExternalHttpClient['request']>(() => pending);
    const a = new OpsAuditShuffleDisclosures({ ops: { request } });
    expect(a.committed(disclosure())).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    resolve(new Response('{}', { status: 202 }));
    await pending;
  });
});
