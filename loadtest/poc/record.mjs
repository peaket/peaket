#!/usr/bin/env node
// run.mjs가 남긴 측정(.cache/peaket-poc/out/plan.jsonl)을 성능 장부(docs/perf-ledger/runs/)로 옮긴다. 손으로 옮기지 않는다(perf-ledger §3의 8).
// 측정 환경 사양(infra.txt)을 만들어 실행마다 붙이고, 장부 표는 index.py로 다시 만든다.
// 쓰는 법: node loadtest/poc/record.mjs [--force]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGES } from './stack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, '.cache', 'peaket-poc', 'out');
const force = process.argv.includes('--force');
const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\0/g, '').trim();
  } catch (err) {
    return `(실패: ${String(err.message).slice(0, 120)})`;
  }
};

const infra = join(OUT, 'infra.txt');
const cpu = process.platform === 'win32' ? sh('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors | Format-List; Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory | Format-List; Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version | Format-List']) : sh('lscpu', []);
writeFileSync(
  infra,
  [
    '# wbs 0.5.1 PoC 측정 환경(프로파일 local-poc, docs/perf-ledger.md §4)',
    `수집 시각: ${new Date().toISOString()}`,
    '',
    '## 호스트',
    cpu.split(/\r?\n/).filter(Boolean).join('\n'),
    `WSL: ${sh('wsl.exe', ['--version']).split(/\r?\n/).slice(0, 3).join(' / ')}`,
    `.wslconfig: ${existsSync(join(process.env.USERPROFILE ?? '', '.wslconfig')) ? readFileSync(join(process.env.USERPROFILE, '.wslconfig'), 'utf8') : '없음(WSL 기본: 논리 프로세서 전부, 메모리 절반)'}`,
    '',
    '## Docker 엔진(측정 컨테이너가 도는 VM)',
    sh('docker', ['info', '--format', 'Server {{.ServerVersion}}, CPUs {{.NCPU}}, Mem {{.MemTotal}} bytes, OS {{.OperatingSystem}}, Kernel {{.KernelVersion}}, cgroup {{.CgroupVersion}}']),
    '',
    '## 이미지(다이제스트 고정)',
    ...Object.entries(IMAGES).map(([k, v]) => `${k}: ${v}`),
    `peaket/poc-bench:local: ${sh('docker', ['image', 'inspect', '--format', '{{.Id}}', IMAGES.bench])}`,
    `peaket/poc-vt41:local: ${sh('docker', ['image', 'inspect', '--format', '{{.Id}}', 'peaket/poc-vt41:local'])}`,
    '',
    '## CPU 배치(컨테이너 CPU 한도, --cpus. WSL에서는 어느 코어에 놓일지 고를 수 없어 한도만 둔다, docs/verification.md §3.5 6번)',
    '- Valkey 주 노드 셋(valkey-1·2·3) 2개씩, 복제 셋(valkey-4·5·6) 1개씩. Kafka 브로커 셋 2개씩(Kafka 묶음에서만 뜬다)',
    '- 측정 도구 컨테이너: 측정마다 manifest notes와 bench-summary.json의 cpus. 한 키 INCR 6, 클라이언트 셋 비교 1, 동작 시험 2, S-T27 2, Kafka 4',
    '- V-T41: 앱 컨테이너 1(파드 CPU 한도 고정), k6 컨테이너 4(첫·두 번째 회차)·8(세 번째 회차 -c-)',
    '- 측정은 한 번에 하나씩 돈다(run.mjs). 측정 중에는 다른 측정·시험을 돌리지 않았다',
    '',
    '## 시계',
    '- 발생기와 대상이 같은 PC·같은 커널이라 시계가 하나다(NTP 오차 해당 없음, perf-ledger §3의 3)',
    '',
  ].join('\n'),
);

