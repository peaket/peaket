// F-03-4 실제 서버 무대(T13~T16, 계획 '감독에게' 5 (가)).
// 한 프로세스에 받는 쪽 넷(bundle의 startBundle: payment-svc·purchase-svc·admission-ctrl·queue-svc)을 띄우고,
// identity-svc(실제 프로세스, 관리 계정 commander·operator, 비밀번호·TOTP·패스키)와 ops-svc(실제 프로세스, PostgreSQL)를 띄운다.
// 콘솔은 운영 빌드(apps/console-host/dist)를 preview-server로 내고, /v1/ops는 ops-svc로, /v1/ops/auth/*는 identity-svc로 넘긴다(ops-proxy.mjs).
// - Docker는 docker-2 자리만 쓴다(gate-F-03-4 owner.txt 확인). 컨테이너는 시작할 때와 끝날 때 `docker rm -f -v`로 지운다.
// - 이 파일은 시험 도구다. 비밀번호·TOTP 시드·패스키 개인키는 임시 폴더와 이 프로세스 메모리에만 두고 로그·저장소에 남기지 않는다.
// - 단계별 준비: PostgreSQL·Valkey → 마이그레이션 → 관리 계정 시드 → bundle 넷 → identity → ops → 미리보기.
//   실행: node console-commands/stage.mjs (tools/web-checks에서). Playwright webServer가 이 명령을 띄운다.
// - T16은 ops-svc의 받는 곳 목록에 닿지 않는 주소를 더해야 하므로 POST /stage/ops/restart로 ops-svc만 다시 띄운다.
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { envFileText, v1EnvFiles, v1Keys } from '../../local/v1-stage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '..', '..', '..');
const STAGE_PORT = Number(process.env.PEAKET_CONSOLE_COMMANDS_STAGE_PORT ?? 4281);
const PREVIEW_PORT = Number(process.env.PEAKET_CONSOLE_COMMANDS_PREVIEW_PORT ?? 4280);
const PREVIEW_ORIGIN = `http://localhost:${PREVIEW_PORT}`;
const LOCK_ROOT = process.env.PEAKET_LOCK_ROOT ?? 'D:/ticketpass-locks';
const DOCKER_SLOT = 'docker-2';
const OWNER = 'gate-F-03-4';
const CONTAINER_PREFIX = 'gate-f034-';
const ISSUER = 'https://identity.peaket.local';
const ID_PORTS = { app: 0, management: 0, grpc: 0 };
const bundlePorts = {};

const work = mkdtempSync(join(tmpdir(), 'peaket-f034-stage-'));
const logDir = join(work, 'logs');
mkdirSync(logDir, { recursive: true });
const logs = [];
const children = new Map();
let bundle;
let ops;
let opsState;
let identity;
let preview;
let postgres;
let valkey;
let ready = false;
let closing = false;
let eventId = randomUUID().toLowerCase();
let stageError;
let accounts = {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  logs.push(`[${new Date().toISOString()}] ${line}`);
  if (logs.length > 2000) logs.shift();
  process.stderr.write(`${line}\n`);
}

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout ?? 120_000 }).trim();
}

