// F-05-12 identity 시작·모듈 조립(TR-05·TR-11). 정본: docs/review/plans/F-05-12.md §4·§5, architecture §8.6 4
// '시작 파일 조립을 따로 띄워 본다', identity §6.1, openapi createIdentityBoothReverification.
//
// VerifyBoothReverification 클래스를 직접 부르는 단위 시험은 main.ts·VerificationModule이 그 처리기·유스케이스를
// 실제로 싣지 않아도 통과한다. 여기서는 소스 경계로 조립을 본다(ticket-svc/test/device-key-assembly.test.ts와 같은 방식).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
const strip = (s: string): string =>
  s
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/**'))
    .join('\n');

const MAIN = strip(read('../src/main.ts'));
const MODULE = strip(read('../src/modules/verification/verification.module.ts'));
const CONTROLLER = strip(read('../src/modules/verification/inbound/verification.controller.ts'));

describe('identity-svc 부스 대조 조립 [O-T28 ①]', () => {
  test('O-T28 ① VerificationModule이 StartBoothReverification·VerifyBoothReverification·부스 표 저장소를 싣는다', () => {
    expect(MODULE).toMatch(/\bStartBoothReverification\b/);
    expect(MODULE).toMatch(/\bVerifyBoothReverification\b/);
    expect(MODULE).toMatch(/\bBOOTH_REVERIFICATIONS\b/);
  });

  test('O-T28 ① verification.controller가 POST /v1/identity/booth-reverifications를 실제 유스케이스에 잇는다', () => {
    expect(CONTROLLER).toMatch(/@Controller\(\s*['"]v1\/identity(?:\/booth-reverifications)?['"]\s*\)/);
    expect(CONTROLLER).toMatch(/['"]booth-reverifications['"]|@Post\(\s*\)[\s\S]{0,400}booth-reverifications/);
    expect(CONTROLLER).toMatch(/\bStartBoothReverification\b/);
    expect(CONTROLLER).toMatch(/boothReverifications?\.run\(/);
  });

  test('O-T28 ① main.ts가 ReverificationCheckService에 VerifyBoothReverification 처리기를 등록한다', () => {
    expect(MAIN).toMatch(/\bboothReverificationHandlers\(/);
    expect(MAIN).toMatch(/service\.app\.get\(VerifyBoothReverification\)/);
    // 같은 서비스(ReverificationCheckService) 안에 CheckReverification과 함께 싣는다
    const at = MAIN.indexOf('ReverificationCheckService');
    expect(at).toBeGreaterThan(-1);
    const block = MAIN.slice(at, MAIN.indexOf('},', at));
    expect(block).toMatch(/\bboothReverificationHandlers\(|\bVerifyBoothReverification\b/);
  });

  test('O-T28 ① 부스 대조 지표는 result 이름표만 쓰고 계정·티켓·토큰·연계정보를 싣지 않는다', () => {
    const at = MAIN.indexOf("name: 'identity_booth_reverifications_total'");
    expect(at, 'identity_booth_reverifications_total 계수기가 main.ts에 있다').toBeGreaterThan(-1);
    const counter = MAIN.slice(at, MAIN.indexOf('});', at));
    expect(counter).toMatch(/labelNames:\s*\[[^\]]*'result'/);
    expect(counter).not.toMatch(/labelNames:\s*\[[^\]]*'(account|accountId|ticket|ticketId|token|ci|ciHmac)'/);
  });
});
