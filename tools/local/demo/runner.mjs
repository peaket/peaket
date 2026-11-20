// BAT-086 시연 재생기(계획 §1 G3, §5). `tools/web-checks`의 Playwright 1.64.1을 빌려 쓴다(새 패키지 없음).
// - 시나리오마다 브라우저 맥락을 새로 연다(로그인·티켓이 시나리오 사이에 새지 않게).
// - 화면은 조건을 기다린다(고정 sleep 없음). 실패하면 화면 그림·URL·마지막 단계를 남긴다.
// - 결과 확인(checks)은 제품 API·화면에서 만든다. 하나라도 만들어지지 않으면 그 시나리오는 실패다(조용한 건너뛰기 없음).
// - S1·S3·S4·S6은 구매 세션 서명(ECDH+HKDF)으로 실제 API를 끝까지 부른다. PG는 데모 무대의 시뮬레이터다.
//   S2·S5·S7·S8·S9는 화면을 열고, 아직 자동화하지 못한 판정은 '실패'로 남긴다(까닭을 적는다).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { demoAuth, httpsJson, readSeed } from '../demo-auth.mjs';
import { DEMO_GATEWAY_PORTS, DEMO_HOSTS, demoExpectedWorkloads } from '../demo-objects.mjs';
import { admissionClaims, createClientKeyPair, purchaseMac, requestKey, sharedSecret } from '../../../packages/api-client/src/purchase/crypto.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 2000) => (String(s ?? '').length > n ? `…${String(s ?? '').slice(-n)}` : String(s ?? ''));
/** 데모 무대의 구매 동의 문안 판(v1EnvFiles와 같다). 서버 값과 다르면 422 consent-version-outdated다 */
export const DEMO_CONSENT_VERSION = 'lt-v1-2026-11';
/** 데모 시계: 회차 오픈을 지금 + 30초로 당긴다(계획 §12 [가정]) */
export const DEMO_CLOCK_MS = 30_000;
const OPEN_WAIT_MS = 180_000;
const PAYMENT_WAIT_MS = 90_000;
const ACTION_TIMEOUT_MS = 30_000;

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
  const root = env.PEAKET_TOOLS_DIR || join(process.env.USERPROFILE || process.env.HOME || '.', '.cache', 'peaket-tools');
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
  return env.PEAKET_KUBECONFIG || join(env.PEAKET_TOOLS_DIR || join(process.env.USERPROFILE || process.env.HOME || '.', '.cache', 'peaket-tools'), `kubeconfig-${cluster}`);
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
    list = JSON.parse(kubectl(['get', 'deploy', '-A', '-l', 'app.kubernetes.io/part-of=peaket-demo', '-o', 'json'], o));
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
    sessionCache: new Map(),
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
    ctx.sessionCache.set(key, await (ctx.auth ?? demoAuth)(account.kind === 'fan' ? 'fan' : 'admin', key));
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
      await page.getByText(new RegExp(text, 'i')).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
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

