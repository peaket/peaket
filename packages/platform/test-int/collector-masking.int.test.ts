// 실제 수집기 두 단의 2차 마스킹(V-T49 ③, docs/observability.md §7 '개인정보 2단계 마스킹 통제'·'2차 마스킹 정규식 원천',
// §1 '설정 원천과 로컬 확인', docs/verification.md V-T49 ③, docs/security/asvs/delivery.md 16.2.5, 계획 docs/review/plans/F-01-3.md §5·§6).
// 정본: 게이트웨이 수집기는 로그 본문·로그 속성·span 속성·자원 속성의 글 값에 원천(pii-patterns.json)의 꼴을 걸어 `[REDACTED]`로 바꾸고,
// IP를 담는 속성(client.address·network.peer.address·source.address)은 앞부분 꼴(a.b.c.0/24, h:h:h::/48)이면 그대로, IPv4는 앞부분으로,
// 그 밖은 `[REDACTED]`로 바꾼다. 같은 글은 수집기와 maskPiiText(오류 수집 가림)에서 같은 결과가 된다.
// 서비스 템플릿의 1차 가림·IP 앞부분이 값을 먼저 지우므로(같은 규칙을 두 곳에서 지킴), 이 시험은 서비스를 거치지 않고 원문 값을 수집기에 바로 넣는다
// (계획 §9). 로그 본문은 에이전트의 filelog 자리(/var/log/pods)에 쓴 CRI 줄로, 로그 속성·자원 속성은 게이트웨이(peaket-gw-0)에 OTLP로,
// span은 에이전트에 OTLP로 보낸다(에이전트 → 부하 분산 → 게이트웨이 둘). 개인정보는 분해한 칸이 아니라 결과 파일 원문 바이트에서 찾는다.
// span은 꼬리 표본을 지나야 하므로 peaket.sample.keep=true를 단다.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { maskPiiText } from '../src/pii-text.js';
import { GATEWAY_ALIASES, attr, bool, createNetwork, podLogs, pollUntil, postOtlp, spanIdOf, startAgent, startGateway, str, traceIdOf, type CollectorContainer, type CollectorOutput } from './collector.js';

/** 넣는 원문 값(코드 상수와 겹치지 않게 고른다). 값마다 결과 바이트에 없어야 한다 */
const RAW = {
  email: 'mask.fan@example.co.kr',
  quotedEmail: 'quoted_fan@mail.example.org',
  emailPairA: 'pair.one@example.net',
  emailPairB: 'pair.two@example.com',
  phoneHyphen: '010-3141-5926',
  phoneCompact: '01127182818',
  phonePairA: '01055501234',
  phonePairB: '01699998888',
  e164: '+821062831853',
  cardHyphen: '4000-0025-0000-3155',
  cardSpace: '3782 8224 6310 0050',
  cardCompact: '6200000000000005',
  account: '98765432109876',
  ipv4Raw: '203.0.113.77',
  ipv4Raw2: '192.0.2.201',
  ipv6Raw: '2001:db8:abcd:12::1',
  host: 'fan-laptop.home.example',
} as const;

/** 글 값(본문·속성). 사람이 쓴 로그처럼 원문 값을 섞는다 */
const TEXTS = {
  emails: `case=T1 가입 실패 ${RAW.email} user="${RAW.quotedEmail}" pair=${RAW.emailPairA},${RAW.emailPairB}`,
  phones: `case=T2 문자 실패 ${RAW.phoneHyphen} ${RAW.phoneCompact} 둘 ${RAW.phonePairA}/${RAW.phonePairB} 국제 ${RAW.e164}`,
  cards: `case=T3 승인 거절 ${RAW.cardHyphen} / ${RAW.cardSpace} / ${RAW.cardCompact}`,
  account: `case=T4 POST /platform/bank-accounts/KOOKMIN/${RAW.account}/holder 502`,
};
/** 앞부분 꼴(그대로 남아야 하는 값) */
const PREFIX = { v4: '198.51.100.0/24', v6: '2001:db8:beef::/48' };

const TRACE = traceIdOf(0x3a);
const ns = { namespace: 'peaket-it', pod: 'demo-svc-7d9f6c', uid: '0f2b1c3d-aaaa-bbbb-cccc-ddddeeeeffff', container: 'demo-svc' };