function freePort() {
  return new Promise((resolveP, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolveP(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

function mappedPort(id, port) {
  const mapped = docker(['port', id, `${port}/tcp`]).split('\n')[0];
  return Number(mapped.slice(mapped.lastIndexOf(':') + 1));
}

function rmContainer(id) {
  if (!id) return;
  try {
    docker(['rm', '-f', '-v', id]);
  } catch {
    // 이미 없다
  }
}

async function waitFor(what, cond, timeoutMs = 120_000, intervalMs = 200) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > until) throw new Error(`${what}이(가) ${timeoutMs}ms 안에 오지 않았다`);
    await sleep(intervalMs);
  }
}

const statusOf = (url) => fetch(url).then((r) => r.status, () => 0);
const readyOf = (port) => statusOf(`http://127.0.0.1:${port}/ready`);

function assertDockerSlot() {
  const file = join(LOCK_ROOT, DOCKER_SLOT, 'owner.txt');
  if (!existsSync(file)) throw new Error(`Docker ${DOCKER_SLOT} 자리를 잡지 않았다. 먼저 D:/ticketpass-locks/lock.sh로 ${DOCKER_SLOT} 자리를 잡아라(이 시험은 docker 자리를 쓰지 않는다)`);
  const owner = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
  if (owner !== OWNER) throw new Error(`Docker ${DOCKER_SLOT} 자리의 주인이 ${owner}다. ${OWNER} 차례가 아니다`);
}

function removeStaleContainers() {
  const ids = docker(['ps', '-aq', '--filter', `name=${CONTAINER_PREFIX}`]).split(/\r?\n/).filter(Boolean);
  for (const id of ids) rmContainer(id);
}

function writeEnvFile(dir, service, values) {
  writeFileSync(join(dir, `${service}.env`), envFileText(values), 'utf8');
}

function spawnChild(name, cwd, args, env, extra = {}) {
  const outFile = join(logDir, `${name}.log`);
  const stream = [];
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env, OTEL_SERVICE_NAME: name, OTEL_TRACES_EXPORTER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...extra,
  });
  const collect = (d) => {
    const s = String(d);
    stream.push(s);
    if (stream.length > 2000) stream.shift();
    try {
      writeFileSync(outFile, stream.join(''));
    } catch {
      // 로그 파일을 못 써도 시험은 계속한다
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const entry = { name, child, output: () => stream.join(''), outFile, exited: undefined };
  child.once('exit', (code, signal) => {
    entry.exited = { code, signal };
    if (!closing && ready) log(`${name} 프로세스가 예기치 않게 끝났다(code=${code}, signal=${signal})`);
  });
  children.set(name, entry);
  return entry;
}

async function stopChild(name, child, timeoutMs = 15_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // 이미 끝났다
  }
  const until = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < until) await sleep(100);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 이미 끝났다
    }
  }
}