/** SQL 읽기(로컬 데모 전용 예외: 파트너 목록·상세 API가 없는 곳의 읽기만). 쓰기는 하지 않는다 */
function sqlRead(ctx, db, statement) {
  return kubectl(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-tAc', statement], { env: ctx.env }).trim();
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
  if (Number.isFinite(openAt) && openAt <= ctx.now()) {
    ctx.log(`  오픈이 이미 지났다(${info.json.openAt}). 시계를 당기지 않는다`);
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

/** 대기열 진입 → 입장 확정(구매 세션 재료). 조건을 기다리며 다시 묻는다 */
async function admit(ctx, account, eventId) {
  const origin = originOf(ctx.contract, 'queue');
  // ① 사전 검증 토큰(사람 확인 보류 hd여도 발급된다). 추가 검증이 필요하면 화면(SCR-009) 몫이라 실패로 남긴다
  const pre = await api(ctx, account, {
    method: 'POST',
    host: 'queue',
    path: `/v1/queues/${eventId}/pre-verifications`,
    headers: { origin, 'content-type': 'application/json' },
    body: { deviceId: 'demo-play' },
  });
  if (pre.status !== 201 || typeof pre.json?.preverifyToken !== 'string') throw new Error(`사전 검증 토큰 → ${pre.status} ${tail(pre.text, 600)}`);
  // ② 진입(사전 검증 토큰 필요)
  const entry = await api(ctx, account, {
    method: 'POST',
    host: 'queue',
    path: `/v1/queues/${eventId}/entries`,
    headers: { origin, 'content-type': 'application/json' },
    body: { preverifyToken: pre.json.preverifyToken, deviceId: 'demo-play', entryRequestId: randomUUID() },
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
  const sig = await signer.sign('POST', path, body);
  const res = await api(ctx, account, { method: 'POST', host: 'api', path, headers: { ...sig, 'idempotency-key': randomUUID(), 'content-type': 'application/json' }, body });
  return res;
}

/** 주문 생성 */
async function createOrder(ctx, account, signer, holdId) {
  const path = '/v1/orders';
  const body = { holdId, buyer: { name: '데모 지민' }, consents: { provisionToSeller: true, salesTerms: true, consentVersion: DEMO_CONSENT_VERSION } };
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
  const script = `const fs=require('fs');const env=Object.fromEntries(fs.readFileSync('/etc/peaket/bundle/payment-svc.env','utf8').split('\\n').filter(Boolean).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));const auth='Basic '+Buffer.from(env.PEAKET_PG_SIM_SECRET_KEY+':').toString('base64');fetch('http://pg-simulator.purchase.svc.cluster.local:8790'+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{authorization:auth,'content-type':'application/json'},${body === undefined ? '' : `body:${JSON.stringify(JSON.stringify(body))}`}}).then(async r=>{const t=await r.text();console.log(JSON.stringify({status:r.status,text:t}))}).catch(e=>{console.log(JSON.stringify({status:0,text:String(e)}));process.exit(1)})`;
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
    await visit(ctx, { screen: 'SCR-001', path: '/', account: 'jimin' });
    await visit(ctx, { screen: 'SCR-002', path: '/events/{eventId}', account: 'jimin', expect: ['예매|LUMEN'] });
    const { openAt } = await shiftClock(ctx, eventId);
    ctx.vars.openAt = openAt;
    await visit(ctx, { screen: 'SCR-007', path: '/queue/{eventId}', account: 'jimin', expect: ['로비|대기|순번|오픈'] }).catch((e) => ctx.log(`  화면 SCR-007: ${e.message}`));
    await waitOpen(ctx, eventId, openAt);
    const admission = await admit(ctx, 'jimin', eventId);
    const signer = await purchaseSigner(admission);
    const hold = heldOf(await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: ['R1-1-1', 'R1-1-2'] }), 'S1');
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
    const paid = await waitPayment(ctx, 'jimin', orderId, ['APPROVED']);
    ctx.addCheck('payment-approved', paid === 'APPROVED', `결제 상태 ${paid}`);
    let ticketId;
    for (let i = 0; i < 60 && !ticketId; i += 1) {
      const detail = await orderDetail(ctx, 'jimin', orderId);
      ticketId = (detail.seats ?? []).map((s) => s.ticketId).find(Boolean);
      if (!ticketId) await sleep(500);
    }
    if (!ticketId) throw new Error('결제 승인 뒤에도 발권된 ticketId가 없다');
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
    await visit(ctx, { screen: 'SCR-008', path: '/queue/{eventId}', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-008: ${e.message}`));
    await visit(ctx, { screen: 'SCR-054', path: '/my/likes', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-054: ${e.message}`));
    ctx.addCheck('sold-out', false, '시드의 E-3는 매진 상태가 아니다(전석 매진 픽스처가 없다). BAT-087 기본 시드 또는 다음 묶음 몫');
    ctx.addCheck('cancel-alert-subscribed', false, '취소표 알림 신청 API·화면 자동화가 이 묶음에 없다(SCR-018→054)');
    return ctx.checks;
  },

  async S3(ctx) {
    const eventId = demoEventId(ctx, 'LUMEN 콘서트 2026 서울');
    ctx.vars.eventId = eventId;
    await visit(ctx, { screen: 'SCR-011', path: '/booking/{eventId}/checkout', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-011: ${e.message}`));
    const { openAt } = await shiftClock(ctx, eventId);
    await waitOpen(ctx, eventId, openAt);
    const admission = await admit(ctx, 'jimin', eventId);
    const signer = await purchaseSigner(admission);

    // ① 승인 거절: 홀드는 풀리고 좌석을 다시 잡을 수 있어야 한다
    const hold1 = heldOf(await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: ['R1-2-1', 'R1-2-2'] }), 'S3-거절');
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
    const rehold = await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: ['R1-2-1', 'R1-2-2'] });
    ctx.addCheck('seat-released', rehold.status === 201, `같은 좌석 다시 홀드 → ${rehold.status}`);

    // ② 결과 불명: 응답을 끊어 UNKNOWN을 만든다
    const hold2 = heldOf(await holdSeats(ctx, 'jimin', eventId, signer, { seatIds: ['R1-3-1', 'R1-3-2'] }), 'S3-불명');
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
    await visit(ctx, { screen: 'SCR-002', path: '/events/{eventId}', account: 'jimin', expect: ['예매|페스티벌'] });
    const { openAt } = await shiftClock(ctx, eventId);
    await waitOpen(ctx, eventId, openAt);
    await visit(ctx, { screen: 'SCR-008', path: '/queue/{eventId}', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-008: ${e.message}`));
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
    const paid = await waitPayment(ctx, 'jimin', order.json.orderId, ['APPROVED']);
    ctx.addCheck('payment-approved', paid === 'APPROVED', `결제 상태 ${paid}`);
    await visit(ctx, { screen: 'SCR-010', path: '/booking/{eventId}/seats', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-010: ${e.message}`));
    await visit(ctx, { screen: 'SCR-011', path: '/booking/{eventId}/checkout', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-011: ${e.message}`));
    return ctx.checks;
  },

  async S5(ctx) {
    await visit(ctx, { screen: 'SCR-013', path: '/my/tickets', account: 'jimin' }).catch((e) => ctx.log(`  화면 SCR-013: ${e.message}`));
    ctx.addCheck('transfer-offer', false, '양도 요청·수락은 팬 재인증(카카오/구글 다시 로그인)을 요구한다. 이 묶음은 그 브라우저 의식을 자동화하지 않았다');
    ctx.addCheck('cancel-with-fee', false, '티켓 취소(20% 공제)도 재인증이 필요하다. 같은 까닭');
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
    if (![200, 202, 409].includes(submitted.status)) throw new Error(`판매 심사 제출 → ${submitted.status} ${tail(submitted.text, 600)}`);
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
    const missing = '관제 명령의 2인 승인은 콘솔의 패스키 재인증(WebAuthn)을 거친다. 이 묶음은 그 의식을 자동화하지 않았다(CDP 가상 인증기 코드는 demo-auth passkey에 있으나 승인 흐름 조작이 남았다)';
    ctx.addCheck('self-approval-403', false, missing);
    ctx.addCheck('second-approval-ok', false, missing);
    ctx.addCheck('audit-entry', false, missing);
    return ctx.checks;
  },

  async S8(ctx) {
    await visit(ctx, { screen: 'SCR-037', path: '/staff', account: 'haneul', expect: ['배정|현장|스태프'] }).catch((e) => ctx.log(`  화면 SCR-037: ${e.message}`));
    await visit(ctx, { screen: 'SCR-036', path: '/', account: 'haneul', origin: 'scanner', expect: ['스캔|스캐너|기기'] }).catch((e) => ctx.log(`  화면 SCR-036: ${e.message}`));
    const missing = '스캐너 기기 로그인(등록 코드·DPoP)과 합성 티켓 판정 넷은 기기 자격 증명을 시드가 남기지 않아 이 묶음에서 자동화하지 못했다. BAT-087 기기 7대는 관제에 있으나 등록 코드를 발급·보관하지 않는다';
    for (const c of ['verdict-pass', 'verdict-reject', 'verdict-needs-check', 'verdict-anomaly']) ctx.addCheck(c, false, missing);
    return ctx.checks;
  },

  async S9(ctx) {
    const productionId = sqlRead(ctx, 'peaket_demo_core', `select id from production where title = 'LUMEN 콘서트 2026 서울' limit 1`);
    ctx.vars.productionId = productionId;
    await visit(ctx, { screen: 'SCR-044', path: `/events/${productionId}/cancellation`, account: 'stella-admin', origin: 'partner', expect: ['취소'] }).catch((e) => ctx.log(`  화면 SCR-044: ${e.message}`));
    await visit(ctx, { screen: 'SCR-045', path: '/cs/inbox', account: 'sujin', origin: 'console', expect: ['CS|문의'] }).catch((e) => ctx.log(`  화면 SCR-045: ${e.message}`));
    const missing = '회차 취소 확정은 관제 2인 승인(패스키 재인증)을 거친다. 이 묶음은 그 의식과 일괄 환불 진행을 자동화하지 않았다';
    ctx.addCheck('refunded', false, missing);
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
  try {
    for (const s of o.scenarios) {
      const scenarioStarted = (o.now?.() ?? Date.now());
      const startedIso = new Date(scenarioStarted).toISOString();
      const ctx = newCtx({ ...o, runId, artifactsDir, pw, browser, log });
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
