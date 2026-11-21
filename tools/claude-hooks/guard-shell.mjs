#!/usr/bin/env node
// 셸 명령 훅의 실행 파일(ADR-0330). 규칙은 shell-rules.mjs에 있다. 실행 전이면 막거나 묻고, 실행 뒤면 알린다
import { run } from './lib.mjs';
import { pre, post } from './shell-rules.mjs';

run((input) => (input?.hook_event_name === 'PostToolUse' ? post(input) : pre(input)));