function runNode(cwd, script, env, label, args = []) {
  try {
    return execFileSync(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
  } catch (e) {
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.slice(-3000);
    throw new Error(`${label} 실패: ${out}`);
  }
}



function ecJwk(kid) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid };
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function passkeyMaterial(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  return {
    name,
    credentialId: randomBytes(32).toString('base64url'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    publicKeyCose: cose.toString('base64'),
    aaguid: randomUUID(),
  };
}

function buildAccounts() {
  const defs = [
    { key: 'commander', email: 'gate-f034-commander@peaket.test', displayName: 'F-03-4 commander', role: 'commander' },
    { key: 'operator', email: 'gate-f034-operator@peaket.test', displayName: 'F-03-4 operator', role: 'operator' },
  ];
  const out = {};
  for (const d of defs) {
    out[d.key] = {
      ...d,
      id: randomUUID(),
      password: randomBytes(18).toString('base64url'),
      totpSeed: base32(randomBytes(20)),
      passkey: passkeyMaterial(`${d.displayName} 패스키`),
    };
  }
  return out;
}

function bootstrapOf(list) {
  return {
    version: 1,
    seedFile: 'console-commands-stage',
    promoters: [],
    accounts: list.map((a) => ({
      key: a.key,
      id: a.id,
      email: a.email,
      displayName: a.displayName,
      role: a.role,
      password: a.password,
      totpSeed: a.totpSeed,
      passkeys: [{ name: a.passkey.name, credentialId: a.passkey.credentialId, publicKeyCose: a.passkey.publicKeyCose, aaguid: a.passkey.aaguid }],
    })),
  };
}

const keys = v1Keys();
let identityKeys;
const pepperKey = randomBytes(32).toString('base64');
const totpKey = randomBytes(32).toString('base64');
const internalGrpcToken = randomBytes(24).toString('base64url');

function identityEnv(databaseUrl, ports) {
  return {
    PEAKET_ENV: 'local',
    PEAKET_DATABASE_URL: databaseUrl,
    PEAKET_FAN_TOKEN_KEY: JSON.stringify(identityKeys.fan),
    PEAKET_ADMIN_TOKEN_KEY: JSON.stringify(identityKeys.admin),
    PEAKET_STAFF_TOKEN_KEY: JSON.stringify(identityKeys.staff),
    PEAKET_TOKEN_ISSUER: ISSUER,
    PEAKET_ADMIN_PEPPER_KEY: pepperKey,
    PEAKET_ADMIN_TOTP_KEY: totpKey,
    PEAKET_OPS_CONSOLE_ORIGIN: PREVIEW_ORIGIN,
    PEAKET_PARTNER_CONSOLE_ORIGIN: 'https://partner.peaket.example',
    // 로그인 실패 셈·패스키 챌린지는 이 프로세스 메모리로 둔다(PEAKET_ENV=local). 받는 쪽 넷이 쓰는 Valkey의 100ms 마감과
    // 같은 Redis를 나눠 쓰면 로그인이 503 admin-login-unavailable로 흔들린다(무대 확인 2026-11-24)
    PEAKET_GRPC_HOST: '127.0.0.1',
    PEAKET_GRPC_PORT: String(ports.grpc),
    PORT: String(ports.app),
    PEAKET_MANAGEMENT_PORT: String(ports.management),
    PEAKET_LOG_LEVEL: 'warn',
    PEAKET_LOG_PSEUDONYM_KEY: randomBytes(32).toString('base64'),
    PEAKET_ADMIN_MAIL_DIR: join(work, 'mail'),
    PEAKET_INTERNAL_GRPC_TOKEN: internalGrpcToken,
  };
}

function opsEnvOf(opts = {}) {
  const admission = opts.admissionAddrs ?? [`127.0.0.1:${bundlePorts.admissionControl}`];
  return {
    PEAKET_ENV: 'local',
    PEAKET_DATABASE_URL: opts.databaseUrl,
    PEAKET_IDENTITY_GRPC_URL: `127.0.0.1:${ID_PORTS.grpc}`,
    PEAKET_IDENTITY_JWKS_URL: `http://127.0.0.1:${ID_PORTS.app}/internal/jwks/admin.json`,
    PEAKET_IDENTITY_ISSUER: ISSUER,
    PEAKET_PURCHASE_CONTROL_GRPC_ADDRS: `127.0.0.1:${bundlePorts.purchaseControl}`,
    PEAKET_QUEUE_CONTROL_GRPC_ADDRS: `127.0.0.1:${bundlePorts.queueControl}`,
    PEAKET_ADMISSION_CONTROL_GRPC_ADDRS: admission.join(','),
    PEAKET_PAYMENT_CONTROL_GRPC_ADDRS: `127.0.0.1:${bundlePorts.paymentControl}`,
    PEAKET_PAYMENT_GRPC_ADDR: `127.0.0.1:${bundlePorts.paymentGrpc}`,
    // 재인증 jti 1회용은 이 프로세스 메모리로 둔다(PEAKET_ENV=local). 받는 쪽 넷이 쓰는 Valkey의 100ms 마감과
    // 같은 Redis를 나눠 쓰면 재인증 확인이 503 reauth-unavailable로 흔들린다(무대 확인 2026-11-24)
    PORT: String(opts.port),
    PEAKET_MANAGEMENT_PORT: String(opts.managementPort),
    PEAKET_LOG_LEVEL: 'info',
    PEAKET_LOG_PSEUDONYM_KEY: randomBytes(32).toString('base64'),
    PEAKET_INTERNAL_GRPC_TOKEN: internalGrpcToken,
  };
}

function previewEnv(opsPort, identityPort) {
  return {
    PEAKET_ENV: 'local',
    PEAKET_OPS_API_ORIGIN: PREVIEW_ORIGIN,
    PEAKET_OPS_PROXY_TARGET: `http://127.0.0.1:${opsPort}`,
    PEAKET_IDENTITY_PROXY_TARGET: `http://127.0.0.1:${identityPort}`,
    PEAKET_IDENTITY_ISSUER: ISSUER,
  };
}

function assertBuild() {
  const need = [
    join(REPO, 'services', 'identity-svc', 'dist', 'main.js'),
    join(REPO, 'services', 'ops-svc', 'dist', 'main.js'),
    join(REPO, 'services', 'bundle', 'dist', 'bundle.js'),
    join(REPO, 'apps', 'console-host', 'dist', 'index.html'),
  ];
  for (const f of need) if (!existsSync(f)) throw new Error(`빌드 산출물이 없다: ${f}(먼저 pnpm build, 그리고 PEAKET_OPS_API_ORIGIN=${PREVIEW_ORIGIN} pnpm --filter @peaket/console-host build)`);
  const assets = join(REPO, 'apps', 'console-host', 'dist', 'assets');
  const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
  if (!js.some((f) => /^main\..+\.js$/.test(f))) throw new Error('apps/console-host/dist/assets/main.*.js가 없다(운영 빌드를 만든다)');
  const hasOrigin = js.some((f) => readFileSync(join(assets, f), 'utf8').includes(PREVIEW_ORIGIN));
  if (!hasOrigin) throw new Error(`콘솔 빌드의 관제 API 주소가 ${PREVIEW_ORIGIN}이 아니다(PEAKET_OPS_API_ORIGIN=${PREVIEW_ORIGIN}으로 다시 빌드한다)`);
}

async function startPostgres() {
  const name = `${CONTAINER_PREFIX}pg-${process.pid}`;
  const id = docker(['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=gate-f034', '-e', 'POSTGRES_DB=peaket', '-p', '127.0.0.1::5432', 'postgres:18-alpine']);
  const port = mappedPort(id, 5432);
  const urlOf = (db) => `postgres://postgres:gate-f034@127.0.0.1:${port}/${db}`;
  await waitFor('PostgreSQL 준비', () => {
    try {
      docker(['exec', id, 'pg_isready', '-U', 'postgres', '-d', 'peaket']);
      return true;
    } catch {
      return false;
    }
  }, 90_000, 300);
  return { id, port, urlOf, url: urlOf('peaket') };
}

async function startValkey() {
  const name = `${CONTAINER_PREFIX}redis-${process.pid}`;
  const id = docker(['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::6379', 'valkey/valkey:8.1-alpine']);
  const port = mappedPort(id, 6379);
  await waitFor('Valkey 준비', () => {
    try {
      return docker(['exec', id, 'valkey-cli', 'ping']) === 'PONG';
    } catch {
      return false;
    }
  }, 60_000, 200);
  return { id, port, url: `redis://127.0.0.1:${port}` };
}

function createDatabases(names) {
  for (const name of names) {
    try {
      docker(['exec', postgres.id, 'psql', '-U', 'postgres', '-d', 'peaket', '-c', `create database ${name}`]);
    } catch (e) {
      if (!String(e?.stderr ?? e).includes('already exists')) throw e;
    }
  }
}

function migrateAll(urls) {
  const jobs = [
    ['identity-svc', 'identity', urls.identity],
    ['ops-svc', 'ops', urls.ops],
    ['purchase-svc', 'purchase', urls.purchase],
    ['payment-svc', 'payment', urls.payment],
  ];
  for (const [svc, label, url] of jobs) {
    log(`${label} 마이그레이션`);
    runNode(join(REPO, 'services', svc), 'scripts/migrate.mjs', { PEAKET_ENV: 'local', PEAKET_DATABASE_URL: url }, `${label} 마이그레이션`);
  }
}

function seedAccounts(identityUrl) {
  const file = join(work, 'bootstrap.json');
  writeFileSync(file, JSON.stringify(bootstrapOf(Object.values(accounts))), { mode: 0o600 });
  runNode(
    join(REPO, 'services', 'identity-svc'),
    'scripts/seed-demo.mjs',
    {
      PEAKET_ENV: 'local',
      PEAKET_DATABASE_URL: identityUrl,
      PEAKET_DEMO_BOOTSTRAP_FILE: file,
      PEAKET_ADMIN_PEPPER_KEY: pepperKey,
      PEAKET_ADMIN_TOTP_KEY: totpKey,
    },
    '관리 계정 시드',
    ['--apply'],
  );
  log(`관리 계정 ${Object.keys(accounts).length}개를 넣었다(commander·operator, 패스키 포함)`);
}

async function startBundleReceivers(urls, envDir) {
  const { startBundle } = await import(pathToFileURL(join(REPO, 'services', 'bundle', 'dist', 'bundle.js')).href);
  bundlePorts.bundleManagement = await freePort();
  bundlePorts['queue-svc'] = { app: await freePort(), management: await freePort(), grpc: await freePort() };
  bundlePorts['purchase-svc'] = { app: await freePort(), management: await freePort() };
  bundlePorts['admission-ctrl'] = { app: await freePort(), management: await freePort() };
  bundlePorts['payment-svc'] = { app: await freePort(), management: await freePort(), grpc: await freePort() };
  bundlePorts.paymentGrpc = bundlePorts['payment-svc'].grpc;
  bundlePorts.purchaseControl = await freePort();
  bundlePorts.queueControl = await freePort();
  bundlePorts.admissionControl = await freePort();
  bundlePorts.paymentControl = await freePort();

  const pgSimUrl = `http://127.0.0.1:${await freePort()}`;
  const files = v1EnvFiles({
    keys,
    queueRedisUrl: valkey.url,
    seatRedisUrl: valkey.url,
    purchaseDatabaseUrl: urls.purchase,
    paymentDatabaseUrl: urls.payment,
    seatmapDir: join(work, 'seatmaps'),
    batchResultDir: join(work, 'batch-results'),
    pgSimUrl,
    ports: bundlePorts,
    logLevel: 'info',
  });
  // 받는 쪽 제어 포트(F-02-1·F-02-2). 결제사 흉내 서버 주소는 시작 검사만 지나면 되고 이 시험은 결제 승인을 부르지 않는다
  files['purchase-svc'] = { ...files['purchase-svc'], PEAKET_CONTROL_GRPC_HOST: '127.0.0.1', PEAKET_PURCHASE_CONTROL_GRPC_PORT: String(bundlePorts.purchaseControl) };
  files['queue-svc'] = { ...files['queue-svc'], PEAKET_CONTROL_GRPC_HOST: '127.0.0.1', PEAKET_QUEUE_CONTROL_GRPC_PORT: String(bundlePorts.queueControl) };
  files['admission-ctrl'] = { ...files['admission-ctrl'], PEAKET_CONTROL_GRPC_HOST: '127.0.0.1', PEAKET_ADMISSION_CONTROL_GRPC_PORT: String(bundlePorts.admissionControl) };
  files['payment-svc'] = {
    ...files['payment-svc'],
    PEAKET_CONTROL_GRPC_HOST: '127.0.0.1',
    PEAKET_PAYMENT_CONTROL_GRPC_PORT: String(bundlePorts.paymentControl),
    // 명령 6 대체 결제사 전환의 ResolvePgSwitch가 승인 상한을 답해야 한다(없으면 0이라 전환이 503)
    PEAKET_PG_APPROVAL_TPS: JSON.stringify({ TOSS: 37.9, PORTONE: 12.5 }),
  };
  mkdirSync(envDir, { recursive: true });
  for (const [service, values] of Object.entries(files)) writeEnvFile(envDir, service, values);

  const common = {
    ...process.env,
    PEAKET_ENV: 'local',
    PEAKET_POD: 'gate-f034-bundle',
    HOSTNAME: 'gate-f034-bundle',
    OTEL_TRACES_EXPORTER: 'none',
    PEAKET_INTERNAL_GRPC_TOKEN: internalGrpcToken,
  };
  let fatal;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      const s = String(chunk);
      if (/error|fatal|실패/i.test(s)) log(`bundle: ${s.slice(0, 500)}`);
      cb();
    },
  });
  bundle = await startBundle({
    config: { env: 'local', services: ['payment-svc', 'purchase-svc', 'admission-ctrl', 'queue-svc'], envDir, managementPort: bundlePorts.bundleManagement },
    common,
    logDestination: sink,
    onFatal: (service, err) => {
      fatal = `${service}: ${err instanceof Error ? err.message : String(err)}`;
      log(`bundle 서비스 치명 실패 ${fatal}`);
    },
  });
  if (fatal) throw new Error(`bundle 시작 실패: ${fatal}`);
  for (const [service, p] of Object.entries(bundlePorts)) {
    if (!p || typeof p !== 'object') continue;
    await waitFor(`${service} 준비`, async () => (await readyOf(p.management)) === 200, 180_000, 300);
    log(`${service} 준비`);
  }
}

