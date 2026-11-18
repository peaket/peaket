// Serwist 서비스 워커 경로(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, BAT-350).
// 워커는 빌드 때 scripts/service-worker.mjs가 묶어 <distDir>/serwist/sw.js로 둔다(next.config.ts runAfterProductionCompile, 미리 저장 목록·판도 거기서 정한다).
// 이 처리기는 그 파일만 읽고, 요청 때 app/sw.ts를 다시 묶지 않는다. standalone 서버에는 원본이 없어, 빌드 때 그린 결과를 캐시에서 찾지 못하면
// 다시 묶기가 실패해 워커 등록이 거절됐다(BAT-171 시험 이의 6). 파일은 server/standalone.mjs가 standalone 폴더로 복사한다.
// cacheComponents가 켜져 있어 dynamic·revalidate 내보내기 대신 읽기를 `use cache`로 감싼다(빌드 때 한 번 그린다).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheLife } from 'next/cache';
import { SW_DIR, SW_FILES } from '../../../scripts/service-worker.mjs';

export function generateStaticParams() {
  return SW_FILES.map((path) => ({ path }));
}

async function readSerwistFile(path: string): Promise<string> {
  'use cache';
  cacheLife('max');
  // 실행 폴더 기준으로 읽는다(standalone server.js는 자기 폴더로 옮겨 간다). 파일 추적이 앱 폴더 전체를 끌어오지 않게 표시한다
  return readFile(join(/* turbopackIgnore: true */ process.cwd(), process.env.PEAKET_NEXT_DIST ?? '.next', SW_DIR, path), 'utf8');
}

export async function GET(_request: Request, context: { params: Promise<{ path: string }> }) {
  const { path } = await context.params;
  if (!SW_FILES.includes(path)) return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const body = await readSerwistFile(path);
  return new Response(body, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/my/tickets',
      'Cache-Control': 'public, max-age=0, must-revalidate',
    },
  });
}
