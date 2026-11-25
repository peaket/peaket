// F-03-6(FE-T29) ② 첫 화면 JS와 화면·위젯 덩어리 크기(gzip). 빌드 산출물과 그 빌드의 /dashboard HTML을 읽는다.
// 정적 산출물이라 한 번 계산하고, 측정 보고서는 같은 값을 3회로 본다(무작위 없음).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DASHBOARD_PATH, buildSizes, gzipKB } from './lib.mjs';
import { REPORT_ROOT } from './stage.mjs';

/** 빌드 폴더의 js 파일을 `/상대경로` → Buffer로 읽는다(소스 맵 제외) */
export function readScriptFiles(dir) {
  const out = {};
  const walk = (abs, rel) => {
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, e.name);
      const childRel = `${rel}/${e.name}`.replaceAll('\\', '/');
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.map')) out[childRel] = readFileSync(childAbs);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * @param {'mf'|'single'} build
 * @param {{ dir: string, origin: string }} stage
 * @param {{ scripts?: string[] }} [o] 첫 그림까지 브라우저가 받은 스크립트 경로(있으면 그것으로 첫 JS를 센다)
 */
export async function measureSizes(build, stage, o = {}) {
  const res = await fetch(stage.origin + DASHBOARD_PATH);
  if (!res.ok) throw new Error(`첫 화면 HTML ${res.status}: ${stage.origin}${DASHBOARD_PATH}`);
  const html = await res.text();
  const files = readScriptFiles(stage.dir);
  const sizes = buildSizes({ html, files, build });
  const loadedFiles = [...new Set(o.scripts ?? [])].filter((p) => files[p] !== undefined);
  const loaded = loadedFiles.length ? { files: loadedFiles, gzipKB: gzipKB(loadedFiles.map((p) => files[p])) } : null;
  const report = { build, path: DASHBOARD_PATH, ...sizes, loaded };
  writeFileSync(path.join(REPORT_ROOT, `sizes-${build}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
