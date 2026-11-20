// BAT-087 기본 합성 시드 적용기(docs/review/plans/BAT-087.md §5·§6 G5).
// - `--check`: 시드 파일의 참조·비밀 없음·개수 계약을 본다(클러스터 없이, DS-05)
// - `--apply`: ① 첫 관리자·패스키·promoter 부트스트랩 Job 둘 ② 공개·관리 API로 공연·회차·좌석맵·기기·판매 승인
//   ③ 개수를 다시 읽어 `--json`으로 낸다(created·counts·total)
// - 예외(로컬 데모 전용, 계획 '고침' 절·deploy/envs/demo/README.md): 공연장(place) 행과 스태프 배정(staff_assignment)은
//   공개 API가 없어 직접 SQL로 넣고, 기존 공연·회차·스태프를 찾는 읽기도 직접 SQL로 한다. 공연·회차·좌석맵은
//   공개 API로만 만들어 감사 기록·Outbox를 남긴다(계획 B12, M8).
// - 두 번 적용해도 계정·공연·회차·promoter·스태프·기기 수가 같다(키·제목·차례·이메일로 찾아 없을 때만 만든다).
//   회차는 시작 시각 차례로 찾는다(상대 시각은 적용마다 값이 달라져 epoch로 찾을 수 없다, RV-01).
//   두 번째에는 좌석맵을 다시 PUT하지 않는다(같은 배치를 덮어쓰지 않는다)
// - 회차 시각 넷(오픈·시작·종료·입장 시작)은 실행 시각 기준 상대 표기(`+2h`·`+1d6h`)만 쓰고 절대 ISO로 펼친다.
//   차례(지금 < 오픈 < 판매 종료 < 시작 < 종료, 입장 시작 <= 시작)를 --check가 먼저 보고 어기면 --apply도 멈춘다
// - 비밀·개인정보는 출력하지 않는다. 실패하면 exit 1이고 어느 단계가 실패했는지만 낸다
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_CLUSTER, DEMO_GATEWAY_PORTS, DEMO_HOSTS, demoOrigins } from './demo-objects.mjs';
import { demoUuid, demoAuth, httpsJson, prepareDemoSecrets, readSeed, DEMO_CONTRACT_FILE, DEMO_SEED_FILE } from './demo-auth.mjs';
import { DEFAULT_ROOT, ensureTool } from './tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 상대 시각 표기(+2h·+1d·+1d6h·+30m). 단위는 d·h·m 차례로 붙인다. 모든 회차 시각은 이 표기만 쓴다(RV-01) */
const RELATIVE_TIME = /^([+-])(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/;
const TIME_UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000 };
/** 회차 시각 칸 넷. entryOpensAt만 없어도 된다 */
const EVENT_TIME_FIELDS = ['openAt', 'startAt', 'endAt', 'entryOpensAt'];
/** 판매는 회차 시작 24시간 전에 끝난다(core `registration.ts`의 `SALE_END_BEFORE_START_MS`와 같은 값) */
const SALE_END_BEFORE_START_MS = 24 * 60 * 60_000;

/**
 * 상대 표기 하나를 밀리초로 읽는다. 상대 표기가 아니면 null이다(절대 ISO·'내일' 같은 값).
 * @param {string} value
 */
export function relativeSeedTimeMs(value) {
  const text = String(value ?? '').trim();
  const m = RELATIVE_TIME.exec(text);
  if (!m || !/\d/.test(text)) return null;
  const total = Number(m[2] ?? 0) * TIME_UNIT_MS.d + Number(m[3] ?? 0) * TIME_UNIT_MS.h + Number(m[4] ?? 0) * TIME_UNIT_MS.m;
  return (m[1] === '-' ? -1 : 1) * total;
}

/**
 * 시드의 시각 값 하나를 Date로 읽는다. 상대 표기(`+2h`)는 now 기준이고, 절대 ISO는 그대로 쓴다.
 * `checkSeed`는 절대 ISO를 받지 않는다(시드가 늙지 않게 모든 시각을 상대 표기로 둔다).
 * @param {string} value @param {Date} now @param {string} what 오류 메시지에 쓸 자리
 */
