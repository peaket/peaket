#!/usr/bin/env node
// peaket-runbook 시작 파일(비상 Job, ADR-0239·ADR-0053·ADR-0102): draft|sign|run.
// 제어 갈래는 runbook-cli-main이 gRPC·감사·주소를 조립하고 대기열 Redis를 열지 않는다(IR027-01·02).
import { runRunbookCliMain } from './runbook-cli-main.js';

process.exitCode = await runRunbookCliMain({ argv: process.argv.slice(2), env: process.env });
