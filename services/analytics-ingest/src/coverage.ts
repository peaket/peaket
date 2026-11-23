// 커버리지 대조(docs/streaming.md §6 '마감 커버리지', docs/features/analytics.md §7 커버리지 줄, OPS-200, F-04-3).
// 파티션마다 대상 오프셋 구간 [from, to]에 있는 고유한 (파티션, 오프셋) 수가 구간 길이와 같은지 본다. 적재·거절·건너뜀 위치를 모두 적는
// bronze.brz_offset을 센다(거절 기록의 위치도 구간에 넣는다는 정본 규칙을 한 표로). 모자라면 빈 오프셋 구간을 돌려준다(다시 적재 대상).
// 트랜잭션 생산자를 쓰지 않고 토픽이 삭제 보존이라는 전제다. 압축 토픽 control.settings는 대조에서 뺀다(§6).

export const COVERAGE_EXCLUDED_TOPICS = new Set(['control.settings']);

export interface CoverageRange {
  readonly topic: string;
  readonly partition: number;
  /** 구간 처음(포함) */
  readonly from: bigint;
  /** 구간 끝(포함) */
  readonly to: bigint;
}

export interface CoverageResult extends CoverageRange {
  readonly expected: bigint;
  readonly present: bigint;
  /** 빠진 오프셋 구간(처음·끝 포함). 너무 많으면 앞 100개 [가정]만 */
  readonly gaps: readonly { from: bigint; to: bigint }[];
}

export interface CoverageReader {
  rows<T>(sql: string, params: Record<string, string>): Promise<T[]>;
}

const GAP_LIMIT = 100;

export async function coverageOf(ch: CoverageReader, r: CoverageRange): Promise<CoverageResult> {
  const expected = r.to >= r.from ? r.to - r.from + 1n : 0n;
  const params = { topic: r.topic, partition: String(r.partition), from: r.from.toString(), to: r.to.toString() };
  const where = 'topic = {topic:String} AND partition = {partition:UInt32} AND offset BETWEEN {from:UInt64} AND {to:UInt64}';
  const [agg] = await ch.rows<{ n: string; lo: string; hi: string }>(
    `SELECT toString(uniqExact(offset)) AS n, toString(min(offset)) AS lo, toString(max(offset)) AS hi FROM bronze.brz_offset WHERE ${where}`,
    params,
  );
  const present = BigInt(agg?.n ?? '0');
  const gaps: { from: bigint; to: bigint }[] = [];
  if (present === 0n) {
    if (expected > 0n) gaps.push({ from: r.from, to: r.to });
  } else if (present < expected) {
    const lo = BigInt(agg!.lo);
    const hi = BigInt(agg!.hi);
    if (lo > r.from) gaps.push({ from: r.from, to: lo - 1n });
    // 안쪽 빈 자리: 다음 오프셋이 하나보다 더 떨어진 곳(마지막 줄의 다음 값은 기본값 0이라 걸리지 않는다)
    const inner = await ch.rows<{ a: string; b: string }>(
      `SELECT toString(o + 1) AS a, toString(n - 1) AS b FROM (
         SELECT offset AS o, leadInFrame(offset) OVER (ORDER BY offset ROWS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS n
         FROM (SELECT DISTINCT offset FROM bronze.brz_offset WHERE ${where})
       ) WHERE n > o + 1 ORDER BY o LIMIT ${GAP_LIMIT}`,
      params,
    );
    gaps.push(...inner.map((x) => ({ from: BigInt(x.a), to: BigInt(x.b) })));
    if (hi < r.to) gaps.push({ from: hi + 1n, to: r.to });
  }
  return { ...r, expected, present, gaps };
}