export function seedTime(value, now = new Date(), what = '시각') {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${what}이 비었다`);
  const rel = relativeSeedTimeMs(text);
  if (rel !== null) return new Date(now.getTime() + rel);
  const at = Date.parse(text);
  if (Number.isNaN(at)) throw new Error(`${what}을 읽지 못했다: ${text}(상대 표기 '+2h'나 절대 ISO를 쓴다)`);
  return new Date(at);
}

/** 시드의 회차 시각을 실행 시각 기준 절대 ISO로 펼친다(원본 시드 객체는 바꾸지 않는다) */
export function resolveSeedTimes(seed, now = new Date()) {
  return {
    ...seed,
    events: (seed.events ?? []).map((e) => ({
      ...e,
      openAt: seedTime(e.openAt, now, `회차 ${e.key}의 openAt`).toISOString(),
      startAt: seedTime(e.startAt, now, `회차 ${e.key}의 startAt`).toISOString(),
      endAt: seedTime(e.endAt, now, `회차 ${e.key}의 endAt`).toISOString(),
      ...(e.entryOpensAt === undefined ? {} : { entryOpensAt: seedTime(e.entryOpensAt, now, `회차 ${e.key}의 entryOpensAt`).toISOString() }),
    })),
  };
}

/** 시드 파일 하나를 읽고 검사한다. password·totp·privateKey 같은 값 칸이 있으면 실패(DS-05) */
export function checkSeed(file = DEMO_SEED_FILE, now = new Date()) {
  const seed = readSeed(file);
  const problems = [];
  const text = readFileSync(file, 'utf8');
  for (const bad of ['password:', 'totp:', 'privateKey:', 'credentialId:', 'secret:']) {
    if (text.toLowerCase().includes(bad)) problems.push(`시드에 비밀 값 칸이 있다: ${bad}`);
  }
  for (const a of seed.accounts) {
    if (a.kind === 'admin') {
      if (!a.passwordEnv) problems.push(`관리 계정 ${a.key}에 passwordEnv가 없다`);
      if (!a.totpEnv) problems.push(`관리 계정 ${a.key}에 totpEnv가 없다`);
      if (!/@(?:example\.test|example\.com|peaket\.test)$/.test(a.email ?? '')) problems.push(`관리 계정 ${a.key}의 email이 example.test·peaket.test가 아니다(실제 이메일 금지)`);
    } else if (!/(?:example\.test|example\.com|peaket\.test)$/.test(a.email ?? '')) {
      problems.push(`팬 ${a.key}의 email이 example.test·peaket.test가 아니다(실제 이메일 금지)`);
    }
    if (a.phone) problems.push(`계정 ${a.key}에 전화번호 값이 있다(실제 개인정보 금지)`);
  }
  for (const p of seed.adminPasskeys ?? []) {
    if (!p.credentialEnv || !p.privateKeyEnv) problems.push(`패스키 ${p.accountKey}에 credentialEnv·privateKeyEnv가 없다`);
  }
  // 모든 회차 시각(오픈·시작·종료·입장 시작)은 상대 표기여야 한다. 절대 날짜가 하나라도 남으면 시드가 늙어
  // 언젠가 422로 멈춘다(RV-01). 읽지 못하는 표기도 여기서 잡는다
  for (const e of seed.events ?? []) {
    for (const field of EVENT_TIME_FIELDS) {
      const value = e[field];
      if (value === undefined) {
        if (field !== 'entryOpensAt') problems.push(`회차 ${e.key}에 ${field}가 없다`);
        continue;
      }
      if (relativeSeedTimeMs(value) === null) problems.push(`회차 ${e.key}의 ${field}(${value})가 절대 시각이다: 상대 표기('+2h'·'+1d'·'+1d6h')만 쓴다`);
    }
  }
  // 펼친 시각의 차례를 본다: 지금 < 오픈 < 판매 종료(시작 24시간 전) < 시작 < 종료, 입장 시작 <= 시작.
  // 어기면 --apply가 422로 멈추기 전에 --check가 먼저 알린다
  let events = [];
  try {
    events = resolveSeedTimes(seed, now).events;
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  for (const e of events) {
    const raw = (field) => seed.events.find((x) => x.key === e.key)?.[field] ?? e[field];
    const open = Date.parse(e.openAt);
    const start = Date.parse(e.startAt);
    const end = Date.parse(e.endAt);
    const entry = e.entryOpensAt === undefined ? null : Date.parse(e.entryOpensAt);
    if (!(start < end)) problems.push(`회차 ${e.key}의 startAt(${raw('startAt')})이 endAt(${raw('endAt')})보다 늦거나 같다`);
    if (entry !== null && !(entry <= start)) problems.push(`회차 ${e.key}의 entryOpensAt(${raw('entryOpensAt')})이 startAt(${raw('startAt')})보다 늦다`);
    if (!(now.getTime() < open)) problems.push(`회차 ${e.key}의 openAt(${raw('openAt')})이 지난 시각이다: 오픈은 지금보다 미래여야 등록된다`);
    else if (!(open < start - SALE_END_BEFORE_START_MS)) problems.push(`회차 ${e.key}의 openAt(${raw('openAt')})이 판매 종료(시작 24시간 전)보다 늦다`);
  }
  const seatCounts = seatCountsOf(seed);
  return {
    ok: problems.length === 0,
    problems,
    counts: {
      accounts: seed.accounts.length,
      fans: seed.accounts.filter((a) => a.kind === 'fan').length,
      admins: seed.accounts.filter((a) => a.kind === 'admin').length,
      passkeys: (seed.adminPasskeys ?? []).length,
      promoters: (seed.promoters ?? []).length,
      productions: (seed.productions ?? []).length,
      events: (seed.events ?? []).length,
      seatMaps: (seed.seatMaps ?? []).length,
      seats: seatCounts.seats,
      wheelchairSeats: seatCounts.wheelchair,
      staff: (seed.staff ?? []).length,
      devices: (seed.staff ?? []).reduce((n, s) => n + (s.devices ?? []).length, 0),
    },
  };
}

/** 좌석맵 구역을 펼쳐 좌석·휠체어석 수를 센다(copyOf는 원본을 센다) */
export function seatCountsOf(seed) {
  let seats = 0;
  let wheelchair = 0;
  for (const map of seed.seatMaps) {
    // 복제(copyOf)는 원본 좌석을 다시 세지 않는다
    if (map.copyOf) continue;
    const base = map;
    for (const sec of base.sections ?? []) {
      seats += Number(sec.rows ?? 0) * Number(sec.seatsPerRow ?? 0);
      wheelchair += Number(sec.wheelchairSeats ?? 0);
    }
  }
  return { seats, wheelchair };
}

/** 시드의 좌석맵 하나를 API 본문으로 펼친다(구역·줄·번 범위 → 좌석 배열) */
export function expandSeatMap(seed, map) {
  const byKey = new Map(seed.seatMaps.map((s) => [s.key, s]));
  const base = map.copyOf ? byKey.get(map.copyOf) : map;
  if (!base?.sections) throw new Error(`좌석맵 ${map.key}의 원본(${map.copyOf})을 찾지 못했다`);
  const sections = [];
  let index = 0;
  for (const sec of base.sections) {
    const rows = Number(sec.rows ?? 0);
    const per = Number(sec.seatsPerRow ?? 0);
    const width = Math.min(400, per * 32);
    const startX = 250 + (sections.length % 2) * 500;
    const startY = 120 + Math.floor(sections.length / 2) * 380;
    const seats = [];
    for (let r = 0; r < rows; r += 1) {
      for (let n = 1; n <= per; n += 1) {
        seats.push({
          seatId: `${sec.code}-${r + 1}-${n}`,
          index: index++,
          row: `${sec.code}${r + 1}`,
          number: n,
          x: startX + (n - 1) * 32,
          y: startY + r * 26,
          tierId: sec.grade,
          ...(n <= Number(sec.wheelchairSeats ?? 0) && r === rows - 1 ? { wheelchair: true } : {}),
        });
      }
    }
    sections.push({
      sectionId: sec.code,
      name: sec.name ?? sec.code,
      level: String(sec.level ?? '1'),
      shape: { kind: 'RECT', points: [[startX - 8, startY - 8], [startX + width, startY - 8], [startX + width, startY + rows * 26], [startX - 8, startY + rows * 26]] },
      fillRule: { method: 'GRID', rows, seatsPerRow: per },
      tierId: sec.grade,
      ...(sec.gateZone ? { gateZone: sec.gateZone } : {}),
      label: { x: startX, y: startY - 20 },
      seatIndexRange: { from: index - seats.length, to: index - 1 },
      seats,
    });
  }
  return { canvas: canvasOf(base), sections };
}

/** 구역 배치가 캔버스를 넘지 않게 필요한 크기로 늘린다(구역은 두 열로 놓는다) */
function canvasOf(base) {
  const sections = base.sections ?? [];
  const columns = 2;
  const levels = Math.max(1, Math.ceil(sections.length / columns));
  const maxRows = Math.max(0, ...sections.map((s) => Number(s.rows ?? 0)));
  const width = Math.max(Number(base.canvas?.width ?? 1400), 250 + (columns - 1) * 500 + 400 + 50);
  const height = Math.max(Number(base.canvas?.height ?? 1000), 120 + (levels - 1) * 380 + maxRows * 26 + 20);
  return { width, height };
}

const kubeconfig = () => process.env.PEAKET_KUBECONFIG || join(DEFAULT_ROOT, `kubeconfig-${process.env.PEAKET_DEMO_CLUSTER || process.env.PEAKET_CLUSTER || DEMO_CLUSTER}`);
/** kubectl 한 번(전용 kubeconfig) */
async function kubectl(args, o = {}) {
  const k = await ensureTool('kubectl');
  return execFileSync(k, ['--kubeconfig', kubeconfig(), ...args], { encoding: 'utf8', stdio: o.input !== undefined ? ['pipe', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'], ...o });
}

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** 데모 PostgreSQL에 SQL 한 번(로컬 데모 전용 예외). 여러 행은 `|`로 잇고 한 줄에 하나씩 돌려준다 */
async function psql(db, statement) {
  const out = await kubectl(['-n', 'purchase', 'exec', 'deploy/demo-postgres', '--', 'psql', '-U', 'postgres', '-d', db, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', statement], { quiet: true });
  return String(out)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 부트스트랩 Job 하나를 지우고 다시 만든 뒤 끝날 때까지 본다 */
async function runBootstrapJob(o) {
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: 'core', labels: { 'app.kubernetes.io/part-of': 'peaket-demo' } },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': o.name, 'app.kubernetes.io/part-of': 'peaket-demo' } },
        spec: {
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [
            {
              name: 'bootstrap',
              image: o.image,
              imagePullPolicy: 'Never',
              command: ['node', 'scripts/seed-demo.mjs', '--apply'],
              env: [{ name: 'PEAKET_ENV', value: 'local' }, { name: 'PEAKET_DEMO_BOOTSTRAP_FILE', value: '/etc/peaket/bootstrap/bootstrap.json' }],
              envFrom: [{ secretRef: { name: o.secret } }],
              volumeMounts: [{ name: 'bootstrap', mountPath: '/etc/peaket/bootstrap', readOnly: true }],
              resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { memory: '512Mi' } },
              securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, runAsNonRoot: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } },
            },
          ],
          volumes: [{ name: 'bootstrap', secret: { secretName: 'demo-bootstrap' } }],
        },
      },
    },
  };
  await kubectl(['-n', 'core', 'delete', 'job', o.name, '--ignore-not-found', '--wait=true']);
  await kubectl(['-n', 'core', 'create', '-f', '-'], { input: JSON.stringify(job) });
  const until = Date.now() + 300_000;
  while (Date.now() < until) {
    const status = JSON.parse(await kubectl(['-n', 'core', 'get', 'job', o.name, '-o', 'json'], { quiet: true })).status ?? {};
    if (status.succeeded >= 1) return;
    if (status.failed >= 1) {
      let logs = '';
      try {
        logs = await kubectl(['-n', 'core', 'logs', `job/${o.name}`, '--tail=40'], { quiet: true });
      } catch {}
      throw new Error(`${o.name} 부트스트랩이 실패했다\n${logs}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${o.name} 부트스트랩이 300초 안에 끝나지 않았다`);
}

/** 데모 접속 정보(demo-auth와 같은 파일). 없으면 포트 기본값 */
function contract() {
  if (existsSync(DEMO_CONTRACT_FILE)) return JSON.parse(readFileSync(DEMO_CONTRACT_FILE, 'utf8'));
  return { hosts: DEMO_HOSTS, ports: DEMO_GATEWAY_PORTS };
}

const cookieHeader = (cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** API 한 번. 2xx가 아니면 상태·경로만 담아 실패한다(본문에 비밀이 있을 수 있어 그대로 싣지 않는다) */
async function api(o) {
  const res = await httpsJson(o);
  if (res.status < 200 || res.status >= 300) throw new Error(`${o.method} ${o.path} → ${res.status}`);
  return res.json;
}

/** 데모 공연장(place) 행을 직접 SQL로 보장한다(공연장을 만드는 공개 API가 없다, 로컬 데모 전용 예외) */
async function ensurePlaces(seed, promoterId) {
  const byName = new Map();
  const names = [...new Set(seed.productions.map((p) => p.placeName))];
  for (const name of names) {
    const prod = seed.productions.find((p) => p.placeName === name);
    const id = demoUuid(`place:${name}`);
    await psql(
      'peaket_demo_core',
      `insert into place (id, name, address, region, status, created_by) values (${sqlLiteral(id)}, ${sqlLiteral(name)}, ${sqlLiteral(prod.placeAddress)}, '서울', 'ACTIVE', ${sqlLiteral(promoterId)}) on conflict (id) do nothing`,
    );
    byName.set(name, id);
  }
  return byName;
}

/** 공연·회차를 SQL로 읽는다(파트너 목록·상세 API가 아직 없어 키를 찾는 읽기만 예외로 한다) */
async function readProductions(promoterId) {
  const rows = await psql('peaket_demo_core', `select id, title, sale_review from production where promoter_id = ${sqlLiteral(promoterId)}`);
  return rows.map((line) => {
    const [id, title, saleReview] = line.split('|');
    return { id, title, saleReview };
  });
}

/** 한 공연의 회차를 SQL로 읽는다(시작 시각 차례로 시드 회차와 잇는다) */
async function readEvents(productionId) {
  const rows = await psql('peaket_demo_core', `select id, extract(epoch from starts_at)::bigint from event where production_id = ${sqlLiteral(productionId)} order by starts_at, id`);
  return rows.map((line) => {
    const [id, epoch] = line.split('|');
    return { id, epoch: Number(epoch) };
  });
}

/**
 * 기존 회차 행과 시드 회차를 시작 시각 차례로 잇는다. 시드 시각이 상대 표기라 적용마다 펼친 값이 달라져
 * epoch로 찾을 수 없다(RV-01). 한 공연의 회차는 한 요청으로 모두 만들어지므로 개수와 차례가 같다
 * @param {Array<{ key: string, startAt: string }>} events 펼친 시드 회차
 * @param {Array<{ id: string, epoch: number }>} rows DB 회차
 * @returns {Array<[string, string]>} 시드 key → 회차 ID(모자라면 있는 것만)
 */
export function matchSeedEvents(events, rows) {
  const wanted = [...events].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
  const ordered = [...rows].sort((a, b) => a.epoch - b.epoch);
  return wanted.flatMap((e, i) => (ordered[i] ? [[e.key, ordered[i].id]] : []));
}

/** 공연에 배치본(좌석맵)이 이미 있는지(회차의 venue_id가 채워졌는지) */
async function hasLayout(productionId) {
  const rows = await psql('peaket_demo_core', `select 1 from event where production_id = ${sqlLiteral(productionId)} and venue_id is not null limit 1`);
  return rows.length > 0;
}

/** 계정 ID를 이메일로 읽는다(identity DB, 읽기만) */
async function readAccountIds(emails) {
  if (emails.length === 0) return new Map();
  const rows = await psql('peaket_demo_identity', `select id, email from account where email in (${emails.map(sqlLiteral).join(', ')})`);
  return new Map(rows.map((line) => {
    const [id, email] = line.split('|');
    return [email, id];
  }));
}

/** 스태프 배정을 직접 SQL로 넣는다(파트너 초대 API가 없다, 로컬 데모 전용 예외). 이미 있으면 0 */
async function insertStaffAssignment(o) {
  const exists = await psql('peaket_demo_identity', `select 1 from staff_assignment where event_id = ${sqlLiteral(o.eventId)} and account_id = ${sqlLiteral(o.accountId)} limit 1`);
  if (exists.length) return 0;
  await psql(
    'peaket_demo_identity',
    `insert into staff_assignment (id, account_id, event_id, promoter_id, role, invite_email, invite_token_hash, invite_expires_at, invited_by, valid_from, valid_until, status, accepted_at, consent_version)
     values (${sqlLiteral(demoUuid(`staff:${o.eventId}:${o.accountId}`))}, ${sqlLiteral(o.accountId)}, ${sqlLiteral(o.eventId)}, ${sqlLiteral(o.promoterId)}, ${sqlLiteral(o.role)}, null, null, now() + interval '365 days', ${sqlLiteral(o.invitedBy)}, now(), now() + interval '365 days', 'ASSIGNED', now(), 'demo-v1')
     on conflict (event_id, account_id) do nothing`,
  );
  return 1;
}

/**
 * 부트스트랩 → 기본 시드 적용. 실패는 단계 이름과 함께 던진다.
 * @param {{ seedFile?: string }} [o]
 */
export async function applySeed(o = {}) {
  const seedFile = o.seedFile ?? DEMO_SEED_FILE;
  // 검사와 적용이 같은 시계를 쓴다(상대 표기를 두 번 펼쳐 값이 어긋나지 않게)
  const now = new Date();
  const checked = checkSeed(seedFile, now);
  if (!checked.ok) throw new Error(`시드 검사에 실패했다: ${checked.problems.join('; ')}`);
  const { bootstrap } = prepareDemoSecrets({ seedFile });
  const seed = resolveSeedTimes(readSeed(seedFile), now);
  const c = contract();
  // core 부트스트랩(첫 promoter)만 슈퍼유저 주소를 쓴다. 실행 파드는 demo-core의 역할 주소만 받는다(RV-03)
  await runBootstrapJob({ name: 'demo-bootstrap-core', image: 'peaket/core-svc:demo', secret: 'demo-bootstrap-core' });
  await runBootstrapJob({ name: 'demo-bootstrap-identity', image: 'peaket/identity-svc:demo', secret: 'demo-identity' });

  // 팬 계정: gRPC CreateSession → 가입 마무리(이미 마무리했으면 409·422를 넘긴다)
  const fanSessions = {};
  for (const a of seed.accounts.filter((x) => x.kind === 'fan')) {
    const s = await demoAuth('fan', a.key);
    fanSessions[a.key] = s;
    const done = await httpsJson({
      host: c.hosts.api,
      port: c.ports.api,
      method: 'POST',
      path: '/v1/identity/signup-completions',
      headers: { cookie: cookieHeader(s.cookies), origin: demoOrigins()['www'] },
      body: { ageOver14: true, consents: { terms: true, privacy: true, marketing: false, phone: false }, nickname: a.nickname ?? a.key },
    });
    if (![200, 201, 204, 409, 422].includes(done.status)) throw new Error(`팬 ${a.key} 가입 마무리 → ${done.status}`);
  }

  // 파트너·관제 관리자 로그인
  const promoterId = bootstrap.promoters[0]?.id ?? null;
  const partner = await demoAuth('admin', 'stella-admin');
  const partnerHeaders = { cookie: cookieHeader(partner.cookies), origin: demoOrigins().partner, 'sec-fetch-site': 'same-origin' };
  const ops = await demoAuth('admin', 'sujin');
  const opsHeaders = { cookie: cookieHeader(ops.cookies), origin: demoOrigins().console, 'sec-fetch-site': 'same-origin' };

  const counts = { productions: 0, events: 0, seatMaps: 0, staff: 0, devices: 0 };
  const places = await ensurePlaces(seed, promoterId);
  const known = new Map((await readProductions(promoterId)).map((p) => [p.title, p]));
  const eventIds = {};
  for (const prod of seed.productions) {
    const events = seed.events.filter((e) => e.productionKey === prod.key);
    let row = known.get(prod.title);
    if (!row) {
      const created = await api({
        host: c.hosts['partner-api'],
        port: c.ports['partner-api'],
        method: 'POST',
        path: '/v1/partner/productions',
        headers: { ...partnerHeaders, 'idempotency-key': demoUuid(`create-production:${prod.key}`) },
        body: {
          title: prod.title,
          genre: prod.genre,
          ageRating: prod.ageRating,
          runningMinutes: prod.runningMinutes,
          placeId: places.get(prod.placeName),
          artists: [],
          aliases: prod.aliases ?? [],
          events: events.map((e) => ({
            openAt: e.openAt,
            startsAt: e.startAt,
            endsAt: e.endAt,
            entryOpensAt: e.entryOpensAt,
            lobbyMinutes: e.lobbyMinutes ?? 10,
            perPersonLimit: e.perPersonLimit ?? 4,
            seatAssignment: e.seatAssignment ?? 'PICK',
            reentryAllowed: e.reentryAllowed ?? false,
          })),
        },
      });
      counts.productions += 1;
      counts.events += created.eventIds.length;
      events.forEach((e, i) => (eventIds[e.key] = created.eventIds[i]));
      known.set(prod.title, { id: created.productionId, title: prod.title, saleReview: 'DRAFT' });
    } else {
      const rows = await readEvents(row.id);
      for (const [key, id] of matchSeedEvents(events, rows)) eventIds[key] = id;
    }
  }

  // 좌석맵: 아직 배치본이 없는 공연에만 한 번 PUT한다(같은 공연의 회차는 같은 배치본, ADR-0093).
  // 두 번째 적용에서는 venue가 이미 있어 다시 쓰지 않는다. 중간에 실패해 다시 돌아도 빠진 공연만 채운다
  for (const prod of seed.productions) {
    const productionId = known.get(prod.title)?.id;
    if (!productionId) continue;
    if (await hasLayout(productionId)) continue;
    const map = seed.seatMaps.find((m) => seed.events.find((e) => e.key === m.eventKey)?.productionKey === prod.key);
    if (!map) continue;
    const layout = expandSeatMap(seed, map);
    const prices = seed.events.find((e) => e.key === map.eventKey)?.prices ?? {};
    // 좌석 등급(구역 tierId)은 모두 가격 등급에 있어야 한다. 회차 가격에 없는 등급은 그 회차의 가장 싼 값으로 채운다
    const cheapest = Math.min(...Object.values(prices).map(Number));
    const gradePrices = [...new Set(layout.sections.map((s) => s.tierId).filter(Boolean))].map((tierId) => ({ tierId, name: tierId, price: Number(prices[tierId] ?? cheapest) }));
    await api({
      host: c.hosts['partner-api'],
      port: c.ports['partner-api'],
      method: 'PUT',
      path: `/v1/partner/productions/${productionId}/seatmap`,
      headers: { ...partnerHeaders, 'if-match': '"0"' },
      body: {
        layoutVersion: 0,
        canvas: layout.canvas,
        priceTiers: gradePrices,
        sections: layout.sections,
      },
    });
    counts.seatMaps += 1;
  }

  // 스태프 배정(파트너 초대 API가 없어 직접 SQL, 로컬 데모 전용 예외)
  const staffEmails = [...new Set(seed.staff.map((s) => seed.accounts.find((a) => a.key === s.accountKey)?.email).filter(Boolean))];
  const accountIds = await readAccountIds(staffEmails);
  const invitedBy = demoUuid('admin:sujin');
  for (const s of seed.staff) {
    const eventId = eventIds[s.eventKey];
    if (!eventId) continue;
    const accountId = accountIds.get(seed.accounts.find((a) => a.key === s.accountKey)?.email);
    if (!accountId) throw new Error(`스태프 ${s.key}의 계정을 identity DB에서 찾지 못했다`);
    counts.staff += await insertStaffAssignment({ eventId, accountId, role: s.role, promoterId, invitedBy });
  }

  // 판매 승인: 공연마다 파트너 판매 심사 제출(BAT-616) → 관제 승인. 이미 승인된 공연은 건너뛴다.
  // 기기 배치는 core의 회차 판매 설정(sale-config)을 읽으므로 승인 뒤에 한다
  const promoter = seed.promoters[0];
  const approvedRows = new Map((await readProductions(promoterId)).map((p) => [p.id, p.saleReview]));
  for (const prod of seed.productions) {
    const row = known.get(prod.title);
    if (!row) continue;
    const productionId = row.id;
    if (approvedRows.get(productionId) === 'APPROVED') continue;
    const submitted = await httpsJson({
      host: c.hosts['partner-api'],
      port: c.ports['partner-api'],
      method: 'POST',
      path: `/v1/partner/productions/${productionId}/sale-review`,
      headers: partnerHeaders,
      body: {
        seller: { legalName: promoter.legalName, representative: '예시 대표', address: '서울특별시 예시구 예시로 1', phone: '02-0000-0000', email: 'stella@example.test', businessRegNo: '000-00-00000', mailOrderReportNo: '제0000-예시호' },
        payoutAccount: { bankCode: '000', accountNumber: '000000000000', holderName: promoter.legalName },
        accessibleSeating: { confirmed: true },
      },
    });
    if (submitted.status === 404) {
      // BAT-616(파트너 판매 심사 제출)이 아직 develop에 없을 때만 도는 로컬 데모 예외다.
      // 공개 경로가 생기면 이 갈래는 쓰이지 않는다(계획 '고침' 절). 감사 기록·판매자 사본은 남지 않는다(한계)
      console.error(`알림: ${productionId} 판매 심사 제출 경로가 없다(BAT-616 미병합). 로컬 데모 예외로 sale_review만 SUBMITTED로 바꾼다`);
      await psql('peaket_demo_core', `update production set sale_review = 'SUBMITTED' where id = ${sqlLiteral(productionId)} and sale_review in ('DRAFT', 'REJECTED')`);
    } else if (![200, 202, 409].includes(submitted.status)) {
      throw new Error(`판매 심사 제출 ${productionId} → ${submitted.status}(BAT-616 파트너 판매 심사 경로가 필요하다)`);
    }
    const scale = seed.events.filter((e) => e.productionKey === prod.key).map((e) => ({ eventId: eventIds[e.key], scale: 'SMALL' })).filter((x) => x.eventId);
    if (scale.length) {
      await api({
        host: c.hosts['ops-api'],
        port: c.ports['ops-api'],
        method: 'POST',
        path: `/v1/ops/sale-reviews/${productionId}/approvals`,
        headers: opsHeaders,
        body: { scales: scale, placeId: places.get(prod.placeName) },
      });
    }
  }

  // 기기(관제) → 배치(파트너)
  const devices = await api({ host: c.hosts['ops-api'], port: c.ports['ops-api'], method: 'GET', path: '/v1/ops/scanner-devices', headers: opsHeaders });
  const deviceByName = new Map((devices.items ?? devices.devices ?? []).map((d) => [d.name, d.deviceId ?? d.id]));
  for (const s of seed.staff) {
    const eventId = eventIds[s.eventKey];
    if (!eventId) continue;
    for (const d of s.devices ?? []) {
      let deviceId = deviceByName.get(d.name);
      if (!deviceId) {
        const created = await api({ host: c.hosts['ops-api'], port: c.ports['ops-api'], method: 'POST', path: '/v1/ops/scanner-devices', headers: opsHeaders, body: { name: d.name, promoterId } });
        deviceId = created.deviceId ?? created.id;
        deviceByName.set(d.name, deviceId);
        counts.devices += 1;
      }
      // If-Match는 새 배치에 "0"이다. 이미 배치된 기기면 412(판이 다름)를 받는데, 데모 시드는 배치를 바꾸지 않으므로 넘긴다
      const placed = await httpsJson({
        host: c.hosts['partner-api'],
        port: c.ports['partner-api'],
        method: 'PUT',
        path: `/v1/partner/events/${eventId}/device-placements/${deviceId}`,
        headers: { ...partnerHeaders, 'if-match': '"0"' },
        body: { gateZone: d.booth, mode: 'IN' },
      });
      if (![200, 412].includes(placed.status)) throw new Error(`기기 배치 ${d.name} → ${placed.status}`);
    }
  }

  const total = {
    accounts: seed.accounts.length,
    passkeys: (seed.adminPasskeys ?? []).length,
    promoters: (seed.promoters ?? []).length,
    productions: seed.productions.length,
    events: seed.events.length,
    seatMaps: seed.seatMaps.length,
    staff: seed.staff.length,
    devices: seed.staff.reduce((n, s) => n + (s.devices ?? []).length, 0),
  };
  return { ok: true, counts, total, eventIds: Object.keys(eventIds).length, fanSessions: Object.keys(fanSessions).length, seed: seedFile.replaceAll('\\', '/') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const apply = argv.includes('--apply');
  const check = argv.includes('--check') || !apply;
  const unknown = argv.filter((a) => !['--check', '--apply', '--json'].includes(a));
  if (unknown.length) {
    console.error(`demo-seed의 모르는 인자: ${unknown.join(', ')}(쓰는 법: --check|--apply [--json])`);
    process.exit(2);
  }
  if (check) {
    const result = checkSeed();
    if (json) console.log(JSON.stringify(result, null, 2));
    else if (result.ok) console.log(`시드가 맞다: ${JSON.stringify(result.counts)}`);
    else console.error(result.problems.join('\n'));
    if (!result.ok) process.exit(1);
    if (!apply) process.exit(0);
  }
  try {
    const result = await applySeed();
    console.log(json ? JSON.stringify(result, null, 2) : `시드를 적용했다: ${JSON.stringify(result.counts)}`);
    process.exit(0);
  } catch (e) {
    console.error(`시드 적용 실패: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
