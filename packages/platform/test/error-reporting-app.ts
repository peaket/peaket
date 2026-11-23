// 오류 수집 시험(error-reporting.test.ts)의 시험 서비스와 가짜 수신기. 시험 대상이 아니다.
// - 시험 서비스: createService로 띄운다. 로그인한 요청(identify)이 이메일·전화번호 본문을 받아 DB 쓰기에 실패하는 경로(5xx),
//   같은 요청 모양의 4xx·정상 분기 거절, 바깥 제공자를 부르는 경로를 둔다
// - 가짜 수신기: Sentry 받는 곳의 사건 묶음 입구(POST /api/<프로젝트>/envelope/?sentry_key=…)만 흉내 내는 node:http 서버.
//   진짜 SDK(@sentry/core)가 보낸 바이트를 그대로 받아 사건 묶음(envelope) 형식대로 푼다(Sentry 개발 문서 'Envelopes':
//   머리 줄 하나, 그 뒤 항목마다 항목 머리 줄과 본문. 항목 머리에 length가 있으면 본문은 그 바이트 수, 없으면 다음 줄바꿈까지)
// 텔레메트리를 먼저 띄우는 시험이 이 파일을 동적으로 읽는다(node:http를 계측하기 전에 읽히지 않게)
import 'reflect-metadata';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import { ProblemError, Roles, createExternalHttpClient, requestLog } from '../src/index.js';

/** 로그인한 팬의 원문 계정 ID(사건에는 가명 accountRef만 가야 한다) */
export const RAW_ACCOUNT_ID = 'acct-raw-5521';
/**
 * 오류 글(바깥 오류)에 넣는 값. 요청 본문 값과 겹치지 않게 고른다(본문이 새면 본문 시험이 잡는다).
 * 이메일(맨 것·DB 오류처럼 따옴표 안), 휴대폰(국내 하이픈, 붙여 쓴 것, 국제 표기 E.164 `+82…`, docs/features/identity.md의 phone_e164),
 * 카드(결제사 시험 번호: 하이픈, 구분자 없는 16자리)
 */
export const PII_IN_MESSAGE = {
  email: 'msg.fan@example.org',
  quotedEmail: 'quoted.fan@example.net',
  phone: '010-4444-0188',
  phoneCompact: '01022220166',
  phoneE164: '+821033330177',
  card: '4111-1111-1111-1111',
  cardPlain: '5555555555554444',
};
/** 원인 오류(cause) 글에 넣는 값 */
export const PII_IN_CAUSE = { email: 'other.fan@example.com', phone: '010-7777-0123', card: '4012 8888 8888 1881' };
/** 바깥 호출 시험이 정하는 모의 외부 서버 주소 */
export const outbound = { baseUrl: 'http://127.0.0.1:9' };

@Controller('v1/err')
@Roles(['public'])
export class ErrController {
  /** 프로필 저장: 본문 값이 쿼리 매개변수로 들어간 DB 쓰기가 실패한다(예상하지 못한 오류, 5xx) */
  @Post('profile')
  profile(@Body() body: { email: string; phone: string; note: string }) {
    requestLog().identify({ accountId: RAW_ACCOUNT_ID });
    throw new DrizzleQueryError('insert into fan_profile (email, phone, note) values ($1, $2, $3)', [body.email, body.phone, body.note], Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }));
  }

  /** 같은 요청 모양의 일반 5xx(이름 없는 오류) */
  @Post('crash')
  crash(@Body() _body: unknown) {
    requestLog().identify({ accountId: RAW_ACCOUNT_ID });
    throw new Error('profile store exploded');
  }

  /** 글에 연락처·카드 번호가 든 이름 없는 5xx와 그 원인 사슬(RV012-5). 값은 PII_IN_MESSAGE·PII_IN_CAUSE */
  @Post('pii-crash')
  piiCrash(@Body() _body: unknown) {
    requestLog().identify({ accountId: RAW_ACCOUNT_ID });
    const m = PII_IN_MESSAGE;
    throw new Error(`프로필 저장 실패: ${m.email} ${m.phone} 카드 ${m.card}; invalid input syntax for type uuid: "${m.quotedEmail}"; 국제 ${m.phoneE164} 붙임 ${m.phoneCompact} 카드 ${m.cardPlain}`, {
      cause: new Error(`원인: 다른 연락처 ${PII_IN_CAUSE.email} ${PII_IN_CAUSE.phone} 카드 ${PII_IN_CAUSE.card}`),
    });
  }

  /** 정상 분기 거절(좌석 경합 409) */
  @Post('hold')
  hold(@Body() _body: unknown) {
    requestLog().identify({ accountId: RAW_ACCOUNT_ID });
    throw new ProblemError({ type: 'seat-already-held', status: 409, title: '좌석이 이미 선택되었습니다', normalBranch: true });
  }

  /** 4xx(과부하 거절 429) */
  @Post('busy')
  busy(@Body() _body: unknown) {
    requestLog().identify({ accountId: RAW_ACCOUNT_ID });
    throw new ProblemError({ type: 'server-busy', status: 429, title: '잠시 뒤에 다시 시도해 주세요', retryAfterSeconds: 2 });
  }

  /** 바깥 제공자 호출(V-T31 ③과 같은 클라이언트) */
  @Get('call-out')
  async callOut() {
    const client = createExternalHttpClient({ provider: 'toss-payments', baseUrl: outbound.baseUrl, timeoutCapMs: 3_000 });
    const res = await client.request({ method: 'POST', path: '/v1/payments/{paymentKey}/confirm', params: { paymentKey: 'tgen_abc' }, body: '{}' });
    return { status: res.status };
  }
}

