// 원격 위젯 폴더 린트(F-03-2 OPS-350 T6, ASVS 3.2.3). 뿌리 ESLint 설정을 실제로 읽어 위반 표본을 원격 위젯 폴더 경로로 린트한다.
// 정본: docs/frontend.md §4.5 '금지'(원격 위젯이 fetch·WebSocket·localStorage를 직접 쓰거나 전역(window)에 값을 두지 않는다, 계약 패키지 밖의 @peaket/*를
// 가져오지 않는다, 공용 ESLint 설정 REMOTE_WIDGET_RULES와 공용 원격 빌드의 린트 단계가 막는다), docs/security/asvs/frontend.md 3.2.3, ADR-0361 결정 13.
// 지금 원격 위젯 둘의 원천은 오류 0이어야 하고(규칙이 너무 넓지 않다), 같은 표본이 원격 폴더 밖에서는 이 규칙에 걸리지 않는다(범위 짝 확인).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, 'eslint.config.mjs') });
async function rules(code, file) {
  const [r] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return r.messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}
const Q = 'apps/widgets/queue/src/Sample.tsx';
const P = 'apps/widgets/purchase/src/sample.ts';

test('F-03-2 T6 [ASVS v5.0.0-3.2.3] ① 원격 위젯 폴더에서 전역(window·globalThis·document·self)에 값을 두면 린트 오류다', async () => {
  const blocked = [
    'window.peaketShared = 1;\n',
    "globalThis['peaket'] = {};\n",
    'document.peaketToken = "t";\n',
    'self.cache = new Map();\n',
    'window.count += 1;\n',
    'window.count++;\n',
    'delete window.peaket;\n',
    'Object.assign(window, { a: 1 });\n',
    "Object.defineProperty(globalThis, 'a', { value: 1 });\n",
    "Reflect.set(window, 'a', 1);\n",
  ];
  for (const code of blocked) {
    for (const file of [Q, P]) assert.deepEqual(await rules(`${code}export {};\n`, file), ['no-restricted-syntax'], `${file}: ${code}`);
  }
});

test('F-03-2 T6 [ASVS v5.0.0-3.2.3] ② 바깥 통로(fetch·WebSocket·EventSource·XMLHttpRequest)와 브라우저 저장소를 직접 쓰면 린트 오류다(전역 객체를 거쳐도)', async () => {
  const globals = ["fetch('/v1/ops/live');\n", "new WebSocket('wss://x.example');\n", "new EventSource('/v1/ops/live');\n", 'new XMLHttpRequest();\n', "localStorage.getItem('k');\n", "sessionStorage.setItem('k', 'v');\n", "indexedDB.open('db');\n"];
  for (const code of globals) assert.deepEqual(await rules(`${code}export {};\n`, Q), ['no-restricted-globals'], code);
  const viaGlobalObject = ["window.fetch('/x');\n", "globalThis.localStorage.getItem('k');\n", "window['sessionStorage'].clear();\n"];
  for (const code of viaGlobalObject) assert.deepEqual(await rules(`${code}export {};\n`, P), ['no-restricted-syntax'], code);
});

test('F-03-2 T6 [ASVS v5.0.0-3.2.3] ③ @peaket/* 가운데 계약 패키지만 가져오고(정적·동적), 계약 패키지·react만 쓰는 위젯은 통과한다', async () => {
  assert.deepEqual(await rules("import { Button } from '@peaket/ds';\nexport const b = Button;\n", Q), ['no-restricted-imports']);
  assert.deepEqual(await rules("import { track } from '@peaket/telemetry';\nexport const t = track;\n", P), ['no-restricted-imports']);
  assert.deepEqual(await rules("export const load = () => import('@peaket/api-client');\n", Q), ['no-restricted-syntax']);
  const clean = [
    "import { useEffect, useState } from 'react';",
    "import { CONTRACT_MAJOR, defineWidget, type WidgetProps } from '@peaket/console-contract';",
    'export default function W({ services }: WidgetProps) {',
    '  const [v, setV] = useState<unknown>(null);',
    "  useEffect(() => services.data.subscribe('queue-admission-rate.summary' as never, {}, setV), [services]);",
    '  return <span>{String(v)}{CONTRACT_MAJOR}</span>;',
    '}',
    'export const w = defineWidget;',
    "export const lazy = () => import('@peaket/console-contract');",
    '',
  ].join('\n');
  assert.deepEqual(await rules(clean, Q), []);
});

test('F-03-2 T6 [ASVS v5.0.0-3.2.3] ④ 지금 원격 위젯 둘의 원천은 이 규칙에 걸리지 않고, 같은 표본이 원격 폴더 밖(호스트)에서는 이 규칙에 걸리지 않는다', async () => {
  const results = await eslint.lintFiles(['apps/widgets/queue/src', 'apps/widgets/purchase/src']);
  assert.ok(results.length >= 10, `린트한 파일 수 ${results.length}`);
  const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${r.filePath}:${m.line} ${m.ruleId}`));
  assert.deepEqual(errors, []);
  // 범위 짝: 호스트 원천은 ConsoleServices를 만드는 쪽이라 fetch를 쓴다(원격 규칙 밖)
  assert.deepEqual(await rules("export const f = () => fetch('/remotes.json');\n", 'apps/console-host/src/shared/lib/remotes/sample.ts'), []);
});
