// 웹 푸시 전용 서비스 워커 경로 `/push/sw.js`(범위 `/push/`, docs/frontend.md §5.4 '웹 푸시를 받는 서비스 워커는 따로 둔다', ADR-0363 결정 7, FE-T48).
// 스크립트를 범위 맨 위에 두어 `Service-Worker-Allowed`가 필요 없다. 워커 스크립트는 캐시하지 않는다(`no-cache`, 요청 때 낸다).
// 파일은 빌드 때 scripts/service-worker.mjs가 <distDir>/serwist/push-sw.js로 묶어 둔다. 라우트 그룹 밖이라 HTML 셸·CSP 처리를 받지 않는다.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheLife } from 'next/cache';
import { connection } from 'next/server';
import { PUSH_SW_FILE, SW_DIR } from '../../../scripts/service-worker.mjs';

async function readPushWorker(): Promise<string> {
  'use cache';
  cacheLife('max');
  return readFile(join(/* turbopackIgnore: true */ process.cwd(), process.env.PEAKET_NEXT_DIST ?? '.next', SW_DIR, PUSH_SW_FILE), 'utf8');
}

export async function GET() {
  // 빌드 때 정적으로 그리면 Next가 ISR 캐시 머리(30일)를 달아 앞단이 낡은 워커를 낼 수 있다. 요청 때 내고 파일 읽기만 캐시한다
  await connection();
  const body = await readPushWorker();
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}
