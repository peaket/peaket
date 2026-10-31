// 서비스 OpenAPI 차이 검사(D-T38, docs/devops.md §3.1 contract-check, openspec 변경 add-service-template 결정 7)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './git-fixture.mjs';
import { checkServices, compareService, parseOperations, serviceTargets } from './service-openapi.mjs';

// JSON 왕복: structuredClone은 같은 객체를 가리키던 칸을 복사 뒤에도 하나로 남겨, 한 곳만 고치려던 시험이 세 곳을 고친다
const clone = (x) => JSON.parse(JSON.stringify(x));

// 계약(OpenAPI 3.1, $ref와 type 배열을 쓴다)
const CONTRACT = {
  openapi: '3.1.0',
  info: { title: 'c', version: '1' },
  components: {
    schemas: {
      Item: {
        type: 'object',
        description: '물건',
        required: ['id', 'state'],
        properties: {
          id: { type: 'string', format: 'uuid', description: '아이디' },
          state: { type: 'string', enum: ['OPEN', 'CLOSED'] },
          note: { type: ['string', 'null'], maxLength: 20 },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
      Problem: { type: 'object', properties: { type: { type: 'string', format: 'uri' }, status: { type: 'integer' } } },
    },
    parameters: { ItemId: { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } } },
    responses: { Problem: { description: 'RFC 9457', content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
    requestBodies: { ItemBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } },
  },
  paths: {
    '/v1/items/{itemId}': {
      get: {
        parameters: [{ $ref: '#/components/parameters/ItemId' }, { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } },
          '401': { $ref: '#/components/responses/Problem' },
          '404': { $ref: '#/components/responses/Problem', description: '없음' },
        },
      },
      put: {
        parameters: [{ $ref: '#/components/parameters/ItemId' }],
        requestBody: { $ref: '#/components/requestBodies/ItemBody' },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } }, '409': { $ref: '#/components/responses/Problem' } },
      },
    },
    '/v1/other': { get: { responses: { '204': { description: '없음' } } } },
  },
};

// 서비스가 뽑은 문서(@nestjs/swagger는 OpenAPI 3.0, 안에 펼친 스키마, nullable, 설명·형식이 다를 수 있다)
const ITEM_30 = {
  type: 'object',
  required: ['state', 'id'],
  properties: {
    id: { type: 'string' },
    state: { type: 'string', enum: ['CLOSED', 'OPEN'], description: '상태' },
    note: { type: 'string', nullable: true },
    tags: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
};
const EMITTED = {
  openapi: '3.0.0',
  info: { title: 'svc', version: '0.0.0' },
  paths: {
    '/v1/items/{itemId}': {
      get: {
        operationId: 'ItemsController_get',
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }, { name: 'if-none-match', in: 'header', required: false, schema: { type: 'string' } }],
        responses: { '200': { description: '', content: { 'application/json': { schema: ITEM_30 } } }, '404': { description: '없음' } },
      },
      put: {
        parameters: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: ITEM_30 } } },
        responses: { '200': { description: '', content: { 'application/json': { schema: ITEM_30 } } } },
      },
    },
  },
};
const OWNS = ['GET /v1/items/{itemId}', 'PUT /v1/items/{itemId}'];
const cmp = (emitted, owns = OWNS, contract = CONTRACT) => compareService({ contract, emitted, owns: parseOperations(owns).operations });

test('DT38_계약과같은판은_설명·형식·nullable·$ref만달라도_통과한다', () => {
  assert.deepEqual(cmp(EMITTED), []);
});

test('DT38_계약에없는응답칸은_작업과칸이름을보이며실패한다', () => {
  const e = clone(EMITTED);
  e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema.properties.secretFlag = { type: 'boolean' };
  const diffs = cmp(e);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /GET \/v1\/items\/\{itemId\}/);
  assert.match(diffs[0], /응답 200 application\/json/);
  assert.match(diffs[0], /secretFlag.*계약에 없는 칸/);
});

