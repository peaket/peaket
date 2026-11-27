// F-02-6(동결 로컬) 엣지·WAF·CDN 포트 계약 시험. 구현 전 트리에서는 새 모듈이 없어 실행 전에 실패한다.
// 구현이 끝나면 이 파일이 포트·가짜의 계약(명령 4 WAF, 명령 6 진입 Degraded, S3 사본 고정·매진 정적 응답)을 고정한다.
// 정본: docs/features/control-tower.md §3 명령 4·6, §5 'AWS WAF API'·'CDN 설정 API', §14 C-T44 ⑥,
// docs/features/queue-admission.md §4·§9, ADR-0078 결정 2, ADR-0223 결정 1·8·9, ADR-0234 결정 5, ADR-0349 결정 9·10.
// 실제 AWS 호출은 미실행·[가정]이다. 이 파일은 처리량·인원·K1/K2/K7 수치를 새로 주장하지 않는다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { EdgeCommandExecutor } from '../src/modules/commands/application/edge-command-executor.js';
import { MemoryCdnEdgeSettings } from '../src/modules/commands/adapters/memory-cdn-edge-settings.js';
import { MemoryEntryMode } from '../src/modules/commands/adapters/memory-entry-mode.js';
import { MemoryWafBlocks } from '../src/modules/commands/adapters/memory-waf-blocks.js';
import { ExecuteCommand, MemoryAuditChain, MemoryCommandStore } from '../src/modules/commands/index.js';

const NOW = Date.parse('2026-11-28T00:00:00.000Z');
const HOUR = 60 * 60_000;
const REQUESTER = '0193a000-0000-7000-8000-0000000000f1';
const ACTOR = { accountId: REQUESTER, sessionId: '', role: 'commander' };
const NEXT = { execute: async () => ({ status: 'FAILED' as const, error: 'next-not-called' }) };

/** 명령 저장소와 실행기를 함께 만든다. approvalMode ONE은 실행·되돌리기 계약만 보려는 시험 지름길이다 */
async function fixture(type: 'BLOCK_ASN_IP' | 'DEGRADED_MODE', params: Record<string, unknown>) {
  const audit = new MemoryAuditChain();
  const store = new MemoryCommandStore(audit);
  const command = await store.create({
    commandId: randomUUID(),
    type,
    reason: '동결 로컬 F-02-6 포트 계약 시험',
    params,
    requestedBy: REQUESTER,
    requestedRole: 'commander',
    nowMs: NOW,
    approvalMode: 'ONE',
  });
  const waf = new MemoryWafBlocks();
  const entryMode = new MemoryEntryMode();
  const cdn = new MemoryCdnEdgeSettings();
  const edge = new EdgeCommandExecutor({ waf, entryMode, cdn, next: NEXT, nowMs: () => NOW });
  const execution = new ExecuteCommand(store, edge);
  return { audit, store, command, waf, entryMode, cdn, edge, execution };
}

const expiry = (ms: number) => new Date(ms).toISOString();

