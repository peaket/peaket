// proto 계약(docs/api/proto)을 protobufjs JSON 설명자로 바꿔 TS 모듈로 쓴다(추천 적용 2026-11-03, BUILD_ORDER PRF-020).
// 서버는 실행 중에 .proto 파일을 읽지 않고 이 설명자를 @grpc/proto-loader의 fromJSON에 넣는다.
// 파일을 읽지 않으므로 Next.js 앱 서버처럼 번들로 묶어도 경로가 깨지지 않는다. 코드 생성 방식은 BUILD_ORDER BAS-030(proto CI)이 다시 본다.
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const protobuf = createRequire(import.meta.url)('protobufjs');

export const PROTO = fileURLToPath(new URL('../../../docs/api/proto/', import.meta.url));

function protoFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return protoFiles(p);
      return p.endsWith('.proto') ? [p] : [];
    });
}

/** peaket/identity/v1/identity.proto → identityV1Identity(앞의 peaket은 뺀다) */
export function exportName(rel) {
  const parts = rel.replace(/\.proto$/, '').split('/').filter((p, i) => !(i === 0 && p === 'peaket'));
  return parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * proto 파일마다 JSON 설명자를 만든다. import한 google/protobuf 공용 형은 protobufjs의 내장 정의로 채운다.
 * @param {string} [dir] proto 뿌리(기본 docs/api/proto)
 * @returns {{ rel: string, name: string, json: object }[]}
 */
export function protoDescriptors(dir = PROTO) {
  return protoFiles(dir).map((file) => {
    const rel = relative(dir, file).split(sep).join('/');
    const root = new protobuf.Root();
    root.resolvePath = (_origin, target) => (target.startsWith('google/protobuf/') ? target : join(dir, target));
    root.loadSync(rel, { keepCase: true });
    // 이름을 모두 풀어 본다(없는 형을 가리키면 여기서 실패한다)
    root.resolveAll();
    return { rel, name: exportName(rel), json: root.toJSON() };
  });
}

/** out 폴더에 설명자 모듈과 모음 파일(index.ts)을 쓴다 */
export function writeProtoModules(out, dir = PROTO) {
  mkdirSync(out, { recursive: true });
  const all = protoDescriptors(dir);
  const head = (rel) => `// 생성물: docs/api/proto/${rel}의 protobufjs JSON 설명자(scripts/proto-descriptors.mjs). 손으로 고치지 않는다.\n`;
  for (const d of all) {
    const file = `${d.rel.replace(/\.proto$/, '').split('/').join('-')}.ts`;
    writeFileSync(join(out, file), `${head(d.rel)}export const ${d.name}: Record<string, unknown> = ${JSON.stringify(d.json, null, 2)};\n`);
  }
  const index = all.map((d) => `export { ${d.name} } from './${d.rel.replace(/\.proto$/, '').split('/').join('-')}.js';`);
  writeFileSync(
    join(out, 'index.ts'),
    '// 생성물: proto 계약마다 JSON 설명자(@grpc/proto-loader의 fromJSON에 넣는다). 손으로 고치지 않는다.\n' + index.join('\n') + '\n',
  );
}
