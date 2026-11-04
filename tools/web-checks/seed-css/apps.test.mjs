// FE-T36 앱·경로 표 시험: 경로 묶음 이름이 정본 §5.8 표에 있는지, HTML에서 스타일시트를 차례대로 뽑는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, BUILDS, portOf, stylesheetHrefs, serverCommand } from './apps.mjs';
import { loadCssBudgets } from '../lib/canon.mjs';

test('도구 경로마다 적은 경로 묶음 이름이 docs/frontend.md §5.8 표에 있다', () => {
  const budgets = loadCssBudgets();
  for (const app of APPS) for (const p of app.pages) assert.ok(budgets.has(p.row), `${app.name} ${p.path}: §5.8에 '${p.row}' 행이 없다`);
});

test('도구 앱 다섯(웹·파트너·관제·스캐너·포렌식)을 모두 보고 포트가 겹치지 않는다', () => {
  assert.deepEqual(APPS.map((a) => a.name), ['web', 'partner', 'console', 'scanner', 'forensics']);
  const ports = APPS.flatMap((a) => Object.keys(BUILDS).map((b) => portOf(a, b)));
  assert.equal(new Set(ports).size, ports.length);
  // 경로 검사는 운영 빌드(운영과 같은 산출 폴더), 탐침은 PoC 빌드
  assert.match(serverCommand(APPS[0], 'prod').command, /next start -p 4101$/);
  assert.equal(serverCommand(APPS[0], 'prod').env.PEAKET_NEXT_DIST, '.next');
  assert.match(serverCommand(APPS[0], 'poc').command, /next start -p 4111$/);
  assert.equal(serverCommand(APPS[0], 'poc').env.PEAKET_NEXT_DIST, '.next-poc');
  assert.match(serverCommand(APPS[3], 'prod').command, /serve\.mjs .*scanner\/dist .*--spa/);
  assert.match(serverCommand(APPS[3], 'poc').command, /serve\.mjs .*scanner\/dist-poc .*--spa/);
  assert.throws(() => serverCommand(APPS[3], 'other'), /모르는 빌드/);
});

test('도구 HTML에서 스타일시트 링크만 문서 차례대로 뽑는다', () => {
  const html = `<link rel="preload" href="/f.woff2"><link rel="stylesheet" href="/a.css" data-precedence="next"><link href='/b.css?x=1&amp;y=2' rel=stylesheet><link rel="icon" href="/i.ico">`;
  assert.deepEqual(stylesheetHrefs(html), ['/a.css', '/b.css?x=1&y=2']);
  // 줄인 HTML(html-webpack-plugin)은 속성 값의 따옴표를 뺀다
  assert.deepEqual(stylesheetHrefs('<script defer src=/a.js></script><link href=/assets/main.1.css rel=stylesheet><link rel=preload href=/x.css>'), ['/assets/main.1.css']);
  // rel은 낱말 목록이고 data-href 같은 다른 속성은 href가 아니다
  assert.deepEqual(stylesheetHrefs('<link data-href="/no.css" rel="stylesheet alternate" href="/alt.css">'), ['/alt.css']);
});