test('DT38_계약에있는응답칸을빼도_필수목록이달라도_실패한다', () => {
  const e = clone(EMITTED);
  const s = e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema;
  delete s.properties.tags;
  s.required = ['id'];
  const diffs = cmp(e).join('\n');
  assert.match(diffs, /tags.*서비스에 없는 칸/);
  assert.match(diffs, /필수/);
});

test('DT38_형과열거값이달라도_실패한다', () => {
  const e = clone(EMITTED);
  const s = e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema;
  s.properties.id = { type: 'integer' };
  s.properties.state.enum = ['OPEN'];
  const diffs = cmp(e).join('\n');
  assert.match(diffs, /id.*형/);
  assert.match(diffs, /state.*열거/);
});

test('DT38_맡은작업이서비스문서에없으면_실패한다', () => {
  const e = clone(EMITTED);
  delete e.paths['/v1/items/{itemId}'].put;
  assert.match(cmp(e).join('\n'), /PUT \/v1\/items\/\{itemId\}.*서비스 문서에 없다/);
});

test('DT38_계약에없는작업을내거나_목록에없는계약작업을내면_실패한다', () => {
  const e = clone(EMITTED);
  e.paths['/v1/hidden'] = { post: { responses: { '201': { description: '' } } } };
  e.paths['/v1/other'] = { get: { responses: { '204': { description: '' } } } };
  const diffs = cmp(e).join('\n');
  assert.match(diffs, /POST \/v1\/hidden.*계약에 없다/);
  assert.match(diffs, /GET \/v1\/other.*맡는 목록에 없다/);
});

test('DT38_맡는목록의작업이계약에없거나_적는형식이틀리면_실패한다', () => {
  assert.match(cmp(EMITTED, [...OWNS, 'DELETE /v1/items/{itemId}']).join('\n'), /DELETE \/v1\/items\/\{itemId\}.*계약에 없다/);
  const bad = parseOperations(['GET', 'get /v1/x', 'GET /v1/items/{itemId}', 'GET /v1/items/{itemId}']);
  assert.equal(bad.errors.length, 3); // 형식 둘, 겹침 하나
  assert.deepEqual(bad.operations, ['GET /v1/items/{itemId}']);
});

test('DT38_매개변수가빠지거나_필수여부가다르면_실패한다', () => {
  const e = clone(EMITTED);
  const get = e.paths['/v1/items/{itemId}'].get;
  get.parameters = [get.parameters[0], { name: 'If-None-Match', in: 'header', required: true, schema: { type: 'string' } }, { name: 'debug', in: 'query', schema: { type: 'boolean' } }];
  const diffs = cmp(e).join('\n');
  assert.match(diffs, /header if-none-match.*필수/);
  assert.match(diffs, /query debug.*계약에 없는 매개변수/);
  const e2 = clone(EMITTED);
  e2.paths['/v1/items/{itemId}'].get.parameters.pop();
  assert.match(cmp(e2).join('\n'), /header if-none-match.*서비스에 없는 매개변수/);
});

test('DT38_요청본문의모양·필수·내용형식이다르면_실패한다', () => {
  const e = clone(EMITTED);
  const put = e.paths['/v1/items/{itemId}'].put;
  put.requestBody.required = false;
  put.requestBody.content['application/json'].schema = { type: 'object', properties: { id: { type: 'string' } } };
  put.requestBody.content['text/plain'] = { schema: { type: 'string' } };
  const diffs = cmp(e).join('\n');
  assert.match(diffs, /요청 본문.*필수/);
  assert.match(diffs, /요청 본문.*text\/plain/);
  assert.match(diffs, /요청 본문 application\/json.*state.*서비스에 없는 칸/);
});

test('DT38_2xx상태모음은같아야하고_서비스가적은오류응답은계약에있어야한다', () => {
  const e = clone(EMITTED);
  const put = e.paths['/v1/items/{itemId}'].put;
  put.responses['201'] = put.responses['200'];
  delete put.responses['200'];
  put.responses['418'] = { description: '' };
  const diffs = cmp(e).join('\n');
  assert.match(diffs, /PUT .*성공 응답 상태.*200.*201/);
  assert.match(diffs, /응답 418.*계약에 없다/);
  // 계약의 오류 응답(401)을 서비스가 적지 않은 것은 괜찮다(게이트웨이·공용 필터가 낸다). 위 EMITTED가 그렇다
  // 서비스가 적은 오류 응답 본문은 계약과 모양이 같아야 한다
  const e2 = clone(EMITTED);
  e2.paths['/v1/items/{itemId}'].get.responses['404'] = { description: '', content: { 'application/problem+json': { schema: { type: 'object', properties: { code: { type: 'string' } } } } } };
  assert.match(cmp(e2).join('\n'), /응답 404 application\/problem\+json.*code.*계약에 없는 칸/);
});

