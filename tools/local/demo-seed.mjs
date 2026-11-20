// BAT-087 기본 합성 시드 적용기(docs/review/plans/BAT-087.md §5·§6 G5).
// - `--check`: 시드 파일의 참조·비밀 없음·개수 계약을 본다(클러스터 없이, DS-05)
// - `--apply`: ① 첫 관리자·패스키·promoter 부트스트랩 Job 둘 ② 공개·관리 API로 공연·회차·좌석맵·스태프·기기·판매 승인
//   ③ 개수를 다시 읽어 `--json`으로 낸다. 공연·좌석을 DB에 직접 넣지 않는다(감사·Outbox가 없어지지 않게)
// - 두 번 적용해도 계정·공연·회차·promoter·스태프·기기 수가 같다(키·제목·이메일·이름으로 찾아 없을 때만 만든다)
// - 비밀·개인정보는 출력하지 않는다. 실패하면 exit 1이고 어느 단계가 실패했는지만 낸다
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_CLUSTER, DEMO_GATEWAY_PORTS, DEMO_HOSTS, demoOrigins } from './demo-objects.mjs';
import { demoAuth, httpsJson, prepareDemoSecrets, readSeed, DEMO_CONTRACT_FILE, DEMO_SEED_FILE } from './demo-auth.mjs';
import { DEFAULT_ROOT, ensureTool } from './tools.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 시드 파일 하나를 읽고 검사한다. password·totp·privateKey 같은 값 칸이 있으면 실패(DS-05) */
export function checkSeed(file = DEMO_SEED_FILE) {
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
  return { canvas: base.canvas ?? { width: 1400, height: 1000 }, sections };
}