async function startIdentity(urls) {
  ID_PORTS.app = await freePort();
  ID_PORTS.management = await freePort();
  ID_PORTS.grpc = await freePort();
  identity = spawnChild('identity-svc', join(REPO, 'services', 'identity-svc'), ['--import', '@peaket/platform/telemetry/register', 'dist/main.js'], identityEnv(urls.identity, ID_PORTS));
  await waitFor('identity-svc 준비', async () => (await readyOf(ID_PORTS.management)) === 200, 180_000, 300);
  log(`identity-svc 준비(app ${ID_PORTS.app}, gRPC ${ID_PORTS.grpc})`);
}

async function startOps(urls, opts = {}) {
  const port = opts.port ?? (await freePort());
  const managementPort = opts.managementPort ?? (await freePort());
  const env = opsEnvOf({ databaseUrl: urls.ops, port, managementPort, ...opts });
  ops = spawnChild('ops-svc', join(REPO, 'services', 'ops-svc'), ['--import', '@peaket/platform/telemetry/register', 'dist/main.js'], env);
  await waitFor('ops-svc 준비', async () => (await readyOf(managementPort)) === 200, 180_000, 300);
  opsState = { port, managementPort };
  log(`ops-svc 준비(app ${port})`);
  return opsState;
}

async function restartOps(urls, opts = {}) {
  const oldPort = opsState?.port;
  const oldManagement = opsState?.managementPort;
  if (ops) {
    await stopChild('ops-svc', ops.child);
    children.delete('ops-svc');
  }
  // 같은 포트로 다시 띄운다(미리보기 프록시 주소가 바뀌지 않게)
  const p = await startOps(urls, { ...opts, ...(oldPort ? { port: oldPort } : {}), ...(oldManagement ? { managementPort: oldManagement } : {}) });
  return p;
}