test('DT38_성공응답에본문이없으면_실패한다', () => {
  const e = clone(EMITTED);
  delete e.paths['/v1/items/{itemId}'].get.responses['200'].content;
  assert.match(cmp(e).join('\n'), /응답 200.*application\/json/);
});

test('DT38_anyOf_null과_allOf하나짜리는_같은모양으로읽는다', () => {
  const e = clone(EMITTED);
  const s = e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'];
  s.schema = { allOf: [clone(ITEM_30)] };
  s.schema.allOf[0].properties.note = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  assert.deepEqual(cmp(e), []);
});

// 계약 Zod를 contractSchema(Zod 4 toJSONSchema, openapi-3.0)로 바꾼 문서가 내는 표기(코드 리뷰, 2026-11-01 실제 출력)
const withSchema = (schema) => {
  const e = clone(EMITTED);
  e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema = schema;
  return e;
};
const itemWith = (props) => ({ ...clone(ITEM_30), properties: { ...clone(ITEM_30).properties, ...props } });

test('DT38_Zod의null표기들은_계약의null형과같다', () => {
  for (const note of [
    { anyOf: [{ type: 'string' }, { type: 'string', nullable: true, enum: [null] }] },
    { anyOf: [{ type: 'string' }, { type: 'null', enum: [null] }] },
    { anyOf: [{ type: 'string' }, { nullable: true, enum: [null] }] },
  ]) {
    assert.deepEqual(cmp(withSchema(itemWith({ note }))), [], JSON.stringify(note));
  }
});

test('DT38_anyOf와oneOf는_같은모양으로본다', () => {
  const c = clone(CONTRACT);
  c.components.schemas.Item.properties.tags = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };
  const e = withSchema(itemWith({ tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }] } }));
  e.paths['/v1/items/{itemId}'].put.requestBody.content['application/json'].schema = clone(e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema);
  e.paths['/v1/items/{itemId}'].put.responses['200'] = clone(e.paths['/v1/items/{itemId}'].get.responses['200']);
  assert.deepEqual(cmp(e, OWNS, c), []);
  // 원소 모양이 다르면 여전히 실패한다
  const bad = withSchema(itemWith({ tags: { anyOf: [{ type: 'array', items: { type: 'integer' } }, { type: 'string' }] } }));
  assert.match(cmp(bad, OWNS, c).join('\n'), /tags/);
});

test('DT38_값하나짜리열거들의anyOf는_계약의열거하나와같다', () => {
  const state = { anyOf: [{ type: 'string', enum: ['OPEN'] }, { type: 'string', const: 'CLOSED' }] };
  assert.deepEqual(cmp(withSchema(itemWith({ state }))), []);
  const fewer = { anyOf: [{ type: 'string', enum: ['OPEN'] }, { type: 'string', enum: ['GONE'] }] };
  assert.match(cmp(withSchema(itemWith({ state: fewer }))).join('\n'), /state.*열거/);
});

test('DT38_요청에서는읽기전용칸을_응답에서는쓰기전용칸을_빼고견준다', () => {
  const c = clone(CONTRACT);
  c.components.schemas.Item.properties.viewedAt = { type: 'string', readOnly: true };
  c.components.schemas.Item.properties.secret = { type: 'string', writeOnly: true };
  const e = clone(EMITTED);
  const put = e.paths['/v1/items/{itemId}'].put;
  put.requestBody.content['application/json'].schema = itemWith({ secret: { type: 'string' } });
  put.responses['200'].content['application/json'].schema = itemWith({ viewedAt: { type: 'string' } });
  e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema = itemWith({ viewedAt: { type: 'string' } });
  assert.deepEqual(cmp(e, OWNS, c), []);
  // 요청 본문에 읽기 전용 칸을 받는다고 적으면 실패한다
  put.requestBody.content['application/json'].schema = itemWith({ secret: { type: 'string' }, viewedAt: { type: 'string' } });
  assert.match(cmp(e, OWNS, c).join('\n'), /요청 본문.*viewedAt.*계약에 없는 칸/);
});

