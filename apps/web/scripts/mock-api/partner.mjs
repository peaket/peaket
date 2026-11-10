// 파트너 콘솔 가짜 API(공연 등록 위저드, ADR-0199·0245). 계약(docs/api/openapi.yaml) 모양만 맞춘다.
// 상태: /__mock/state?partner=ok|too-close|maintenance|schedule|down|unauthorized
// 공연 이미지(ADR-0257): /__mock/state?partnerImage=ok|spec|type|unavailable|limit 이 다음 올리기의 답을 정한다(ok가 기본).
// 처리 결과의 폭·높이는 PNG 머리(IHDR)에서 읽고, 없으면 1200×1600이다. 올린 행은 공연마다 메모리에 둔다(포스터 하나, 상세 10장).
// 가짜 API가 결함을 숨기지 않게 실서버(core-svc partner-media.controller·production-images)의 차례와 답을 따른다:
//   올리기: 공연(이 가짜 API로 등록한 것만, 그 밖은 404) → X-Requested-With(400) → 10MB(413, 본문을 버리며 읽은 뒤 답한다) → 칸 구조(400)
//   → 대체 텍스트 1~300자(422 ALT_INVALID) → 파일 앞부분·Content-Type·확장자(415) → 상세 10장(409)
//   고치기: 본문 칸(400) → 공연(404) → If-Match 없음(428) → 이미지(404) → 판(412). 바뀐 것이 없으면 판을 올리지 않고, 순서가 밀린 행도 판을 올린다
import { randomUUID } from 'node:crypto';

const ID = (n) => `0190f3a1-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;
const ARTISTS = [
  { artistId: ID(101), name: 'LUMEN' },
  { artistId: ID(102), name: '루멘 어쿠스틱' },
  { artistId: ID(103), name: '스텔라 밴드' },
];
const PLACES = [
  { placeId: ID(201), name: '피켓 아레나', address: '서울 송파구 올림픽로 1' },
  { placeId: ID(202), name: '피켓홀', address: '서울 마포구 양화로 10' },
];
const PROBLEM = 'application/problem+json';
const problem = (status, slug, extra = {}) => ({ type: `https://peaket.example/problems/${slug}`, title: slug, status, ...extra });
const NAMES = [320, 640, 960, 1280].flatMap((w) => [`${w}.avif`, `${w}.webp`]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 계약 ProductionImage. 기준 주소는 실서버처럼 경로 없는 출처 + /production/{imageId}다 */
export function productionImage(origin, row) {
  const url = `${new URL(origin).origin}/production/${row.imageId}`;
  return { imageId: row.imageId, kind: row.kind, alt: row.alt, order: row.order, width: row.width, height: row.height, version: row.version, url, derivatives: Object.fromEntries(NAMES.map((n) => [n, `${url}/${n}`])) };
}

/** 본문 바이트를 모은다. 상한을 넘으면 나머지를 버리며 끝까지 읽고 null(응답을 보낸 뒤 끊어 받는 쪽이 413을 읽게 한다) */
function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) over = true;
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

const pngSize = (b) => (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 12, 16) === 'IHDR' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : { width: 1200, height: 1600 });
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const BY_TYPE = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const BY_EXT = { jpg: 'jpeg', jpeg: 'jpeg', png: 'png', webp: 'webp' };
/** 파일 앞부분(JPEG FF D8 FF, PNG 시그니처, WebP RIFF????WEBP) */
function sniff(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return undefined;
}
const altValid = (alt) => {
  const n = [...alt].length;
  return n >= 1 && n <= 300 && !alt.includes('\u0000') && !/\p{Cs}/u.test(alt);
};
const badRequest = { type: 'about:blank', title: 'Bad Request', status: 400 };

