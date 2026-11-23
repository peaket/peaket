// F-05-5 스캐너 기기 등록 화면(SCR-036 /enroll)이 관제 콘솔 SCR-053 등록 QR(/enroll#code=…)을 실제로 받는지 본다(시험 리뷰 1 TR-01).
// 정본: docs/features/offline-gate.md §6.1 'GAT-170 마감 규칙' 마지막 줄(조각 code면 실제 연결 등록 화면, 입력 칸에 넣음, 주소창에서 지움,
// 저장소에 쓰지 않음, 실패 뒤 입력 칸 남음), 계획 docs/review/plans/F-05-5.md §10의 4(enrollScreenEntry로 진입을 정한다).
// 스캐너 API는 page.route로 답한다(덧붙임 시험). 등록 경로의 실제 서버 판정은 services/ticket-svc/test-int/scanner-f055.int.test.ts가 본다.
import { expect, test } from '@playwright/test';

const CODE = 'KDTW-BMQX-HLRP';
const API = 'https://scanner-api.peaket.example';

/** 스캐너 API 대역: 등록 요청 본문을 적고 정한 응답을 준다. 사전 요청(OPTIONS)과 다른 경로도 CORS 머리를 달아 답한다 */
async function scannerApi(page, enrollment) {
  const enrollBodies = [];
  await page.route(`${API}/**`, async (route) => {
    const req = route.request();
    const cors = {
      'access-control-allow-origin': req.headers().origin ?? '*',
      'access-control-allow-headers': 'content-type, dpop, authorization, accept',
      'access-control-allow-methods': 'GET, POST, PUT',
      'access-control-expose-headers': 'date, www-authenticate, retry-after',
    };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (new URL(req.url()).pathname === '/v1/scanner/device-enrollments' && req.method() === 'POST') {
      enrollBodies.push(req.postDataJSON());
      return route.fulfill({ status: enrollment.status, headers: { ...cors, 'content-type': enrollment.status < 300 ? 'application/json' : 'application/problem+json' }, body: JSON.stringify(enrollment.body) });
    }
    // 등록 뒤 로그인 화면이 부르는 경로 등: 이 시험의 판정 밖이라 닫힌 응답만 준다
    return route.fulfill({ status: 503, headers: { ...cors, 'content-type': 'application/problem+json', 'retry-after': '1' }, body: JSON.stringify({ type: 'https://peaket.example/problems/scanner-auth-unavailable', title: '대역', status: 503 }) });
  });
  return enrollBodies;
}

/** 브라우저 저장소 셋(localStorage·sessionStorage·IndexedDB 모든 저장소의 모든 값)에서 코드가 든 자리 목록 */
async function placesHolding(page, code) {
  return page.evaluate(async (needle) => {
    const hits = [];
    const has = (v) => {
      try {
        return JSON.stringify(v, (_k, x) => (x instanceof ArrayBuffer || ArrayBuffer.isView(x) ? '[bytes]' : typeof CryptoKey !== 'undefined' && x instanceof CryptoKey ? '[key]' : x)).includes(needle);
      } catch {
        return String(v).includes(needle);
      }
    };
    for (const [name, s] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]]) {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k.includes(needle) || (s.getItem(k) ?? '').includes(needle)) hits.push(`${name}:${k}`);
      }
    }
    const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    for (const { name } of dbs) {
      if (!name) continue;
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of [...db.objectStoreNames]) {
        const all = await new Promise((res, rej) => {
          const r = db.transaction(store, 'readonly').objectStore(store).getAll();
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (has(all)) hits.push(`indexedDB:${name}/${store}`);
      }
      db.close();
    }
    return hits;
  }, code);
}

test('O-T37 ① /enroll#code= 진입은 ?live=1 없이 실제 연결 등록 화면이고 입력 칸에 코드가 들어가며 주소창 조각이 지워지고 저장소에 남지 않는다', async ({ page }) => {
  await scannerApi(page, { status: 201, body: { deviceId: 'dev-1' } });
  await page.goto(`/enroll#code=${CODE}`);
  await expect(page.getByLabel('등록 코드')).toHaveValue(CODE);
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  expect(new URL(page.url()).pathname).toBe('/enroll');
  expect(await placesHolding(page, CODE)).toEqual([]);
});

test('O-T37 ① [기기 등록]은 그 코드로 등록 요청을 보내고, 성공하면 /login?live=1로 가며 코드는 저장소에 남지 않는다', async ({ page }) => {
  const bodies = await scannerApi(page, { status: 201, body: { deviceId: 'dev-1' } });
  await page.goto(`/enroll#code=${CODE}`);
  await expect(page.getByLabel('등록 코드')).toHaveValue(CODE);
  await page.getByRole('button', { name: '기기 등록' }).click();
  await expect(page).toHaveURL(/\/login\?live=1$/);
  expect(bodies).toEqual([{ code: CODE }]);
  expect(await placesHolding(page, CODE)).toEqual([]);
});

test('O-T37 ① 등록이 실패(410)하면 오류 글이 보이고 입력 칸의 코드가 남아 다시 누를 수 있으며 저장소에 코드가 없다', async ({ page }) => {
  const title = '등록 코드가 만료되었거나 이미 사용되었습니다';
  const bodies = await scannerApi(page, { status: 410, body: { type: 'https://peaket.example/problems/enrollment-code-expired', title, status: 410 } });
  await page.goto(`/enroll#code=${CODE}`);
  await page.getByRole('button', { name: '기기 등록' }).click();
  await expect(page.getByRole('alert')).toContainText(title);
  await expect(page.getByLabel('등록 코드')).toHaveValue(CODE);
  await expect(page.getByRole('button', { name: '기기 등록' })).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe('/enroll');
  expect(bodies).toEqual([{ code: CODE }]);
  expect(await placesHolding(page, CODE)).toEqual([]);
});
