// BAT-086 시연 재생기(계획 §1 G3, §5). `tools/web-checks`의 Playwright 1.64.1을 빌려 쓴다(새 패키지 없음).
// - 시나리오마다 브라우저 맥락을 새로 연다(로그인·티켓이 시나리오 사이에 새지 않게).
// - 화면은 조건을 기다린다(고정 sleep 없음). 실패하면 화면 그림·URL·마지막 단계를 남긴다.
// - 결과 확인(checks)은 제품 API·화면에서 만든다. 하나라도 만들어지지 않으면 그 시나리오는 실패다(조용한 건너뛰기 없음).
// - S1·S3·S4·S6은 구매 세션 서명(ECDH+HKDF)으로 실제 API를 끝까지 부른다. PG는 데모 무대의 시뮬레이터다.
//   S2·S5·S7·S8·S9는 화면을 열고, 아직 자동화하지 못한 판정은 '실패'로 남긴다(까닭을 적는다).
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, createPrivateKey, generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { demoAccountSecrets, demoAuth, demoUuid, httpsJson, issueFanReauthToken, prepareDemoSecrets, readSeed, totpAt } from '../demo-auth.mjs';
import { expandSeatMap } from '../demo-seed.mjs';
import { DEMO_GATEWAY_PORTS, DEMO_HOSTS, demoExpectedWorkloads } from '../demo-objects.mjs';
import { admissionClaims, createClientKeyPair, purchaseMac, requestKey, sharedSecret } from '../../../packages/api-client/src/purchase/crypto.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 2000) => (String(s ?? '').length > n ? `…${String(s ?? '').slice(-n)}` : String(s ?? ''));
/** 데모 무대의 구매 동의 문안 판(v1EnvFiles와 같다). 서버 값과 다르면 422 consent-version-outdated다 */
export const DEMO_CONSENT_VERSION = 'lt-v1-2026-11';
/** 데모 시계: 회차 오픈을 지금 + 30초로 당긴다(계획 §12 [가정]) */
export const DEMO_CLOCK_MS = 30_000;
const OPEN_WAIT_MS = 180_000;
const PAYMENT_WAIT_MS = 90_000;
const ACTION_TIMEOUT_MS = 30_000;
/** 대기열 기기 식별자(16바이트 base64url 22자). 서버가 CSPRNG 128비트 꼴만 받는다 */
const DEMO_DEVICE_ID = Buffer.alloc(16, 7).toString('base64url');
/** 좌석맵 판 파일의 좌석 ID(주문 DB가 UUID를 요구한다). 같은 회차·표시는 같은 UUID다 */
const demoSeatId = (eventId, label) => demoUuid(`seat:${eventId}:${label}`);

/** tools/web-checks의 Playwright를 읽는다. 없으면 설치 명령을 그대로 알려 준다 */
export async function loadPlaywright(repo) {
  const req = createRequire(join(repo, 'tools', 'web-checks', 'package.json'));
  let resolved;
  try {
    resolved = req.resolve('@playwright/test');
  } catch {
    throw new Error(`Playwright를 찾지 못했다. \`pnpm --dir tools/web-checks install --frozen-lockfile\`와 \`pnpm --dir tools/web-checks exec playwright install chromium\`를 먼저 한다(tools/web-checks를 빌려 쓴다, 계획 §5)`);
  }
  const mod = await import(pathToFileURL(resolved).href);
  return mod.default ?? mod;
}

/** kubectl 실행 파일. 환경 값 → .cache/peaket-tools의 kubectl-* → PATH 차례(시험이 가짜 kubectl을 PATH에 둘 수 있게) */
export function kubectlBin(env = process.env) {
  if (env.PEAKET_KUBECTL) return env.PEAKET_KUBECTL;
  const root = env.PEAKET_TOOLS_DIR || join(REPO, '.cache', 'peaket-tools');
  try {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || !d.name.startsWith('kubectl-')) continue;
      for (const name of process.platform === 'win32' ? ['kubectl.exe', 'kubectl'] : ['kubectl']) {
        const p = join(root, d.name, name);
        if (existsSync(p)) return p;
      }
    }
  } catch {}
  for (const name of process.platform === 'win32' ? ['kubectl.exe', 'kubectl'] : ['kubectl']) {
    const p = join(root, name);
    if (existsSync(p)) return p;
  }
  return 'kubectl';
}

/** 데모 kubeconfig(없으면 실행 때 오류로 드러난다) */
export function kubeconfigOf(env = process.env) {
  const cluster = env.PEAKET_DEMO_CLUSTER || env.PEAKET_CLUSTER || 'lane4-demo';
  return env.PEAKET_KUBECONFIG || join(env.PEAKET_TOOLS_DIR || join(REPO, '.cache', 'peaket-tools'), `kubeconfig-${cluster}`);
}

/** 윈도우에서는 .cmd·.bat을 cmd.exe로 부른다(가짜 도구 시험이 배치 파일을 둘 수 있게) */
function runTool(bin, args, o = {}) {
  const opts = {
    encoding: 'utf8',
    stdio: o.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    input: o.input,
    timeout: o.timeout ?? 120_000,
    maxBuffer: 32 * 1024 * 1024,
    env: o.env ?? process.env,
  };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    // cmd /s /c는 바깥 따옴표 한 쌍을 벗긴다. 그래서 명령줄 전체를 한 번 더 감싼다
    const quote = (a) => (/[\s"]/.test(String(a)) ? `"${String(a).replaceAll('"', '\\"')}"` : String(a));
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${bin}" ${args.map(quote).join(' ')}"`], opts);
  }
  return spawnSync(bin, args, opts);
}

/** kubectl 한 번(전용 kubeconfig). 실패는 호출한 쪽이 까닭과 함께 다룬다 */
export function kubectl(args, o = {}) {
  const r = runTool(kubectlBin(o.env), ['--kubeconfig', kubeconfigOf(o.env), ...args], o);
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const e = new Error(`kubectl ${args[0] ?? ''} → ${r.status}`);
    e.stderr = String(r.stderr ?? '');
    throw e;
  }
  return String(r.stdout ?? '');
}

/**
 * 무대가 준비됐는지 본다. 하나라도 모자라면 { ok: false, reason: 'pods-not-ready', problems }다.
 * `play`가 이 확인보다 먼저 어떤 시나리오도 통과로 세지 않는다(V-T7 ③).
 */
export function stageProblems(o = {}) {
  const expected = demoExpectedWorkloads();
  if (expected.length === 0) return { ok: false, reason: 'no-workloads', problems: ['기대 워크로드 목록이 비었다(0건은 통과가 아니다)'] };
  let list;
  try {
    // 차트의 Deployment 라벨은 app.kubernetes.io/part-of=peaket이다(네임스페이스만 peaket-demo). 라벨로 좁히지 않고
    // 이름·네임스페이스로 기대 목록과 견준다(다른 라벨로 뜬 워크로드도 조용히 통과하지 않게)
    list = JSON.parse(kubectl(['get', 'deploy', '-A', '-o', 'json'], o));
  } catch (e) {
    const text = String(e?.stderr ?? e?.message ?? '');
    return { ok: false, reason: /NotFound|does not exist|connection refused|no such host/i.test(text) ? 'cluster-not-found' : 'pods-not-ready', problems: [`워크로드 목록을 읽지 못했다: ${tail(text, 800)}`] };
  }
  const byKey = new Map((list.items ?? []).map((d) => [`${d.metadata.namespace}/${d.metadata.name}`, d]));
  const problems = [];
  for (const w of expected) {
    const d = byKey.get(`${w.namespace}/${w.name}`);
    if (!d) problems.push(`missing ${w.namespace}/${w.name}`);
    else {
      const ready = Number(d.status?.readyReplicas ?? 0);
      if (ready < w.expected) problems.push(`pods-not-ready ${w.namespace}/${w.name} ready ${ready}/${w.expected}`);
    }
  }
  return { ok: problems.length === 0, reason: problems.length ? 'pods-not-ready' : undefined, problems };
}

/** 데모 접속 정보의 출처(호스트·포트). 접속 정보에 없는 키는 기본 포트로 채운다 */
export function originOf(contract, key) {
  const host = contract?.hosts?.[key] ?? DEMO_HOSTS[key];
  const port = contract?.ports?.[key] ?? DEMO_GATEWAY_PORTS[key];
  if (!host || !port) throw new Error(`데모 접속 정보에 ${key}가 없다`);
  return `https://${host}:${port}`;
}

/** 경로의 `{eventId}`·`{ticketId}` 같은 자리를 바꾼다 */
export function fillPath(path, vars = {}) {
  return String(path).replace(/\{([A-Za-z0-9_]+)\}/g, (m, k) => {
    if (vars[k] === undefined) throw new Error(`경로 ${path}의 ${k} 값이 없다`);
    return encodeURIComponent(String(vars[k]));
  });
}

const cookieHeader = (cookies) => (cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');

/** 시나리오 재생 상태 하나. 시험·기록이 읽는 값은 전부 여기에 남는다 */
function newCtx(o) {
  const ctx = {
    contract: o.contract,
    repo: o.repo,
    runId: o.runId,
    artifactsDir: o.artifactsDir,
    headed: o.headed,
    video: o.video,
    now: o.now ?? Date.now,
    log: o.log ?? ((s) => console.log(s)),
    pw: o.pw,
    browser: o.browser,
    env: o.env,
    // API 세션은 시나리오 사이에 이어 쓴다(브라우저 맥락은 시나리오마다 새로 연다). 관리 로그인의 TOTP 칸도 함께 기록한다
    sessionCache: o.sessionCache ?? new Map(),
    totpSteps: o.totpSteps ?? new Map(),
    contexts: new Map(),
    pages: new Map(),
    visited: [],
    checks: {},
    firstScreenAt: undefined,
    vars: {},
    artifacts: [],
    addCheck(name, ok, detail) {
      const prev = ctx.checks[name];
      const value = { ok: Boolean(ok), detail: String(detail ?? '') };
      if (!prev || (!prev.ok && value.ok)) ctx.checks[name] = value;
    },
    has(name) {
      return ctx.checks[name]?.ok === true;
    },
  };
  return ctx;
}

/** 계정 하나의 데모 세션(팬은 gRPC CreateSession, 관리자는 비밀번호+TOTP). 값은 메모리에만 둔다 */
async function session(ctx, key) {
  if (!ctx.sessionCache.has(key)) {
    const account = readSeed().accounts.find((a) => a.key === key);
    if (!account) throw new Error(`시드에 없는 계정: ${key}`);
    const value = await (ctx.auth ?? demoAuth)(account.kind === 'fan' ? 'fan' : 'admin', key);
    if (account.kind !== 'fan') ctx.totpSteps.set(key, totpStep());
    ctx.sessionCache.set(key, value);
  }
  return ctx.sessionCache.get(key);
}

/** 계정의 브라우저 맥락 하나(시나리오 안에서 재사용). 쿠키를 그 맥락에만 싣는다 */
async function contextFor(ctx, account) {
  if (ctx.contexts.has(account)) return ctx.contexts.get(account);
  const s = await session(ctx, account);
  const context = await ctx.browser.newContext({
    ignoreHTTPSErrors: true,
    locale: 'ko-KR',
    colorScheme: 'light',
    viewport: { width: 1280, height: 800 },
    ...(ctx.video ? { recordVideo: { dir: join(ctx.artifactsDir, 'video') } } : {}),
  });
  if (s.cookies?.length) await context.addCookies(s.cookies);
  ctx.contexts.set(account, context);
  return context;
}

async function pageFor(ctx, account) {
  if (ctx.pages.has(account)) return ctx.pages.get(account);
  const context = await contextFor(ctx, account);
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  ctx.pages.set(account, page);
  return page;
}

/**
 * 화면 하나를 연다. 화면은 증거이고 판정은 checks가 맡는다. 실패하면 그림·URL·단계를 남기고 던진다.
 * @param {{ screen?: string, path: string, account: string, expect?: string[] }} step
 */
async function visit(ctx, step) {
  const page = await pageFor(ctx, step.account);
  const originKey = step.origin ?? 'www';
  const url = `${originOf(ctx.contract, originKey)}${fillPath(step.path, ctx.vars)}`;
  const started = ctx.now();
  ctx.log(`화면 ${step.screen ?? step.path}: ${url}`);
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ACTION_TIMEOUT_MS });
  } catch (e) {
    await failArtifact(ctx, step, page, e);
    throw new Error(`화면 ${step.screen ?? step.path}을 열지 못했다: ${e instanceof Error ? e.message : String(e)}`);
  }
  const status = response?.status() ?? 0;
  if (status >= 400) {
    await failArtifact(ctx, step, page, new Error(`HTTP ${status}`));
    throw new Error(`화면 ${step.screen ?? step.path}이(가) HTTP ${status}다`);
  }
  // 셸이 그려졌는지(화면 코드가 없는 주소는 Next 404다)
  await page.waitForSelector('main, #main, [role="main"], form, h1', { timeout: ACTION_TIMEOUT_MS }).catch(async (e) => {
    await failArtifact(ctx, step, page, e);
    throw new Error(`화면 ${step.screen ?? step.path}의 본문을 찾지 못했다`);
  });
  for (const text of step.expect ?? []) {
    try {
      // 보이는 본문 글자로 본다. getByText의 첫 일치가 숨은 RSC 조각일 수 있어 화면에 그려진 글자를 조건으로 기다린다
      await page.waitForFunction((src) => new RegExp(src, 'i').test(document.body?.innerText ?? ''), text, { timeout: ACTION_TIMEOUT_MS });
    } catch (e) {
      await failArtifact(ctx, step, page, e);
      throw new Error(`화면 ${step.screen ?? step.path}에서 '${text}'를 찾지 못했다`);
    }
  }
  ctx.visited.push({ screen: step.screen, path: step.path, url: page.url(), status, ms: Math.round(ctx.now() - started) });
  if (ctx.firstScreenAt === undefined) ctx.firstScreenAt = ctx.now();
  return page;
}

