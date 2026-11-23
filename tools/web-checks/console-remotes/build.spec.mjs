// 관제 운영 빌드의 원격 산출물·원격 목록·공유 싱글턴(F-03-2 OPS-350 T9·T18). 브라우저를 띄우지 않고 apps/console-host/dist를 읽는다.
// 정본: docs/frontend.md §4.5 'remotes.json'(칸 다섯, entry 정식 주소, integrity는 그 바이트의 sha384, contractMajor는 계약 패키지 판의 큰 수)·
// '공유 싱글턴'(원격은 대체본 없이 호스트 것만 쓴다: 원격 산출물에 react·계약 패키지 사본이 없다), §5.8 관제 콘솔 '원격마다 80KB [가정]',
// docs/devops.md §6.6(싱글턴 검사), ADR-0361 결정 2·3·7. 크기 상한은 정본 표에서 읽는다(lib/canon.mjs). 사본 검사의 표지는 같은 빌드의 호스트
// 덩어리에서 실제로 찾아져야 한다(아무것도 못 찾는 검사가 늘 통과하지 않게, 짝 확인).
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseBudgetRows, repoRoot } from '../lib/canon.mjs';
import { DIST, builtList, shaDirsOf } from './forge.mjs';

const consoleRow = parseBudgetRows(readFileSync(path.join(repoRoot, 'docs/frontend.md'), 'utf8')).find((r) => r['경로 묶음'] === '관제 콘솔');
/** §5.8 관제 콘솔 '원격마다 nKB [가정]'(kB = 1,000바이트) */
const REMOTE_KB = Number(/원격마다 (\d+)KB/.exec(consoleRow?.['첫 JS'] ?? '')?.[1]);
const contractMajor = Number(JSON.parse(readFileSync(path.join(repoRoot, 'packages/console-contract/package.json'), 'utf8')).version.split('.')[0]);
const hostJs = () => readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(DIST, 'assets', f), 'utf8'));
/** 공유 싱글턴 표지: react 본체 내부 칸 이름, 계약 패키지 오류 글. 실제 값 원격만의 원천 표지: 위젯 키 */
const MARKS = { react: '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE', contract: '원격 sha 꼴이 아니다' };
const REMOTE_ONLY = { queue: 'queue-admission-rate.summary', purchase: 'purchase-pg-status.summary' };

test('F-03-2 T9 ① 원격 목록은 원격마다 정식 주소·그 바이트의 sha384(Web Crypto로 따로 계산)·계약 판이고, 원격 sha 폴더는 remoteEntry.js 한 파일이며 gzip이 정본 상한 안이다', async () => {
  expect(REMOTE_KB, '§5.8 관제 콘솔 원격 예산').toBeGreaterThan(0);
  const list = builtList();
  expect(list.map((e) => e.name).sort()).toEqual(['purchase', 'queue']);
  for (const e of list) {
    expect(Object.keys(e).sort()).toEqual(['contractMajor', 'entry', 'integrity', 'name', 'sha']);
    expect(e.entry).toBe(`/remotes/${e.name}/${e.sha}/remoteEntry.js`);
    expect(e.sha).toMatch(/^[0-9a-f]{7,40}$/);
    expect(e.contractMajor).toBe(contractMajor);
    expect(shaDirsOf(DIST, e.name)).toEqual([e.sha]);
    expect(readdirSync(path.join(DIST, 'remotes', e.name, e.sha)), `${e.name} 한 파일`).toEqual(['remoteEntry.js']);
    const bytes = readFileSync(path.join(DIST, 'remotes', e.name, e.sha, 'remoteEntry.js'));
    expect(e.integrity, `${e.name} integrity`).toBe(`sha384-${Buffer.from(await crypto.subtle.digest('SHA-384', bytes)).toString('base64')}`);
    const kb = gzipSync(bytes).length / 1000;
    expect(kb, `${e.name} ${kb}kB > ${REMOTE_KB}kB`).toBeLessThanOrEqual(REMOTE_KB);
  }
});

test('F-03-2 T18 원격 산출물에 공유 싱글턴(react·계약 패키지) 사본이 없고 호스트에만 있으며, 실제 값 원격의 원천은 호스트 덩어리에 없다', () => {
  const host = hostJs();
  for (const [what, mark] of Object.entries(MARKS)) expect(host.some((t) => t.includes(mark)), `짝 확인: 호스트에 ${what} 표지가 있다`).toBe(true);
  for (const e of builtList()) {
    const text = readFileSync(path.join(DIST, 'remotes', e.name, e.sha, 'remoteEntry.js'), 'utf8');
    for (const [what, mark] of Object.entries(MARKS)) expect(text.includes(mark), `${e.name}에 ${what} 사본`).toBe(false);
    // 원격이 호스트 공유 범위에서 가져가는 모듈(대체본 없이): 계약 패키지는 판 범위 ^<CONTRACT_MAJOR>.0.0
    expect(text).toContain(`"@peaket/console-contract",!1,[1,${contractMajor},0,0]`);
    // 짝 확인: 원격만의 원천 표지는 그 원격에 있고, 호스트에는 없다(MF 빌드의 호스트 덩어리에 위젯 원천이 없다, FE-T25)
    expect(text.includes(REMOTE_ONLY[e.name]), `${e.name}에 자기 원천 표지`).toBe(true);
    expect(host.some((t) => t.includes(REMOTE_ONLY[e.name])), `호스트에 ${e.name} 원격 원천`).toBe(false);
  }
});
