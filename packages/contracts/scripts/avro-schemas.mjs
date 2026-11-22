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

/**
 * asyncapi 채널(토픽)마다 Avro 스키마가 있는 메시지의 주제 이름(<토픽>-<레코드 전체 이름>, docs/api/avro/README.md §3·§4)을 이름 차례로 돌려준다.
 * 메시지 이름과 같은 이름의 .avsc 레코드가 있으면 Avro 메시지다(JSON 메시지 RumSample·InvestigationRequest 등과 WebSocket·SSE 채널은 .avsc가 없어 빠진다)
 * @param {{ channels?: Record<string, { address?: string, messages?: Record<string, unknown> }> }} asyncapi 읽은 asyncapi 문서
 * @param {{ fullName: string, schema: { name: string } }[]} files avroSchemaFiles의 결과
 */
export function avroSubjectsOf(asyncapi, files) {
  const bySimpleName = new Map(files.map((f) => [f.schema.name.split('.').pop(), f.fullName]));
  const out = new Set();
  for (const ch of Object.values(asyncapi.channels ?? {})) {
    if (typeof ch?.address !== 'string' || ch.address.startsWith('/')) continue;
    for (const name of Object.keys(ch.messages ?? {})) {
      const full = bySimpleName.get(name);
      if (full) out.add(`${ch.address}-${full}`);
    }
  }
  return [...out].sort();
}

/** 로컬 클러스터·합본의 고정 스키마 ID: 주제를 이름 차례로 1부터 번호 매긴다(ADR-0357 결정 4. 로컬에서만 뜻이 있다) */
export function localSchemaIdsOf(subjects) {
  return Object.fromEntries([...subjects].sort().map((s, i) => [s, i + 1]));
}

/**
 * out 폴더에 스키마 모듈과 모음 파일(index.ts), 로컬 고정 번호 파일(local-schema-ids.json)을 쓴다
 * @param {object} asyncapi 읽은 asyncapi 문서(주제 목록을 만든다)
 */
export function writeAvroModules(out, asyncapi, dir = AVRO) {
  mkdirSync(out, { recursive: true });
  const all = avroSchemaFiles(dir);
  const subjects = avroSubjectsOf(asyncapi, all);
  const localIds = localSchemaIdsOf(subjects);
  // 로컬 도구(tools/local)가 TS를 거치지 않고 읽는 같은 값
  writeFileSync(join(out, 'local-schema-ids.json'), `${JSON.stringify(localIds, null, 2)}
`);
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
      '/** asyncapi 채널마다 Avro로 내는 주제 이름(<토픽>-<레코드 전체 이름>), 이름 차례 */',
      `export const avroSubjects: readonly string[] = Object.freeze(${JSON.stringify(subjects, null, 2)});`,
      '',
      '/** 로컬 클러스터·합본(레지스트리가 없다)의 고정 스키마 ID: avroSubjects를 이름 차례로 1부터(ADR-0357 결정 4). local-schema-ids.json과 같은 값 */',
      `export const localSchemaIds: Readonly<Record<string, number>> = Object.freeze(${JSON.stringify(localIds, null, 2)});`,
      '',
      '/** 레지스트리 주제 이름(TopicRecordNameStrategy, docs/api/avro/README.md §3): <토픽>-<네임스페이스.레코드> */',
      'export function avroSubject(topic: string, fullName: string): string {',
      '  return `${topic}-${fullName}`;',
      '}',
      '',
    ].join('\n'),
  );
}