describe('F026-WAF 명령 4 WAF 포트', () => {
  test('F026-WAF ① 명령 4 CIDR·ASN을 WAF 포트에 넣고 ACKED가 되며 expiresAt이 명령 행에 남는다', async () => {
    const f = await fixture('BLOCK_ASN_IP', {
      cidrs: ['198.51.100.0/24', '2001:db8:1::/48'],
      asns: [64512, 64513],
      expiresAt: expiry(NOW + HOUR),
    });
    const out = await f.execution.run(f.command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect(out.expiresAtMs).toBe(NOW + HOUR);
    expect(await f.waf.remaining(f.command.commandId)).toEqual({
      cidrs: ['198.51.100.0/24', '2001:db8:1::/48'],
      asns: [64512, 64513],
    });
    // 같은 명령을 다시 넣어도 목록이 늘지 않는다(멱등)
    await f.waf.apply(f.command.commandId, { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAtMs: NOW + HOUR });
    expect((await f.waf.remaining(f.command.commandId)).cidrs).toEqual(['198.51.100.0/24', '2001:db8:1::/48']);
  });

  test('F026-WAF ② WAF가 실패하면 FAILED waf-unavailable이고 다시 하면 같은 명령 ID로 같은 목록을 다시 넣는다', async () => {
    const f = await fixture('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    f.waf.failApply = true;
    const failed = await f.execution.run(f.command, ACTOR, NOW);
    expect(failed.state).toBe('FAILED');
    expect(failed.lastError).toMatch(/^waf-unavailable/);
    // 다시 하기(T11): 같은 명령·같은 목록, WAF가 돌아오면 ACKED
    f.waf.failApply = false;
    const current = await f.store.find(f.command.commandId);
    expect(current).toBeDefined();
    const retried = await f.execution.run(current!, ACTOR, NOW + 1);
    expect(retried.state).toBe('ACKED');
    expect(await f.waf.remaining(f.command.commandId)).toEqual({ cidrs: ['198.51.100.0/24'], asns: [64512] });
  });

  test('F026-WAF ③ 손으로 풀기는 다른 살아 있는 명령 4가 막는 대역·ASN을 남긴다', async () => {
    const a = await fixture('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    const b = await fixture('BLOCK_ASN_IP', { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAt: expiry(NOW + HOUR) });
    await a.waf.apply(a.command.commandId, { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAtMs: NOW + HOUR });
    await a.waf.apply(b.command.commandId, { cidrs: ['198.51.100.0/24'], asns: [64512], expiresAtMs: NOW + HOUR });
    await a.waf.release(a.command.commandId);
    expect(await a.waf.remaining(a.command.commandId)).toEqual({ cidrs: [], asns: [] });
    expect(await a.waf.remaining(b.command.commandId)).toEqual({ cidrs: ['198.51.100.0/24'], asns: [64512] });
    // 마지막 소유자가 풀면 빠진다
    await a.waf.release(b.command.commandId);
    expect(await a.waf.remaining(b.command.commandId)).toEqual({ cidrs: [], asns: [] });
  });
});

describe('F026-ENTRY·F026-CDN 명령 6 포트', () => {
  test('F026-ENTRY ⑤ ENTRY_DEGRADED 실행은 mode:entry에 on과 expireAtMs를 쓰고 되돌리기는 on=false를 쓴다', async () => {
    const f = await fixture('DEGRADED_MODE', { mode: 'ENTRY_DEGRADED', expiresAt: expiry(NOW + HOUR) });
    const out = await f.execution.run(f.command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect(f.entryMode.value).toEqual({ on: true, expireAtMs: NOW + HOUR });
    const reverted = await f.edge.revert(out, ACTOR);
    expect(reverted.status).toBe('ACKED');
    expect(f.entryMode.value).toEqual({ on: false, expireAtMs: NOW });
  });

  test('F026-CDN ① STATE_MIRROR_FIXED는 queue-files 원본을 S3 사본으로 고정하고 되돌리기는 원본 그룹으로 돌린다', async () => {
    const f = await fixture('DEGRADED_MODE', { mode: 'STATE_MIRROR_FIXED' });
    const before = await f.cdn.read();
    expect(before.queueFilesOrigin).toBe('ORIGIN_GROUP');
    const out = await f.execution.run(f.command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect((await f.cdn.read()).queueFilesOrigin).toBe('S3_FALLBACK');
    const reverted = await f.edge.revert(out, ACTOR);
    expect(reverted.status).toBe('ACKED');
    expect((await f.cdn.read()).queueFilesOrigin).toBe('ORIGIN_GROUP');
  });

  test('F026-CDN ② SOLD_OUT_STATIC은 queue 진입 응답을 정적 매진으로 바꾸고 되돌리기는 원본으로 돌린다', async () => {
    const f = await fixture('DEGRADED_MODE', { mode: 'SOLD_OUT_STATIC' });
    expect((await f.cdn.read()).queueEntryResponse).toBe('ORIGIN');
    const out = await f.execution.run(f.command, ACTOR, NOW);
    expect(out.state).toBe('ACKED');
    expect((await f.cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    const reverted = await f.edge.revert(out, ACTOR);
    expect(reverted.status).toBe('ACKED');
    expect((await f.cdn.read()).queueEntryResponse).toBe('ORIGIN');
  });
});

describe('C-T44 ⑥ CloudFront 설정·S3 사본 고정 계약', () => {
  test('C-T44 ⑥ CloudFront 가짜의 원본 그룹은 500·502·503·504·연결 2초·시도 1회이고, S3 사본 고정은 해제 명령 전까지 유지된다', async () => {
    const cdn = new MemoryCdnEdgeSettings();
    expect((await cdn.read()).originGroup).toEqual({ failoverCodes: [500, 502, 503, 504], connectionTimeoutMs: 2_000, attempts: 1 });
    await cdn.apply({ stateMirrorFixed: true });
    // 다른 읽기·다른 스위치가 고정을 풀지 않는다
    await cdn.read();
    await cdn.apply({ soldOutStatic: true });
    expect((await cdn.read()).queueFilesOrigin).toBe('S3_FALLBACK');
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    // 해제 명령(되돌리기)만 원본 그룹으로 돌린다. 매진 정적 응답은 그대로다
    await cdn.apply({ stateMirrorFixed: false });
    expect((await cdn.read()).queueFilesOrigin).toBe('ORIGIN_GROUP');
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
  });

  test('C-T44 ⑥ 매진 정적 응답을 켜고 끄면 queue 배포의 진입 응답 모드가 바뀌고 S3 고정과 독립이다', async () => {
    const cdn = new MemoryCdnEdgeSettings();
    await cdn.apply({ soldOutStatic: true });
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    // S3 고정을 켜고 끄어도 매진 정적 응답은 그대로다
    await cdn.apply({ stateMirrorFixed: true });
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    await cdn.apply({ stateMirrorFixed: false });
    expect((await cdn.read()).queueEntryResponse).toBe('SOLD_OUT_STATIC');
    await cdn.apply({ soldOutStatic: false });
    expect((await cdn.read()).queueEntryResponse).toBe('ORIGIN');
  });
});

describe('F026-PORTS 공개 면', () => {
  test('F026-PORTS ① WafBlocks·EntryModeStore·CdnEdgeSettings·Memory* 포트 계약이 공개 면에 있다', async () => {
    const waf = new MemoryWafBlocks();
    const entry = new MemoryEntryMode();
    const cdn = new MemoryCdnEdgeSettings();
    expect(typeof waf.apply).toBe('function');
    expect(typeof waf.release).toBe('function');
    expect(typeof waf.remaining).toBe('function');
    expect(typeof entry.write).toBe('function');
    expect(typeof entry.read).toBe('function');
    expect(typeof cdn.read).toBe('function');
    expect(typeof cdn.apply).toBe('function');
    expect(await entry.read()).toBeUndefined();
  });
});
