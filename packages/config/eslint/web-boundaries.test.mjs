// 화면 앱 구조 린트 시험(web-boundaries.mjs, ADR-0329). 실행: pnpm --filter @peaket/config test
// 규칙은 파일 시스템(조각의 공개 파일 유무)을 읽으므로 임시 폴더에 작은 앱을 만들어 그 자리에서 린트한다.
// 끝의 기준선 시험은 실제 저장소를 린트해 기준선이 늘지 않고 고친 줄이 남지 않았는지 본다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { readWebBoundaryBaseline, webBoundaryConfigs, WEB_BOUNDARY_APPS } from './web-boundaries.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const APP = 'apps/web';
const FSD = ['_app', '_pages', 'widgets', 'features', 'entities', 'shared'];

/** 임시 앱: 조각마다 공개 파일이 있는 곳과 없는 곳(nobarrel)을 둔다 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-boundaries-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
for (const rel of [
  '_app/routing/a.ts',
  '_pages/home/index.ts',
  '_pages/cart/index.ts',
  '_pages/cart/model/state.ts',
  'widgets/shell/index.ts',
  'widgets/shell/ui/Shell.tsx',
  'features/login/index.ts',
  'features/login/flow.ts',
  'features/login/browser.ts',
  'features/login/server/post.ts',
  'features/nobarrel/thing.ts',
  'entities/user/index.ts',
  'entities/user/model.ts',
  'shared/lib/index.ts',
  'shared/lib/format.ts',
]) {
  const file = path.join(tmp, APP, 'src', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const x = 1;\n');
}

const lintAt = async (rel, code, baseline = []) => {
  const eslint = new ESLint({
    cwd: tmp,
    overrideConfigFile: true,
    overrideConfig: webBoundaryConfigs({ root: tmp, apps: [{ app: APP, layers: FSD, routes: true }], baseline }),
  });
  const [r] = await eslint.lintText(code, { filePath: path.join(tmp, APP, rel) });
  assert.equal(r.messages.filter((m) => m.fatal).length, 0, `해석 오류: ${JSON.stringify(r.messages)}`);
  return r.messages.map((m) => `${m.ruleId?.replace('peaket-web-boundaries/', '')}: ${m.message}`);
};

/** [린트할 파일(src·app 기준), 코드, 기대 알림(규칙 이름과 메시지에 든 글자), 시험 이름] */
const cases = [
  // 층 방향(결정 1)
  ['src/shared/lib/format.ts', "import { x } from '../../features/login';", ['layer-direction', "'shared' 층은 위 층 'features'"], '아래층이_위층을_가져오면_막힌다'],
  ['src/entities/user/model.ts', "export { x } from '@/_pages/home';", ['layer-direction', "'entities' 층은 위 층 '_pages'"], '별칭_다시내보내기도_막힌다'],
  ['src/shared/lib/format.ts', "import type { X } from '../../features/login';", ['layer-direction', '위 층'], '타입만_가져와도_위층이면_막힌다'],
  ['src/features/login/flow.ts', "import { x } from '../nobarrel/thing';", ['layer-direction', "다른 조각 'nobarrel'"], '같은층_다른조각은_막힌다'],
  ['src/_pages/cart/model/state.ts', "import { x } from '../../home';", ['layer-direction', "다른 조각 'home'"], '페이지끼리_가져오면_막힌다'],
  ['src/features/login/flow.ts', "import { x } from '../../entities/user';", null, '위층이_아래층_공개파일을_가져오면_통과한다'],
  ['src/shared/lib/format.ts', "import { x } from '../lib';", null, 'shared는_조각이없어_서로_가져와도_통과한다'],
  ['src/shared/lib/format.ts', "import React from 'react';", null, '바깥_패키지는_보지_않는다'],
  // 조각 공개 파일(결정 2)
  ['src/widgets/shell/ui/Shell.tsx', "import { x } from '@/features/login/flow';", ['no-slice-internals', "'features/login' 조각의 안쪽 파일"], '아래층_조각의_안쪽파일은_막힌다'],
  ['src/_app/routing/a.ts', "import { x } from '../../entities/user/model';", ['no-slice-internals', "공개 파일 '../../entities/user'"], '상대경로_안쪽파일도_막히고_공개파일을_알려준다'],
  ['src/widgets/shell/ui/Shell.tsx', "import { x } from '@/features/login';", null, '공개파일_index는_통과한다'],
  ['src/widgets/shell/ui/Shell.tsx', "import { x } from '@/features/login/browser';", null, '브라우저전용_browser는_통과한다'],
  ['src/widgets/shell/ui/Shell.tsx', "import { x } from '@/features/login/server/post';", null, '서버전용_server는_통과한다'],
  ['src/widgets/shell/ui/Shell.tsx', "import { x } from '@/features/nobarrel/thing';", null, '공개파일이_없는_조각은_통과한다'],
  ['src/widgets/shell/ui/Shell.tsx', "import type { X } from '@/features/login/flow';", null, '타입만_가져오기는_통과한다'],
  ['src/widgets/shell/ui/Shell.tsx', "export const load = () => import('@/features/login/flow');", null, '늦게싣기_import는_통과한다'],
  ['src/features/login/flow.ts', "import { x } from './browser';", null, '같은조각_안은_통과한다'],
  ['src/widgets/shell/ui/Shell.test.tsx', "import { x } from '@/features/login/flow';", null, '시험파일은_층규칙을_보지_않는다'],
  // 이름(결정 3)
  ['src/features/login/formatDate.ts', 'export {};', ['file-naming', "파일 이름 'formatDate'"], 'ts파일_낙타표기는_막힌다'],
  ['src/features/Login_Dir/x.ts', 'export {};', ['file-naming', "폴더 'features/Login_Dir'"], '폴더_대문자밑줄은_막힌다'],
  ['src/entities/user/ui/user_card.tsx', 'export {};', ['file-naming', "파일 이름 'user_card'"], 'tsx_밑줄표기는_막힌다'],
  ['src/entities/user/ui/UserCard.tsx', 'export {};', null, 'tsx_부품하나는_대문자시작으로_통과한다'],
  ['src/entities/user/ui/board-d.tsx', 'export {};', null, 'tsx_부품묶음은_소문자하이픈으로_통과한다'],
  ['src/entities/user/model.test.mjs', 'export {};', null, '첫점_앞만_본다'],
  // 받는 값 타입 이름(결정 4)
  ['src/entities/user/ui/UserCard.tsx', 'export function UserCard(props: Props) { return <div />; }', ['props-type-naming', "'UserCardProps'로 이름 짓는다(지금 'Props'"], '파일안_짧은이름은_막힌다'],
  ['src/entities/user/ui/UserCard.tsx', 'export const UserCard = ({ id }: CardProps) => <div>{id}</div>;', ['props-type-naming', "지금 'CardProps'"], '화살표함수_부품도_본다'],
  ['src/entities/user/ui/UserCard.tsx', 'export function UserCard(props: UserCardProps) { return <div />; }', null, '부품이름_Props는_통과한다'],
  ['src/entities/user/ui/UserCard.tsx', 'export function UserCard({ id }: { id: string }) { return <div>{id}</div>; }', null, '그자리_객체타입은_통과한다'],
  ['src/_pages/home/ui/HomePage.tsx', 'export function HomePage(props: PageProps) { return <main />; }', null, '공용이름_PageProps는_통과한다'],
  ['src/entities/user/ui/UserCard.tsx', 'export function useCard(props: Props) { return <div />; }', null, '소문자_함수는_부품이_아니다'],
  // Next.js 경로 파일(결정 5)
  ['app/(shop)/[id]/page.tsx', "export { default } from '@/_pages/home';", null, '경로파일_다시내보내기는_통과한다'],
  ['app/(shop)/[id]/page.tsx', "'use client';\nexport const instant = false;\nexport { default, metadata } from '@/_pages/home';", null, '경로설정_글자값과_지시문은_통과한다'],
  ['app/(shop)/[id]/page.tsx', "import Home from '@/_pages/home';\nexport default Home;", null, '가져와서_이름으로_내보내기는_통과한다'],
  ['app/(shop)/[id]/page.tsx', 'export default function Page() { return <main />; }', ['route-reexport-only', '다시 내보내기만'], '경로파일에_화면을_그리면_막힌다'],
  ['app/login/route.ts', 'export async function POST() { return new Response(null); }', ['route-reexport-only', '다시 내보내기만'], '경로처리기에_코드를_두면_막힌다'],
  ['app/(shop)/[id]/page.tsx', "export const metadata = { title: 'x' };", ['route-reexport-only', '다시 내보내기만'], '경로설정이_아닌_값은_막힌다'],
];

