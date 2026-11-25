// IR-05: 명령 12(PG_ASSIGN)도 적용 확인 행이 있으면 상세 응답의 delivery가 APPLY_CHECK여야 한다(B16, ADR-0365 결정 14).
import { describe, expect, test } from 'vitest';
import { GetCommand } from '../src/modules/commands/application/get-command.js';
import { applyCheckViewOf, type ApplyCheckRow, type ApplyCheckStore, type Command, type CommandStore } from '../src/modules/commands/index.js';

const COMMAND_ID = '0193f100-0000-7000-8000-0000000000c1';
const row: ApplyCheckRow = {
  commandId: COMMAND_ID,
  stage: 'ACKED',
  version: 7,
  messageKey: '0193f100-0000-7000-8000-0000000000e1:PG_ASSIGNMENT:',
  outboxId: '0193f100-0000-7000-8000-0000000000f1',
  service: 'payment-svc',
  status: 'CHECKING',
  writtenAtMs: 1_000,
  sentAtMs: 1_500,
  pods: [{ pod: 'payment-svc-0' }],
  targetCount: 1,
  ackedCount: 0,
  alertOpen: false,
  nextCheckAtMs: 6_500,
  updatedAtMs: 1_500,
};

describe('IR-05 명령 12의 delivery', () => {
  test('PG_ASSIGN에 적용 확인 행이 있으면 delivery가 APPLY_CHECK다', async () => {
    const command = {
      commandId: COMMAND_ID,
      type: 'PG_ASSIGN',
      params: { eventId: '0193f100-0000-7000-8000-0000000000e1' },
    } as unknown as Command;
    const store = { find: async () => command } as unknown as CommandStore;
    const applyChecks: Pick<ApplyCheckStore, 'latestOf'> = { latestOf: async () => row };

    const got = await new GetCommand(store, undefined, applyChecks).execute(COMMAND_ID);

    expect(got.delivery).toEqual(applyCheckViewOf(row));
  });
});