test('DT38_숫자열거는_값으로형을읽고_스칼라형union은_형목록과같다', () => {
  const c = clone(CONTRACT);
  c.components.schemas.Item.properties.n = { type: 'integer', enum: [1, 2] };
  c.components.schemas.Item.properties.rate = { type: 'number', enum: [0, 0.1] };
  c.components.schemas.Item.properties.v = { type: ['boolean', 'integer', 'string'] };
  const props = {
    n: { anyOf: [{ type: 'number', const: 1 }, { type: 'integer', const: 2 }] },
    rate: { anyOf: [{ type: 'integer', const: 0 }, { type: 'number', const: 0.1 }] },
    v: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'boolean' }] },
  };
  const e = withSchema(itemWith(props));
  delete e.paths['/v1/items/{itemId}'].put;
  assert.deepEqual(cmp(e, ['GET /v1/items/{itemId}'], c), []);
  // 정수 칸을 실수로 적으면 여전히 실패한다
  const bad = withSchema(itemWith({ ...props, n: { type: 'number' } }));
  delete bad.paths['/v1/items/{itemId}'].put;
  assert.match(cmp(bad, ['GET /v1/items/{itemId}'], c).join('\n'), /\$\.n: /);
});

test('DT38_null과함께감싼하나안의조합도_버리지않고견준다', () => {
  // Zod z.union([z.union([A, B]), z.null()])은 anyOf:[{anyOf:[A, B]}, null 조각]을 낸다(다시 본 리뷰, 2026-11-01)
  const A = { type: 'object', properties: { a: { type: 'string' } } };
  const B = { type: 'object', properties: { b: { type: 'string' } } };
  const c = clone(CONTRACT);
  c.components.schemas.U = { oneOf: [A, B] };
  c.components.schemas.Item.properties.p = { oneOf: [{ $ref: '#/components/schemas/U' }, { type: 'null' }] };
  const same = withSchema(itemWith({ p: { anyOf: [{ anyOf: [clone(B), clone(A)] }, { type: 'string', nullable: true, enum: [null] }] } }));
  delete same.paths['/v1/items/{itemId}'].put;
  assert.deepEqual(cmp(same, ['GET /v1/items/{itemId}'], c), []);
  const other = withSchema(itemWith({ p: { anyOf: [{ anyOf: [{ type: 'object', properties: { x: { type: 'integer' } } }, { type: 'array', items: { type: 'string' } }] }, { type: 'null' }] } }));
  delete other.paths['/v1/items/{itemId}'].put;
  assert.notDeepEqual(cmp(other, ['GET /v1/items/{itemId}'], c), []);
});

test('DT38_형없이적은null열거는_null형으로본다', () => {
  const c = clone(CONTRACT);
  c.components.schemas.Item.properties.state = { enum: ['OPEN', 'CLOSED', null] };
  assert.match(cmp(withSchema(itemWith({ state: { enum: ['OPEN', 'CLOSED'] } })), ['GET /v1/items/{itemId}'], c).join('\n'), /state.*형/);
});

test('DT38_자기를가리키는nullable스키마도_끝나고같으면통과한다', () => {
  const c = clone(CONTRACT);
  c.components.schemas.Node = { type: 'object', properties: { parent: { anyOf: [{ $ref: '#/components/schemas/Node' }, { type: 'null' }] }, name: { type: 'string' } } };
  c.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Node' };
  const e = clone(EMITTED);
  e.components = { schemas: { Node: { type: 'object', properties: { parent: { allOf: [{ $ref: '#/components/schemas/Node' }], nullable: true }, name: { type: 'string' } } } } };
  e.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema = { $ref: '#/components/schemas/Node' };
  delete e.paths['/v1/items/{itemId}'].put;
  assert.deepEqual(cmp(e, ['GET /v1/items/{itemId}'], c), []);
  // 순환 안의 모양이 다르면 실패한다
  e.components.schemas.Node.properties.name = { type: 'integer' };
  assert.match(cmp(e, ['GET /v1/items/{itemId}'], c).join('\n'), /name.*형/);
});

