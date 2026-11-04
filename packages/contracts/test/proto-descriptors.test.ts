// 내부 gRPC 계약의 JSON 설명자(추천 적용 2026-11-03, BUILD_ORDER PRF-020). 서버는 .proto 파일 대신 이것을 @grpc/proto-loader에 넣는다.
import { expect, test } from 'vitest';
import { identityV1Identity } from '../src/gen/proto/index.js';
import { exportName, protoDescriptors } from '../scripts/proto-descriptors.mjs';

type Ns = { nested?: Record<string, Ns>; methods?: Record<string, { requestType: string; responseType: string }>; fields?: Record<string, unknown>; values?: Record<string, number> };
const at = (root: Ns, path: string): Ns => path.split('.').reduce<Ns>((n, k) => n.nested?.[k] as Ns, root);

test('PRF020_모든proto계약이_이름을다풀어_설명자가된다', () => {
  const all = protoDescriptors();
  expect(all.map((d) => d.rel)).toContain('peaket/identity/v1/identity.proto');
  expect(new Set(all.map((d) => d.name)).size).toBe(all.length);
});

test('PRF020_내보내는이름은_peaket을뺀경로다', () => {
  expect(exportName('peaket/identity/v1/identity.proto')).toBe('identityV1Identity');
  expect(exportName('peaket/purchase/v1/refund.proto')).toBe('purchaseV1Refund');
});

test('I-T50_ADR0119_identity설명자에_SessionService호출여섯이있다', () => {
  const svc = at(identityV1Identity as Ns, 'peaket.identity.v1.SessionService');
  // 계정 잇기 셋(GetLinkProposal·SeparateAccount·AddProvider)은 identity.proto가 더했다(BUILD_ORDER BOT-123이 넘겨받아 고침)
  expect(Object.keys(svc.methods ?? {})).toEqual(['CreateSession', 'GetLinkProposal', 'SeparateAccount', 'AddProvider', 'EndSession', 'IssueReauthToken']);
  expect(svc.methods?.IssueReauthToken).toMatchObject({ requestType: 'IssueReauthTokenRequest', responseType: 'IssueReauthTokenResponse' });
  expect(at(identityV1Identity as Ns, 'peaket.identity.v1.ReauthStrength').values).toEqual({
    REAUTH_STRENGTH_UNSPECIFIED: 0,
    REAUTH_STRENGTH_VERIFIED: 1,
    REAUTH_STRENGTH_REQUESTED: 2,
  });
  // import한 공용 형(Timestamp)도 함께 실린다
  expect(at(identityV1Identity as Ns, 'google.protobuf.Timestamp').fields).toBeDefined();
});
