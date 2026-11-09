// 파트너 콘솔 가짜 API(공연 등록 위저드, ADR-0199·0245). 계약(docs/api/openapi.yaml) 모양만 맞춘다.
// 상태: /__mock/state?partner=ok|too-close|maintenance|schedule|down|unauthorized
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

export function createPartnerMock() {
  /** 멱등 키 → 처음 응답(같은 키로 다시 오면 같은 ID를 돌려준다) */
  const created = new Map();
  /** 마지막 등록 요청(브라우저 검사가 본문·멱등 키를 본다) */
  let last = null;
  return {
    last: () => last,
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
      if (p === '/v1/partner/productions' && req.method === 'POST') {
        const key = req.headers['idempotency-key'];
        void readJson(req).then((body) => {
          last = { key, body };
          if (state.partner === 'down') return send(503, problem(503, 'server-busy'), PROBLEM);
          if (state.partner === 'too-close') return send(409, problem(409, 'open-too-close', { eventIndex: 0, suggestedOpenAt: new Date(Date.parse(body?.events?.[0]?.openAt) + 300_000).toISOString() }), PROBLEM);
          if (state.partner === 'maintenance') return send(409, problem(409, 'open-maintenance-window', { eventIndex: 0 }), PROBLEM);
          if (state.partner === 'schedule') return send(422, problem(422, 'event-schedule-invalid', { eventIndex: 0 }), PROBLEM);
          if (!created.has(key)) created.set(key, { productionId: randomUUID(), eventIds: (body?.events ?? []).map(() => randomUUID()), warnings: [] });
          return send(201, created.get(key));
        });
        return true;
      }
      return false;
    },
  };
}