async function failArtifact(ctx, step, page, e) {
  try {
    const name = `${step.screen ?? 'screen'}-${String(step.path).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}-${ctx.now()}.png`;
    const file = join(ctx.artifactsDir, name);
    mkdirSync(ctx.artifactsDir, { recursive: true });
    await page.screenshot({ path: file, fullPage: false });
    ctx.artifacts.push({ step: step.screen ?? step.path, url: page.url(), file, error: e instanceof Error ? e.message : String(e) });
    ctx.log(`  실패 그림: ${file}`);
  } catch {}
}

/** 제품 API 한 번. 쿠키는 데모 세션에서만 읽고 로그에 싣지 않는다 */
async function api(ctx, account, o) {
  const s = await session(ctx, account);
  const hostKey = o.host ?? 'api';
  const res = await httpsJson({
    host: ctx.contract.hosts[hostKey],
    port: ctx.contract.ports[hostKey],
    method: o.method,
    path: o.path,
    ...(o.body === undefined ? {} : { body: o.body }),
    headers: {
      cookie: cookieHeader(s.cookies),
      origin: originOf(ctx.contract, o.originKey ?? (hostKey === 'partner-api' ? 'partner' : hostKey === 'ops-api' ? 'console' : 'www')),
      'sec-fetch-site': 'same-origin',
      ...(o.headers ?? {}),
    },
  });
  return res;
}

/** SQL 읽기(로컬 데모 전용 예외: 파트너 목록·상세 API가 없는 곳의 읽기만). 쓰기는 sqlDemoWrite 하나로 좁힌다 */
function sqlRead(ctx, db, statement) {
  return kubectl(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-tAc', statement], { env: ctx.env }).trim();
}

/**
 * 데모 전용 SQL 쓰기. 제품 API가 아직 없는 자리(판매 심사 제출)를 재생할 때만 쓴다.
 * 제품 동작을 바꾸지 않고, 시험 실행마다 같은 픽스처를 만드는 용도다.
 */
function sqlDemoWrite(ctx, db, statement) {
  return kubectl(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tAc', statement], { env: ctx.env }).trim();
}

/** 대기열 Valkey 한 번(로컬 데모 전용 예외: 매진 픽스처를 만들 때만 쓴다). 실패는 던진다 */
function redis(ctx, args) {
  return kubectl(['-n', 'purchase', 'exec', 'deploy/demo-valkey', '--', 'valkey-cli', ...args], { env: ctx.env }).trim();
}

/**
 * 회차 일정 사본(q:{event:E}:cfg)을 데모 전용으로 만든다. 판매 승인 때 core-svc relay가 쓰는 값과 같은 칸이다.
 * 이 데모 무대에는 relay가 없어 cfg가 비어 있으면 대기열 API가 404(queue-not-found)다.
 */
function ensureQueueSchedule(ctx, eventId) {
  const row = JSON.parse(sqlRead(ctx, 'peaket_demo_core', `select json_build_object('openAt', open_at, 'startsAt', starts_at, 'lobbyMinutes', lobby_minutes) from event where id = '${eventId}'`));
  const opensAtMs = Date.parse(row.openAt);
  const startsAtMs = Date.parse(row.startsAt);
  if (!Number.isFinite(opensAtMs) || !Number.isFinite(startsAtMs)) throw new Error(`회차 ${eventId}의 일정을 읽지 못했다: ${JSON.stringify(row)}`);
  redis(ctx, [
    'HSET', `q:{event:${eventId}}:cfg`,
    'opensAtMs', String(opensAtMs),
    'startsAtMs', String(startsAtMs),
    // 오픈 직후 묶음(openBatch)은 데모에서 끈다. 켜면 T=0 진입이 503 batching으로 막혀 재생기가 기다릴 수 없다.
    // 로비 섞기(lobbyShuffle)는 켜 둔다(둘 다 끄면 parseSchedule이 거절한다)
    'lobbyShuffle', '1',
    'openBatch', '0',
    'lobbyMinutes', String(row.lobbyMinutes ?? 10),
    'rev', '1',
  ]);
  // cfg를 읽는 쪽은 1초 캐시를 둔다. 새로 쓴 값이 바로 보이도록 회차 세대 키를 새로 만든다
  redis(ctx, ['DEL', `q:{event:${eventId}}:epoch`]);
}

/**
 * 같은 회차의 지난 대기열 입장(계정별 q:adm 키와 입장 표시)을 지운다(데모 전용).
 * 이걸 지우지 않으면 play를 다시 돌릴 때 entries가 409 already-admitted로 막힌다.
 */
async function resetQueueAdmission(ctx, eventId, account = 'jimin') {
  // 대기 중인 대기표가 있으면 먼저 뺀다(이미 입장한 계정은 409/410일 수 있어 결과를 보지 않는다)
  await api(ctx, account, {
    method: 'DELETE',
    host: 'queue',
    path: `/v1/queues/${eventId}/entries/me`,
    headers: { origin: originOf(ctx.contract, 'queue') },
  }).catch(() => undefined);
  const pattern = `q:adm:*:${eventId}`;
  for (const key of redis(ctx, ['--scan', '--pattern', pattern]).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    redis(ctx, ['DEL', key]);
  }
  redis(ctx, ['DEL', `q:{event:${eventId}}:admitted`, `q:{event:${eventId}}:slot_of`, `q:{event:${eventId}}:req`]);
}

/** 한 계정의 회차별 구매 한도 표시(Redis quota)를 지운다(데모 전용: S3가 S1 뒤에 같은 회차를 다시 쓴다) */
async function resetPurchaseQuota(ctx, account, eventId) {
  const me = await session(ctx, account);
  redis(ctx, ['DEL', `s:{event:${eventId}}:quota:${me.accountId}`]);
}

/** 컨테이너 안에 파일 하나를 쓴다(데모 재생기의 좌석맵 판 파일). 표준 입력으로 넘긴다 */
function kubectlWriteFile(ctx, path, text) {
  kubectl(['-n', 'purchase', 'exec', '-i', 'deploy/bundle', '--', 'sh', '-c', `mkdir -p '${dirname(path)}' && cat > '${path}'`], { env: ctx.env, input: text });
}

/**
 * purchase-svc가 읽는 좌석맵 판 파일(/tmp/seatmaps/{eventId}.json)을 시드에서 만든다.
 * 시드의 좌석맵은 API로 core에 들어가지만, purchase-svc는 로컬 판 파일을 읽는다(FileSeatMapSource).
 * 이 파일이 없으면 홀드가 503 seat-store-unavailable이다(데모 무대의 파일 자리를 재생기가 채운다).
 */
function writeSeatMap(ctx, eventId, eventKey) {
  const seed = readSeed();
  const ev = seed.events.find((e) => e.key === eventKey);
  const map = seed.seatMaps.find((m) => m.eventKey === eventKey);
  if (!ev || !map) throw new Error(`시드에 회차 ${eventKey}의 좌석맵이 없다`);
  const expanded = expandSeatMap(seed, map);
  // 주문 DB의 items[].seatId는 UUID다. 시드의 읽기 쉬운 좌석 ID(R1-1-1)는 label로 남기고 UUID로 바꾼다(같은 회차·좌석은 같은 UUID)
  for (const sec of expanded.sections) {
    for (const seat of sec.seats) {
      seat.label = seat.seatId;
      seat.seatId = demoSeatId(eventId, seat.seatId);
    }
  }
  const row = JSON.parse(sqlRead(ctx, 'peaket_demo_core', `select json_build_object('startsAt', starts_at, 'limit', per_person_limit) from event where id = '${eventId}'`));
  const startsAtMs = Date.parse(row.startsAt);
  if (!Number.isFinite(startsAtMs)) throw new Error(`회차 ${eventId}의 시작 시각을 읽지 못했다`);
  const file = {
    perAccountLimit: Number(row.limit),
    saleEndsAt: new Date(startsAtMs - 24 * 60 * 60_000).toISOString(),
    tierPrices: Object.fromEntries(Object.entries(ev.prices ?? {}).map(([k, v]) => [k, Number(v)])),
    layout: { layoutVersion: 1, sections: expanded.sections },
  };
  kubectlWriteFile(ctx, `/tmp/seatmaps/${eventId}.json`, JSON.stringify(file));
  // 좌석 판매 열기(SeatStore.openSale과 같은 Redis 상태). 이 세대 키가 없으면 홀드가 NOT_READY → 503이다
  const seatCount = Math.max(...expanded.sections.map((s) => s.seatIndexRange.to)) + 1;
  const sec = String(Math.floor(Date.now() / 1000));
  redis(ctx, ['SADD', 's:ctl:events', eventId]);
  redis(ctx, ['SETBIT', `s:{event:${eventId}}:bitmap`, String(seatCount - 1), '0']);
  redis(ctx, ['HSET', `s:{event:${eventId}}:epoch`, 'epoch', sec, 'node', 'demo', 'gen', '1', 'chk', sec]);
  redis(ctx, ['PEXPIREAT', `s:{event:${eventId}}:bitmap`, String(startsAtMs)]);
  redis(ctx, ['PEXPIREAT', `s:{event:${eventId}}:epoch`, String(startsAtMs)]);
}

/**
 * 조건을 기다린다(고정 sleep 아님). fn이 { ok, value, detail }을 돌려줄 때까지 다시 본다.
 * 실패하면 마지막 detail을 실패 사유로 남긴다.
 */
async function waitUntil(ctx, what, fn, o = {}) {
  const timeoutMs = o.timeoutMs ?? ACTION_TIMEOUT_MS * 2;
  const intervalMs = o.intervalMs ?? 500;
  const until = ctx.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last?.ok) return last.value;
    if (ctx.now() > until) throw new Error(`${what}을(를) ${Math.round(timeoutMs / 1000)}초 안에 보지 못했다(${last?.detail ?? '조건 아님'})`);
    await sleep(intervalMs);
  }
}

const b64u = (b) => Buffer.from(b).toString('base64url');