const kubeconfig = () => process.env.PEAKET_KUBECONFIG || join(DEFAULT_ROOT, `kubeconfig-${process.env.PEAKET_DEMO_CLUSTER || DEMO_CLUSTER}`);
/** kubectl 한 번(전용 kubeconfig) */
async function kubectl(args, o = {}) {
  const k = await ensureTool('kubectl');
  return execFileSync(k, ['--kubeconfig', kubeconfig(), ...args], { encoding: 'utf8', stdio: o.input !== undefined ? ['pipe', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe'], ...o });
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

/**
 * 부트스트랩 → 기본 시드 적용. 실패는 단계 이름과 함께 던진다.
 * @param {{ seedFile?: string }} [o]
 */
export async function applySeed(o = {}) {
  const seedFile = o.seedFile ?? DEMO_SEED_FILE;
  const { bootstrap } = prepareDemoSecrets({ seedFile });
  const seed = readSeed(seedFile);
  const c = contract();
  await runBootstrapJob({ name: 'demo-bootstrap-core', image: 'peaket/core-svc:demo', secret: 'demo-core' });
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
      headers: { cookie: cookieHeader(s.cookies), origin: demoOrigins()[ 'www' ] },
      body: { ageOver14: true, consents: { terms: true, privacy: true, marketing: false, phone: false }, nickname: a.nickname ?? a.key },
    });
    if (![200, 201, 204, 409, 422].includes(done.status)) throw new Error(`팬 ${a.key} 가입 마무리 → ${done.status}`);
  }

  // 파트너 관리자 로그인
  const partner = await demoAuth('admin', 'stella-admin');
  const partnerHeaders = { cookie: cookieHeader(partner.cookies), origin: demoOrigins().partner, 'sec-fetch-site': 'same-origin' };
  const ops = await demoAuth('admin', 'sujin');
  const opsHeaders = { cookie: cookieHeader(ops.cookies), origin: demoOrigins().console, 'sec-fetch-site': 'same-origin' };

  const counts = { productions: 0, events: 0, seatMaps: 0, staff: 0, devices: 0 };
  const existing = await api({ host: c.hosts['partner-api'], port: c.ports['partner-api'], method: 'GET', path: '/v1/partner/productions?limit=100', headers: partnerHeaders });
  const byTitle = new Map((existing.items ?? []).map((p) => [p.title, p.productionId]));
  const promoterId = bootstrap.promoters[0]?.id ?? null;
  const eventIds = {};
  for (const prod of seed.productions) {
    let productionId = byTitle.get(prod.title);
    if (!productionId) {
      const events = seed.events.filter((e) => e.productionKey === prod.key);
      const created = await api({
        host: c.hosts['partner-api'],
        port: c.ports['partner-api'],
        method: 'POST',
        path: '/v1/partner/productions',
        headers: partnerHeaders,
        body: {
          title: prod.title,
          genre: prod.genre,
          ageRating: prod.ageRating,
          runningMinutes: prod.runningMinutes,
          newPlace: { name: prod.placeName, address: prod.placeAddress },
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
      productionId = created.productionId;
      events.forEach((e, i) => (eventIds[e.key] = created.eventIds[i]));
      byTitle.set(prod.title, productionId);
      counts.productions += 1;
      counts.events += created.eventIds.length;
    } else {
      const detail = await api({ host: c.hosts['partner-api'], port: c.ports['partner-api'], method: 'GET', path: `/v1/partner/productions/${productionId}`, headers: partnerHeaders });
      for (const e of detail.events ?? []) eventIds[e.eventId ?? e.id] = e.eventId ?? e.id;
      // 상세의 회차는 시작 시각으로 시드와 잇는다
      for (const e of seed.events.filter((x) => x.productionKey === prod.key)) {
        const hit = (detail.events ?? []).find((x) => x.startsAt === e.startAt);
        if (hit) eventIds[e.key] = hit.eventId ?? hit.id;
      }
    }
    // 좌석맵: 시드의 좌석맵을 API 모양으로 펼쳐 PUT(같은 내용을 다시 써도 같다)
    const maps = seed.seatMaps.filter((m) => seed.events.find((e) => e.key === m.eventKey)?.productionKey === prod.key);
    for (const map of maps) {
      const layout = expandSeatMap(seed, map);
      const detail = await api({ host: c.hosts['partner-api'], port: c.ports['partner-api'], method: 'GET', path: `/v1/partner/productions/${productionId}`, headers: partnerHeaders });
      const prices = seed.events.find((e) => e.key === map.eventKey)?.prices ?? {};
      await api({
        host: c.hosts['partner-api'],
        port: c.ports['partner-api'],
        method: 'PUT',
        path: `/v1/partner/productions/${productionId}/seatmap`,
        headers: partnerHeaders,
        body: {
          layoutVersion: detail.version ?? 0,
          canvas: layout.canvas,
          priceTiers: Object.entries(prices).map(([tierId, price]) => ({ tierId, name: tierId, price })),
          sections: layout.sections,
        },
      });
      counts.seatMaps += 1;
    }
  }
  // 남은 좌석맵(복제)은 같은 공연 배치라 새로 쓰지 않는다. 회차별 다른 배치는 뒤 단계에서 나눈다

  // 스태프 초대(이메일로 찾아 없을 때만) — 이벤트별
  for (const s of seed.staff) {
    const eventId = eventIds[s.eventKey];
    if (!eventId) continue;
    const account = seed.accounts.find((a) => a.key === s.accountKey);
    const staff = await api({ host: c.hosts['partner-api'], port: c.ports['partner-api'], method: 'GET', path: `/v1/partner/events/${eventId}/staff`, headers: partnerHeaders });
    const known = new Set((staff.items ?? staff.staff ?? []).map((x) => x.email));
    if (!known.has(account.email)) {
      await api({
        host: c.hosts['partner-api'],
        port: c.ports['partner-api'],
        method: 'POST',
        path: `/v1/partner/events/${eventId}/staff-invitations`,
        headers: partnerHeaders,
        body: { invitations: [{ email: account.email, role: s.role }] },
      });
      counts.staff += 1;
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
      await api({
        host: c.hosts['partner-api'],
        port: c.ports['partner-api'],
        method: 'PUT',
        path: `/v1/partner/events/${eventId}/device-placements/${deviceId}`,
        headers: partnerHeaders,
        body: { gateZone: d.booth, mode: 'IN' },
      });
    }
  }

  // 판매 승인: 공연마다 판매 심사 제출 → 관제 승인(값은 시드의 가상 사업자 정보)
  const promoter = seed.promoters[0];
  for (const prod of seed.productions) {
    const productionId = byTitle.get(prod.title);
    if (!productionId) continue;
    const detail = await api({ host: c.hosts['partner-api'], port: c.ports['partner-api'], method: 'GET', path: `/v1/partner/productions/${productionId}`, headers: partnerHeaders });
    if (detail.saleReview?.status === 'APPROVED' || detail.saleApprovedAt) continue;
    await httpsJson({
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
    const scale = (detail.events ?? []).map((e) => ({ eventId: e.eventId ?? e.id, scale: 'SMALL' }));
    const placeId = detail.place?.placeId ?? detail.place?.id;
    const artistIds = (detail.artists ?? []).map((a) => a.artistId ?? a.id).filter(Boolean);
    if (placeId && scale.length) {
      await httpsJson({
        host: c.hosts['ops-api'],
        port: c.ports['ops-api'],
        method: 'POST',
        path: `/v1/ops/sale-reviews/${productionId}/approvals`,
        headers: opsHeaders,
        body: { scales: scale, placeId, artistIds },
      });
    }
  }

  return { ok: true, counts, eventIds: Object.keys(eventIds).length, fanSessions: Object.keys(fanSessions).length, seed: seedFile.replaceAll('\\', '/') };
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
