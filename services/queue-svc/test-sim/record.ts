// 실측 결과를 .cache/peaket-poc/out/에 쓰고 plan.jsonl에 한 줄 더한다(loadtest/poc/record.mjs가 성능 장부로 옮긴다).
// 실행 번호는 이미 있는 결과(.cache와 성능 장부)의 가장 큰 번호 + 1이라, 다시 재도 앞 원본을 덮어쓰지 않는다.
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
export const SIM_OUT = join(ROOT, '.cache', 'peaket-poc', 'out');
const LEDGER_RUNS = join(ROOT, 'docs', 'perf-ledger', 'runs');
export const SIM_DAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

/** `${base}-rN`에서 아직 쓰지 않은 N */
export function nextRunId(base: string): string {
  const seen = (dir: string, re: RegExp) => (existsSync(dir) ? readdirSync(dir).map((f) => re.exec(f)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])) : []);
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const n = Math.max(0, ...seen(SIM_OUT, new RegExp(`^${esc}-r(\\d+)\\.json$`)), ...seen(LEDGER_RUNS, new RegExp(`^${esc}-r(\\d+)-local-poc$`)));
  return `${base}-r${n + 1}`;
}

export function saveRun(id: string, out: object, ledger: Record<string, unknown>, startedAt: string): void {
  mkdirSync(SIM_OUT, { recursive: true });
  writeFileSync(join(SIM_OUT, `${id}.json`), JSON.stringify(out, null, 2));
  appendFileSync(join(SIM_OUT, 'plan.jsonl'), JSON.stringify({ id, startedAt, endedAt: new Date().toISOString(), cpus: 'host(측정 프로세스)', args: [], ...ledger }) + '\n');
}