async function startPreview(opsPort) {
  preview = spawnChild('preview', join(REPO, 'apps', 'console-host'), ['scripts/preview-server.mjs', String(PREVIEW_PORT)], previewEnv(opsPort, ID_PORTS.app));
  await waitFor('콘솔 미리보기 서버', async () => (await statusOf(`${PREVIEW_ORIGIN}/login`)) === 200, 60_000, 200);
  log(`콘솔 미리보기 서버 준비(${PREVIEW_ORIGIN})`);
}

function storesOf(eid, commandId) {
  if (!/^[0-9a-f-]{36}$/i.test(eid)) throw new Error('event가 UUID가 아니다');
  const purchase = docker(['exec', postgres.id, 'psql', '-U', 'postgres', '-d', 'purchase', '-tAc', `select paused, paused_revision::text, paused_command_id::text from sale_control where scope = 'EVENT' and event_id = '${eid}'`]).trim();
  const payment = docker(['exec', postgres.id, 'psql', '-U', 'postgres', '-d', 'payment', '-tAc', `select active, to_pg, version::text from pg_switch where scope = '${eid}'`]).trim();
  const hash = (key) => {
    try {
      const raw = docker(['exec', valkey.id, 'valkey-cli', '--raw', 'HGETALL', key]).split(/\r?\n/);
      const out = {};
      for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
      return out;
    } catch {
      return {};
    }
  };
  return {
    eventId: eid,
    commandId,
    purchase,
    payment,
    seat: hash(`s:{event:${eid}}:ctl`),
    queueNotice: hash(`q:{event:${eid}}:notice`),
    admission: hash(`q:{event:${eid}}:ctl`),
  };
}

