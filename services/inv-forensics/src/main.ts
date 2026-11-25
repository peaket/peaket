// inv-forensics 실행기(F-04-11 동결 로컬). 계산 결과를 JSON 한 줄로 낸다.
// ops DB 영속화와 ops_event는 F-04-12가 ops-svc 조사 모듈에 붙인다(계획 §10).
import { readFileSync } from 'node:fs';
import { computeClusters, RULE_VERSION, type ExternalPost } from './cluster.js';
import { ClickHouseReader, ingestProgressAt, loadClusterInput, loadSnapshotTables } from './clickhouse.js';
import { buildSnapshot, freezeDecision } from './snapshot.js';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const required = (name: string): string => {
  const v = arg(name);
  if (!v) throw new Error(`--${name} 값이 필요하다`);
  return v;
};
const ms = (name: string): number => {
  const t = Date.parse(required(name));
  if (!Number.isFinite(t)) throw new Error(`--${name} 시각이 ISO 8601이 아니다`);
  return t;
};

function reader(): ClickHouseReader {
  const baseUrl = process.env.PEAKET_CLICKHOUSE_URL ?? 'http://127.0.0.1:8123';
  return new ClickHouseReader({
    baseUrl,
    user: process.env.PEAKET_INV_READER_USER ?? 'inv_reader',
    password: process.env.PEAKET_INV_READER_PASSWORD ?? '',
  });
}

async function main(): Promise<void> {
  const command = args[0];
  if (command === 'snapshot') {
    const eventId = required('event');
    const version = Number(required('version'));
    const frozenAt = ms('frozen-at');
    const rangeFrom = arg('range-from') ? ms('range-from') : null;
    const prevHash = arg('prev-hash') ?? null;
    const late = args.includes('--late');
    const tables = await loadSnapshotTables(reader(), { eventId, from: rangeFrom, to: frozenAt });
    const snapshot = buildSnapshot({ eventId, version, frozenAt, prevHash, rangeFrom, late, tables });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
    return;
  }
  if (command === 'cluster') {
    const eventId = required('event');
    const limitPerPerson = Number(required('limit'));
    const saleStartMs = ms('sale-start');
    const snapshotVersion = Number(arg('snapshot-version') ?? '1');
    const postsPath = arg('posts');
    const posts = postsPath ? (JSON.parse(readFileSync(postsPath, 'utf8')) as ExternalPost[]) : [];
    const input = await loadClusterInput(reader(), {
      eventId,
      saleStartMs,
      limitPerPerson,
      snapshotVersion,
      ruleVersion: arg('rule-version') ?? RULE_VERSION,
      posts,
    });
    process.stdout.write(`${JSON.stringify(computeClusters(input))}\n`);
    return;
  }
  if (command === 'freeze') {
    const windowEndsAt = ms('window-end');
    const now = ms('now');
    const progress = arg('progress') ? ms('progress') : await ingestProgressAt(reader());
    process.stdout.write(`${JSON.stringify(freezeDecision({ windowEndsAt, now, ingestProgressAt: progress }))}\n`);
    return;
  }
  throw new Error('명령: snapshot | cluster | freeze');
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