/** JWT의 payload(로그에 싣지 않는다) */
function jwtPayload(token) {
  const part = String(token ?? '').split('.')[1];
  if (!part) throw new Error('토큰 모양이 아니다(JWT payload 없음)');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/** TOTP 시간 칸(30초). 같은 칸의 코드는 서버가 한 번만 받는다 */
const totpStep = () => Math.floor(Date.now() / 1000 / 30);

/**
 * 팬 재인증 토큰 하나. identity gRPC IssueReauthToken에 세션·계정·제공자·작업을 넘긴다.
 * 데모에는 OIDC 제공자가 없어 제공자 재로그인만 생략하고, 토큰 발급·강도 판정은 실제 경로다(계획 B7·감독 결정 4).
 */
async function fanReauth(ctx, accountKey, operation) {
  const s = await session(ctx, accountKey);
  if (!s.sessionId) throw new Error(`${accountKey} 팬 세션의 sessionId가 없다`);
  const seed = readSeed();
  const account = seed.accounts.find((a) => a.key === accountKey);
  if (!account) throw new Error(`시드에 없는 계정: ${accountKey}`);
  return issueFanReauthToken({ sessionId: s.sessionId, accountId: s.accountId, provider: account.provider, providerUserId: account.providerUserId, operation });
}

/**
 * 팬 본인확인을 마쳐 ticket:buy scope와 pid가 있는 세션을 만든다(데모 시험 기관).
 * 시험 기관 창을 브라우저로 열지 않고, 기관이 서명해 돌려주는 결과 값과 같은 모양을 시험 비밀로 직접 만든다
 * (services/identity-svc/scripts/mock-idv.mjs의 sealResult와 같은 HMAC). 값은 메모리에만 둔다.
 */
async function ensureFanVerified(ctx, accountKey) {
  let s = await session(ctx, accountKey);
  const token = (s.cookies ?? []).find((c) => c.name === '__Secure-peaket_at')?.value;
  let claims;
  try {
    claims = jwtPayload(token ?? '');
  } catch {
    claims = {};
  }
  if (String(claims.scope ?? '').split(' ').includes('ticket:buy')) return s;
  const start = await api(ctx, accountKey, {
    method: 'POST',
    host: 'api',
    path: '/v1/identity/verifications',
    headers: { 'content-type': 'application/json' },
    body: { purpose: 'FIRST', next: '/my' },
  });
  if (start.status === 201 && typeof start.json?.verificationId === 'string') {
    const id = start.json.verificationId;
    const { secrets } = prepareDemoSecrets();
    const body = { v: 1, tx: id, outcome: 'VERIFIED', person: `demo-${accountKey}`, birth: '2000-01-01', iat: Date.now() };
    const result = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    const mac = createHmac('sha256', Buffer.from(secrets.idvSecret, 'base64')).update(`peaket-test-idv-result:v1:${result}`).digest('base64url');
    const done = await api(ctx, accountKey, {
      method: 'POST',
      host: 'api',
      path: `/v1/identity/verifications/${id}/result`,
      headers: { 'content-type': 'application/json' },
      body: { providerResult: { verificationId: id, result, mac } },
    });
    if (done.status !== 200 || done.json?.status !== 'VERIFIED') throw new Error(`팬 본인확인 확정 → ${done.status} ${tail(done.text, 600)}`);
  } else if (start.status !== 409) {
    throw new Error(`팬 본인확인 시작 → ${start.status} ${tail(start.text, 600)}`);
  }
  // 확인 전에 만든 세션 토큰에는 scope·pid가 없다. 같은 계정으로 다시 로그인해 새 토큰을 쓰고, 이미 연 브라우저 맥락에도 쿠키를 바꾼다
  const fresh = await demoAuth('fan', accountKey);
  ctx.sessionCache.set(accountKey, fresh);
  const context = ctx.contexts.get(accountKey);
  if (context && fresh.cookies?.length) await context.addCookies(fresh.cookies);
  return fresh;
}

/**
 * 관리 재인증 토큰 하나(패스키까지). 비밀번호·TOTP는 .cache에서 메모리로만 읽고, 응답의 챌린지에
 * 시드 패스키로 WebAuthn assertion(ES256)을 직접 만들어 보낸다(CDP 가상 인증기와 같은 서명).
 * 같은 TOTP 칸은 서버가 한 번만 받으므로, 그 계정의 앞선 로그인·재인증과 칸이 겹치면 다음 칸까지 기다린다(조건 대기).
 */
async function adminReauth(ctx, accountKey, act) {
  const s = await session(ctx, accountKey);
  if (!s.passkey) throw new Error(`${accountKey}에 패스키 시드가 없다`);
  const last = ctx.totpSteps?.get(accountKey) ?? -1;
  if (totpStep() <= last) {
    const waitMs = (last + 1) * 30_000 - Date.now() + 1_200;
    if (waitMs > 0) {
      ctx.log(`  ${accountKey}의 다음 TOTP 칸을 기다린다(${Math.ceil(waitMs / 1000)}초)`);
      await sleep(waitMs);
    }
  }
  const { password, totpSeed } = demoAccountSecrets(accountKey);
  const aud = accountKey === 'stella-admin' ? 'partner' : 'ops';
  const originKey = aud === 'partner' ? 'partner' : 'console';
  const path = `/v1/${aud}/auth/reauthentications`;
  const start = await api(ctx, accountKey, {
    method: 'POST',
    host: aud === 'partner' ? 'partner-api' : 'ops-api',
    originKey,
    path,
    headers: { 'content-type': 'application/json' },
    body: { act, password, code: totpAt(totpSeed), withPasskey: true },
  });
  ctx.totpSteps?.set(accountKey, totpStep());
  if (start.status !== 200 || start.json?.next !== 'PASSKEY') {
    throw new Error(`${accountKey} 재인증 1단계 → ${start.status} ${tail(start.text, 600)}`);
  }
  // 패스키 RP 출처는 콘솔 출처 그대로다(데모는 포트가 붙는다). RP ID만 포트가 없다
  const passkeyOrigin = ctx.contract.origins?.[s.passkey.rpId === 'partner.peaket.example' ? 'partner' : 'console'] ?? `https://${s.passkey.rpId}`;
  const credential = webauthnAssertion(s.passkey, start.json.publicKey, passkeyOrigin);
  const done = await api(ctx, accountKey, {
    method: 'POST',
    host: aud === 'partner' ? 'partner-api' : 'ops-api',
    originKey,
    path,
    headers: { 'content-type': 'application/json' },
    body: { reauthStep: start.json.reauthStep, credential },
  });
  if (done.status !== 200 || typeof done.json?.reauthToken !== 'string' || done.json.reauthToken === '') {
    throw new Error(`${accountKey} 재인증 2단계(패스키) → ${done.status} ${tail(done.text, 600)}`);
  }
  return done.json.reauthToken;
}

/**
 * 시드 패스키로 WebAuthn assertion 하나. simple-webauthn의 verifyAuthenticationResponse가 보는 것을 그대로 만든다:
 * clientDataJSON(type webauthn.get, challenge, origin), authenticatorData(rpIdHash·UP|UV·서명 횟수 0), ES256 서명(raw R||S).
 */
function webauthnAssertion(passkey, publicKey, origin) {
  const challenge = String(publicKey?.challenge ?? '');
  if (!challenge) throw new Error('패스키 챌린지가 없다');
  origin = origin ?? `https://${passkey.rpId}`;
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }), 'utf8');
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(passkey.rpId, 'utf8').digest(),
    Buffer.from([0x05]), // UP(0x01) | UV(0x04)
    Buffer.alloc(4), // 서명 횟수 0(시드 패스키 저장값도 0)
  ]);
  const clientHash = createHash('sha256').update(clientDataJSON).digest();
  // WebAuthn(ES256)의 서명은 ASN.1 DER이다(@simplewebauthn/server의 unwrapEC2Signature). JWS(DPoP)의 raw R||S와 다르다
  const signature = signBytes('sha256', Buffer.concat([authenticatorData, clientHash]), {
    key: createPrivateKey({ key: Buffer.from(passkey.privateKey, 'base64'), format: 'der', type: 'pkcs8' }),
  });
  return {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(authenticatorData),
      signature: b64u(signature),
      ...(passkey.userHandle ? { userHandle: passkey.userHandle } : {}),
    },
  };
}

/**
 * 스캐너 기기 키(DPoP). .cache에 보존해 다시 실행해도 같은 기기 자격을 쓴다(등록 코드는 1회용이라 매번 새로 발급).
 * jkt는 RFC 7638 SHA-256(공개 JWK의 crv·kty·x·y).
 */
function deviceKey(ctx) {
  const file = join(ctx.repo, '.cache', 'peaket-tools', 'demo-secrets', 'scanner-device.json');
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (saved.privateKeyPkcs8 && saved.jwk && saved.jkt) return saved;
  }
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const jkt = b64u(createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })).digest());
  const out = { privateKeyPkcs8: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'), jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, jkt };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
  return out;
}

/** DPoP 증명 하나(RFC 9449). 서명은 ES256 raw(R||S)이고 jose가 검증하는 꼴과 같다 */
function dpopProof(key, method, url, accessToken) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk };
  const payload = {
    jti: randomUUID(),
    htm: String(method).toUpperCase(),
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    ...(accessToken ? { ath: b64u(createHash('sha256').update(accessToken).digest()) } : {}),
  };
  const signingInput = `${b64u(Buffer.from(JSON.stringify(header)))}.${b64u(Buffer.from(JSON.stringify(payload)))}`;
  const signature = signBytes('sha256', Buffer.from(signingInput), {
    key: createPrivateKey({ key: Buffer.from(key.privateKeyPkcs8, 'base64'), format: 'der', type: 'pkcs8' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64u(signature)}`;
}

/**
 * 스캐너 API 한 번(기기 DPoP). htu는 게이트웨이가 서비스에 넘긴 주소여야 한다.
 * 포트가 붙은 출처와 정본 이름을 차례로 시도해, 증명만 틀렸을 때(400·401 invalid_dpop_proof) 다음 후보로 넘어간다.
 */
async function scannerJson(ctx, o) {
  const host = ctx.contract.hosts['scanner-api'];
  const port = ctx.contract.ports['scanner-api'];
  const key = o.key ?? deviceKey(ctx);
  const bases = [`https://${host}:${port}`, `https://${host}`];
  let res;
  for (const base of bases) {
    const proof = dpopProof(key, o.method, `${base}${o.path}`, o.accessToken);
    res = await httpsJson({
      host,
      port,
      method: o.method,
      path: o.path,
      ...(o.body === undefined ? {} : { body: o.body }),
      headers: {
        dpop: proof,
        // 스캐너 PWA 출처는 데모에서 포트가 붙는다(identity PEAKET_SCANNER_PWA_ORIGIN과 같아야 한다)
        origin: ctx.contract.origins?.scanner ?? 'https://scanner.peaket.example',
        'content-type': 'application/json',
        ...(o.accessToken ? { authorization: `DPoP ${o.accessToken}` } : {}),
        ...(o.headers ?? {}),
      },
    });
    if (res.status >= 200 && res.status < 300) return res;
    if (![400, 401].includes(res.status) || !/invalid[-_]dpop/i.test(`${res.text} ${JSON.stringify(res.headers ?? {})}`)) return res;
  }
  return res;
}

/** 시드 회차의 ID(공연 제목 + 가장 이른 회차). 시드는 두 번 돌려도 중복을 만들지 않는다 */
function demoEventId(ctx, productionTitle) {
  const id = sqlRead(ctx, 'peaket_demo_core', `select e.id from event e join production p on p.id = e.production_id where p.title = '${productionTitle.replaceAll("'", "''")}' order by e.starts_at, e.id limit 1`);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`회차를 찾지 못했다(공연 ${productionTitle}): ${JSON.stringify(id)}`);
  return id;
}

function eventVersion(ctx, eventId) {
  const v = sqlRead(ctx, 'peaket_demo_core', `select version from event where id = '${eventId}'`);
  if (!/^[0-9]+$/.test(v)) throw new Error(`회차 판(version)을 읽지 못했다: ${JSON.stringify(v)}`);
  return v;
}

/**
 * 데모 시계: 회차 오픈을 지금+30초로 당긴다(파트너 회차 고치기 API, 공개 전에만).
 * 이미 오픈했으면 그대로 쓴다(지난 오픈은 고칠 수 없다).
 */
async function shiftClock(ctx, eventId) {
  const info = await api(ctx, 'jimin', { method: 'GET', path: `/v1/events/${eventId}`, host: 'api' });
  const openAt = info.json?.openAt ? Date.parse(info.json.openAt) : NaN;
  // 시드가 오픈을 지금+30초로 둔다(계획 B6). 이미 가까우면 파트너 고치기를 부르지 않는다.
  // 승인된 공연의 회차 고치기는 pending_revision에 쌓여 공개 값이 바뀌지 않고, 판매 심사 상태만 SUBMITTED로 만든다
  if (Number.isFinite(openAt) && openAt <= ctx.now() + 10 * 60_000) {
    ctx.log(`  오픈이 이미 가깝다(${info.json.openAt}). 시계를 당기지 않는다`);
    return { openAt };
  }
  const wanted = new Date(ctx.now() + DEMO_CLOCK_MS).toISOString();
  const res = await api(ctx, 'stella-admin', {
    method: 'PATCH',
    host: 'partner-api',
    path: `/v1/partner/events/${eventId}`,
    headers: { 'if-match': `"${eventVersion(ctx, eventId)}"` },
    body: { openAt: wanted, lobbyMinutes: 10, lobbyShuffle: true },
  });
  if (![200, 409].includes(res.status)) throw new Error(`데모 시계(오픈 시각 고치기) → ${res.status} ${tail(res.text, 800)}`);
  const after = await api(ctx, 'jimin', { method: 'GET', path: `/v1/events/${eventId}`, host: 'api' });
  if (after.status !== 200) throw new Error(`데모 시계 뒤 공개 조회 → ${after.status}`);
  ctx.log(`  오픈을 ${after.json?.openAt ?? wanted}로 당겼다`);
  return { openAt: Date.parse(after.json?.openAt ?? wanted) };
}

/** 오픈 조건을 기다린다(고정 sleep 아님, 조건 폴링) */
async function waitOpen(ctx, eventId, openAt) {
  const until = ctx.now() + OPEN_WAIT_MS;
  for (;;) {
    const res = await api(ctx, 'jimin', { method: 'GET', path: `/v1/events/${eventId}`, host: 'api' });
    const status = res.json?.status;
    if (res.status === 200 && status === 'SCHEDULED' && Number.isFinite(openAt) && ctx.now() >= openAt) return;
    if (ctx.now() > until) throw new Error(`회차 오픈(조건)을 ${Math.round(OPEN_WAIT_MS / 1000)}초 안에 보지 못했다(status ${status ?? res.status})`);
    await sleep(1000);
  }
}

/** 대기열 사전 검증 토큰 하나(대기실 화면이 진입할 때 쓰는 값과 같은 API) */
async function queuePreverify(ctx, account, eventId) {
  const pre = await api(ctx, account, {
    method: 'POST',
    host: 'queue',
    path: `/v1/queues/${eventId}/pre-verifications`,
    headers: { origin: originOf(ctx.contract, 'queue'), 'content-type': 'application/json' },
    body: { deviceId: DEMO_DEVICE_ID },
  });
  if (pre.status !== 201 || typeof pre.json?.preverifyToken !== 'string') throw new Error(`사전 검증 토큰 → ${pre.status} ${tail(pre.text, 600)}`);
  return pre.json.preverifyToken;
}

/** 대기열 진입 → 입장 확정(구매 세션 재료). 조건을 기다리며 다시 묻는다 */
async function admit(ctx, account, eventId) {
  const origin = originOf(ctx.contract, 'queue');
  ensureQueueSchedule(ctx, eventId);
  // ① 사전 검증 토큰(사람 확인 보류 hd여도 발급된다). 추가 검증이 필요하면 화면(SCR-009) 몫이라 실패로 남긴다
  const pre = await api(ctx, account, {
    method: 'POST',
    host: 'queue',
    path: `/v1/queues/${eventId}/pre-verifications`,
    headers: { origin, 'content-type': 'application/json' },
    body: { deviceId: DEMO_DEVICE_ID },
  });
  if (pre.status !== 201 || typeof pre.json?.preverifyToken !== 'string') throw new Error(`사전 검증 토큰 → ${pre.status} ${tail(pre.text, 600)}`);
  // ② 진입(사전 검증 토큰 필요)
  const entry = await api(ctx, account, {
    method: 'POST',
    host: 'queue',
    path: `/v1/queues/${eventId}/entries`,
    headers: { origin, 'content-type': 'application/json' },
    body: { preverifyToken: pre.json.preverifyToken, deviceId: DEMO_DEVICE_ID, entryRequestId: randomUUID() },
  });
  if (![200, 201, 202].includes(entry.status) || !entry.json) throw new Error(`대기열 진입 → ${entry.status} ${tail(entry.text, 600)}`);
  if (entry.json.verification === 'REQUIRED') throw new Error('대기열이 추가 검증(SCR-009)을 요구했다. 사람 확인 화면 자동화는 이 묶음에 없다');
  const ticket = entry.json.queueTicket;
  if (!ticket) throw new Error(`대기열 응답에 queueTicket이 없다(묶음 대기 202일 수 있다): ${tail(entry.text, 400)}`);
  const until = ctx.now() + OPEN_WAIT_MS;
  for (;;) {
    const res = await api(ctx, account, {
      method: 'POST',
      host: 'queue',
      path: `/v1/queues/${eventId}/admission`,
      headers: { origin, 'content-type': 'application/json' },
      body: { queueTicket: ticket },
    });
    const body = res.json ?? {};
    if (res.status === 200 && body.status === 'ADMITTED' && typeof body.admissionToken === 'string') return body;
    if (body.status === 'VERIFYING' || body.verification === 'REQUIRED') throw new Error('대기열이 추가 검증(SCR-009)을 요구했다. 사람 확인 화면 자동화는 이 묶음에 없다');
    if (res.status === 410) throw new Error(`입장 확정이 끝났다(410): ${body.type ?? tail(res.text, 300)}`);
    if (ctx.now() > until) throw new Error(`입장 확정을 ${Math.round(OPEN_WAIT_MS / 1000)}초 안에 받지 못했다(status ${body.status ?? res.status})`);
    const wait = Number(body.retryAfterMs ?? (body.retryAfterSeconds ? body.retryAfterSeconds * 1000 : 1500));
    await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 5000) : 1500);
  }
}