for (const [rel, code, expected, name] of cases) {
  test(`ADR0329_${name}`, async () => {
    const messages = await lintAt(rel, code);
    if (expected === null) {
      assert.deepEqual(messages, []);
    } else {
      assert.equal(messages.length, 1, messages.join('\n'));
      const [rule, text] = expected;
      assert.ok(messages[0].startsWith(`${rule}: `), messages[0]);
      assert.ok(messages[0].includes(text), messages[0]);
    }
  });
}

test('ADR0329_기준선에_적은_가져오기는_통과한다', async () => {
  const code = "import { x } from '@/features/login/flow';";
  assert.equal((await lintAt('src/widgets/shell/ui/Shell.tsx', code)).length, 1);
  const baseline = [{ rule: 'no-slice-internals', key: `${APP}/src/widgets/shell/ui/Shell.tsx#@/features/login/flow` }];
  assert.deepEqual(await lintAt('src/widgets/shell/ui/Shell.tsx', code, baseline), []);
});

// ── 실제 저장소의 기준선 ─────────────────────────────────────────────────────────────────────

/** 기준선은 줄이기만 한다(docs/devops.md §4.4 '보안 린트' ②와 같은 방식). 고쳐서 줄을 지웠으면 이 수도 같이 줄인다 */
const BASELINE_MAX = 63;
const RULES = ['layer-direction', 'no-slice-internals', 'props-type-naming', 'route-reexport-only'];