@Module({ controllers: [ErrController] })
export class ErrModule {}

// ---- 가짜 수신기 ----

export interface EnvelopeItem {
  header: Record<string, unknown>;
  payload: Buffer;
}

export interface ReceivedEnvelope {
  url: string;
  headers: IncomingHttpHeaders;
  /** 받은 본문 바이트(압축을 풀었으면 푼 것) */
  raw: Buffer;
  header: Record<string, unknown>;
  items: EnvelopeItem[];
}

/** Sentry 사건 묶음을 형식대로 푼다. 형식이 틀리면 던진다(가짜가 아무것이나 받아 통과하지 않게) */
export function parseEnvelope(raw: Buffer): { header: Record<string, unknown>; items: EnvelopeItem[] } {
  let pos = 0;
  const line = (): Buffer => {
    const nl = raw.indexOf(0x0a, pos);
    const end = nl < 0 ? raw.length : nl;
    const out = raw.subarray(pos, end);
    pos = nl < 0 ? raw.length : nl + 1;
    return out;
  };
  const header = JSON.parse(line().toString('utf8')) as Record<string, unknown>;
  const items: EnvelopeItem[] = [];
  while (pos < raw.length) {
    const h = line();
    if (h.length === 0) continue;
    const itemHeader = JSON.parse(h.toString('utf8')) as Record<string, unknown>;
    if (typeof itemHeader.type !== 'string') throw new Error(`사건 묶음 항목 머리에 type이 없다: ${h.toString('utf8')}`);
    let payload: Buffer;
    if (typeof itemHeader.length === 'number') {
      payload = raw.subarray(pos, pos + itemHeader.length);
      if (payload.length !== itemHeader.length) throw new Error('사건 묶음 항목 본문이 length보다 짧다');
      pos += itemHeader.length;
      if (raw[pos] === 0x0a) pos += 1;
    } else payload = line();
    items.push({ header: itemHeader, payload });
  }
  return { header, items };
}

export interface FakeReceiver {
  /** DSN(공개 키 key, 프로젝트 42) */
  dsn: string;
  key: string;
  /** 받아서 푼 사건 묶음 */
  envelopes: ReceivedEnvelope[];
  /** 입구가 아닌 곳·틀린 키로 온 요청(있으면 SDK와 짝이 틀린 것) */
  rejected: { url: string; reason: string }[];
  /** 답을 보낸 요청 수 */
  answered: () => number;
  /** 사건(type event) 본문을 JSON으로 */
  events: () => Record<string, unknown>[];
  /** n번째 묶음이 올 때까지 기다린다 */
  waitFor: (n: number) => Promise<void>;
  close: () => Promise<void>;
}

/**
 * 가짜 수신기를 띄운다. respondAfterMs를 주면 그만큼 늦게 답한다(느린 받는 곳), hang이면 답하지 않는다(멈춘 받는 곳)
 */
export async function startFakeReceiver(o: { respondAfterMs?: number; hang?: boolean } = {}): Promise<FakeReceiver> {
  const key = 'f00dfacecafe4b1d9e2a7c3b5d6e8f01';
  const envelopes: ReceivedEnvelope[] = [];
  const rejected: { url: string; reason: string }[] = [];
  const waiters: { n: number; resolve: () => void }[] = [];
  let answered = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const u = new URL(url, 'http://receiver');
      const reject = (status: number, reason: string) => {
        rejected.push({ url, reason });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: reason }));
        answered++;
      };
      if (req.method !== 'POST' || u.pathname !== '/api/42/envelope/') return reject(404, `입구가 아니다: ${req.method} ${u.pathname}`);
      if (u.searchParams.get('sentry_key') !== key || u.searchParams.get('sentry_version') !== '7') return reject(403, 'sentry_key·sentry_version이 틀리다');
      let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') raw = gunzipSync(raw);
      const parsed = parseEnvelope(raw);
      envelopes.push({ url, headers: req.headers, raw, ...parsed });
      for (const w of waiters.filter((x) => envelopes.length >= x.n)) w.resolve();
      if (o.hang) return;
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: parsed.header.event_id }));
        answered++;
      };
      // real-time: 느린 받는 곳을 흉내 낸다(SDK가 끝낼 때 답을 기다리는지 본다). 시험 쪽 대기가 아니다 F-01-2
      if (o.respondAfterMs) setTimeout(answer, o.respondAfterMs);
      else answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  return {
    dsn: `http://${key}@127.0.0.1:${port}/42`,
    key,
    envelopes,
    rejected,
    answered: () => answered,
    events: () => envelopes.flatMap((e) => e.items.filter((i) => i.header.type === 'event').map((i) => JSON.parse(i.payload.toString('utf8')) as Record<string, unknown>)),
    waitFor: (n) => (envelopes.length >= n ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ n, resolve }))),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
