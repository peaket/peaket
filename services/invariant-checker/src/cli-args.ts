// 명령줄 인자와 환경 값. DB 주소는 환경 값으로만 받는다(프로세스 목록에 비밀번호가 보이지 않게, ASVS v5.0.0-13.3.1).
//   INVARIANT_CHECK_DB_URL(필수): 임시 표를 만들 검사 연결. 원본 DB를 줘도 원본 표는 건드리지 않는다
//   INVARIANT_PURCHASE_DB_URL·INVARIANT_PAYMENT_DB_URL·INVARIANT_TICKET_DB_URL: 없으면 그 원본을 쓰는 불변식은 SKIPPED
import type { SourceName } from './tables.js';

export interface CliConfig {
  out: string;
  records?: string;
  checkUrl: string;
  sources: Partial<Record<SourceName, string>>;
  enqueueWithinMs: number;
  issueDeadlineMs: number;
}

export class CliError extends Error {
  override name = 'CliError';
}

const ENV: Record<SourceName, string> = { purchase: 'INVARIANT_PURCHASE_DB_URL', payment: 'INVARIANT_PAYMENT_DB_URL', ticket: 'INVARIANT_TICKET_DB_URL' };

export function parseCliArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): CliConfig {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!['--out', '--records', '--enqueue-within-sec', '--issue-deadline-min'].includes(a)) throw new CliError(`모르는 인자: ${a}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new CliError(`${a}에 값이 없다`);
    flags.set(a, v);
  }
  const out = flags.get('--out');
  if (!out) throw new CliError('--out <실행 폴더>가 필요하다');
  const checkUrl = env.INVARIANT_CHECK_DB_URL;
  if (!checkUrl) throw new CliError('환경 값 INVARIANT_CHECK_DB_URL이 필요하다');
  const sources: CliConfig['sources'] = {};
  for (const [s, k] of Object.entries(ENV) as Array<[SourceName, string]>) if (env[k]) sources[s] = env[k];
  const positive = (flag: string, def: number, unit: number, name: string) => {
    const raw = flags.get(flag);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!(Number.isInteger(n) && n > 0)) throw new CliError(`${name}는 양의 정수여야 한다: ${raw}`);
    return n * unit;
  };
  return {
    out,
    ...(flags.has('--records') ? { records: flags.get('--records')! } : {}),
    checkUrl,
    sources,
    enqueueWithinMs: positive('--enqueue-within-sec', 60_000, 1000, '--enqueue-within-sec'),
    issueDeadlineMs: positive('--issue-deadline-min', 30 * 60_000, 60_000, '--issue-deadline-min'),
  };
}
