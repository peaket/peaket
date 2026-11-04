// @peaket/ds Storybook 정적 빌드의 이야기 목록과 주소(FE-T18·FE-T40, BUILD_ORDER BAS-180).
// 빌드: tools/storybook에서 pnpm run build → tools/storybook/storybook-static/(뿌리와 따로 둔 작업 공간)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STORYBOOK_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../storybook/storybook-static');
export const STORYBOOK_PORT = 4120;

/** index.json의 이야기(type story)만, id 차례로. 빌드가 없으면 멈춘다(검사가 0개로 통과하지 않게) */
export function storyEntries(dir = STORYBOOK_DIR) {
  const file = join(dir, 'index.json');
  if (!existsSync(file)) throw new Error(`Storybook 정적 빌드가 없다: tools/storybook에서 pnpm install --frozen-lockfile && pnpm run build (${file})`);
  const index = JSON.parse(readFileSync(file, 'utf8'));
  const stories = Object.values(index.entries ?? {})
    .filter((e) => e.type === 'story')
    .map((e) => ({ id: e.id, title: e.title, name: e.name }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (stories.length === 0) throw new Error(`이야기가 없다: ${file}`);
  return stories;
}

/** 이야기 하나만 그리는 iframe 주소. 다크는 Storybook 전역 값 theme:dark(.storybook/preview.tsx) */
export function storyPath(id, theme = 'light') {
  const q = new URLSearchParams({ id, viewMode: 'story' });
  if (theme === 'dark') q.set('globals', 'theme:dark');
  return `/iframe.html?${q.toString().replace('theme%3Adark', 'theme:dark')}`;
}

/** 이야기를 열고 그려질 때까지 기다린다: 루트에 내용이 있고, 키트 루트 클래스가 붙고, 글꼴을 다 읽었다 */
export async function openStory(page, id, theme = 'light') {
  await page.goto(storyPath(id, theme));
  await page.waitForFunction(
    (dark) => {
      const root = document.querySelector('#storybook-root');
      return !!root && root.childElementCount > 0 && document.body.classList.contains('pk') && document.body.classList.contains('dark') === dark;
    },
    theme === 'dark',
  );
  await page.evaluate(() => document.fonts.ready);
}
