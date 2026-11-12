// 브라우저 확인용 로컬 파트너 스택(BUILD_ORDER HOT-220, ADR-0264 결정 14, docs/review/plans/BAT-150.md §3.6). 평소에는 돌지 않는다.
// PEAKET_LOCAL_STACK=1이면 실제 PostgreSQL 18 컨테이너(lane2-pg-seatmap)·마이그레이션·실제 core-svc HTTP 앱(시험 조립, FakeIdentity가 관리 역할)·
// 운영 실행 명령의 seatmap-worker 프로세스·로컬 폴더 팬 파일 저장소와 파트너 게이트웨이 대역을 띄우고 멈출 때까지 둔다.
// 게이트웨이 대역: 파트너 콘솔 출처의 요청만 받아(CORS, 자격 증명 허용) /v1/partner/ 경로를 core-svc로 넘기고, 쿠키 local_as=admin|member로
// 시험 계정 둘(같은 테넌트의 파트너 관리자·실무자)의 내부 신원 머리를 단다. 보낸 신원 머리는 버린다. 운영 빌드에 들지 않는다(시험 폴더).
//   PEAKET_LOCAL_STACK=1 node node_modules/vitest/vitest.mjs run --config vitest.integration.config.mjs test-int/local-partner-stack.int.test.ts
// 환경 값(모두 선택): PEAKET_LOCAL_GW_PORT(4321) PEAKET_LOCAL_CORE_PORT(4320) PEAKET_LOCAL_PARTNER_ORIGIN(http://127.0.0.1:3001)
//   PEAKET_LOCAL_STOP(이 파일이 생기면 멈춘다, 기본 <tmp>/peaket-lane2-local-partner-stack.stop) PEAKET_LOCAL_INFO(띄운 주소·공연 ID·대역 열쇠를 적는 파일)
// 멈추기: 멈춤 파일을 만들거나 정보 파일의 stop 주소(?key= 포함)를 연다. 컨테이너·팬 파일 폴더·정보 파일은 멈출 때 지운다(docker rm -f -v).
// 같은 이름의 컨테이너가 남아 있으면 띄우기 전에 지운다(앞선 실행이 강제로 끝났을 때).
import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { GrpcSeatmapParser, LocalFolderPublicFileStore } from '../src/modules/catalog/index.js';
import { FakeIdentity, testMedia } from '../test/support.js';
import { StaticTemplateCatalog } from '../src/modules/catalog/index.js';
import { seedSeatmapTemplates } from '../src/seed/seatmap-templates.js';
import { gatewayHandler } from './local-gateway.js';
import { SERVICE_DIR, startWorker } from './media-support.js';
import { startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const GW_PORT = Number(process.env.PEAKET_LOCAL_GW_PORT ?? 4321);
const CORE_PORT = Number(process.env.PEAKET_LOCAL_CORE_PORT ?? 4320);
const PARTNER_ORIGIN = process.env.PEAKET_LOCAL_PARTNER_ORIGIN ?? 'http://127.0.0.1:3001';
// 갈래마다 다른 이름(다른 작업 폴더의 스택과 파일이 섞이지 않게)
const STOP = process.env.PEAKET_LOCAL_STOP ?? join(tmpdir(), 'peaket-lane2-local-partner-stack.stop');
const INFO = process.env.PEAKET_LOCAL_INFO ?? join(tmpdir(), 'peaket-lane2-local-partner-stack.json');
const CONTAINER = 'lane2-pg-seatmap';

/** 시드 공연(브라우저 확인 대본 P1~P5) */
const TENANT_A = '7a1d0000-0000-4000-8000-00000000000a';
const TENANT_B = '7a1d0000-0000-4000-8000-00000000000b';
const P = {
  P1: '0b8f1f2e-4a1d-4c1e-9b5a-000000000001',
  P2: '0b8f1f2e-4a1d-4c1e-9b5a-000000000002',
  P3: '0b8f1f2e-4a1d-4c1e-9b5a-000000000003',
  P4: '0b8f1f2e-4a1d-4c1e-9b5a-000000000004',
  P5: '0b8f1f2e-4a1d-4c1e-9b5a-000000000005',
} as const;

describe.runIf(process.env.PEAKET_LOCAL_STACK === '1')('로컬 파트너 스택', () => {
  test('파트너 콘솔이 붙을 수 있게 띄워 둔다', async () => {
    if (existsSync(STOP)) await rm(STOP);
    try {
      execFileSync('docker', ['rm', '-f', '-v', CONTAINER], { stdio: 'ignore' });
    } catch {
      // 남은 컨테이너가 없다
    }
    const pg = await startPostgres({ name: CONTAINER });
    let admin: Database | undefined;
    let appDb: Database | undefined;
    let partnerDb: Database | undefined;
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let parser: GrpcSeatmapParser | undefined;
    let svc: Awaited<ReturnType<typeof createService>> | undefined;
    let gw: Server | undefined;
    const files = join(tmpdir(), 'peaket-lane2-local-partner-files');
    try {
      await migrateCore(pg.url);
      admin = createDatabase({ url: pg.url, applicationName: 'local-stack', max: 4 });
      await ensureOutboxPartitions(admin, systemClock);
      const templates = StaticTemplateCatalog.load(join(SERVICE_DIR, 'seed', 'seatmap-templates'));
      await seedSeatmapTemplates(admin, templates);
      appDb = await loginFor(admin, pg, 'core_app_login', 'core_app', 4);
      partnerDb = await loginFor(admin, pg, 'core_partner_login', 'core_partner', 6);
      worker = await startWorker();
      parser = new GrpcSeatmapParser(worker.address);
      await rm(files, { recursive: true, force: true });
      await mkdir(files, { recursive: true });
      const identity = new FakeIdentity();
      svc = await createService({
        name: 'core-svc',
        module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia({ seatmap: parser, publicFiles: new LocalFolderPublicFileStore(files), templates }) }),
        env: { PEAKET_ENV: 'local', PEAKET_LOG_LEVEL: 'info' },
        clock: systemClock,
        adminAuthz: identity,
      });

      // ---------- 시드 ----------
      const place0 = '7a1d0000-0000-4000-8000-0000000000f1';
      await admin.db.insert(promoter).values([
        { id: TENANT_A, legalName: '(주)피켓 시험 파트너' },
        { id: TENANT_B, legalName: '(주)다른 파트너' },
      ]);
      await admin.db.insert(place).values({ id: place0, name: '피켓 아레나', address: '서울 어딘가 1', region: '서울', createdBy: TENANT_A });
      const now = Date.now();
      const future = new Date(now + 30 * 86_400_000);
      const prod = (id: string, tenant: string, title: string) => ({ id, promoterId: tenant, placeId: place0, title, genre: '콘서트' });
      await admin.db.insert(production).values([prod(P.P1, TENANT_A, 'P1 배치본 없음'), prod(P.P2, TENANT_A, 'P2 배치본 있음'), prod(P.P3, TENANT_A, 'P3 승인·오픈 전'), prod(P.P4, TENANT_A, 'P4 승인·오픈함'), prod(P.P5, TENANT_B, 'P5 다른 파트너')]);
      const ev = (id: string, productionId: string, tenant: string, day: number, openAt = future) => ({ id, productionId, promoterId: tenant, openAt, startsAt: new Date(now + day * 86_400_000), endsAt: new Date(now + day * 86_400_000 + 7_200_000) });
      const e = (n: number) => `0b8f1f2e-4a1d-4c1e-9b5a-0000000e${String(n).padStart(4, '0')}`;
      await admin.db.insert(event).values([ev(e(11), P.P1, TENANT_A, 40), ev(e(12), P.P1, TENANT_A, 41), ev(e(21), P.P2, TENANT_A, 40), ev(e(31), P.P3, TENANT_A, 40), ev(e(41), P.P4, TENANT_A, 40), ev(e(42), P.P4, TENANT_A, 41), ev(e(51), P.P5, TENANT_B, 40)]);
      const adminH = identity.partner(TENANT_A, 'partner_admin');
      const memberH = identity.partner(TENANT_A, 'partner_member');
      const otherH = identity.partner(TENANT_B, 'partner_admin');
      const body = await readFile(join(SERVICE_DIR, 'test-int', 'fixtures', 'seatmap-editor', 'save-body.json'), 'utf8');
      for (const id of [P.P2, P.P3, P.P4]) {
        const r = await svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${id}/seatmap`, headers: { ...adminH, 'content-type': 'application/json', 'if-match': '"0"' }, payload: body });
        expect(r.statusCode).toBe(200);
      }
      const r5 = await svc.http.inject({ method: 'PUT', url: `/v1/partner/productions/${P.P5}/seatmap`, headers: { ...otherH, 'content-type': 'application/json', 'if-match': '"0"' }, payload: body });
      expect(r5.statusCode).toBe(200);
      // P3·P4는 승인 이력, P4는 회차 하나가 오픈함(1시간 전)
      for (const id of [P.P3, P.P4]) await admin.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date(now - 86_400_000) }).where(eq(production.id, id));
      await admin.db.update(event).set({ openAt: new Date(now - 3_600_000) }).where(eq(event.id, e(41)));

      await svc.http.listen({ host: '127.0.0.1', port: CORE_PORT });

      // ---------- 게이트웨이 대역(test-int/local-gateway.ts) ----------
      // 대역 조작 열쇠는 띄울 때마다 새로 만들어 정보 파일에만 적는다(같은 PC의 다른 쪽이 계정을 바꾸거나 멈추지 못하게)
      const key = randomBytes(18).toString('base64url');
      let stopRequested = false;
      const handler = gatewayHandler({
        partnerOrigin: PARTNER_ORIGIN,
        upstream: `http://127.0.0.1:${CORE_PORT}`,
        identity: { admin: adminH, member: memberH },
        key,
        onStop: () => {
          stopRequested = true;
        },
        listFiles: async () => {
          const out: string[] = [];
          const walk = async (d: string) => {
            for (const n of await readdir(d, { withFileTypes: true })) {
              const p = join(d, n.name);
              if (n.isDirectory()) await walk(p);
              else out.push(relative(files, p).replaceAll('\\', '/'));
            }
          };
          await walk(files);
          return out.sort();
        },
      });
      gw = createServer((req, res) => void handler(req, res));
      // 자리가 이미 쓰이면(다른 스택이 떠 있으면) 기다리지 않고 실패한다
      await new Promise<void>((f, reject) => {
        gw!.once('error', reject);
        gw!.listen(GW_PORT, '127.0.0.1', () => {
          gw!.off('error', reject);
          f();
        });
      });
      const q = `key=${key}`;
      const info = {
        gateway: `http://127.0.0.1:${GW_PORT}`,
        partnerOrigin: PARTNER_ORIGIN,
        build: `NEXT_PUBLIC_PARTNER_API_ORIGIN=http://127.0.0.1:${GW_PORT}`,
        productions: Object.fromEntries(Object.entries(P).map(([k, id]) => [k, `${PARTNER_ORIGIN}/events/${id}/seatmap`])),
        switchToMember: `http://127.0.0.1:${GW_PORT}/__local/as?role=member&${q}`,
        switchToAdmin: `http://127.0.0.1:${GW_PORT}/__local/as?role=admin&${q}`,
        files: `http://127.0.0.1:${GW_PORT}/__local/files?${q}`,
        filesDir: files,
        stop: `http://127.0.0.1:${GW_PORT}/__local/stop?${q}`,
        stopFile: STOP,
        container: CONTAINER,
      };
      await writeFile(INFO, `${JSON.stringify(info, null, 2)}\n`);
      console.log(`로컬 파트너 스택이 떴다(주소·열쇠는 ${INFO})`);
      while (!stopRequested && !existsSync(STOP)) await new Promise((f) => setTimeout(f, 500));
    } finally {
      if (gw?.listening) await new Promise<void>((f) => gw!.close(() => f()));
      await svc?.close();
      parser?.close();
      await worker?.stop();
      await appDb?.close();
      await partnerDb?.close();
      await admin?.close();
      pg.stop();
      await rm(files, { recursive: true, force: true });
      await rm(INFO, { force: true });
      await rm(STOP, { force: true });
    }
  }, 12 * 3_600_000);
});