/** identity DB에 남은 패스키 서명 횟수. 가상 인증기를 그 값에서 시작해야 서명 횟수 퇴행으로 거절되지 않는다 */
function signCountOf(accountId) {
  try {
    const out = docker(['exec', postgres.id, 'psql', '-U', 'postgres', '-d', 'identity', '-tAc', `select sign_count from admin_passkey where admin_account_id = '${accountId}' order by created_at limit 1`]).trim();
    return Number(out) || 0;
  } catch {
    return 0;
  }
}

function accountView() {
  return Object.fromEntries(
    Object.entries(accounts).map(([key, a]) => [
      key,
      {
        key,
        id: a.id,
        email: a.email,
        password: a.password,
        totpSeed: a.totpSeed,
        role: a.role,
        passkey: {
          credentialId: a.passkey.credentialId,
          privateKey: a.passkey.privateKey,
          userHandle: Buffer.from(a.id.replaceAll('-', ''), 'hex').toString('base64'),
          rpId: 'localhost',
          name: a.passkey.name,
          signCount: signCountOf(a.id),
        },
      },
    ]),
  );
}

function statusView() {
  return {
    ready,
    eventId,
    previewUrl: PREVIEW_ORIGIN,
    stageUrl: `http://127.0.0.1:${STAGE_PORT}`,
    accounts: accountView(),
    ports: { identity: ID_PORTS, ops: opsState, bundle: bundlePorts },
    logs: logs.slice(-50),
  };
}