test('ADR0329_기준선은_늘지_않고_줄마다_까닭이_있다', () => {
  const entries = readWebBoundaryBaseline();
  assert.ok(entries.length <= BASELINE_MAX, `기준선이 ${entries.length}줄로 늘었다(최대 ${BASELINE_MAX}). 새 위반은 고치거나 ADR로 예외를 정한다`);
  for (const e of entries) {
    assert.ok(RULES.includes(e.rule), `모르는 규칙: ${e.rule}`);
    assert.ok(typeof e.reason === 'string' && e.reason.trim().length > 0, `까닭 없음: ${e.key}`);
  }
  assert.equal(new Set(entries.map((e) => `${e.rule} ${e.key}`)).size, entries.length, '같은 줄이 두 번 있다');
});

test('ADR0329_기준선의_줄은_모두_아직_위반이다(고친_줄이_남지_않는다)', async () => {
  const entries = readWebBoundaryBaseline();
  const files = [...new Set(entries.map((e) => e.key.split('#')[0]))];
  const eslint = new ESLint({ cwd: REPO, overrideConfigFile: true, overrideConfig: webBoundaryConfigs({ baseline: [] }) });
  const results = await eslint.lintFiles(files);
  const lines = new Map(files.map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')]));
  const found = new Set();
  for (const r of results) {
    const file = path.relative(REPO, r.filePath).split(path.sep).join('/');
    for (const m of r.messages) {
      const rule = m.ruleId?.replace('peaket-web-boundaries/', '');
      if (rule === 'route-reexport-only') found.add(`${rule} ${file}`);
      else if (rule === 'props-type-naming') found.add(`${rule} ${file}#${m.message.match(/부품 '([^']+)'/)[1]}`);
      else if (rule === 'layer-direction' || rule === 'no-slice-internals') {
        const spec = lines.get(file)[m.line - 1].match(/(?:from\s*|import\(\s*)['"]([^'"]+)['"]/)[1];
        found.add(`${rule} ${file}#${spec}`);
      }
    }
  }
  const stale = entries.filter((e) => !found.has(`${e.rule} ${e.key}`)).map((e) => `${e.rule} ${e.key}`);
  assert.deepEqual(stale, [], '이미 고친 줄이 기준선에 남았다. 기준선에서 지우고 BASELINE_MAX도 줄인다');
});

test('ADR0329_세_화면_앱이_모두_규칙_대상이다', () => {
  assert.deepEqual(WEB_BOUNDARY_APPS.map((a) => a.app), ['apps/web', 'apps/partner', 'apps/console-host']);
  for (const { app } of WEB_BOUNDARY_APPS) assert.ok(fs.existsSync(path.join(REPO, app, 'src')), `${app}/src 없음`);
});