/** 구매 세션 서명기(브라우저 대신 Node WebCrypto로 같은 식). 키는 메모리에만 있다 */
async function purchaseSigner(admission) {
  const claims = admissionClaims(admission.admissionToken);
  if (!claims) throw new Error('입장 토큰 모양이 틀렸다(jti를 읽지 못했다)');
  if (!admission.serverEcdhPublicKey) throw new Error('입장 응답에 서버 ECDH 공개키가 없다');
  const pair = await createClientKeyPair(globalThis.crypto.subtle);
  const secret = await sharedSecret(globalThis.crypto.subtle, pair.privateKey, admission.serverEcdhPublicKey);
  const key = await requestKey(globalThis.crypto.subtle, secret, claims.jti);
  let seq = 0;
  const sign = async (method, pathAndQuery, body) => {
    seq += 1;
    const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
    return {
      'x-admission-token': admission.admissionToken,
      'x-purchase-seq': String(seq),
      'x-purchase-mac': await purchaseMac(globalThis.crypto.subtle, key, method, pathAndQuery, seq, bytes),
    };
  };
  return { sign, clientPublicKey: pair.publicKey, admissionToken: admission.admissionToken };
}

/** 좌석 홀드. body는 seatIds 또는 auto */
async function holdSeats(ctx, account, eventId, signer, body) {
  const path = `/v1/events/${eventId}/holds`;
  // 첫 구매 요청은 구매 세션을 여는 임시 공개키를 본문에 실어야 한다(ADR-0050 결정 8·9). 없으면 no_session 401이다
  const payload = { ...body, clientEphemeralPublicKey: body.clientEphemeralPublicKey ?? signer.clientPublicKey };
  const sig = await signer.sign('POST', path, payload);
  const res = await api(ctx, account, { method: 'POST', host: 'api', path, headers: { ...sig, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body: payload });
  return res;
}

/** 주문 생성 */
async function createOrder(ctx, account, signer, holdId) {
  const path = '/v1/orders';
  // 주문 buyer는 이름과 휴대폰 번호가 모두 있어야 한다(order-request.ts buyerOf). 010-0000-0000은 합성 번호다
  const body = { holdId, buyer: { name: '데모 지민', phone: '010-0000-0000' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: DEMO_CONSENT_VERSION } };
  const sig = await signer.sign('POST', path, body);
  const res = await api(ctx, account, { method: 'POST', host: 'api', path, headers: { ...sig, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body });
  return res;
}

/** 결제 시도 시작(시뮬레이터) */
async function startPayment(ctx, account, signer, orderId) {
  const path = `/v1/orders/${orderId}/payments`;
  const body = { payMethod: 'CARD' };
  const sig = await signer.sign('POST', path, body);
  return api(ctx, account, { method: 'POST', host: 'api', path, headers: { ...sig, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body });
}

/** 결제 접수 */
async function acceptPayment(ctx, account, signer, orderId, attempt) {
  const path = `/v1/orders/${orderId}/payment-acceptance`;
  const body = { pg: attempt.pg, paymentKey: attempt.paymentKey, amount: attempt.amount, attemptId: attempt.attemptId };
  const sig = await signer.sign('POST', path, body);
  return api(ctx, account, { method: 'POST', host: 'api', path, headers: { ...sig, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body });
}

/** 결제 상태를 조건으로 기다린다(APPROVED·FAILED·UNKNOWN 가운데 하나) */
async function waitPayment(ctx, account, orderId, want) {
  const until = ctx.now() + PAYMENT_WAIT_MS;
  let last;
  for (;;) {
    const res = await api(ctx, account, { method: 'GET', host: 'api', path: `/v1/orders/${orderId}/payment-status` });
    last = res.json?.status ?? `HTTP ${res.status}`;
    if (want.includes(last)) return last;
    if (ctx.now() > until) throw new Error(`결제 상태를 ${Math.round(PAYMENT_WAIT_MS / 1000)}초 안에 ${want.join('·')}로 보지 못했다(마지막 ${last})`);
    await sleep(500);
  }
}

/** 주문 상세(발권된 ticketId) */
async function orderDetail(ctx, account, orderId) {
  const res = await api(ctx, account, { method: 'GET', host: 'api', path: `/v1/orders/${orderId}` });
  if (res.status !== 200) throw new Error(`주문 상세 → ${res.status} ${tail(res.text, 400)}`);
  return res.json;
}

/**
 * 시뮬레이터 제어 API를 클러스터 안에서 부른다(호스트에서 pg-simulator에 닿지 않는다).
 * bundle 파드의 결제 환경 파일에서 시험 키를 읽어 Basic 인증만 만든다. 값은 출력에 싣지 않는다.
 */
function simCall(ctx, method, path, body) {
  // 본문 없는 DELETE에 content-type: application/json을 붙이면 Fastify가 빈 JSON 본문으로 보고 400을 낸다.
  // 본문이 있을 때만 content-type을 보낸다
  const script = `const fs=require('fs');const env=Object.fromEntries(fs.readFileSync('/etc/peaket/bundle/payment-svc.env','utf8').split('\\n').filter(Boolean).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));const auth='Basic '+Buffer.from(env.PEAKET_PG_SIM_SECRET_KEY+':').toString('base64');fetch('http://pg-simulator.purchase.svc.cluster.local:8790'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{authorization:auth${body === undefined ? '' : ",'content-type':'application/json'"}},${body === undefined ? '' : `body:${JSON.stringify(JSON.stringify(body))}`}}).then(async r=>{const t=await r.text();console.log(JSON.stringify({status:r.status,text:t}))}).catch(e=>{console.log(JSON.stringify({status:0,text:String(e)}));process.exit(1)})`;
  const out = kubectl(['-n', 'purchase', 'exec', 'deploy/bundle', '--', 'node', '-e', script], { env: ctx.env });
  let parsed;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    throw new Error(`시뮬레이터 응답을 읽지 못했다: ${tail(out, 400)}`);
  }
  if (parsed.status < 200 || parsed.status >= 300) throw new Error(`시뮬레이터 ${method} ${path} → ${parsed.status} ${tail(parsed.text, 300)}`);
  try {
    return parsed.text ? JSON.parse(parsed.text) : undefined;
  } catch {
    return parsed.text;
  }
}

/** 시뮬레이터 결제창 인증(성공 주소가 받을 paymentKey를 만든다) */
function simulatorAuthenticate(ctx, orderId, amount) {
  return simCall(ctx, 'POST', '/sim/authenticate', { orderId, amount });
}

function simulatorFault(ctx, fault) {
  return simCall(ctx, 'POST', '/sim/faults', fault);
}

function simulatorClearFaults(ctx) {
  return simCall(ctx, 'DELETE', '/sim/faults');
}

/** 홀드 응답을 확인한다. 201과 holdId·seatIds를 요구한다 */
function heldOf(res, what) {
  if (res.status !== 201) throw new Error(`${what} 좌석 홀드 → ${res.status} ${tail(res.text, 800)}`);
  const hold = res.json ?? {};
  if (typeof hold.holdId !== 'string' || !Array.isArray(hold.seatIds)) throw new Error(`${what} 홀드 응답에 holdId·seatIds가 없다: ${tail(res.text, 500)}`);
  return hold;
}

// ---------------------------------------------------------------------------
// 시나리오 흐름. 심사·검증이 읽는 판정은 반환한 checks다.
// ---------------------------------------------------------------------------

const FLOWS = {
  async S1(ctx) {
    const eventId = demoEventId(ctx, 'LUMEN 콘서트 2026 서울');
    ctx.vars.eventId = eventId;
    await resetQueueAdmission(ctx, eventId);
    writeSeatMap(ctx, eventId, 'e1-1025');
    await ensureFanVerified(ctx, 'jimin');
    // 홈 피드(/v1/home)는 아직 제품에 없다. 화면 증거로만 열고 실패는 로그에 남긴다(판정은 S1 checks)
    await visit(ctx, { screen: 'SCR-001', path: '/', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-001: ${e.message}`));
    await visit(ctx, { screen: 'SCR-002', path: '/events/{eventId}', account: 'jimin', expect: ['예매|LUMEN'] });
    const { openAt } = await shiftClock(ctx, eventId);
    ctx.vars.openAt = openAt;
    await visit(ctx, { screen: 'SCR-007', path: '/queue/{eventId}', account: 'jimin', origin: 'queue', expect: ['로비|대기|순번|오픈'] }).catch((e) => ctx.log(`  화면 SCR-007: ${e.message}`));
    await waitOpen(ctx, eventId, openAt);
    const admission = await admit(ctx, 'jimin', eventId);
    const signer = await purchaseSigner(admission);
    const hold = heldOf(await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: [demoSeatId(eventId, 'R1-1-5'), demoSeatId(eventId, 'R1-1-6')] }), 'S1');
    ctx.vars.holdId = hold.holdId;
    ctx.addCheck('seat-hold-2', hold.seatIds.length === 2, `홀드 좌석 ${hold.seatIds.join(', ')}`);
    const order = await createOrder(ctx, 'jimin', signer, hold.holdId);
    if (order.status !== 201 || !order.json?.orderId) throw new Error(`주문 생성 → ${order.status} ${tail(order.text, 800)}`);
    const orderId = order.json.orderId;
    ctx.vars.orderId = orderId;
    const started = await startPayment(ctx, 'jimin', signer, orderId);
    if (started.status !== 201) throw new Error(`결제 시도 시작 → ${started.status} ${tail(started.text, 800)}`);
    const attempt = started.json ?? {};
    if (attempt.pg !== 'SIMULATOR') throw new Error(`데모 결제사가 SIMULATOR가 아니다: ${JSON.stringify(attempt.pg)}`);
    const amount = attempt.checkout?.amount ?? order.json.amount;
    const auth = simulatorAuthenticate(ctx, orderId, amount);
    const accepted = await acceptPayment(ctx, 'jimin', signer, orderId, { pg: 'SIMULATOR', paymentKey: auth.paymentKey, amount, attemptId: attempt.attemptId });
    if (accepted.status !== 202) throw new Error(`결제 접수 → ${accepted.status} ${tail(accepted.text, 800)}`);
    // 이 구현의 결제 성공 종착 상태는 CONFIRMED다(APPROVED는 승인 뒤 발권을 기다리는 중간 상태). 둘 다 결제 승인으로 본다
    const paid = await waitPayment(ctx, 'jimin', orderId, ['CONFIRMED', 'APPROVED']);
    ctx.addCheck('payment-approved', paid === 'CONFIRMED' || paid === 'APPROVED', `결제 상태 ${paid}`);
    // 주문 상세 GET /v1/orders/{orderId}는 아직 제품에 없다. 발권은 ticket-svc 원장에 남으므로 그 원장에서 기다린다(로컬 데모 읽기 예외)
    const ticketId = await waitUntil(
      ctx,
      '결제 승인 뒤 발권 티켓',
      async () => {
        const id = sqlRead(ctx, 'peaket_demo_ticket', `select id from ticket where order_id = '${orderId}' order by created_at, id limit 1`);
        return { ok: /^[0-9a-f-]{36}$/.test(id), value: id, detail: id || '아직 없음' };
      },
      { timeoutMs: 60_000, intervalMs: 1_000 },
    );
    ctx.vars.ticketId = ticketId;
    ctx.addCheck('ticket-qr', true, `ticketId ${ticketId}`);
    await visit(ctx, { screen: 'SCR-010', path: '/booking/{eventId}/seats', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-010: ${e.message}`));
    await visit(ctx, { screen: 'SCR-011', path: '/booking/{eventId}/checkout', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-011: ${e.message}`));
    await visit(ctx, { screen: 'SCR-012', path: '/booking/{eventId}/result', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-012: ${e.message}`));
    await visit(ctx, { screen: 'SCR-013', path: '/my/tickets/{ticketId}', account: 'jimin', expect: ['티켓|QR|입장'] }).catch((e) => ctx.log(`  화면 SCR-013: ${e.message}`));
    return ctx.checks;
  },

  async S2(ctx) {
    const eventId = demoEventId(ctx, '소극장 뮤지컬');
    ctx.vars.eventId = eventId;
    // E-3은 시드에서 오픈을 가까이(+1m) 둔다. 매진 화면은 판매가 열린 뒤 대기실에서만 보인다.
    // 오픈 시각이 아직 멀면 화면이 로비 대기에서 멈추므로, 오픈 조건을 먼저 기다린다(고정 sleep 아님)
    await ensureFanVerified(ctx, 'jimin');
    const { openAt } = await shiftClock(ctx, eventId);
    await waitOpen(ctx, eventId, openAt);
    ensureQueueSchedule(ctx, eventId);
    await resetQueueAdmission(ctx, eventId);
    // 데모 전용 예외(계획 B11의 로컬 한정): 공개 API에 '재고 0' 쓰기가 없어 대기열 Redis의 notice를 매진으로 바꾼다.
    // 시드는 E-3를 매진으로 두라고만 적고 실제로 만들지 않는다(deploy/envs/demo/seed/base.yaml의 E-3 주석).
    redis(ctx, ['HSET', `q:{event:${eventId}}:notice`, 'saleState', 'SOLD_OUT', 'soldOutTiers', '["A"]']);
    const sale = await waitUntil(
      ctx,
      '매진 대기 상태 파일',
      async () => {
        const res = await httpsJson({ host: ctx.contract.hosts['queue-files'], port: ctx.contract.ports['queue-files'], method: 'GET', path: `/v1/queues/${eventId}/segment-states/0.json` });
        return { ok: res.status === 200 && res.json?.saleStatus === 'SOLD_OUT', value: res.json, detail: `HTTP ${res.status} saleStatus ${res.json?.saleStatus ?? '없음'}` };
      },
      { timeoutMs: 90_000, intervalMs: 1_000 },
    );
    ctx.addCheck('sold-out', true, `대기 상태 파일 saleStatus ${sale.saleStatus} · soldOutTiers ${JSON.stringify(sale.soldOutTiers ?? [])}`);

    // 대기실 화면은 공연 상세가 발급한 사전 검증 토큰으로 진입한다. 직접 URL로 열면 토큰이 없어 공연 상세로 돌아가므로,
    // 같은 API로 토큰을 받아 브라우저 저장소에 넣고 연다(대기열 진입·판정은 실제 화면·API가 한다)
    const preverifyToken = await queuePreverify(ctx, 'jimin', eventId);
    const page = await pageFor(ctx, 'jimin');
    await page.addInitScript(
      ({ qkey, token, deviceId, at }) => {
        localStorage.setItem('peaket.device', deviceId);
        localStorage.setItem(qkey, JSON.stringify({ preverifyToken: token, preverifyIssuedAt: at, savedAt: at }));
      },
      { qkey: `peaket.queue.${eventId}`, token: preverifyToken, deviceId: DEMO_DEVICE_ID, at: ctx.now() },
    );
    await visit(ctx, { screen: 'SCR-018', path: '/queue/{eventId}', account: 'jimin', origin: 'queue' });
    // 매진 화면은 대기실이 진입·상태 파일을 받은 다음에야 그려진다. 화면 하나에 최대 2분을 준다
    const alert = page.getByRole('button', { name: /취소표 알림 받기/ }).first();
    await alert.waitFor({ state: 'visible', timeout: 120_000 });
    await alert.click();
    // 취소표 알림 신청 API(/v1/events/{id}/subscriptions)는 아직 제품에 없다. 화면의 실패 분기와 [다시 시도] 문구를 재생한다
    await page.getByText(/다시 시도해 주세요/).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
    ctx.addCheck('retry-message', true, '취소표 알림 신청 실패 → [다시 시도] 문구 확인(신청 API는 제품 빈칸)');
    await visit(ctx, { screen: 'SCR-054', path: '/my/likes', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-054: ${e.message}`));
    return ctx.checks;
  },

  async S3(ctx) {
    // S3는 결제 실패·결과 불명으로 끝나지 않은 주문을 남긴다. S9가 취소·환불하는 E-1을 더럽히지 않도록
    // 별도 회차 E-4(팬미팅)에서 돌린다. E-4는 이 시나리오만 쓰고, 시드 오픈도 가까이(+1분) 둔다
    const eventId = demoEventId(ctx, '팬미팅');
    ctx.vars.eventId = eventId;
    writeSeatMap(ctx, eventId, 'e4-01');
    await ensureFanVerified(ctx, 'jimin');
    await visit(ctx, { screen: 'SCR-011', path: '/booking/{eventId}/checkout', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-011: ${e.message}`));
    const { openAt } = await shiftClock(ctx, eventId);
    await waitOpen(ctx, eventId, openAt);
    // 같은 회차를 S1이 먼저 썼다. 계정별 입장 표시를 지워 다시 줄을 설 수 있게 한다(데모 전용)
    await resetQueueAdmission(ctx, eventId);
    const admission = await admit(ctx, 'jimin', eventId);
    // S1이 같은 회차에서 이미 2석을 샀다. S3는 실패·결과 불명에 필요한 4석을 더 쓰므로 한도 표시를 데모 전용으로 지운다
    await resetPurchaseQuota(ctx, 'jimin', eventId);
    const signer = await purchaseSigner(admission);

    // ① 승인 거절: 홀드는 풀리고 좌석을 다시 잡을 수 있어야 한다
    const hold1 = heldOf(await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: [demoSeatId(eventId, 'R1-2-1'), demoSeatId(eventId, 'R1-2-2')] }), 'S3-거절');
    const order1 = await createOrder(ctx, 'jimin', signer, hold1.holdId);
    if (order1.status !== 201) throw new Error(`S3 첫 주문 → ${order1.status} ${tail(order1.text, 600)}`);
    const orderId1 = order1.json.orderId;
    const start1 = await startPayment(ctx, 'jimin', signer, orderId1);
    if (start1.status !== 201) throw new Error(`S3 첫 결제 시도 → ${start1.status}`);
    const amount1 = start1.json?.checkout?.amount ?? order1.json.amount;
    simulatorFault(ctx, { op: 'confirm', orderId: orderId1, kind: 'decline', code: 'REJECT_CARD_COMPANY', times: 1 });
    const auth1 = simulatorAuthenticate(ctx, orderId1, amount1);
    const accept1 = await acceptPayment(ctx, 'jimin', signer, orderId1, { pg: 'SIMULATOR', paymentKey: auth1.paymentKey, amount: amount1, attemptId: start1.json.attemptId });
    if (accept1.status !== 202) throw new Error(`S3 첫 결제 접수 → ${accept1.status} ${tail(accept1.text, 600)}`);
    await waitPayment(ctx, 'jimin', orderId1, ['FAILED']).catch((e) => ctx.log(`  S3 거절 확인: ${e.message}`));
    simulatorClearFaults(ctx);
    // 해제 확인: 같은 좌석을 다시 홀드한다(성공하면 풀린 것이다)
    const rehold = await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: [demoSeatId(eventId, 'R1-2-1'), demoSeatId(eventId, 'R1-2-2')] });
    ctx.addCheck('seat-released', rehold.status === 201, `같은 좌석 다시 홀드 → ${rehold.status}`);

    // ② 결과 불명: 응답을 끊어 UNKNOWN을 만든다
    const hold2 = heldOf(await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: [demoSeatId(eventId, 'R1-3-1'), demoSeatId(eventId, 'R1-3-2')] }), 'S3-불명');
    const order2 = await createOrder(ctx, 'jimin', signer, hold2.holdId);
    if (order2.status !== 201) throw new Error(`S3 둘째 주문 → ${order2.status}`);
    const orderId2 = order2.json.orderId;
    const start2 = await startPayment(ctx, 'jimin', signer, orderId2);
    if (start2.status !== 201) throw new Error(`S3 둘째 결제 시도 → ${start2.status}`);
    const amount2 = start2.json?.checkout?.amount ?? order2.json.amount;
    simulatorFault(ctx, { op: 'confirm', orderId: orderId2, kind: 'drop', applied: false, times: 1 });
    const auth2 = simulatorAuthenticate(ctx, orderId2, amount2);
    const accept2 = await acceptPayment(ctx, 'jimin', signer, orderId2, { pg: 'SIMULATOR', paymentKey: auth2.paymentKey, amount: amount2, attemptId: start2.json.attemptId });
    if (accept2.status !== 202) throw new Error(`S3 둘째 결제 접수 → ${accept2.status}`);
    const unknown = await waitPayment(ctx, 'jimin', orderId2, ['UNKNOWN', 'FAILED']).catch(async () => {
      const last = await api(ctx, 'jimin', { method: 'GET', host: 'api', path: `/v1/orders/${orderId2}/payment-status` });
      return last.json?.status ?? '조회 실패';
    });
    ctx.addCheck('unknown-result', unknown === 'UNKNOWN', `결제 상태 ${unknown}`);
    simulatorClearFaults(ctx);
    await visit(ctx, { screen: 'SCR-012', path: '/booking/{eventId}/result', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-012: ${e.message}`));
    await visit(ctx, { screen: 'SCR-055', path: '/my/orders', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-055: ${e.message}`));
    ctx.vars.eventId = eventId;
    await visit(ctx, { screen: 'SCR-010', path: '/booking/{eventId}/seats', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-010: ${e.message}`));
    return ctx.checks;
  },

  async S4(ctx) {
    const eventId = demoEventId(ctx, '가을 야외 페스티벌');
    ctx.vars.eventId = eventId;
    writeSeatMap(ctx, eventId, 'e2-01');
    await ensureFanVerified(ctx, 'jimin');
    await visit(ctx, { screen: 'SCR-002', path: '/events/{eventId}', account: 'jimin', expect: ['예매|페스티벌'] });
    const { openAt } = await shiftClock(ctx, eventId);
    await waitOpen(ctx, eventId, openAt);
    await visit(ctx, { screen: 'SCR-008', path: '/queue/{eventId}', account: 'jimin', origin: 'queue' }).catch((e) => ctx.log(`  화면 SCR-008: ${e.message}`));
    await resetQueueAdmission(ctx, eventId);
    const admission = await admit(ctx, 'jimin', eventId);
    const signer = await purchaseSigner(admission);
    const res = await holdSeats(ctx, 'jimin', eventId, signer, { auto: { firstTierId: 'R', count: 2, wheelchair: false, allowSplit: true }, clientEphemeralPublicKey: signer.clientPublicKey });
    const hold = heldOf(res, 'S4');
    ctx.addCheck('auto-assign', hold.seatIds.length === 2 && Boolean(hold.assignResult), `배정 ${hold.assignResult ?? '없음'} · ${hold.seatIds.join(', ')}`);
    const order = await createOrder(ctx, 'jimin', signer, hold.holdId);
    if (order.status !== 201) throw new Error(`S4 주문 → ${order.status} ${tail(order.text, 600)}`);
    const started = await startPayment(ctx, 'jimin', signer, order.json.orderId);
    if (started.status !== 201) throw new Error(`S4 결제 시도 → ${started.status}`);
    const amount = started.json?.checkout?.amount ?? order.json.amount;
    const auth = simulatorAuthenticate(ctx, order.json.orderId, amount);
    const accepted = await acceptPayment(ctx, 'jimin', signer, order.json.orderId, { pg: 'SIMULATOR', paymentKey: auth.paymentKey, amount, attemptId: started.json.attemptId });
    if (accepted.status !== 202) throw new Error(`S4 결제 접수 → ${accepted.status}`);
    const paid = await waitPayment(ctx, 'jimin', order.json.orderId, ['CONFIRMED', 'APPROVED']);
    ctx.addCheck('payment-approved', paid === 'CONFIRMED' || paid === 'APPROVED', `결제 상태 ${paid}`);
    await visit(ctx, { screen: 'SCR-010', path: '/booking/{eventId}/seats', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-010: ${e.message}`));
    await visit(ctx, { screen: 'SCR-011', path: '/booking/{eventId}/checkout', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-011: ${e.message}`));
    return ctx.checks;
  },

  async S5(ctx) {
    const eventId = demoEventId(ctx, 'LUMEN 콘서트 2026 서울');
    ctx.vars.eventId = eventId;
    const me = await session(ctx, 'jimin');
    // 티켓 목록 HTTP(GET /v1/tickets)는 아직 제품에 없다. 로컬 데모 예외로 ticket 원장에서 지민의 유효 티켓 하나를 읽는다
    const ticketId = sqlRead(ctx, 'peaket_demo_ticket', `select id from ticket where event_id = '${eventId}' and account_id = '${me.accountId}' and status = 'ISSUED' order by created_at, id limit 1`);
    if (!/^[0-9a-f-]{36}$/.test(ticketId)) throw new Error(`S5에 쓸 지민의 티켓이 없다(S1이 먼저 돈다): ${JSON.stringify(ticketId)}`);
    ctx.vars.ticketId = ticketId;
    await visit(ctx, { screen: 'SCR-013', path: '/my/tickets', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-013: ${e.message}`));
    // 양도 화면은 증거로만 연다. POST /v1/tickets/{id}/transfers·/v1/transfers/*는 아직 제품에 없다(이 묶음은 화면·API를 만들지 않는다)
    await visit(ctx, { screen: 'SCR-014', path: '/my/tickets/{ticketId}/transfer', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-014: ${e.message}`));
    ctx.vars.offerId = randomUUID();
    await visit(ctx, { screen: 'SCR-041', path: '/my/transfers/{offerId}', account: 'haneul' }).catch((e) => ctx.log(`  화면 SCR-041: ${e.message}`));

    // 팬 재인증: OIDC 제공자 재로그인만 데모에 없고, 세션·제공자 연결·토큰 발급은 identity gRPC 실제 경로다(ticket-cancel 경로 재사용)
    const token = await fanReauth(ctx, 'jimin', 'TICKET_CANCEL');
    ctx.addCheck('fan-reauth', typeof token === 'string' && token.length > 0, 'IssueReauthToken(act FAN_SENSITIVE·op TICKET_CANCEL) 발급');

    const quote = await api(ctx, 'jimin', { method: 'GET', host: 'api', path: `/v1/tickets/${ticketId}/cancellation-quote` });
    if (quote.status !== 200) throw new Error(`취소 견적 → ${quote.status} ${tail(quote.text, 600)}`);
    const q = quote.json ?? {};
    await visit(ctx, { screen: 'SCR-038', path: '/my/tickets/{ticketId}/cancel', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-038: ${e.message}`));
    const cancelled = await api(ctx, 'jimin', {
      method: 'POST',
      host: 'api',
      path: `/v1/tickets/${ticketId}/cancellation`,
      headers: { 'x-reauth-token': token, 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      body: {},
    });
    if (cancelled.status !== 202) throw new Error(`티켓 취소 → ${cancelled.status} ${tail(cancelled.text, 600)}`);
    const feeOk = Number(q.deductionAmount) > 0 && Number(q.refundAmount) < Number(q.ticketPrice);
    ctx.addCheck('cancel-with-fee', feeOk, `공제율 ${q.deductionRate} · 공제 ${q.deductionAmount}원 · 환급 ${q.refundAmount}원 · 취소 ${cancelled.json?.status ?? '응답 없음'}`);
    return ctx.checks;
  },

  async S6(ctx) {
    await visit(ctx, { screen: 'SCR-020', path: '/login', account: 'stella-admin' }).catch((e) => ctx.log(`  화면 SCR-020: ${e.message}`));
    await visit(ctx, { screen: 'SCR-062', path: '/events', account: 'stella-admin', origin: 'partner', expect: ['공연'] }).catch((e) => ctx.log(`  화면 SCR-062: ${e.message}`));
    // 공연장은 시드가 만든 행을 읽는다(파트너 목록·상세 API 없음, BAT-087 로컬 예외와 같은 읽기)
    const placeId = sqlRead(ctx, 'peaket_demo_core', `select id from place where name = '피켓 아레나' limit 1`);
    if (!/^[0-9a-f-]{36}$/.test(placeId)) throw new Error(`시드 공연장(피켓 아레나)을 찾지 못했다: ${JSON.stringify(placeId)}`);
    const title = 'BAT-086 데모 재생 공연';
    const existing = sqlRead(ctx, 'peaket_demo_core', `select id from production where title = '${title}' limit 1`);
    let productionId = /^[0-9a-f-]{36}$/.test(existing) ? existing : undefined;
    if (!productionId) {
      const res = await api(ctx, 'stella-admin', {
        method: 'POST',
        host: 'partner-api',
        path: '/v1/partner/productions',
        headers: { 'idempotency-key': randomUUID() },
        body: {
          title,
          genre: '콘서트',
          ageRating: '전체 관람가',
          runningMinutes: 90,
          placeId,
          artists: [],
          events: [{ openAt: new Date(ctx.now() + 2 * 3600_000).toISOString(), startsAt: new Date(ctx.now() + 30 * 3600_000).toISOString(), endsAt: new Date(ctx.now() + 32 * 3600_000).toISOString(), perPersonLimit: 4, seatAssignment: 'PICK' }],
        },
      });
      if (res.status !== 201 || !res.json?.productionId) throw new Error(`공연 등록 → ${res.status} ${tail(res.text, 800)}`);
      productionId = res.json.productionId;
    }
    ctx.vars.productionId = productionId;
    ctx.addCheck('production-created', true, `productionId ${productionId}`);
    await visit(ctx, { screen: 'SCR-021', path: '/events/new', account: 'stella-admin', origin: 'partner', expect: ['공연|등록'] }).catch((e) => ctx.log(`  화면 SCR-021: ${e.message}`));
    // 좌석맵 한 번(없을 때만). 작은 배치 하나면 충분하다
    const layout = sqlRead(ctx, 'peaket_demo_core', `select count(*) from event where production_id = '${productionId}' and venue_id is not null`);
    if (Number(layout) === 0) {
      const put = await api(ctx, 'stella-admin', {
        method: 'PUT',
        host: 'partner-api',
        path: `/v1/partner/productions/${productionId}/seatmap`,
        headers: { 'if-match': '"0"' },
        body: {
          layoutVersion: 0,
          canvas: { width: 800, height: 600 },
          priceTiers: [{ tierId: 'A', name: 'A', price: 66000 }],
          sections: [
            {
              sectionId: 'A1',
              name: 'A구역 1',
              level: '1',
              shape: { kind: 'RECT', points: [[20, 20], [300, 20], [300, 200], [20, 200]] },
              fillRule: { method: 'GRID', rows: 2, seatsPerRow: 2 },
              tierId: 'A',
              label: { x: 20, y: 10 },
              seatIndexRange: { from: 0, to: 3 },
              seats: [
                { seatId: 'A1-1-1', index: 0, row: 'A1', number: 1, x: 40, y: 60, tierId: 'A' },
                { seatId: 'A1-1-2', index: 1, row: 'A2', number: 2, x: 80, y: 60, tierId: 'A' },
                { seatId: 'A1-2-1', index: 2, row: 'A3', number: 1, x: 40, y: 100, tierId: 'A' },
                { seatId: 'A1-2-2', index: 3, row: 'A4', number: 2, x: 80, y: 100, tierId: 'A' },
              ],
            },
          ],
        },
      });
      if (![200, 201].includes(put.status)) throw new Error(`좌석맵 등록 → ${put.status} ${tail(put.text, 600)}`);
    }
    const submitted = await api(ctx, 'stella-admin', {
      method: 'POST',
      host: 'partner-api',
      path: `/v1/partner/productions/${productionId}/sale-review`,
      body: {
        seller: { legalName: '(주)스텔라엔터테인먼트', representative: '예시 대표', address: '서울특별시 예시구 예시로 1', phone: '02-0000-0000', email: 'stella@example.test', businessRegNo: '000-00-00000', mailOrderReportNo: '제0000-예시호' },
        payoutAccount: { bankCode: '000', accountNumber: '000000000000', holderName: '(주)스텔라엔터테인먼트' },
        accessibleSeating: { confirmed: true },
      },
    });
    if (submitted.status === 404) {
      // 판매 심사 제출 API는 아직 제품에 없다(core-svc에 라우트 없음). 데모 전용으로 심사 대기 상태만 만든다.
      // 이 한 줄은 S6의 '판매 심사 제출'을 통과로 적지 않기 위한 것이고, 측정 문서에 제품 빈칸으로 남긴다
      ctx.log('  판매 심사 제출 API가 없다(404). 데모 전용으로 production.sale_review를 SUBMITTED로 둔다');
      sqlDemoWrite(ctx, 'peaket_demo_core', `update production set sale_review = 'SUBMITTED' where id = '${productionId}' and sale_review = 'DRAFT'`);
    } else if (![200, 202, 409].includes(submitted.status)) {
      throw new Error(`판매 심사 제출 → ${submitted.status} ${tail(submitted.text, 600)}`);
    }
    const scale = JSON.parse(sqlRead(ctx, 'peaket_demo_core', `select coalesce(json_agg(json_build_object('eventId', id, 'scale', 'SMALL')), '[]'::json) from event where production_id = '${productionId}'`));
    await visit(ctx, { screen: 'SCR-048', path: `/sale-reviews/${productionId}`, account: 'minho', origin: 'console', expect: ['판매|승인'] }).catch((e) => ctx.log(`  화면 SCR-048: ${e.message}`));
    const approved = await api(ctx, 'minho', { method: 'POST', host: 'ops-api', path: `/v1/ops/sale-reviews/${productionId}/approvals`, body: { scales: scale, placeId } });
    if (![200, 202, 409].includes(approved.status)) throw new Error(`판매 승인 → ${approved.status} ${tail(approved.text, 600)}`);
    ctx.addCheck('sale-approved', true, `승인 응답 ${approved.status}`);
    const eventId = sqlRead(ctx, 'peaket_demo_core', `select id from event where production_id = '${productionId}' order by starts_at limit 1`);
    ctx.vars.eventId = eventId;
    const pub = await api(ctx, 'jimin', { method: 'GET', host: 'api', path: `/v1/events/${eventId}` });
    ctx.addCheck('status-visible', pub.status === 200 && Array.isArray(pub.json?.salePhases) && pub.json.salePhases.length > 0, `공개 조회 ${pub.status} · 판매 구간 ${pub.json?.salePhases?.length ?? 0}`);
    await visit(ctx, { screen: 'SCR-062', path: '/events', account: 'stella-admin', origin: 'partner' }).catch((e) => ctx.log(`  화면 SCR-062: ${e.message}`));
    await visit(ctx, { screen: 'SCR-026', path: '/events/{eventId}', account: 'jimin', expect: ['BAT-086|예매'] }).catch((e) => ctx.log(`  화면 SCR-026: ${e.message}`));
    return ctx.checks;
  },

  async S7(ctx) {
    const eventId = demoEventId(ctx, 'LUMEN 콘서트 2026 서울');
    ctx.vars.eventId = eventId;
    await visit(ctx, { screen: 'SCR-029', path: `/dashboard?event=${eventId}`, account: 'sujin', origin: 'console', expect: ['관제|대시보드'] }).catch((e) => ctx.log(`  화면 SCR-029: ${e.message}`));
    await visit(ctx, { screen: 'SCR-030', path: '/commands', account: 'sujin', origin: 'console', expect: ['명령'] }).catch((e) => ctx.log(`  화면 SCR-030: ${e.message}`));
    await visit(ctx, { screen: 'SCR-031', path: '/audit', account: 'sujin', origin: 'console', expect: ['감사'] }).catch((e) => ctx.log(`  화면 SCR-031: ${e.message}`));

    // 요청자(수진)가 2인 승인 명령을 만들고, 같은 사람이 승인하면 403, 두 번째 commander가 승인하면 200이다.
    // 재인증 토큰은 패스키까지 마친 것만 통과하고(jti 1회용), 같은 TOTP 칸은 한 번만 받으므로 adminReauth가 칸을 맞춰 기다린다.
    const createToken = await adminReauth(ctx, 'sujin', 'OPS_COMMAND');
    const created = await api(ctx, 'sujin', {
      method: 'POST',
      host: 'ops-api',
      originKey: 'console',
      path: '/v1/ops/commands',
      headers: { 'x-reauth-token': createToken, 'content-type': 'application/json' },
      body: { type: 'DEGRADED_MODE', reason: 'BAT-086 S7 2인 승인 재생', params: { mode: 'READ_ONLY' } },
    });
    if (created.status !== 201 || typeof created.json?.commandId !== 'string') throw new Error(`명령 접수 → ${created.status} ${tail(created.text, 800)}`);
    const commandId = created.json.commandId;
    ctx.vars.commandId = commandId;

    const selfToken = await adminReauth(ctx, 'sujin', 'OPS_COMMAND');
    const self = await api(ctx, 'sujin', {
      method: 'POST',
      host: 'ops-api',
      originKey: 'console',
      path: `/v1/ops/commands/${commandId}/approvals`,
      headers: { 'x-reauth-token': selfToken, 'content-type': 'application/json' },
      body: {},
    });
    // Problem type은 절대 URI다(guidelines §2). 끝의 식별자만 본다
    const selfRule = self.status === 403 && String(self.json?.type ?? '').endsWith('/command-requester-cannot-approve');
    ctx.addCheck('self-approval-403', selfRule, `요청자 자기 승인 → ${self.status} ${self.json?.type ?? ''}`);

    const secondToken = await adminReauth(ctx, 'second-commander', 'OPS_COMMAND');
    const approved = await api(ctx, 'second-commander', {
      method: 'POST',
      host: 'ops-api',
      originKey: 'console',
      path: `/v1/ops/commands/${commandId}/approvals`,
      headers: { 'x-reauth-token': secondToken, 'content-type': 'application/json' },
      body: {},
    });
    const second = demoUuid('admin:second-commander');
    const approvals = Array.isArray(approved.json?.approvals) ? approved.json.approvals : [];
    ctx.addCheck('second-approval-ok', approved.status === 200 && approvals.includes(second), `두 번째 commander 승인 → ${approved.status} · 승인 목록 ${approvals.join(', ') || '없음'}`);

    // 감사 기록: audit_chain에 요청자와 승인자가 다른 계정으로 따로 남았는지 본다(DB 읽기, 로컬 데모 예외)
    const audit = JSON.parse(
      sqlRead(
        ctx,
        'peaket_demo_ops',
        `select coalesce(json_agg(json_build_object('type', record_type, 'requestedBy', record_json->'payload'->>'requestedBy', 'approverRef', record_json->'payload'->>'approverRef')), '[]'::json) from audit_chain where record_id = '${commandId}' and record_type in ('COMMAND_CREATED', 'COMMAND_APPROVED')`,
      ),
    );
    const createdRow = audit.find((r) => r.type === 'COMMAND_CREATED');
    const approvedRow = audit.find((r) => r.type === 'COMMAND_APPROVED');
    const auditOk = createdRow?.requestedBy === demoUuid('admin:sujin') && approvedRow?.approverRef === second && createdRow.requestedBy !== approvedRow.approverRef;
    ctx.addCheck('audit-entry', auditOk, `감사 ${audit.map((r) => r.type).join('·') || '없음'} · 요청자 ${createdRow?.requestedBy ?? '없음'} · 승인자 ${approvedRow?.approverRef ?? '없음'}`);
    await visit(ctx, { screen: 'SCR-031', path: '/audit', account: 'sujin', origin: 'console' }).catch((e) => ctx.log(`  화면 SCR-031(재방문): ${e.message}`));
    return ctx.checks;
  },

  async S8(ctx) {
    const eventId = demoEventId(ctx, 'LUMEN 콘서트 2026 서울');
    ctx.vars.eventId = eventId;
    await visit(ctx, { screen: 'SCR-037', path: '/staff', account: 'haneul', expect: ['배정|현장|스태프'] }).catch((e) => ctx.log(`  화면 SCR-037: ${e.message}`));
    await visit(ctx, { screen: 'SCR-036', path: '/', account: 'haneul', origin: 'scanner', expect: ['스캔|스캐너|기기'] }).catch((e) => ctx.log(`  화면 SCR-036: ${e.message}`));

    // 입장 창을 지금 앞으로 당긴다(시드는 입장 시작이 공연 30시간 전이라 아직 열리지 않았다). 데모 시계와 같은 상대 값이다
    const info = await api(ctx, 'jimin', { method: 'GET', host: 'api', path: `/v1/events/${eventId}` });
    const entryOpen = info.json?.entryOpensAt ? Date.parse(info.json.entryOpensAt) : NaN;
    if (!Number.isFinite(entryOpen) || entryOpen > ctx.now()) {
      const patched = await api(ctx, 'stella-admin', {
        method: 'PATCH',
        host: 'partner-api',
        path: `/v1/partner/events/${eventId}`,
        headers: { 'if-match': `"${eventVersion(ctx, eventId)}"`, 'content-type': 'application/json' },
        body: { entryOpensAt: new Date(ctx.now() - 60 * 60_000).toISOString() },
      });
      if (![200, 409].includes(patched.status)) throw new Error(`입장 시작 앞당기기 → ${patched.status} ${tail(patched.text, 600)}`);
    }

    const me = await session(ctx, 'jimin');
    const ticketId = sqlRead(ctx, 'peaket_demo_ticket', `select id from ticket where event_id = '${eventId}' and account_id = '${me.accountId}' and status = 'ISSUED' order by created_at, id limit 1`);
    if (!/^[0-9a-f-]{36}$/.test(ticketId)) throw new Error(`S8에 쓸 지민의 티켓이 없다(S1·S5가 먼저 돈다): ${JSON.stringify(ticketId)}`);
    ctx.vars.ticketId = ticketId;
    let gateZone = sqlRead(ctx, 'peaket_demo_ticket', `select gate_zone from ticket where id = '${ticketId}'`);

    // 기기 자격(DPoP 키)은 .cache에 보존한다. 등록 코드는 1회용이므로, 기기가 아직 그 키에 묶이지 않았을 때만 새로 발급한다
    const key = deviceKey(ctx);
    const keyHex = Buffer.from(key.jkt, 'base64url').toString('hex');
    const devices = JSON.parse(
      sqlRead(
        ctx,
        'peaket_demo_ticket',
        `select coalesce(json_agg(json_build_object('id', id, 'name', name, 'thumb', coalesce(encode(credential_thumbprint, 'hex'), '')) order by name), '[]'::json) from scanner_device where name like '동문-%' and status = 'ACTIVE'`,
      ),
    );
    if (devices.length === 0) throw new Error('시드에 동문 스캐너 기기가 없다');
    const device = devices.find((d) => d.thumb === keyHex) ?? devices.find((d) => d.thumb === '');
    if (!device) throw new Error('동문 기기가 모두 다른 기기 키에 묶여 있다(같은 키를 보존하지 못했다)');
    ctx.vars.scannerDeviceId = device.id;
    // 검표 판정은 티켓 게이트 구역과 기기 배치 구역이 같아야 통과한다(offline-gate §6.4).
    // 시드가 발권한 티켓에는 게이트 구역이 비어 있어, 데모 전용으로 기기 배치 구역을 티켓에 적는다
    const placementZone = sqlRead(ctx, 'peaket_demo_ticket', `select gate_zone from scanner_placement where event_id = '${eventId}' and scanner_device_id = '${device.id}'`);
    if (placementZone && gateZone !== placementZone) {
      sqlDemoWrite(ctx, 'peaket_demo_ticket', `update ticket set gate_zone = '${placementZone.replaceAll("'", "''")}' where id = '${ticketId}'`);
      gateZone = placementZone;
      ctx.log(`  티켓 게이트 구역을 기기 배치(${placementZone})에 맞췄다(데모 전용)`);
    }
    if (!gateZone) throw new Error('티켓·기기 배치에 게이트 구역이 없다');
    if (device.thumb !== keyHex) {
      const issued = await api(ctx, 'sujin', { method: 'POST', host: 'ops-api', originKey: 'console', path: `/v1/ops/scanner-devices/${device.id}/enrollment-code`, headers: { 'content-type': 'application/json' }, body: {} });
      if (issued.status !== 201 || typeof issued.json?.enrollmentCode !== 'string') throw new Error(`기기 등록 코드 발급 → ${issued.status} ${tail(issued.text, 600)}`);
      const enrolled = await scannerJson(ctx, { method: 'POST', path: '/v1/scanner/device-enrollments', body: { code: issued.json.enrollmentCode }, key });
      if (enrolled.status !== 201 || enrolled.json?.deviceId !== device.id) throw new Error(`기기 등록 → ${enrolled.status} ${tail(enrolled.text, 600)}`);
    }

    // 기기 승인 로그인: 기기가 코드를 열고, 스태프(하늘)가 승인 화면에서 승인한 뒤 기기가 토큰을 받는다
    const started = await scannerJson(ctx, { method: 'POST', path: '/v1/scanner/device-authorizations', body: {}, key });
    if (started.status !== 200 || typeof started.json?.deviceCode !== 'string' || typeof started.json?.userCode !== 'string') {
      throw new Error(`기기 승인 코드 → ${started.status} ${tail(started.text, 600)}`);
    }
    const lookup = await api(ctx, 'haneul', { method: 'POST', host: 'api', path: '/v1/device-approval-lookups', headers: { 'content-type': 'application/json' }, body: { userCode: started.json.userCode } });
    if (lookup.status !== 200) throw new Error(`기기 승인 화면 조회 → ${lookup.status} ${tail(lookup.text, 600)}`);
    const assignment = (lookup.json?.assignments ?? []).find((a) => a.eventId === eventId) ?? lookup.json?.assignments?.[0];
    if (!assignment?.assignmentId) throw new Error('기기 승인 화면에 이 회차의 배정이 없다');
    const approved = await api(ctx, 'haneul', {
      method: 'POST',
      host: 'api',
      path: '/v1/device-approvals',
      headers: { 'content-type': 'application/json' },
      body: { userCode: started.json.userCode, decision: 'APPROVE', assignmentId: assignment.assignmentId },
    });
    if (approved.status !== 204) throw new Error(`기기 승인 → ${approved.status} ${tail(approved.text, 600)}`);
    const grant = await waitUntil(
      ctx,
      '스캐너 스태프 토큰',
      async () => {
        const res = await scannerJson(ctx, { method: 'POST', path: '/v1/scanner/token', body: { deviceCode: started.json.deviceCode }, key });
        if (res.status === 200 && typeof res.json?.access_token === 'string') return { ok: true, value: res.json };
        return { ok: false, detail: `HTTP ${res.status} ${res.json?.error ?? ''}` };
      },
      { timeoutMs: 90_000, intervalMs: 5_500 },
    );
    const claims = jwtPayload(grant.access_token);
    if (claims.evt !== eventId || typeof claims.sid !== 'string') throw new Error(`스캐너 토큰의 회차·세션이 다르다(evt ${claims.evt ?? '없음'})`);
    const scannerSessionId = claims.sid;

    // 오프라인 판정 업로드: 통과 1 + 같은 티켓 중복 1(거부·이상 표시) + 확인 필요 1(VERIFY). 판정은 서버가 티켓 원장으로 다시 계산한다
    const at = ctx.now();
    const base = { eventId, ticketId, scannerSessionId, direction: 'IN', method: 'QR', gateZone, knownSeq: 0 };
    const batch = [
      { id: randomUUID(), ...base, result: 'PASS', scannedAtDevice: new Date(at).toISOString(), deviceSeq: 1 },
      { id: randomUUID(), ...base, result: 'PASS', scannedAtDevice: new Date(at + 1_000).toISOString(), deviceSeq: 2 },
      { id: randomUUID(), ...base, method: 'VERIFY', result: 'CHECK', reason: 'VERIFY_ONLY', scannedAtDevice: new Date(at + 2_000).toISOString(), deviceSeq: 3 },
    ];
    const uploaded = await scannerJson(ctx, { method: 'POST', path: '/v1/scanner/scans', body: batch, accessToken: grant.access_token, key });
    if (uploaded.status !== 200) throw new Error(`스캔 업로드 → ${uploaded.status} ${tail(uploaded.text, 800)}`);
    ctx.vars.scanIds = batch.map((s) => s.id);
    const rows = JSON.parse(
      sqlRead(ctx, 'peaket_demo_ticket', `select coalesce(json_agg(json_build_object('result', result, 'reason', reason, 'flag', flag)), '[]'::json) from scan_event where id in (${batch.map((s) => `'${s.id}'`).join(', ')})`),
    );
    const flags = Array.isArray(uploaded.json?.flags) ? uploaded.json.flags : [];
    const flagPage = await scannerJson(ctx, { method: 'GET', path: `/v1/scanner/events/${eventId}/flags`, accessToken: grant.access_token, key });
    const flagItems = Array.isArray(flagPage.json?.items) ? flagPage.json.items : [];
    const pass = rows.some((r) => r.result === 'PASS');
    const reject = rows.some((r) => r.result === 'REJECT' && r.reason === 'ALREADY_IN');
    const check = rows.some((r) => r.result === 'CHECK');
    const anomaly = flags.some((f) => f.kind === 'DUPLICATE') || flagItems.some((f) => f.kind === 'DUPLICATE');
    ctx.addCheck('verdict-pass', pass, `스캔 기록 ${rows.map((r) => `${r.result}/${r.reason ?? '-'}`).join(' · ')}`);
    ctx.addCheck('verdict-reject', reject, '같은 티켓 두 번째 IN이 ALREADY_IN으로 내려갔다');
    ctx.addCheck('verdict-needs-check', check, 'VERIFY 스캔이 CHECK(확인 필요)로 남았다');
    ctx.addCheck('verdict-anomaly', anomaly, `이상 표시 ${flags.map((f) => f.kind).join('·') || flagItems.map((f) => f.kind).join('·') || '없음'}`);
    await visit(ctx, { screen: 'SCR-033', path: '/', account: 'haneul', origin: 'scanner' }).catch((e) => ctx.log(`  화면 SCR-033: ${e.message}`));
    await visit(ctx, { screen: 'SCR-034', path: '/', account: 'haneul', origin: 'scanner' }).catch((e) => ctx.log(`  화면 SCR-034: ${e.message}`));
    return ctx.checks;
  },

  async S9(ctx) {
    const eventId = demoEventId(ctx, 'LUMEN 콘서트 2026 서울');
    const productionId = sqlRead(ctx, 'peaket_demo_core', `select id from production where title = 'LUMEN 콘서트 2026 서울' limit 1`);
    ctx.vars.eventId = eventId;
    ctx.vars.productionId = productionId;
    await visit(ctx, { screen: 'SCR-044', path: `/events/${productionId}/cancellation`, account: 'stella-admin', origin: 'partner', expect: ['취소'] }).catch((e) => ctx.log(`  화면 SCR-044: ${e.message}`));
    await visit(ctx, { screen: 'SCR-045', path: '/cs/inbox', account: 'sujin', origin: 'console', expect: ['CS|문의'] }).catch((e) => ctx.log(`  화면 SCR-045: ${e.message}`));

    // ① 파트너 관리자 요청 → ② commander 판정(미리보기) → ③ 판정자 아닌 commander가 재인증 뒤 확정(2인)
    const requested = await api(ctx, 'stella-admin', {
      method: 'POST',
      host: 'partner-api',
      path: `/v1/partner/events/${eventId}/cancellation`,
      headers: { 'idempotency-key': randomUUID(), 'content-type': 'application/json' },
      body: { kind: 'CANCEL', reason: 'BAT-086 S9 데모 회차 취소', faultOpinion: 'ORGANIZER', evidenceRef: 'bat-086-demo' },
    });
    let requestId = requested.json?.requestId;
    if (requested.status !== 202) {
      if (requested.status === 409 && typeof requested.json?.requestId === 'string') requestId = requested.json.requestId;
      else throw new Error(`회차 취소 요청 → ${requested.status} ${tail(requested.text, 800)}`);
    }
    if (typeof requestId !== 'string' || requestId === '') throw new Error('회차 취소 요청 응답에 requestId가 없다');
    ctx.vars.requestId = requestId;
    let state = await api(ctx, 'sujin', { method: 'GET', host: 'ops-api', originKey: 'console', path: `/v1/ops/event-cancellations/${requestId}` });
    if (state.status !== 200) throw new Error(`회차 취소 조회 → ${state.status} ${tail(state.text, 600)}`);
    if (['REQUESTED', 'JUDGED', 'PENDING_APPROVAL'].includes(state.json?.status)) {
      const judged = await api(ctx, 'sujin', {
        method: 'POST',
        host: 'ops-api',
        originKey: 'console',
        path: `/v1/ops/event-cancellations/${requestId}/judgement`,
        headers: { 'content-type': 'application/json' },
        body: { fault: 'ORGANIZER', reason: '제작사 귀책(데모)', fanNoticeReason: '공연이 취소되어 결제 금액을 전액 환불합니다' },
      });
      if (judged.status !== 200) throw new Error(`회차 취소 판정 → ${judged.status} ${tail(judged.text, 800)}`);
      state = judged;
    }
    if (state.json?.status === 'PENDING_APPROVAL') {
      const token = await adminReauth(ctx, 'second-commander', 'APPROVAL');
      const approved = await api(ctx, 'second-commander', {
        method: 'POST',
        host: 'ops-api',
        originKey: 'console',
        path: `/v1/ops/event-cancellations/${requestId}/approvals`,
        headers: { 'x-reauth-token': token, 'content-type': 'application/json' },
        body: {},
      });
      if (approved.status !== 200) throw new Error(`회차 취소 확정 → ${approved.status} ${tail(approved.text, 800)}`);
      state = approved;
    }

    // 일괄 환불은 비동기다. 상태가 끝날 때까지 조건을 기다린다(고정 sleep 아님)
    const final = await waitUntil(
      ctx,
      '회차 취소·일괄 환불 완료',
      async () => {
        const res = await api(ctx, 'sujin', { method: 'GET', host: 'ops-api', originKey: 'console', path: `/v1/ops/event-cancellations/${requestId}` });
        const p = res.json?.progress;
        return { ok: res.status === 200 && res.json?.status === 'COMPLETED', value: res.json, detail: `HTTP ${res.status} ${res.json?.status ?? ''} 진행 ${p ? `${p.done}/${p.total}(실패 ${p.failed})` : '없음'}` };
      },
      { timeoutMs: 300_000, intervalMs: 2_000 },
    );
    const progress = final.progress ?? {};
    const refundsDone = Number(progress.total ?? 0) > 0 && Number(progress.failed ?? 0) === 0 && Number(progress.done ?? 0) + Number(progress.failed ?? 0) >= Number(progress.total ?? 0);
    const me = await session(ctx, 'jimin');
    const ticketStates = JSON.parse(sqlRead(ctx, 'peaket_demo_ticket', `select coalesce(json_agg(status), '[]'::json) from ticket where event_id = '${eventId}' and account_id = '${me.accountId}'`));
    const ticketsRefunded = ticketStates.every((s) => s === 'REFUNDED' || s === 'VOIDED');
    // 같은 요청을 다시 확정하지 않는지: COMPLETED에서 approve는 409다
    const againToken = await adminReauth(ctx, 'second-commander', 'APPROVAL');
    const again = await api(ctx, 'second-commander', {
      method: 'POST',
      host: 'ops-api',
      originKey: 'console',
      path: `/v1/ops/event-cancellations/${requestId}/approvals`,
      headers: { 'x-reauth-token': againToken, 'content-type': 'application/json' },
      body: {},
    });
    ctx.addCheck('refunded', refundsDone && ticketsRefunded && again.status === 409, `상태 ${final.status} · 환불 ${progress.done}/${progress.total}(실패 ${progress.failed}) · 티켓 ${ticketStates.join(',') || '없음'} · 다시 확정 ${again.status}`);

    await visit(ctx, { screen: 'SCR-047', path: `/cancellations/${requestId}`, account: 'sujin', origin: 'console', expect: ['취소|환불'] }).catch((e) => ctx.log(`  화면 SCR-047: ${e.message}`));
    await visit(ctx, { screen: 'SCR-013', path: '/my/tickets', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-013: ${e.message}`));
    ctx.vars.compensationId = randomUUID();
    await visit(ctx, { screen: 'SCR-043', path: '/my/compensations/{compensationId}', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-043: ${e.message}`));
    return ctx.checks;
  },
};

