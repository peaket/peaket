#!/usr/bin/env node
// 운영 좌석 Lua 원문(services/purchase-svc …/adapters/hold-lua.ts·expire-lua.ts)을 측정 이미지의 bench/lua/로 내보낸다(S-T27 다시 재기,
// docs/features/seat-hold.md §8, BUILD_ORDER PRF-135). 진입 Lua를 옮기는 run.mjs syncEntryLua와 같은 방식이다: TS 원문을 그대로 가져와
// 쓰고, 사본은 커밋하지 않는다(.gitignore loadtest/poc/bench/lua/seat-*.lua). run.mjs가 측정 이미지를 만들기 전에 부른다.
// 원문 첫 줄이 `#!lua`여야 해서(ADR-0086) 머리 주석을 붙이지 않고 글자 하나 바꾸지 않고 쓴다. 같은지는 loadtest/test/poc-seat.test.mjs가 본다.
// 쓰는 법(저장소 뿌리에서): node loadtest/poc/seat-lua.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADAPTERS = join(ROOT, 'services', 'purchase-svc', 'src', 'modules', 'inventory', 'adapters');
export const LUA_DIR = join(ROOT, 'loadtest', 'poc', 'bench', 'lua');

/** 내보낼 원문: 측정 이미지의 파일 이름(clients.mjs lua(이름)) ← TS 모듈의 내보낸 이름 */
export const SEAT_LUA = [
  { file: 'seat-hold.lua', module: 'hold-lua.ts', name: 'HOLD_LUA' },
  { file: 'seat-open-sale.lua', module: 'hold-lua.ts', name: 'OPEN_SALE_LUA' },
  { file: 'seat-expire.lua', module: 'expire-lua.ts', name: 'EXPIRE_LUA' },
];

/** 원문을 읽는다(TS 모듈은 문자열만 두고 아무것도 가져오지 않아 형 지우기만으로 읽힌다) */
export async function readSeatLua() {
  const out = [];
  for (const s of SEAT_LUA) {
    const m = await import(pathToFileURL(join(ADAPTERS, s.module)).href);
    const text = m[s.name];
    if (typeof text !== 'string') throw new Error(`${s.module}에 ${s.name} 글이 없다`);
    out.push({ ...s, source: `services/purchase-svc/src/modules/inventory/adapters/${s.module} ${s.name}`, text });
  }
  return out;
}

export const sha1 = (t) => createHash('sha1').update(t, 'utf8').digest('hex');

/**
 * 원문을 dir에 그대로 쓴다. 빈 글도 쓴다(빈 글이면 seat-shard.mjs가 그 Lua를 쓰는 부하를 거절한다).
 * @returns {Promise<{ file: string, path: string, source: string, bytes: number, sha1: string, empty: boolean }[]>}
 */
export async function exportSeatLua(dir = LUA_DIR) {
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const s of await readSeatLua()) {
    const path = join(dir, s.file);
    writeFileSync(path, s.text);
    out.push({ file: s.file, path, source: s.source, bytes: Buffer.byteLength(s.text), sha1: sha1(s.text), empty: s.text.length === 0 });
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  for (const r of await exportSeatLua()) console.log(`${r.file} ← ${r.source}: ${r.empty ? '빈 글(아직 원문이 없다)' : `${r.bytes}바이트 sha1 ${r.sha1}`}`);
}
