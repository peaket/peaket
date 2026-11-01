// ST-T18 시험 처리기(docs/streaming.md ST-T18). 시험 파일과 자식 프로세스(st18-child.mjs)가 같이 쓴다. 주문 Saga처럼 자기
// 트랜잭션에서 eventKey로 다시 받은 사건을 거른다(같은 eventKey는 한 번만 반영된다, unique 제약).
export const APPLIED_DDL = `create table if not exists st18_applied (
  id bigserial primary key, run text not null, event_key text not null, order_id text not null, seq int not null,
  topic text not null, part int not null, kafka_offset bigint not null, member text not null, unique (run, event_key))`;

/**
 * @param {{ pool: import('pg').Pool, run: string, member: string, delayMs?: number,
 *   transient?: (m: object) => boolean, hang?: (m: object) => Promise<void> | undefined, slow?: (e: object) => boolean, slowMs?: number,
 *   stats?: object }} o
 */
export function makeHandler(o) {
  const stats = o.stats ?? { maxPerPartition: 0, active: new Map(), duplicates: 0, applied: 0 };
  return {
    stats,
    decode: (m) => JSON.parse(m.value.toString('utf8')),
    keyOf: (e) => e.order,
    eventKeyOf: (e) => e.eventKey,
    async handle(e, m) {
      const k = `${m.topic}:${m.partition}`;
      const n = (stats.active.get(k) ?? 0) + 1;
      stats.active.set(k, n);
      if (n > stats.maxPerPartition) stats.maxPerPartition = n;
      try {
        if (o.transient?.(m)) {
          const err = new Error('저장소 연결 실패(시험)');
          err.name = 'TransientError';
          throw err;
        }
        const h = o.hang?.(m);
        if (h) await h;
        if (o.delayMs) await new Promise((r) => setTimeout(r, Math.random() * o.delayMs));
        // 오래 걸리는 사건(그 키의 줄만 막는다): 커밋 위치가 끝나지 않은 사건을 넘지 않는지 보려고 쓴다
        if (o.slow?.(e)) await new Promise((r) => setTimeout(r, o.slowMs ?? 2_000));
        const r = await o.pool.query(
          'insert into st18_applied (run, event_key, order_id, seq, topic, part, kafka_offset, member) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (run, event_key) do nothing returning id',
          [o.run, e.eventKey, e.order, e.seq, m.topic, m.partition, String(m.offset), o.member],
        );
        if (r.rowCount === 0) stats.duplicates += 1;
        else stats.applied += 1;
      } finally {
        stats.active.set(k, stats.active.get(k) - 1);
      }
    },
  };
}