/**
 * 시나리오 목록을 재생한다. 시험 담당이 가짜 의존성을 넣을 수 있게 deps를 받는다.
 * @param {{ repo: string, scenarios: import('./scenarios.mjs').SCENARIOS, contract: any, artifactsDir: string,
 *   headed?: boolean, video?: boolean, pw?: any, auth?: Function, log?: Function, now?: Function,
 *   browserLauncher?: Function }} o
 */
export async function runScenarios(o) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const artifactsDir = join(o.artifactsDir ?? '.cache/peaket-tools/demo-artifacts', runId);
  mkdirSync(artifactsDir, { recursive: true });
  const log = o.log ?? ((s) => console.log(s));
  const pw = o.pw ?? (await loadPlaywright(o.repo));
  const chromium = pw.chromium;
  if (!chromium) throw new Error('Playwright에 chromium이 없다');
  const launch = o.browserLauncher ?? ((args) => chromium.launch(args));
  const browser = await launch({
    headless: !o.headed,
    args: ['--host-resolver-rules=MAP *.peaket.example 127.0.0.1'],
  });
  const startedAt = o.now?.() ?? Date.now();
  const results = [];
  // API 세션과 TOTP 칸은 한 실행 안에서 이어 쓴다(브라우저 맥락은 시나리오마다 새로 연다, 계획 §11 '화면 사이 상태 새기')
  const sessionCache = new Map();
  const totpSteps = new Map();
  try {
    for (const s of o.scenarios) {
      const scenarioStarted = (o.now?.() ?? Date.now());
      const startedIso = new Date(scenarioStarted).toISOString();
      const ctx = newCtx({ ...o, runId, artifactsDir, pw, browser, log, sessionCache, totpSteps });
      let failure;
      try {
        if (!FLOWS[s.id]) throw new Error(`시나리오 ${s.id}의 재생 흐름이 없다`);
        await FLOWS[s.id](ctx);
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      } finally {
        for (const c of ctx.contexts.values()) await c.close().catch(() => undefined);
      }
      const missing = (s.checks ?? []).filter((name) => !ctx.has(name));
      const failed = (s.checks ?? []).filter((name) => ctx.checks[name] && !ctx.checks[name].ok);
      const ended = (o.now?.() ?? Date.now());
      const ok = !failure && missing.length === 0 && failed.length === 0;
      const reason = failure ?? (missing.length ? `확인하지 못한 checks: ${missing.join(', ')}` : failed.length ? failed.map((n) => `${n}: ${ctx.checks[n].detail}`).join('; ') : undefined);
      const row = {
        id: s.id,
        title: s.title,
        startedAt: startedIso,
        endedAt: new Date(ended).toISOString(),
        seconds: Math.round((ended - scenarioStarted) / 1000),
        result: ok ? '통과' : '실패',
        failedStep: ok ? undefined : failure ? failure.split(':')[0] : missing[0] ? `check ${missing[0]}` : `check ${failed[0]}`,
        reason,
        checks: ctx.checks,
        screens: ctx.visited,
        artifacts: ctx.artifacts,
        firstScreenAt: ctx.firstScreenAt,
      };
      results.push(row);
      log(`${ok ? '통과' : '실패'} ${s.id} ${s.title}${ok ? '' : ` — ${reason}`}`);
      if (ctx.artifacts.length) log(`  실패 그림 ${ctx.artifacts.length}장: ${artifactsDir}`);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  const firstScreenAt = results.map((r) => r.firstScreenAt).filter(Boolean).sort((a, b) => a - b)[0];
  const report = {
    runId,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(o.now?.() ?? Date.now()).toISOString(),
    coldStartSeconds: firstScreenAt === undefined ? undefined : Math.round((firstScreenAt - startedAt) / 1000),
    scenarios: results,
    artifactsDir,
    ok: results.every((r) => r.result === '통과'),
  };
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(join(artifactsDir, 'result.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

/** 화면 하나도 열지 못했을 때(재생기가 시작조차 못 함)를 기록에 남기기 위한 결과 */
export function emptyReport(reason) {
  return { runId: 'none', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), coldStartSeconds: undefined, scenarios: [], ok: false, reason };
}
