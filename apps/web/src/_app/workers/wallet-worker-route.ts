// 월렛 서비스 워커 경로 `/my/tickets/sw.js`(docs/frontend.md §5.4 범위 세부·킬 스위치, ADR-0363 결정 5·6, FE-T14, ASVS 3.5.4).
// - 범위는 끝 `/` 없는 `/my/tickets`라 `Service-Worker-Allowed: /my/tickets`로 낸다. 워커 스크립트는 캐시하지 않는다(`no-cache`, 늘 다시 확인).
// - 웹 앱 서버 실행 환경 `PEAKET_WALLET_SW_MODE=kill`이면 같은 주소가 빌드 때 함께 묶은 킬 스위치 워커를 낸다(빌드 값으로 켜고 끄지 않는다, §5.18).
//   그래서 요청 때 환경을 읽는다(connection()으로 빌드 때 미리 그리지 않게 한다). 파일 읽기만 캐시한다.
// - 파일은 빌드 때 scripts/service-worker.mjs가 <distDir>/serwist/ 아래에 둔다. 요청 때 다시 묶지 않는다(BAT-171 시험 이의 6).
//   standalone 서버는 server/standalone.mjs가 복사한 그 폴더를 읽는다. 라우트 그룹 밖에 두어 HTML 셸·CSP 처리를 받지 않는다.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheLife } from 'next/cache';
import { connection } from 'next/server';
import { SW_DIR, walletWorkerFile } from '../../../scripts/service-worker.mjs';

async function readWorkerFile(file: string): Promise<string> {
  'use cache';
  cacheLife('max');
  // 실행 폴더 기준으로 읽는다(standalone server.js는 자기 폴더로 옮겨 간다). 파일 추적이 앱 폴더 전체를 끌어오지 않게 표시한다
  return readFile(join(/* turbopackIgnore: true */ process.cwd(), process.env.PEAKET_NEXT_DIST ?? '.next', SW_DIR, file), 'utf8');
}

export async function GET() {
  await connection();
  const body = await readWorkerFile(walletWorkerFile(process.env));
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/my/tickets',
      'Cache-Control': 'no-cache',
    },
  });
}
