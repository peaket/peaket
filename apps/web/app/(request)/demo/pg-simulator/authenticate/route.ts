// 데모 SIMULATOR 결제창의 서버 경로(FE-T21, ADR-0253). PEAKET_ENV가 local·ci·demo일 때만 PG 시뮬레이터의 시험 인증을 대신 부른다(그 밖은 404).
// 시뮬레이터 비밀 키는 서버 환경 값으로만 읽고 브라우저로 보내지 않는다.
import { NextResponse } from 'next/server';

const ORDER = /^[A-Za-z0-9_-]{6,64}$/;
const notFound = () => new NextResponse(null, { status: 404, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request): Promise<Response> {
  const env = process.env.PEAKET_ENV;
  const base = process.env.PEAKET_PG_SIM_URL;
  const secret = process.env.PEAKET_PG_SIM_SECRET_KEY;
  if ((env !== 'local' && env !== 'ci' && env !== 'demo') || !base || !secret) return notFound();
  let body: { orderId?: unknown; amount?: unknown; orderName?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ type: 'about:blank', status: 400 }, { status: 400 });
  }
  if (typeof body.orderId !== 'string' || !ORDER.test(body.orderId) || typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount <= 0) {
    return NextResponse.json({ type: 'about:blank', status: 400 }, { status: 400 });
  }
  const orderName = typeof body.orderName === 'string' && body.orderName.length > 0 ? body.orderName.slice(0, 100) : undefined;
  let r: Response;
  try {
    r = await fetch(new URL('/sim/authenticate', base), {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${secret}:`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ orderId: body.orderId, amount: body.amount, ...(orderName ? { orderName } : {}) }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return NextResponse.json({ type: 'about:blank', status: 502 }, { status: 502 });
  }
  if (!r.ok) return NextResponse.json({ type: 'about:blank', status: 502 }, { status: 502 });
  const paymentKey = ((await r.json()) as { paymentKey?: unknown }).paymentKey;
  return NextResponse.json({ paymentKey }, { headers: { 'cache-control': 'no-store' } });
}
