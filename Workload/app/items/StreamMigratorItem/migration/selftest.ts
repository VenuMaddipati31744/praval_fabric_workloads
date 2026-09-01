/**
 * Self-test for the migration engine.
 *
 * The repo has no test runner, so this is a plain script: compile it to
 * CommonJS and run it with node. From the Workload directory:
 *
 *   node_modules/.bin/tsc app/items/StreamMigratorItem/migration/selftest.ts \
 *     --outDir <tmp> --module commonjs --target ES2017 --esModuleInterop \
 *     --skipLibCheck --moduleResolution node
 *   node <tmp>/items/StreamMigratorItem/migration/selftest.js
 *
 * Exits non-zero on the first failed assertion.
 */

import { buildMigrationPlan } from "./mapping/topology";
import { stripSqlComments } from "./mapping/queryMap";
import { buildCreateEventstreamRequest, toBase64 } from "./emit/ItemPayload";
import { isAsyncOperation } from "./execute/asyncOperation";
import { MigrationAssessment } from "./assess/Assessment";
import {
  blobToSqlJob,
  commentedUdfJob,
  eventHubToKustoJob,
  referenceAndUdfJob
} from "./__fixtures__/asaJobs";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail?: string): void {
  checks++;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

function blockedReasons(assessment: MigrationAssessment): string {
  return assessment.findings
    .filter(f => f.status === "Blocked")
    .map(f => `${f.scope}/${f.asaName}`)
    .join(", ");
}

console.log("\n== eventHubToKustoJob: should migrate cleanly ==");
{
  const { definition, assessment } = buildMigrationPlan(eventHubToKustoJob);

  check("assessment reports migratable", assessment.canMigrate, blockedReasons(assessment));
  check("no blocked findings", assessment.counts.Blocked === 0);
  check("one source generated", definition.sources.length === 1);
  check("source is AzureEventHub", definition.sources[0]?.type === "AzureEventHub");
  check("source name is suffixed", definition.sources[0]?.name === "deviceInput-source");

  const defaultStream = definition.streams.find(s => s.type === "DefaultStream");
  check("default stream named after ASA input", defaultStream?.name === "deviceInput");
  check(
    "default stream reads the source",
    defaultStream?.inputNodes?.[0]?.name === "deviceInput-source"
  );

  const derived = definition.streams.find(s => s.type === "DerivedStream");
  check("derived stream named after ASA output", derived?.name === "kustoOutput");

  check("one SQL operator", definition.operators.length === 1);
  check("operator type is SQL", definition.operators[0]?.type === "SQL");
  check(
    "operator reads the default stream",
    definition.operators[0]?.inputNodes?.[0]?.name === "deviceInput"
  );

  // The whole point of the naming scheme: the query moves across untouched.
  check(
    "query passed through verbatim",
    definition.operators[0]?.properties?.query ===
      eventHubToKustoJob.properties.transformation.properties.query
  );

  const advanced = definition.operators[0]?.properties?.advancedSettings;
  check("out-of-order policy carried", advanced?.eventsOutOfOrderPolicy === "Adjust");
  check("out-of-order delay carried", advanced?.eventsOutOfOrderMaxDelayInSeconds === 5);
  check("late arrival delay carried", advanced?.eventsLateArrivalMaxDelayInSeconds === 300);

  check("one destination", definition.destinations.length === 1);
  check("destination is Eventhouse", definition.destinations[0]?.type === "Eventhouse");
  check(
    "destination reads the derived stream",
    definition.destinations[0]?.inputNodes?.[0]?.name === "kustoOutput"
  );
  check("ADX table name carried", definition.destinations[0]?.properties?.tableName === "Readings");
  check("compatibility level set", definition.compatibilityLevel === "1.0");
}

console.log("\n== blobToSqlJob: both ends unsupported ==");
{
  const { definition, assessment } = buildMigrationPlan(blobToSqlJob);

  check("assessment reports NOT migratable", !assessment.canMigrate);
  check("no sources generated", definition.sources.length === 0);
  check("no destinations generated", definition.destinations.length === 0);

  const blobFinding = assessment.findings.find(f => f.scope === "Input" && f.asaName === "blobInput");
  check("blob input blocked", blobFinding?.status === "Blocked");
  check(
    "blob reason mentions notifications, not files",
    /notifications, not the files/i.test(blobFinding?.reason || "")
  );

  const sqlFinding = assessment.findings.find(f => f.scope === "Output" && f.asaName === "sqlOutput");
  check("sql output blocked", sqlFinding?.status === "Blocked");

  // The INTO target has no destination, so the cross-check must catch it.
  const intoFinding = assessment.findings.find(f => f.asaType === "INTO target");
  check("dangling INTO target flagged", intoFinding?.status === "Blocked", "cross-check missed it");
}

console.log("\n== referenceAndUdfJob: reference data and a UDF ==");
{
  const { assessment } = buildMigrationPlan(referenceAndUdfJob);

  check("assessment reports NOT migratable", !assessment.canMigrate);

  const refFinding = assessment.findings.find(f => f.asaName === "lookupInput");
  check("reference input blocked", refFinding?.status === "Blocked");

  const udfFindings = assessment.findings.filter(
    f => f.scope === "Query" && f.status === "Blocked"
  );
  check("udf call detected in query", udfFindings.some(f => f.asaType === "user-defined function"));
  check("declared functions detected", udfFindings.some(f => f.asaType === "functions"));

  // The event hub input itself is still fine, and should be reported as such.
  const ehFinding = assessment.findings.find(f => f.asaName === "eventInput");
  check("event hub input still mapped", ehFinding?.status === "Mapped");

  // The data lake output is supported, but only approximately.
  const lakeFinding = assessment.findings.find(f => f.asaName === "lakeOutput");
  check("data lake output approximated", lakeFinding?.status === "Approximated");
  check("data lake targets Lakehouse", lakeFinding?.targetType === "Lakehouse");
}

console.log("\n== commentedUdfJob: comments must not trip the scanner ==");
{
  const { assessment } = buildMigrationPlan(commentedUdfJob);

  const udfFinding = assessment.findings.find(f => f.asaType === "user-defined function");
  check("commented-out udf NOT flagged", !udfFinding, "false positive from a SQL comment");

  const iotFinding = assessment.findings.find(f => f.asaName === "input1");
  check("iot hub input mapped", iotFinding?.status === "Mapped");
  check("iot hub targets AzureIoTHub", iotFinding?.targetType === "AzureIoTHub");

  check("job is migratable", assessment.canMigrate, blockedReasons(assessment));
}

console.log("\n== helpers ==");
{
  check(
    "stripSqlComments removes line comments",
    stripSqlComments("SELECT 1 -- udf.x\nFROM t").indexOf("udf.") === -1
  );
  check(
    "stripSqlComments removes block comments",
    stripSqlComments("SELECT /* udf.x */ 1").indexOf("udf.") === -1
  );

  // Multi-byte input is the reason we do not call btoa directly.
  const encoded = toBase64('{"q":"温度"}');
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  check("base64 round-trips multi-byte text", decoded === '{"q":"温度"}', decoded);

  const { definition } = buildMigrationPlan(eventHubToKustoJob);
  const request = buildCreateEventstreamRequest("telemetry-job", definition, {
    properties: { retentionTimeInDays: 1, eventThroughputLevel: "Low" }
  });
  check("item type is Eventstream", request.type === "Eventstream");
  check("two definition parts", request.definition?.parts.length === 2);
  check("first part is eventstream.json", request.definition?.parts[0].path === "eventstream.json");
  check("payload type is InlineBase64", request.definition?.parts[0].payloadType === "InlineBase64");

  const roundTripped = JSON.parse(
    Buffer.from(request.definition.parts[0].payload, "base64").toString("utf8")
  );
  check("payload decodes to the definition", roundTripped.sources.length === 1);
  check("decoded operator keeps the query", roundTripped.operators[0].properties.query.length > 0);
}

console.log("\n== create-item response narrowing ==");
{
  // A 202 from Fabric yields an operation handle, which must be polled.
  check("operation indicator detected", isAsyncOperation({ operationId: "op-123" }));
  check(
    "operation indicator with retryAfter detected",
    isAsyncOperation({ operationId: "op-123", retryAfter: 5 })
  );

  // A 201 yields the created item, which must be used directly.
  check(
    "created item not treated as an operation",
    !isAsyncOperation({ id: "i1", type: "Eventstream", displayName: "es", workspaceId: "ws" })
  );
  check(
    "value carrying both fields is treated as an item",
    !isAsyncOperation({ id: "i1", operationId: "op-123" })
  );

  check("null is not an operation", !isAsyncOperation(null));
  check("undefined is not an operation", !isAsyncOperation(undefined));
  check("empty object is not an operation", !isAsyncOperation({}));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("selftest OK");
