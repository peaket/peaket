// 좌석 화면이 실시간 연결 부품을 직접 만들지 않고 Worker에 맡기는지 소스를 읽어 본다(FE-T11, docs/frontend.md §5.2, ADR-0240, BAT-182).
// 화면 시험은 브라우저에서 돌지 않으므로(단위 시험) 배선의 모양만 고정한다. 실제 구독·델타는 Worker 단위 시험(T1~T6)과 5만 석 화면 시험이 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = new URL('./SeatsLive.tsx', import.meta.url);
const source = readFileSync(SRC, 'utf8');
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');

test('FE-T11 화면은 첫 그림(ready)에서 stream을 한 번만 보내고 탭 보임도 알린다', () => {
  assert.match(code, /m\.type === 'ready'/);
  assert.match(code, /type: 'stream'/);
  assert.match(code, /streamUrl\(ORIGINS\.api!, eventId\)/);
  assert.match(code, /expiresAtMs: admissionExpiryMs\(adm\.admissionToken\)/);
  // 다시 그릴 때(ready가 또 와도) 두 번째 stream을 보내지 않는다
  assert.match(code, /let streamSent = false/);
  assert.match(code, /if \(!streamSent\)/);
  assert.match(code, /streamSent = true/);
  // 숨긴 탭 규칙: 첫 stream 전에 지금 보임을 알리고, visibilitychange마다 알린다
  assert.match(code, /type: 'visibility', visible: document\.visibilityState !== 'hidden'/);
  assert.match(code, /addEventListener\('visibilitychange', onVisibility\)/);
  assert.match(code, /removeEventListener\('visibilitychange', onVisibility\)/);
});

test('FE-T11 화면은 Worker의 connection을 XState 기계에 넣고 배너를 그린다', () => {
  assert.match(code, /import \{ connectionEvent, connectionMachine \} from '\.\.\/model\/connection-machine'/);
  assert.match(code, /const connActor = createActor\(connectionMachine\)/);
  assert.match(code, /m\.type === 'connection'/);
  assert.match(code, /const ev = connectionEvent\(m\.state, m\)/);
  assert.match(code, /connActor\.send\(ev\)/);
  // 4401 만료는 ended('예매 시간이 끝났습니다'), 무효·권한 없음은 invalid('세션 무효')다(감독 결정 2026-11-20)
  assert.match(code, /snap\.context\.endReason === 'token-expired' \? 'ended' : 'invalid'/);
  assert.match(code, /connectionBanner\(connection\.state, connection\.degraded\)/);
  assert.match(code, /\{liveBanner \? \(/);
  assert.match(code, /<NoticeBanner/);
  // sections·metrics도 받는다(구독 요약·종단 지연)
  assert.match(code, /m\.type === 'sections'/);
  assert.match(code, /m\.type === 'metrics'/);
  assert.match(code, /data-delta-e2e-ms/);
});

test('FE-T11 화면은 연결 부품(createSeatConnection·WebSocket)을 직접 부르지 않는다', () => {
  assert.doesNotMatch(code, /createSeatConnection/);
  assert.doesNotMatch(code, /new WebSocket/);
  assert.doesNotMatch(code, /peaket\.seats\.v1/);
  // 소켓은 Worker 안에서만 연다. 화면은 @peaket/seatmap의 createSeatMap과 메시지로만 말한다
  assert.match(code, /createSeatMap\(\{/);
  assert.match(code, /mapRef\.current\?\.send\(\{ type: 'stream'/);
});