let net: ReturnType<typeof createNetwork>;
let pods: ReturnType<typeof podLogs>;
const gateways: CollectorContainer[] = [];
let agent: CollectorContainer | undefined;
let outputs: CollectorOutput[] = [];

beforeAll(async () => {
  net = createNetwork();
  pods = podLogs(ns);
  for (const alias of GATEWAY_ALIASES) gateways.push(await startGateway({ network: net.name, alias }));
  agent = await startAgent({ network: net.name, podLogsDir: pods.dir });
  // 로그 본문: 수집기가 뜬 뒤에 파일을 만든다(filelog는 처음 본 파일을 처음부터 읽는다)
  pods.writeCri(Object.values(TEXTS));
  // 로그 속성·자원 속성: 게이트웨이 peaket-gw-0에 바로
  await postOtlp(gateways[0]!.otlpHttp, 'logs', {
    resourceLogs: [
      {
        resource: { attributes: [str('service.name', 'demo-svc'), str('peaket.it.resource_note', TEXTS.emails)] },
        scopeLogs: [{ logRecords: [{ timeUnixNano: '1795400000000000000', body: { stringValue: 'case=A1 속성 시험' }, attributes: [str('peaket.it.phones', TEXTS.phones), str('peaket.it.cards', TEXTS.cards), str('peaket.it.account', TEXTS.account)] }] }],
      },
    ],
  });
  // span: 에이전트에(부하 분산을 지나 게이트웨이 둘 가운데 하나로 간다)
  await postOtlp(agent.otlpHttp, 'traces', {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'demo-svc'), str('peaket.it.resource_note', TEXTS.cards)] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: TRACE,
                spanId: spanIdOf(0x3a, 1),
                name: 'POST /v1/demo/mask',
                kind: 2,
                startTimeUnixNano: '1795400000000000000',
                endTimeUnixNano: '1795400000050000000',
                attributes: [
                  bool('peaket.sample.keep', true),
                  str('peaket.it.emails', TEXTS.emails),
                  str('peaket.it.phones', TEXTS.phones),
                  str('url.full', `https://api.portone.io/platform/bank-accounts/KOOKMIN/${RAW.account}/holder`),
                  str('client.address', RAW.ipv4Raw),
                  str('network.peer.address', PREFIX.v4),
                  str('source.address', RAW.ipv6Raw),
                ],
              },
              {
                traceId: TRACE,
                spanId: spanIdOf(0x3a, 2),
                parentSpanId: spanIdOf(0x3a, 1),
                name: 'child',
                kind: 1,
                startTimeUnixNano: '1795400000010000000',
                endTimeUnixNano: '1795400000020000000',
                attributes: [str('client.address', PREFIX.v6), str('network.peer.address', RAW.ipv4Raw2), str('source.address', RAW.host)],
              },
            ],
          },
        ],
      },
    ],
  });
  // 결과가 다 나올 때까지: 로그 본문 넷(case=T1~T4), 속성 로그 하나(case=A1), span 둘. 꼬리 표본의 판정 대기만큼 걸린다
  outputs = await pollUntil(
    '수집기 결과',
    () => {
      const outs = gateways.map((g) => g.output());
      const logs = outs.flatMap((o) => o.logs);
      const spans = outs.flatMap((o) => o.spans).filter((s) => s.span.traceId === TRACE);
      const bodies = logs.map((l) => l.record.body?.stringValue ?? '');
      const allBodies = ['case=T1', 'case=T2', 'case=T3', 'case=T4', 'case=A1'].every((c) => bodies.some((b) => b.includes(c)));
      return allBodies && spans.length === 2 ? outs : undefined;
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  ).catch((err: unknown) => {
    throw new Error(`${String(err)}\n--- 에이전트 로그\n${agent?.logs()}\n--- 게이트웨이 로그\n${gateways.map((g) => g.logs()).join('\n---\n')}`);
  });
}, 240_000);

afterAll(() => {
  agent?.stop();
  for (const g of gateways) g.stop();
  net?.remove();
  pods?.remove();
});

const allSpans = () => outputs.flatMap((o) => o.spans).filter((s) => s.span.traceId === TRACE);
const allLogs = () => outputs.flatMap((o) => o.logs);
const bodyWith = (marker: string) => allLogs().find((l) => (l.record.body?.stringValue ?? '').includes(marker));

