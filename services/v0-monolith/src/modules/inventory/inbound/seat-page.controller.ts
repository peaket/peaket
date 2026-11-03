// 받는 층: v0 좌석맵 화면(docs/features/seat-hold.md §14 동작 7). 같은 출처 파일(HTML·CSS·JS)만 쓰고 CSP로 묶는다.
// 화면 파일은 패키지의 public/v0-seatmap/에서 시작할 때 한 번 읽는다(정한 이름만 내준다).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Controller, Get, Header, NotFoundException, Res } from '@nestjs/common';
import { ContractParams, Roles } from '@peaket/platform';
import { z } from 'zod';
import { EVENT_ID_PATTERN } from '../domain/inventory.js';

/** src/modules/inventory/inbound(시험)와 dist/modules/inventory/inbound(실행) 모두 패키지 뿌리에서 네 단계 위 */
const PUBLIC_DIR = new URL('../../../../public/v0-seatmap/', import.meta.url);

const ASSETS: Record<string, string> = {
  'seatmap-page.js': 'text/javascript; charset=utf-8',
  'seatmap-model.js': 'text/javascript; charset=utf-8',
  'seatmap.css': 'text/css; charset=utf-8',
  // 랩 판정 계측(§14 동작 7, K5·NFR-012): 계측 파일과 고정 판 web-vitals 속성 정보 빌드(ESM)
  'vitals.js': 'text/javascript; charset=utf-8',
  'web-vitals.js': 'text/javascript; charset=utf-8',
};
/** web-vitals 6.2.3 속성 정보 빌드의 ESM 파일. 패키지가 내보내는 require 조건(UMD) 옆에 있다 */
const WEB_VITALS = join(dirname(createRequire(import.meta.url).resolve('web-vitals/attribution')), 'web-vitals.attribution.js');
const assetText = new Map(
  Object.keys(ASSETS).map((name) => [name, readFileSync(name === 'web-vitals.js' ? WEB_VITALS : new URL(name, PUBLIC_DIR), 'utf8')]),
);

/** 화면 보안 머리(asvs/v0-baseline.md 3.4.3·3.4.4·3.4.6) */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>v0 좌석맵</title>
<link rel="stylesheet" href="/v0/seatmap/assets/seatmap.css">
</head>
<body>
<main>
<h1>v0 좌석맵 <span id="event"></span></h1>
<p id="conn" class="muted">연결 확인 중</p>
<canvas id="map" width="960" height="560" aria-label="좌석맵. 마우스로 좌석을 누르면 고릅니다"></canvas>
<section class="panel" aria-label="고른 좌석">
<p id="selection">고른 좌석이 없습니다</p>
<p id="timer"></p>
<div class="actions">
<button id="hold" type="button" disabled>선택 좌석 잡기</button>
<button id="extend" type="button" hidden>1회 연장</button>
<button id="release" type="button" hidden>놓기</button>
</div>
</section>
<p id="status" role="status" aria-live="polite"></p>
<ul class="legend" aria-label="좌석 상태 범례">
<li><span class="dot available"></span>빈 좌석(등급 색)</li>
<li><span class="dot held"></span>다른 분 선택</li>
<li><span class="dot sold"></span>판매</li>
<li><span class="dot selected"></span>내가 고름</li>
<li><span class="dot mine"></span>내 홀드</li>
</ul>
</main>
<script type="module" src="/v0/seatmap/assets/vitals.js"></script>
<script type="module" src="/v0/seatmap/assets/seatmap-page.js"></script>
</body>
</html>
`;

/** 응답 머리만 쓰는 Fastify 응답의 모양(웹 서버 패키지를 직접 가져오지 않는다) */
interface ReplyHeaders {
  header(name: string, value: string): unknown;
}

const EventParams = z.object({ eventId: z.string().regex(EVENT_ID_PATTERN) }).strict();
const AssetParams = z.object({ file: z.string().max(64) }).strict();

@Controller('v0/seatmap')
export class SeatPageController {
  @Get(':eventId')
  @Roles(['public'])
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('content-security-policy', PAGE_CSP)
  @Header('x-content-type-options', 'nosniff')
  @Header('referrer-policy', 'no-referrer')
  @Header('cache-control', 'no-store')
  page(@ContractParams(EventParams) _p: z.output<typeof EventParams>): string {
    return PAGE_HTML;
  }

  @Get('assets/:file')
  @Roles(['public'])
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', PAGE_CSP)
  @Header('cache-control', 'no-store')
  asset(@ContractParams(AssetParams) p: z.output<typeof AssetParams>, @Res({ passthrough: true }) reply: ReplyHeaders): string {
    if (!Object.hasOwn(ASSETS, p.file)) throw new NotFoundException();
    reply.header('content-type', ASSETS[p.file]!);
    return assetText.get(p.file)!;
  }
}
