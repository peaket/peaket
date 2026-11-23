// 호스트 지표 파싱 시험(F082-6): loadtest/runner/host-metrics.mjs. 계획 docs/review/plans/F-08-2.md 6.3·7.2, 정본 docs/verification.md §3.5 6·8번.
// 표본은 fixtures/f08/의 실제 꼴 글(/proc/stat, cgroup v2 cpu.stat, /proc/<pid>/net/netstat)이다. 값은 그 글에서 손으로 셈했다.
// 실행: node --test loadtest/test/host-metrics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFileSync(join(here, 'fixtures', 'f08', name), 'utf8');
const metrics = () => import('../runner/host-metrics.mjs');

/** 사용률 단위는 계획이 정하지 않았다: 비율(0~1) 또는 백분율(0~100) 가운데 하나로 정확히 맞아야 한다 */
function assertUtil(u, fraction) {
  assert.equal(typeof u, 'number', `사용률이 수가 아니다: ${u}`);
  assert.ok(Math.abs(u - fraction) < 1e-9 || Math.abs(u - fraction * 100) < 1e-7, `사용률 ${u}가 ${fraction}(또는 ${fraction * 100}%)가 아니다`);
}

test('F082-6 ① parseProcStat: procs_running과 논리 프로세서 수(cpu0~cpu7 줄)를 정확히 읽는다', async () => {
  const { parseProcStat } = await metrics();
  const a = parseProcStat(fx('proc-stat-a.txt'));
  const b = parseProcStat(fx('proc-stat-b.txt'));
  assert.equal(a.procsRunning, 3);
  assert.equal(b.procsRunning, 9);
  assert.equal(a.logicalCpus, 8);
  assert.equal(b.logicalCpus, 8);
  // CRLF로 받아도 같다
  assert.equal(parseProcStat(fx('proc-stat-b.txt').replace(/\n/g, '\r\n')).procsRunning, 9);
});

test('F082-6 ② cpuUtilBetween: 두 표본 사이 busy 850·idle 150이면 85%다(user +600, system +200, softirq +50, idle +150)', async () => {
  const { parseProcStat, cpuUtilBetween } = await metrics();
  assertUtil(cpuUtilBetween(parseProcStat(fx('proc-stat-a.txt')), parseProcStat(fx('proc-stat-b.txt'))), 0.85);
});

test('F082-6 ③ cpuUtilBetween: 표본 순서가 뒤바뀌거나 시간이 흐르지 않았으면 오류이고 0을 내지 않는다', async () => {
  const { parseProcStat, cpuUtilBetween } = await metrics();
  const a = parseProcStat(fx('proc-stat-a.txt'));
  const b = parseProcStat(fx('proc-stat-b.txt'));
  assert.throws(() => cpuUtilBetween(b, a), RangeError);
  // 흐른 시간이 0이면 사용률을 모른다: null이거나 오류여야 하고 0·NaN이면 안 된다
  let same;
  try {
    same = cpuUtilBetween(a, a);
  } catch (e) {
    same = e;
  }
  assert.ok(same === null || same instanceof RangeError, `흐른 시간 0인데 ${same}`);
});

test('F082-6 ④ parseProcStat: procs_running 줄이 없으면 procsRunning은 null이다(0이 아니다)', async () => {
  const { parseProcStat } = await metrics();
  const s = parseProcStat(fx('proc-stat-no-procs.txt'));
  assert.strictEqual(s.procsRunning, null);
  assert.equal(s.logicalCpus, 2);
});

test('F082-6 ⑤ parseCpuStat: cgroup v2 cpu.stat에서 주기·스로틀 횟수·스로틀 시간을 정확히 읽는다', async () => {
  const { parseCpuStat } = await metrics();
  const c = parseCpuStat(fx('cgroup-v2-cpu.stat'));
  assert.equal(c.nrPeriods, 18234);
  assert.equal(c.nrThrottled, 2711);
  assert.equal(c.throttledUsec, 98765432);
  assert.equal(c.usageUsec, 845123456);
});

test('F082-6 ⑥ parseCpuStat: CPU 한도가 없는 cgroup(스로틀 칸 없음)이면 스로틀 칸은 null이다(0이 아니다)', async () => {
  const { parseCpuStat } = await metrics();
  const c = parseCpuStat(fx('cgroup-v2-cpu-nolimit.stat'));
  assert.strictEqual(c.nrPeriods, null);
  assert.strictEqual(c.nrThrottled, null);
  assert.strictEqual(c.throttledUsec, null);
  assert.equal(c.usageUsec, 845123456);
});

test('F082-6 ⑦ parseNetstat: TcpExt 머리 줄의 이름 자리로 ListenOverflows 7·ListenDrops 9를 읽는다(IpExt 줄을 섞지 않는다)', async () => {
  const { parseNetstat } = await metrics();
  const n = parseNetstat(fx('netstat.txt'));
  assert.equal(n.listenOverflows, 7);
  assert.equal(n.listenDrops, 9);
});

test('F082-6 ⑧ parseNetstat: TcpExt 줄이 없으면 둘 다 null이다(0이 아니다)', async () => {
  const { parseNetstat } = await metrics();
  const n = parseNetstat(fx('netstat-no-tcpext.txt'));
  assert.strictEqual(n.listenOverflows, null);
  assert.strictEqual(n.listenDrops, null);
});