describe('V-T49 ③ 실제 수집기 두 단의 2차 마스킹', () => {
  test('V-T49 ③-7 [ASVS v5.0.0-16.2.5] 실제 수집기 두 단을 지난 결과 파일 원문 바이트에 넣은 원문 값이 없다(값마다)', () => {
    const bytes = outputs.map((o) => `${o.tracesRaw}\n${o.logsRaw}`).join('\n');
    // 빈 결과가 통과로 새지 않게: 로그와 span이 하나 이상 있다
    expect(allLogs().length).toBeGreaterThanOrEqual(5);
    expect(allSpans()).toHaveLength(2);
    for (const [what, value] of Object.entries(RAW)) expect(bytes, what).not.toContain(value);
  });

  test.each([
    ['T1', TEXTS.emails],
    ['T2', TEXTS.phones],
    ['T3', TEXTS.cards],
    ['T4', TEXTS.account],
  ])('V-T49 ③-8 [ASVS v5.0.0-16.2.5] filelog로 읽은 로그 본문(case=%s)은 maskPiiText와 같은 결과다', (marker, text) => {
    const rec = bodyWith(`case=${marker}`);
    expect(rec?.record.body?.stringValue).toBe(maskPiiText(text));
    // maskPiiText가 실제로 무언가를 가렸다(같은 결과가 '둘 다 안 가림'으로 맞지 않게)
    expect(maskPiiText(text)).toContain('[REDACTED]');
  });

  test('V-T49 ③-9 [ASVS v5.0.0-16.2.5] 로그 속성과 자원 속성의 글 값은 maskPiiText와 같은 결과다', () => {
    const rec = bodyWith('case=A1');
    expect(rec).toBeDefined();
    expect(attr(rec!.record.attributes, 'peaket.it.phones')?.stringValue).toBe(maskPiiText(TEXTS.phones));
    expect(attr(rec!.record.attributes, 'peaket.it.cards')?.stringValue).toBe(maskPiiText(TEXTS.cards));
    expect(attr(rec!.record.attributes, 'peaket.it.account')?.stringValue).toBe(maskPiiText(TEXTS.account));
    expect(attr(rec!.resource, 'peaket.it.resource_note')?.stringValue).toBe(maskPiiText(TEXTS.emails));
  });

  test('V-T49 ③-10 [ASVS v5.0.0-16.2.5] span 속성과 자원 속성의 글 값은 maskPiiText와 같은 결과다', () => {
    const root = allSpans().find((s) => s.span.spanId === spanIdOf(0x3a, 1));
    expect(root).toBeDefined();
    const a = root!.span.attributes;
    expect(attr(a, 'peaket.it.emails')?.stringValue).toBe(maskPiiText(TEXTS.emails));
    expect(attr(a, 'peaket.it.phones')?.stringValue).toBe(maskPiiText(TEXTS.phones));
    expect(attr(a, 'url.full')?.stringValue).toBe(`https://api.portone.io/platform/bank-accounts/KOOKMIN/[REDACTED]/holder`);
    expect(attr(root!.resource, 'peaket.it.resource_note')?.stringValue).toBe(maskPiiText(TEXTS.cards));
    // 글이 아닌 값은 그대로다
    expect(attr(a, 'peaket.sample.keep')?.boolValue).toBe(true);
  });

  test('V-T49 ③-11 [ASVS v5.0.0-16.2.5] IP 속성: 원문 IPv4는 앞부분으로, 앞부분 꼴은 그대로, 그 밖의 값은 가림 표시로 바뀐다', () => {
    const root = allSpans().find((s) => s.span.spanId === spanIdOf(0x3a, 1))!;
    const child = allSpans().find((s) => s.span.spanId === spanIdOf(0x3a, 2))!;
    expect(attr(root.span.attributes, 'client.address')?.stringValue).toBe('203.0.113.0/24');
    expect(attr(root.span.attributes, 'network.peer.address')?.stringValue).toBe(PREFIX.v4);
    // 원문 IPv6는 가림 표시(또는 /48 앞부분, ipPrefix 꼴)
    expect(['[REDACTED]', '2001:db8:abcd::/48']).toContain(attr(root.span.attributes, 'source.address')?.stringValue);
    expect(attr(child.span.attributes, 'client.address')?.stringValue).toBe(PREFIX.v6);
    expect(attr(child.span.attributes, 'network.peer.address')?.stringValue).toBe('192.0.2.0/24');
    expect(attr(child.span.attributes, 'source.address')?.stringValue).toBe('[REDACTED]');
  });
});