// 같은 측정을 다시 돌렸으면 마지막 것만 옮기고 덮어쓴다(코드 리뷰 2026-11-01)
const all = readFileSync(join(OUT, 'plan.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const last = new Map(all.map((p) => [p.id, p]));
const rerun = new Set(all.filter((p, i) => all.findIndex((q) => q.id === p.id) !== i).map((p) => p.id));
const plan = [...last.values()];
const ids = new Set(plan.map((p) => p.id));
/**
 * 측정 도구가 예열 뒤 요청 수(measured)를 따로 내기 전(2026-11-01 08:30~09:20 측정, 코드 리뷰 2026-11-01)의 결과는 요청 수에 예열이 들어 있다.
 * 오픈 모델이면 '보낸 수 - 도착률 x 예열'로 고쳐 bench 칸에 적는다(오류는 원래 예열 뒤만 셌다)
 */
function fixRequests(path) {
  const r = JSON.parse(readFileSync(path, 'utf8'));
  if (!r.bench || r.measured !== undefined || r.bench.requests_note) return;
  if (r.model === 'open' && r.offered_rate && r.warmup_s !== undefined) {
    const measured = r.issued - Math.ceil(r.offered_rate * r.warmup_s);
    r.bench.requests = measured;
    r.bench.error_rate = measured > 0 ? r.errors / measured : 0;
    r.bench.requests_note = '예열 뒤 요청 수로 고쳐 적음(record.mjs fixRequests)';
    writeFileSync(path, JSON.stringify(r, null, 2));
  }
}

let n = 0;
for (const p of plan) {
  if (!p.kpi) continue;
  const runId = `${p.id}-local-poc`;
  const args = ['-I', 'tools/perf-ledger/collect.py', '--run-id', runId, '--kpi', p.kpi, '--version', 'v1', '--profile', 'local-poc',
    '--scenario', p.scenario, '--scenario-args', p.scenarioArgs ?? '', '--infra-file', infra, '--start', p.startedAt, '--end', p.endedAt,
    '--generator', `PoC 측정 도구(${p.k6 ? 'k6 1.4.2' : 'Node 24 loadtest/poc/bench'}) 컨테이너, CPU 한도 ${p.cpus}`, '--region', 'local', '--cost-krw', '0',
    '--notes', `${p.notes}. 결과 표기: 실측(PC). 반복·중앙값은 ADR-0176 표`];
  if (p.rps) args.push('--rps', String(p.rps));
  if (p.duration) args.push('--duration', String(p.duration));
  if (p.warmup) args.push('--warmup', String(p.warmup));
  if (p.closed) args.push('--closed-model');
  if (p.k6) args.push('--k6-summary', join(OUT, `${p.id}.k6.json`), '--extra', join(OUT, `${p.id}.json`));
  else args.push('--bench-summary', join(OUT, `${p.id}.json`));
  if (p.redisTls !== undefined) {
    args.push('--redis-tls', String(p.redisTls));
    if (p.pairOf && ids.has(p.pairOf)) args.push('--paired-run', `${p.pairOf}-local-poc`);
  }
  if (force || rerun.has(p.id)) args.push('--force');
  if (p.invalidReason) args.push('--invalid-reason', p.invalidReason);
  if (!p.k6 && /-st27-/.test(p.id)) {
    const r = JSON.parse(readFileSync(join(OUT, `${p.id}.json`), 'utf8'));
    const over = r.invariants.reduce((n, i) => n + i.oversell, 0);
    const holdErr = r.load.filter((l) => l.kind === 'hold').reduce((n, l) => n + Object.values(l.error_kinds).reduce((a, b) => a + b, 0), 0);
    const unknown = r.invariants.reduce((n, i) => n + i.unknown_release, 0);
    const bitBad = r.invariants.filter((i) => !i.bit_equals_index).length;
    if (over > 0) args.push('--invalid-reason', `불변식 위반: 오버셀 ${over}건`);
    else if (holdErr === 0 && (unknown > 0 || bitBad > 0)) args.push('--invalid-reason', `불변식 위반: 짝이 맞지 않는 놓기 ${unknown}건, 켜진 비트 수와 만료 인덱스 수가 다른 회차 ${bitBad}개`);
    else if (holdErr > 0) args[args.indexOf('--notes') + 1] += `. 오버셀 판정 불가(홀드 오류 ${holdErr}건이 기록에 빠짐)`;
    else args[args.indexOf('--notes') + 1] += `. 오버셀 0(좌석마다 잡기·놓기 순서 확인, 켜진 비트 수 = 만료 인덱스 수)`;
  }
  if (!p.k6) fixRequests(join(OUT, `${p.id}.json`));
  execFileSync('python', args, { cwd: ROOT, stdio: 'inherit' });
  n += 1;
}
execFileSync('python', ['-I', 'tools/perf-ledger/index.py'], { cwd: ROOT, stdio: 'inherit' });
console.log(`장부에 옮김: ${n}개`);