function services(root, list) {
  for (const [name, pkg] of Object.entries(list)) {
    mkdirSync(join(root, 'services', name), { recursive: true });
    writeFileSync(join(root, 'services', name, 'package.json'), JSON.stringify({ name: `@peaket/${name}`, ...pkg }));
  }
}
function project() {
  const root = tempDir('service-openapi-');
  mkdirSync(join(root, 'docs', 'api'), { recursive: true });
  writeFileSync(join(root, 'docs', 'api', 'openapi.yaml'), JSON.stringify(CONTRACT)); // JSON은 YAML이기도 하다
  return root;
}

test('DT38_openapi:emit을가진서비스만_뽑아견주고_목록이없거나_문서를못만들면_실패한다', async () => {
  const root = project();
  services(root, {
    'good-svc': { scripts: { 'openapi:emit': 'x' }, peaket: { contractOperations: OWNS } },
    'bad-svc': { scripts: { 'openapi:emit': 'x' }, peaket: { contractOperations: OWNS } },
    'nolist-svc': { scripts: { 'openapi:emit': 'x' } },
    'broken-svc': { scripts: { 'openapi:emit': 'x' }, peaket: { contractOperations: ['GET /v1/other'] } },
    'plain-svc': { scripts: { build: 'x' } },
  });
  assert.deepEqual(serviceTargets(root), ['services/bad-svc', 'services/broken-svc', 'services/good-svc', 'services/nolist-svc']);
  const emitted = [];
  const emit = async (dir, out) => {
    const name = dir.split(/[\\/]/).pop();
    emitted.push(name);
    if (name === 'broken-svc') throw new Error('빌드 실패');
    const doc = clone(EMITTED);
    if (name === 'bad-svc') doc.paths['/v1/items/{itemId}'].get.responses['200'].content['application/json'].schema.properties.extra = { type: 'string' };
    writeFileSync(out, JSON.stringify(doc));
  };
  const r = await checkServices({ cwd: root, emit });
  assert.deepEqual(emitted.sort(), ['bad-svc', 'broken-svc', 'good-svc']); // 목록이 없는 서비스는 뽑지도 않는다
  const all = r.failures.join('\n');
  assert.match(all, /services\/bad-svc: .*extra.*계약에 없는 칸/);
  assert.match(all, /services\/broken-svc: 문서를 만들지 못했다: 빌드 실패/);
  assert.match(all, /services\/nolist-svc: .*contractOperations/);
  assert.doesNotMatch(all, /good-svc/);
  assert.deepEqual(r.checked, ['services/good-svc']);
});

test('DT38_뽑은문서가JSON이아니면_실패한다', async () => {
  const root = project();
  services(root, { 'x-svc': { scripts: { 'openapi:emit': 'x' }, peaket: { contractOperations: OWNS } } });
  const r = await checkServices({ cwd: root, emit: async (_dir, out) => writeFileSync(out, 'not json') });
  assert.match(r.failures.join('\n'), /services\/x-svc: 뽑은 문서를 읽지 못했다/);
});

test('DT38_contract-breaking_services는_서비스가없으면통과하고_비교본체를부른다', () => {
  const root = project();
  const script = fileURLToPath(new URL('./contract-breaking.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [script, 'services'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /openapi:emit을 가진 서비스가 없/);
  // 목록이 없는 서비스: 뽑기 전에 실패한다(pnpm을 부르지 않는다)
  services(root, { 'q-svc': { scripts: { 'openapi:emit': 'x' } } });
  const r2 = spawnSync(process.execPath, [script, 'services'], { cwd: root, encoding: 'utf8' });
  assert.equal(r2.status, 1, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /services\/q-svc: .*contractOperations/);
});