async function shutdown() {
  if (closing) return;
  closing = true;
  ready = false;
  try {
    await stopChild('preview', preview?.child);
  } catch {}
  try {
    if (ops) await stopChild('ops-svc', ops.child);
  } catch {}
  try {
    if (identity) await stopChild('identity-svc', identity.child);
  } catch {}
  try {
    await bundle?.close();
  } catch (e) {
    log(`bundle 닫기 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
  rmContainer(postgres?.id);
  rmContainer(valkey?.id);
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function startController(urls) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${STAGE_PORT}`);
      if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, ready ? 200 : 503, { ok: ready, ready });
      if (req.method === 'GET' && url.pathname === '/stage/status') return sendJson(res, 200, statusView());
      if (req.method === 'GET' && url.pathname === '/stage/stores') {
        const eid = url.searchParams.get('event') ?? '';
        return sendJson(res, 200, storesOf(eid, url.searchParams.get('commandId') ?? ''));
      }
      if (req.method === 'GET' && url.pathname === '/stage/logs') return sendJson(res, 200, { logs });
      if (req.method === 'POST' && url.pathname === '/stage/ops/restart') {
        const body = await readJson(req);
        const admission = Array.isArray(body.admissionAddrs) && body.admissionAddrs.length > 0 ? body.admissionAddrs.map(String) : undefined;
        if (body.eventId && /^[0-9a-f-]{36}$/i.test(String(body.eventId))) eventId = String(body.eventId).toLowerCase();
        await restartOps(urls, { admissionAddrs: admission });
        return sendJson(res, 200, { ok: true, ports: { app: opsState.port, management: opsState.managementPort } });
      }
      if (req.method === 'POST' && url.pathname === '/stage/event') {
        const body = await readJson(req);
        if (!/^[0-9a-f-]{36}$/i.test(String(body.eventId ?? ''))) return sendJson(res, 400, { error: 'eventId는 UUID다' });
        eventId = String(body.eventId).toLowerCase();
        return sendJson(res, 200, { eventId });
      }
      return sendJson(res, 404, { error: '없는 경로' });
    } catch (e) {
      log(`stage 요청 실패: ${e instanceof Error ? e.message : String(e)}`);
      return sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  await new Promise((resolveP, reject) => {
    server.once('error', reject);
    server.listen(STAGE_PORT, '127.0.0.1', resolveP);
  });
  return server;
}

async function main() {
  assertDockerSlot();
  assertBuild();
  removeStaleContainers();
  accounts = buildAccounts();
  identityKeys = { fan: ecJwk('gate-f034-fan'), admin: ecJwk('gate-f034-admin'), staff: ecJwk('gate-f034-staff') };

  log('PostgreSQL·Valkey 컨테이너를 띄운다');
  [postgres, valkey] = await Promise.all([startPostgres(), startValkey()]);
  createDatabases(['identity', 'ops', 'purchase', 'payment']);
  const urls = {
    identity: postgres.urlOf('identity'),
    ops: postgres.urlOf('ops'),
    purchase: postgres.urlOf('purchase'),
    payment: postgres.urlOf('payment'),
  };

  migrateAll(urls);
  seedAccounts(urls.identity);

  log('받는 쪽 넷(bundle)과 identity-svc를 띄운다');
  await Promise.all([startBundleReceivers(urls, join(work, 'bundle-env')), startIdentity(urls)]);

  log('ops-svc를 띄운다');
  await startOps(urls);
  await startPreview(opsState.port);

  // 시험마다 같은 자리(이벤트·계정)를 쓰도록 알린다
  eventId = randomUUID().toLowerCase();
  log(`무대 준비 완료(event ${eventId})`);
  const server = await startController(urls);
  ready = true;

  const bye = () => {
    void shutdown().finally(() => {
      server.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', bye);
  process.once('SIGINT', bye);
  process.once('exit', () => {
    // 비동기 정리가 못 돈 경우에도 우리 컨테이너만 지운다(남의 컨테이너는 건드리지 않는다)
    rmContainer(postgres?.id);
    rmContainer(valkey?.id);
  });
}

main().catch(async (e) => {
  stageError = e;
  log(`무대를 세우지 못했다: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  await shutdown().catch(() => undefined);
  process.exitCode = 1;
});
