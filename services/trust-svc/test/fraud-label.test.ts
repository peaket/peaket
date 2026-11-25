// F-04-13 부정 예매 라벨 출처의 trust-svc 경계 시험(동결 로컬, LCH-270·LCH-280, FX-T12).
// ops-svc GrpcFraudLabels가 넘기는 FRAUD_ACTIONED/BOT, FRAUD_APPEAL_ACCEPTED/HUMAN을 trust-svc가 받는지 본다.
import { describe, expect, test } from 'vitest';
import { validateLabel } from '../src/modules/scoring/domain/labels.js';

const CASE = '0194b240-0000-7000-8000-000000000001';
const EVENT = '0194b240-0000-7000-8000-000000000002';
const ACCOUNT = '0194b240-0000-7000-8000-000000000003';
const ACTOR = '0194b240-0000-7000-8000-000000000004';

const request = (source: 'FRAUD_ACTIONED' | 'FRAUD_APPEAL_ACCEPTED', label: 'BOT' | 'HUMAN') => ({
  sourceRef: CASE,
  sourceVersion: 2,
  source,
  label,
  eventId: EVENT,
  pid: ACCOUNT,
  queueEntryId: '',
  actedBy: ACTOR,
  deviceRef: '',
  reviewBatch: undefined,
  appliedVerdict: undefined,
  verdictEventKey: '',
});

describe('F-04-13 부정 예매 라벨', () => {
  test('FX-T12 76 trust-svc는 FRAUD_ACTIONED/BOT과 FRAUD_APPEAL_ACCEPTED/HUMAN을 받는다', () => {
    expect(validateLabel(request('FRAUD_ACTIONED', 'BOT'))).toMatchObject({ source: 'FRAUD_ACTIONED', label: 'BOT', sourceVersion: 2 });
    expect(validateLabel(request('FRAUD_APPEAL_ACCEPTED', 'HUMAN'))).toMatchObject({ source: 'FRAUD_APPEAL_ACCEPTED', label: 'HUMAN' });
  });
});