export function createPartnerMock() {
  /** 멱등 키 → 처음 응답(같은 키로 다시 오면 같은 ID를 돌려준다) */
  const created = new Map();
  /** 마지막 등록 요청(브라우저 검사가 본문·멱등 키를 본다) */
  let last = null;
  /** 공연 ID → 이미지 행 목록 */
  const images = new Map();
  /** 받은 올리기 요청(브라우저 검사가 차례·칸을 본다) */
  const uploads = [];
  /** 이 가짜 API로 등록한 공연(그 밖의 공연은 남의 공연·없는 공연과 같은 404) */
  const mine = new Set();
  const listOf = (id) => images.get(id) ?? [];
  const renumber = (rows) => rows.filter((r) => r.kind === 'DETAIL').forEach((r, i) => (r.order = i));
  return {
    last: () => last,
    uploads: () => uploads,
    images: (id) => listOf(id),
    /** 파트너 경로면 처리하고 true */
    handle({ p, req, url, state, send, unauthorized, readJson }) {
      if (!p.startsWith('/v1/partner/')) return false;
      if (state.partner === 'unauthorized') {
        unauthorized();
        return true;
      }
      if ((p === '/v1/partner/artists' || p === '/v1/partner/places') && req.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
        if (q === '') {
          send(400, problem(400, 'validation-failed'), PROBLEM);
          return true;
        }
        const rows = p.endsWith('artists') ? ARTISTS : PLACES;
        send(200, { items: rows.filter((r) => r.name.toLowerCase().includes(q)), nextCursor: null });
        return true;
      }
      const img = /^\/v1\/partner\/productions\/([^/]+)\/images(?:\/([^/]+))?$/.exec(p);
      if (img && req.method === 'POST' && !img[2]) {
        const productionId = img[1];
        void readBody(req, IMAGE_MAX_BYTES + 65_536).then(async (buf) => {
          if (!mine.has(productionId)) return send(404, problem(404, 'not-found'), PROBLEM);
          if (!req.headers['x-requested-with']) return send(400, badRequest, PROBLEM);
          if (buf === null) return send(413, problem(413, 'image-too-large'), PROBLEM, { connection: 'close' });
          let form;
          try {
            form = await new Response(buf, { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
          } catch {
            return send(400, badRequest, PROBLEM);
          }
          const entries = [...form.entries()];
          const files = entries.filter(([, v]) => typeof v !== 'string');
          if (files.some(([, v]) => v.size > IMAGE_MAX_BYTES)) return send(413, problem(413, 'image-too-large'), PROBLEM);
          const values = new Map();
          for (const [k, v] of entries) {
            if (typeof v !== 'string') continue;
            if (!['kind', 'alt', 'order'].includes(k) || values.has(k)) return send(400, badRequest, PROBLEM);
            values.set(k, v);
          }
          const kind = values.get('kind');
          const order = values.get('order');
          if (files.length !== 1 || files[0][0] !== 'file' || (kind !== 'POSTER' && kind !== 'DETAIL') || !values.has('alt') || (order !== undefined && !/^[0-9]$/.test(order))) return send(400, badRequest, PROBLEM);
          const file = files[0][1];
          const alt = values.get('alt');
          uploads.push({ productionId, kind, alt, order: order === undefined ? undefined : Number(order), name: file.name });
          if (!altValid(alt)) return send(422, problem(422, 'image-spec-invalid', { reason: 'ALT_INVALID' }), PROBLEM);
          const bytes = Buffer.from(await file.arrayBuffer());
          const dot = file.name.lastIndexOf('.');
          const f = sniff(bytes.subarray(0, 16));
          if (f === undefined || f !== BY_TYPE[file.type.split(';')[0].trim().toLowerCase()] || f !== (dot >= 0 ? BY_EXT[file.name.slice(dot + 1).toLowerCase()] : undefined)) return send(415, problem(415, 'image-type-unsupported'), PROBLEM);
          const rows = listOf(productionId);
          const details = rows.filter((r) => r.kind === 'DETAIL');
          if (kind === 'DETAIL' && details.length >= 10) return send(409, problem(409, 'image-limit-exceeded'), PROBLEM);
          const mode = state.partnerImage ?? 'ok';
          if (mode === 'type') return send(415, problem(415, 'image-type-unsupported'), PROBLEM);
          if (mode === 'spec') return send(422, problem(422, 'image-spec-invalid', { reason: kind === 'POSTER' ? 'POSTER_SPEC' : 'DETAIL_SPEC' }), PROBLEM);
          if (mode === 'unavailable') return send(503, problem(503, 'image-processing-unavailable'), PROBLEM, { 'retry-after': '30' });
          if (mode === 'limit') return send(409, problem(409, 'image-limit-exceeded'), PROBLEM);
          const row = { imageId: randomUUID(), kind, alt, order: 0, version: 1, ...pngSize(bytes) };
          if (kind === 'POSTER') images.set(productionId, [row, ...rows.filter((r) => r.kind !== 'POSTER')]);
          else {
            details.splice(Math.min(order === undefined ? details.length : Number(order), details.length), 0, row);
            renumber(details);
            images.set(productionId, [...rows.filter((r) => r.kind === 'POSTER'), ...details]);
          }
          return send(201, productionImage(`http://${req.headers.host}`, row), 'application/json; charset=utf-8', { etag: `"${row.version}"` });
        });
        return true;
      }
      if (img && img[2] && req.method === 'DELETE') {
        const rows = listOf(img[1]);
        const row = mine.has(img[1]) && UUID.test(img[2]) ? rows.find((r) => r.imageId === img[2]) : undefined;
        if (!row) send(404, problem(404, 'not-found'), PROBLEM);
        else if (row.kind === 'POSTER') send(409, problem(409, 'poster-not-deletable'), PROBLEM);
        else {
          const rest = rows.filter((r) => r !== row);
          for (const r of rest.filter((x) => x.kind === 'DETAIL')) {
            const before = r.order;
            r.order = rest.filter((x) => x.kind === 'DETAIL').indexOf(r);
            if (r.order !== before) r.version += 1;
          }
          images.set(img[1], rest);
          send(204, undefined);
        }
        return true;
      }
      if (img && img[2] && req.method === 'PATCH') {
        const ifMatch = req.headers['if-match'];
        void readJson(req).then((body) => {
          const keys = body && typeof body === 'object' ? Object.keys(body) : null;
          const altOk = body?.alt === undefined || (typeof body.alt === 'string' && [...body.alt].length >= 1 && [...body.alt].length <= 300);
          const orderOk = body?.order === undefined || (Number.isInteger(body.order) && body.order >= 0 && body.order <= 9);
          if (!keys || keys.some((k) => k !== 'alt' && k !== 'order') || !altOk || !orderOk) return send(400, badRequest, PROBLEM);
          if (!mine.has(img[1])) return send(404, problem(404, 'not-found'), PROBLEM);
          if (ifMatch === undefined) return send(428, problem(428, 'precondition-required'), PROBLEM);
          const rows = listOf(img[1]);
          const row = UUID.test(img[2]) ? rows.find((r) => r.imageId === img[2]) : undefined;
          if (!row) return send(404, problem(404, 'not-found'), PROBLEM);
          if (ifMatch !== `"${row.version}"`) return send(412, problem(412, 'precondition-failed'), PROBLEM);
          if (row.kind === 'POSTER' && body.order !== undefined && body.order !== 0) return send(400, badRequest, PROBLEM);
          let changed = typeof body.alt === 'string' && body.alt !== row.alt;
          if (changed) row.alt = body.alt;
          if (row.kind === 'DETAIL' && body.order !== undefined && body.order !== row.order) {
            const details = rows.filter((r) => r.kind === 'DETAIL' && r !== row);
            details.splice(Math.min(body.order, details.length), 0, row);
            details.forEach((r, i) => {
              if (r.order !== i && r !== row) r.version += 1;
              if (r === row && r.order !== i) changed = true;
              r.order = i;
            });
            images.set(img[1], [...rows.filter((r) => r.kind === 'POSTER'), ...details]);
          }
          if (changed) row.version += 1;
          return send(200, productionImage(`http://${req.headers.host}`, row), 'application/json; charset=utf-8', { etag: `"${row.version}"` });
        });
        return true;
      }
      if (p === '/v1/partner/productions' && req.method === 'POST') {
        const key = req.headers['idempotency-key'];
        void readJson(req).then((body) => {
          last = { key, body };
          if (state.partner === 'down') return send(503, problem(503, 'server-busy'), PROBLEM);
          if (state.partner === 'too-close') return send(409, problem(409, 'open-too-close', { eventIndex: 0, suggestedOpenAt: new Date(Date.parse(body?.events?.[0]?.openAt) + 300_000).toISOString() }), PROBLEM);
          if (state.partner === 'maintenance') return send(409, problem(409, 'open-maintenance-window', { eventIndex: 0 }), PROBLEM);
          if (state.partner === 'schedule') return send(422, problem(422, 'event-schedule-invalid', { eventIndex: 0 }), PROBLEM);
          if (!created.has(key)) created.set(key, { productionId: randomUUID(), eventIds: (body?.events ?? []).map(() => randomUUID()), warnings: [] });
          mine.add(created.get(key).productionId);
          return send(201, created.get(key));
        });
        return true;
      }
      return false;
    },
  };
}
