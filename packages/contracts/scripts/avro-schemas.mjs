// Avro 계약(docs/api/avro/의 .avsc)을 서비스가 실행 중에 읽을 TS 모듈로 옮긴다(ADR-0357 결정 2, F-04-2).
// 값은 .avsc JSON 그대로다(설명 doc도 남긴다: 시작 확인이 레지스트리의 스키마와 견줄 때 같은 글이어야 한다).
// 레코드 전체 이름(네임스페이스.이름) → 스키마의 색인 avroSchemas와 주제 이름 avroSubject를 함께 쓴다.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AVRO = fileURLToPath(new URL('../../../docs/api/avro/', import.meta.url));

function avscFiles(dir) {
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return avscFiles(p);
      return p.endsWith('.avsc') ? [p] : [];
    });
}

/** peaket/trade/OrderEvent.avsc → tradeOrderEvent(앞의 peaket은 뺀다, proto 설명자 exportName과 같은 규칙) */
export function avroExportName(rel) {
  const parts = rel.replace(/\.avsc$/, '').split('/').filter((p, i) => !(i === 0 && p === 'peaket'));
  return parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * .avsc 파일마다 { rel, name, fullName, schema }를 만든다. 레코드가 아니거나 전체 이름이 겹치면 던진다.
 * @param {string} [dir] avro 뿌리(기본 docs/api/avro)
 */
export function avroSchemaFiles(dir = AVRO) {
  const seen = new Set();
  return avscFiles(dir).map((file) => {
    const rel = relative(dir, file).split(sep).join('/');
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    if (schema?.type !== 'record' || typeof schema.name !== 'string') throw new Error(`${rel}: 맨 위가 이름 있는 record가 아니다`);
    const fullName = schema.name.includes('.') ? schema.name : `${schema.namespace ? `${schema.namespace}.` : ''}${schema.name}`;
    if (seen.has(fullName)) throw new Error(`${rel}: 레코드 전체 이름 ${fullName}이 겹친다`);
    seen.add(fullName);
    return { rel, name: avroExportName(rel), fullName, schema };
  });
}

/** out 폴더에 스키마 모듈과 모음 파일(index.ts)을 쓴다 */
export function writeAvroModules(out, dir = AVRO) {
  mkdirSync(out, { recursive: true });
  const all = avroSchemaFiles(dir);
  const fileOf = (rel) => rel.replace(/\.avsc$/, '').split('/').join('-');
  for (const d of all) {
    writeFileSync(
      join(out, `${fileOf(d.rel)}.ts`),
      `// 생성물: docs/api/avro/${d.rel}(scripts/avro-schemas.mjs). 손으로 고치지 않는다.\n` +
        `export const ${d.name}: Readonly<Record<string, unknown>> = ${JSON.stringify(d.schema, null, 2)};\n`,
    );
  }
  const imports = all.map((d) => `import { ${d.name} } from './${fileOf(d.rel)}.js';`);
  const entries = all.map((d) => `  ${JSON.stringify(d.fullName)}: ${d.name},`);
  writeFileSync(
    join(out, 'index.ts'),
    [
      '// 생성물: Avro 계약(docs/api/avro)의 레코드 전체 이름 → .avsc JSON. 서비스가 빌드된 계약 판으로 쓴다(ADR-0357 결정 2). 손으로 고치지 않는다.',
      ...imports,
      '',
      '/** .avsc JSON 하나(값은 파일 그대로) */',
      'export type AvroSchema = Readonly<Record<string, unknown>>;',
      '',
      '/** 레코드 전체 이름(예: peaket.trade.OrderEvent) → 계약 판 스키마 */',
      'export const avroSchemas: Readonly<Record<string, AvroSchema>> = Object.freeze({',
      ...entries,
      '});',
      '',
      '/** 레지스트리 주제 이름(TopicRecordNameStrategy, docs/api/avro/README.md §3): <토픽>-<네임스페이스.레코드> */',
      'export function avroSubject(topic: string, fullName: string): string {',
      '  return `${topic}-${fullName}`;',
      '}',
      '',
    ].join('\n'),
  );
}
