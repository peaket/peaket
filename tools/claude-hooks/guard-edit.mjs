#!/usr/bin/env node
// 파일 편집 전 훅의 실행 파일(ADR-0330). 규칙은 edit-rules.mjs에 있다
import { run } from './lib.mjs';
import { preEdit } from './edit-rules.mjs';

run(preEdit);
