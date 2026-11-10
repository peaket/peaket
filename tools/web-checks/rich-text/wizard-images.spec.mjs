// 위저드 1단계 포스터·상세 이미지(CMP-069 제어형, ADR-0257 결정 4) 재현 시험. FE-T41과 같은 파트너 빌드·서버(/events/new)를 쓴다.
// 브라우저에서만 드러나는 초점 결함을 본다: 줄을 [위로]·[아래로]로 옮긴 뒤 다른 칸에 글자를 치면 초점이 옮기기 버튼으로 끌려가지 않아야 한다.
import { deflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';

const DRAFT_KEY = 'peaket.partner.wizard-draft.v1';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** 디코딩되는 회색 PNG(w×h) */
function png(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  const raw = Buffer.alloc((w + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('HOT-190 이미지 줄을 [위로]로 옮긴 뒤 공연명을 치면 초점이 공연명에 남고 줄 차례가 바뀌지 않는다', async ({ page }) => {
  await page.goto('/events/new');
  await page.locator('#w-title').waitFor();
  await page.evaluate((k) => localStorage.removeItem(k), DRAFT_KEY);
  await page.reload();
  await page.locator('#w-images input[type=file][multiple]').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: png(900, 1300) },
    { name: 'second.png', mimeType: 'image/png', buffer: png(900, 1300) },
  ]);
  const rows = page.locator('#w-images ol > li');
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'second.png 위로 이동' }).click();
  await expect(rows.nth(0)).toContainText('second.png');
  // 옮긴 줄의 버튼에 초점이 있는 것은 맞다(옮긴 뒤 한 번)
  await expect(page.getByRole('button', { name: 'second.png 아래로 이동' })).toBeFocused();

  const title = page.locator('#w-title');
  await title.click();
  await page.keyboard.type('Winter Show A');
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('Winter Show A');
  await expect(rows.nth(0)).toContainText('second.png');
  await expect(rows.nth(1)).toContainText('first.png');

  // 대체 텍스트 칸도 같다(치는 동안 초점이 버튼으로 가지 않는다)
  const alt = rows.nth(1).getByRole('textbox');
  await alt.click();
  await page.keyboard.type('Cast list');
  await expect(alt).toBeFocused();
  await expect(alt).toHaveValue('Cast list');
  await expect(rows.nth(0)).toContainText('second.png');
});

/** 임시저장 값(form.ts serializeDraft와 같은 모양): 이미지 줄 n개(파일 없음) */
function draftWith(n) {
  const images = Array.from({ length: n }, (_, i) => ({ key: `k${i}`, alt: `글 ${i}` }));
  const draft = { title: '', genre: '', ageRating: '', runningMinutes: '', place: null, artists: [], aliases: [], producer: '', notice: '', description: null, images, rounds: [{ key: 'r1', openAt: '', lobbyMinutes: 10, entryOpensAt: '', startsAt: '', endsAt: '', reentryAllowed: false }], queueOrder: 'HYBRID', seatAssignment: 'PICK', perPersonLimit: 4 };
  return JSON.stringify({ v: 1, draft });
}

test('HOT-190 복원한 줄이 11개여도 줄마다 [파일 고르기]로 그 줄만 채우고 대체 텍스트는 그 줄에 남는다', async ({ page }) => {
  await page.goto('/events/new');
  await page.locator('#w-title').waitFor();
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [DRAFT_KEY, draftWith(11)]);
  await page.reload();
  const rows = page.locator('#w-images ol > li');
  await expect(rows).toHaveCount(11);
  await expect(page.getByRole('button', { name: '파일 선택' })).toBeDisabled();
  const pick = rows.nth(2).getByRole('button', { name: '3번째 이미지 파일 고르기' });
  await expect(pick).toBeEnabled();
  const chooser = page.waitForEvent('filechooser');
  await pick.click();
  await (await chooser).setFiles({ name: 'third.png', mimeType: 'image/png', buffer: png(1000, 900) });
  await expect(rows.nth(2)).toContainText('third.png');
  await expect(rows.nth(2).getByRole('textbox')).toHaveValue('글 2');
  await expect(rows.nth(2).getByRole('button', { name: /파일 고르기/ })).toHaveCount(0);
  // 다른 복원 줄은 그대로 비어 있다
  await expect(rows.nth(1)).toContainText('고른 파일 없음');
  await expect(rows.nth(3)).toContainText('고른 파일 없음');
});
