// 시험 도우미: purchase-svc WithdrawalParticipantService.ProcessAccountWithdrawal·QuoteAccountWithdrawal을 계약 설명자로 부르는 클라이언트
// (BAT-010 리뷰 RV-04, BAT-013). services/bundle/test-int/start-files.int.test.ts가 시작 파일로 띄운 purchase-svc의 gRPC 포트를 부를 때 쓴다
// (그 패키지는 grpc-js를 직접 갖지 않는다).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { purchaseV1Account } from '@peaket/contracts/proto';

const LOAD: protoLoader.Options = { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true };
type Pkg = { WithdrawalParticipantService: grpc.ServiceClientConstructor };
type Unary = (req: object, md: grpc.Metadata, opts: grpc.CallOptions, cb: (e: grpc.ServiceError | null, v?: Record<string, unknown>) => void) => void;
type Client = grpc.Client & { ProcessAccountWithdrawal: Unary; QuoteAccountWithdrawal: Unary };
type Result = { ok: true; reply: Record<string, unknown> } | { ok: false; code: string };

async function once(address: string, method: 'ProcessAccountWithdrawal' | 'QuoteAccountWithdrawal', accountId: string, o: { token?: string; caller?: string; deadlineMs?: number } = {}): Promise<Result> {
  const def = protoLoader.fromJSON(purchaseV1Account as Parameters<typeof protoLoader.fromJSON>[0], LOAD);
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { purchase: { v1: Pkg } } }).peaket.purchase.v1;
  const client = new pkg.WithdrawalParticipantService(address, grpc.credentials.createInsecure()) as unknown as Client;
  const md = new grpc.Metadata();
  if (o.token !== undefined) md.set('x-peaket-internal-grpc-token', o.token);
  if (o.caller !== undefined) md.set('x-peaket-internal-grpc-caller', o.caller);
  try {
    const reply = await new Promise<Record<string, unknown>>((res, rej) =>
      client[method]({ account_id: accountId }, md, { deadline: new Date(Date.now() + (o.deadlineMs ?? 5_000)) }, (e, v) => (e ? rej(e) : res(v ?? {}))),
    );
    return { ok: true, reply };
  } catch (e) {
    return { ok: false, code: grpc.status[(e as grpc.ServiceError).code] ?? String(e) };
  } finally {
    client.close();
  }
}

/** 탈퇴 참여자에 그 계정의 정리를 시킨다. 답이면 { ok: true, reply }, gRPC 오류면 { ok: false, code: 상태 이름 } */
export const processAccountWithdrawal = (address: string, accountId: string, o: { token?: string; caller?: string; deadlineMs?: number } = {}): Promise<Result> =>
  once(address, 'ProcessAccountWithdrawal', accountId, o);

/** 탈퇴 전 미사용 티켓 견적(읽기 전용, I-T26 ①). 답이면 { ok: true, reply }, gRPC 오류면 { ok: false, code: 상태 이름 } */
export const quoteAccountWithdrawal = (address: string, accountId: string, o: { token?: string; caller?: string; deadlineMs?: number } = {}): Promise<Result> => once(address, 'QuoteAccountWithdrawal', accountId, o);
