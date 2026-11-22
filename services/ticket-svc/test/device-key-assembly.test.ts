// ticket-svc 시작 파일(src/start.ts)이 기기 키 등록에 재인증 확인기와 알림 보내기 반복을 꽂는지 소스 경계로 본다
// (BUILD_ORDER GAT-020, F-05-1 계획 §6 '시작 조립', ADR-0363 결정 1·4, offline-gate §10.1).
// 시험 조립(assembleDeviceKeys를 직접 부르는 시험)은 start()가 그 함수를 부르지 않아도 통과하므로, 시작 파일의 조립을 따로 본다.
// 조립 함수의 동작 자체는 device-key-reauth.test.ts·device-key-notices.test.ts와 test-int/wallet-reissue-wiring.int.test.ts가 본다.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const SOURCE = readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8');
/** 주석을 뺀 코드(주석 속 이름에 속지 않게) */
const CODE = SOURCE.split('\n')
  .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*') && !l.trimStart().startsWith('/**'))
  .join('\n');
const START = CODE.slice(CODE.indexOf('export async function start('));

describe('ticket-svc 시작 파일의 기기 키 조립 [GAT-020]', () => {
  test('ticket-svc 시작 파일이 기기 키 재인증 확인기와 알림 반복을 조립한다', () => {
    expect(START.length).toBeGreaterThan(0);
    // start()는 조립 함수를 한 번 부르고, DeviceKeys를 따로 만들지 않는다(재인증 없는 조립이 끼어들 길이 없다)
    expect([...START.matchAll(/assembleDeviceKeys\(\{/g)]).toHaveLength(1);
    expect(START).not.toMatch(/new DeviceKeys\(/);
    const call = START.slice(START.indexOf('assembleDeviceKeys({'), START.indexOf('});', START.indexOf('assembleDeviceKeys({')));
    // 저장소는 Drizzle 기기 키 저장소, 확인기는 양도·돌려주기와 같은 인스턴스(reauth)
    expect(call).toMatch(/store: deviceKeyStore\b/);
    expect(call).toMatch(/\breauth,|\breauth: reauth\b/);
    expect(START).toMatch(/new Transfers\(\{[\s\S]*?\breauth\b[\s\S]*?\}\)/);
    // core-svc 주소·내부 토큰을 조립에 넘긴다
    expect(call).toMatch(/coreHttpUrl: config\.coreHttpUrl/);
    expect(call).toMatch(/internalToken: config\.internalToken/);
    // 보내기 반복은 타이머로 돌고 닫을 때 멈춘다
    expect(START).toMatch(/noticeTimer = setInterval\(/);
    expect([...START.matchAll(/if \(noticeTimer\) clearInterval\(noticeTimer\)/g)].length).toBeGreaterThanOrEqual(2);
    // 조립 함수 안에서만 DeviceKeys를 만들고 reauth를 꽂는다
    const assemble = CODE.slice(CODE.indexOf('export function assembleDeviceKeys('), CODE.indexOf('export interface StartOptions'));
    expect(assemble).toMatch(/new DeviceKeys\(\{[^}]*\breauth: o\.reauth\b/);
  });
});
