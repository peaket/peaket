// F-08-9 검색 측정용 호스트 core-svc 무대(계획 docs/review/plans/F-08-9.md 6.1·7.1).
// v1 합본에는 core DB가 없으므로 호스트 PostgreSQL(core DB)과 core-svc(:3001)를 따로 띄우고,
// k6 파드는 host.docker.internal:3001로 보낸다. 로컬·CI에서만 쓴다(운영 배포 아님).
// 쓰는 법:
//   PEAKET_DATABASE_URL=postgres://… PEAKET_ENV=local node tools/local/core-host.mjs up [--port 3001] [--count 10000]
//   node tools/local/core-host.mjs status
//   node tools/local/core-host.mjs down
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PID_FILE = join(ROOT, '.cache', 'peaket-f09', 'core-host.pid');
const LOG_FILE = join(ROOT, '.cache', 'peaket-f09', 'core-host.log');

const fail = (m) => {
  console.error(`core-host: ${m}`);
  process.exit(2);
};

/** 환경 확인: 로컬·CI의 로컬 DB만 받는다(ADR-0271 결정 21과 같은 태도) */
export function coreHostPlan(env = process.env) {
  if (env.PEAKET_ENV !== 'local' && env.PEAKET_ENV !== 'ci') throw new Error(`PEAKET_ENV가 local·ci가 아니다: ${env.PEAKET_ENV ?? '(없음)'}`);
  const url = env.PEAKET_DATABASE_URL;
  if (!url) throw new Error('PEAKET_DATABASE_URL이 없다');
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error(`DB 호스트가 로컬이 아니다: ${host}`);
  return { url, host, port: Number(env.PEAKET_CORE_PORT ?? 3001) };
}

const children = () => {
  try {
    return Number(readFileSync(PID_FILE, 'utf8').trim());
  } catch {
    return null;
  }
};

async function ready(port, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ready`);
      if (r.ok) return true;
    } catch {
      // 아직 뜨지 않았다
    }
    await sleep(500);
  }
  return false;
}

async function run(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  let out = '';
  p.stdout.on('data', (d) => (out += String(d)));
  p.stderr.on('data', (d) => (out += String(d)));
  const code = await new Promise((res) => p.on('exit', res));
  if (code !== 0) throw new Error(`${cmd} ${args.join(' ')} 실패(${code}): ${out.split('\n').slice(-4).join(' ')}`);
}

async function up(a) {
  const plan = coreHostPlan();
  const port = a.port ?? plan.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`--port: ${port}`);
  mkdirSync(dirname(PID_FILE), { recursive: true });
  const env = { ...process.env, PEAKET_ENV: 'local', PEAKET_CORE_PORT: String(port), PORT: String(port) };
  await run('node', ['services/core-svc/scripts/migrate.mjs'], env);
  const log = spawn('node', ['--import', '@peaket/platform/telemetry/register', 'services/core-svc/dist/main.js'], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  log.stdout.on('data', (d) => process.stdout.write(d));
  log.stderr.on('data', (d) => process.stderr.write(d));
  writeFileSync(PID_FILE, String(log.pid));
  if (!(await ready(port))) fail(`core-svc(:${port})가 60초 안에 준비되지 않았다. ${LOG_FILE}를 보라`);
  if (a.count !== undefined) {
    await run('node', ['services/core-svc/scripts/fill-search.mjs', '--count', String(a.count)], env);
  }
  console.log(`core-host: core-svc(:${port}) 준비 완료${a.count !== undefined ? `, 검색 ${a.count}건 채움` : ''}`);
}

function down() {
  const pid = children();
  if (pid === null) {
    console.log('core-host: 실행 중이 아니다');
    return;
  }
  try {
    process.kill(pid);
  } catch {
    // 이미 죽었다
  }
  rmSync(PID_FILE, { force: true });
  console.log(`core-host: ${pid}를 끝냈다`);
}

function status() {
  const pid = children();
  console.log(pid === null ? 'core-host: 실행 중이 아니다' : `core-host: pid ${pid}${existsSync(PID_FILE) ? '' : ' (pid 파일 없음)'}`);
}

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
try {
  if (cmd === 'up') {
    const count = opt('--count');
    await up({ port: opt('--port') === undefined ? undefined : Number(opt('--port')), ...(count === undefined ? {} : { count: Number(count) }) });
  } else if (cmd === 'down') down();
  else if (cmd === 'status') status();
  else fail('쓰는 법: core-host.mjs up [--port 3001] [--count 10000] | status | down');
} catch (e) {
  fail(e?.message ?? e);
}
