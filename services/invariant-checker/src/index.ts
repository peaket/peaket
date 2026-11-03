// 불변식 검사기 공개 목록. 명령은 cli.ts, 시험·다른 도구는 runInvariantChecks를 바로 부른다.
export { CliError, parseCliArgs, type CliConfig } from './cli-args.js';
export { INVARIANTS, type InvariantDef } from './invariants.js';
export { RecordFormatError, emptyRecords, parseRecords, type PgChargeRecord, type QueueOpRecord, type QueueServingRecord, type TestRecords } from './records.js';
export { DETAIL_LIMIT, exitCode, kstIso, toCsv, toDetailNdjson, type InvariantResult, type Verdict, type Violation } from './report.js';
export { runInvariantChecks, type CheckOptions, type CheckRun } from './run.js';
export { SOURCES, SOURCE_TABLES, type SourceName, type SourceTable, type TableName } from './tables.js';
