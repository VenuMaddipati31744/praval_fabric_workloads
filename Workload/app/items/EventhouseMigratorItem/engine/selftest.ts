/**
 * Self-test for the Eventhouse migration engine. No test runner in the repo:
 * compile to CommonJS and run with node, from the Workload directory:
 *
 *   node_modules/.bin/tsc app/items/EventhouseMigratorItem/engine/selftest.ts \
 *     --outDir <tmp> --module commonjs --target ES2017 --esModuleInterop \
 *     --skipLibCheck --moduleResolution node
 *   node <tmp>/selftest.js
 */

import {
  buildMigrationPlan,
  buildSourceTables,
  cacheDaysOf,
  compareHistograms,
  defaultMapping,
  endOfDay,
  histogramQuery,
  kqlName,
  kqlString,
  mergeLookbackCommand,
  normalizeClusterUri,
  parseCslSchema,
  parseHistogram,
  restoreMergeCommand,
  retentionDaysOf,
  SourceTable,
  TargetTable,
  timespanToDays
} from "./index";

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
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const context = {
  sourceClusterUri: "https://adx1.westeurope.kusto.windows.net",
  sourceDatabase: "telemetry",
  now: new Date("2026-10-27T12:00:00Z")
};

const events: SourceTable = {
  name: "Events",
  columns: [
    { name: "Timestamp", type: "datetime" },
    { name: "DeviceId", type: "string" },
    { name: "Value", type: "real" }
  ],
  rowCount: 1000,
  originalSizeBytes: 3 * 1024 * 1024 * 1024 * 1000 / 1000, // 3 GB → ~3.2 MB per row
  retentionDays: 365,
  cacheDays: 30
};

console.log("\n== KQL quoting ==");
{
  check("plain name bracketed", kqlName("Events") === "['Events']");
  check("quote escaped", kqlName("it's") === "['it\\'s']", kqlName("it's"));
  check("control chars rejected", throws(() => kqlName("bad\nname")));
  check("string literal escaped", kqlString("a'b\\c") === "'a\\'b\\\\c'");
  check("cluster uri normalized", normalizeClusterUri("ADX1.westeurope.kusto.windows.net/") === "https://adx1.westeurope.kusto.windows.net");
  check("http rejected", throws(() => normalizeClusterUri("http://x.kusto.windows.net")));
  check("path rejected", throws(() => normalizeClusterUri("https://x.kusto.windows.net/db")));
}

console.log("\n== inventory parsing ==");
{
  const cols = parseCslSchema("Timestamp:datetime, ['Device Id']:string, ['a,b']:long, Payload:dynamic");
  check("four columns", cols.length === 4, JSON.stringify(cols));
  check("bracketed name unquoted", cols[1]?.name === "Device Id");
  check("comma inside brackets kept", cols[2]?.name === "a,b" && cols[2]?.type === "long");
  check("timespan long form", timespanToDays("365.00:00:00") === 365);
  check("timespan partial day rounds up", timespanToDays("1.12:00:00") === 2);
  check("timespan short form", timespanToDays("7d") === 7);
  check("retention policy parsed", retentionDaysOf('{"SoftDeletePeriod":"90.00:00:00","Recoverability":"Enabled"}') === 90);
  check("caching nested form", cacheDaysOf('{"DataHotSpan":{"Value":"31.00:00:00"}}') === 31);
  check("caching flat form", cacheDaysOf({ DataHotSpan: "3.00:00:00" }) === 3);
  const tables = buildSourceTables(
    [{ TableName: "B", Schema: "t:datetime" }, { TableName: "A", Schema: "t:datetime" }],
    [{ TableName: "A", TotalRowCount: 5, TotalOriginalSize: 50, RetentionPolicy: null, CachingPolicy: null }]
  );
  check("tables sorted", tables[0].name === "A");
  check("inherited policy is undefined", tables[0].retentionDays === undefined);
}

console.log("\n== default mapping ==");
{
  const existing: TargetTable = { name: "events", columns: events.columns };
  const m1 = defaultMapping(events, []);
  check("auto-create when no target", m1.mode === "create" && m1.targetTable === "Events");
  check("preferred timestamp chosen", m1.timestampColumn === "Timestamp");
  check("source policies by default", m1.retention.mode === "source" && m1.caching.mode === "source");
  const m2 = defaultMapping(events, [existing]);
  check("map to same-named target", m2.mode === "existing" && m2.targetTable === "events");
}

console.log("\n== daily buckets with extent creation time ==");
{
  const mapping = defaultMapping(events, []);
  const histogram = parseHistogram([
    { day: "2025-01-02", rows: 400 },
    { day: "2025-01-01", rows: 500 },
    { day: "", rows: 100 }
  ]);
  const plan = buildMigrationPlan([mapping], [events], [], { Events: histogram }, context);
  const table = plan.tables[0];

  check("plan ready", plan.ready, JSON.stringify(table.issues));
  check("one copy per day plus nulls", table.copies.length === 3);
  check("days in order", table.copies[0].day === "2025-01-01" && table.copies[1].day === "2025-01-02");
  check("creation time is end of day", table.copies[0].creationTime === "2025-01-01T23:59:59.9999999Z");
  const first = table.copies[0].command;
  check("creationTime in command", first.indexOf("creationTime='2025-01-01T23:59:59.9999999Z'") !== -1, first);
  check("day filter half-open", first.indexOf("['Timestamp'] >= datetime(2025-01-01T00:00:00.000Z) and ['Timestamp'] < datetime(2025-01-02T00:00:00.000Z)") !== -1, first);
  check("pulls from source cluster", first.indexOf("cluster('https://adx1.westeurope.kusto.windows.net').database('telemetry').['Events']") !== -1);
  check("idempotent tags", first.indexOf(`ingestIfNotExists='["ssmig:Events:2025-01-01"]'`) !== -1 && first.indexOf("ingest-by:ssmig:Events:2025-01-01") !== -1, first);
  check("async", first.indexOf(".set-or-append async ['Events']") === 0);
  const nulls = table.copies[2];
  check("null bucket has no creation time", nulls.day === undefined && nulls.creationTime === undefined && nulls.command.indexOf("isnull(['Timestamp'])") !== -1);
  check("null rows warned", table.issues.some(i => /no 'Timestamp' value/.test(i.message)));
  check("large bucket distributed", first.indexOf("distributed=true") !== -1, first);
  check("create table from source schema", table.prepare[0].command === ".create-merge table ['Events'] (['Timestamp']:datetime, ['DeviceId']:string, ['Value']:real)");
  check("retention copied from source", table.prepare.some(p => p.command === ".alter-merge table ['Events'] policy retention softdelete = 365d recoverability = enabled"));
  check("caching copied from source", table.prepare.some(p => p.command === ".alter table ['Events'] policy caching hot = 30d"));
  check("merge lookback covers oldest day", table.mergeLookbackDays === 666, String(table.mergeLookbackDays));
  check("totals", plan.totals.copies === 3 && plan.totals.rows === 1000);
}

console.log("\n== merge policy lifecycle ==");
{
  check("lookback command", mergeLookbackCommand("Events", 30) === `.alter-merge table ['Events'] policy merge @'{"Lookback":{"Kind":"Custom","CustomPeriod":"30.00:00:00"}}'`);
  check("restore deletes when none existed", restoreMergeCommand("Events", null) === ".delete table ['Events'] policy merge");
  check("restore puts original back", restoreMergeCommand("Events", '{"Lookback":{"Kind":"Default"}}') === `.alter table ['Events'] policy merge @'{"Lookback":{"Kind":"Default"}}'`);
}

console.log("\n== policies ==");
{
  const histogram = parseHistogram([{ day: "2026-10-01", rows: 1 }]);
  const custom = { ...defaultMapping(events, []), retention: { mode: "custom" as const, days: 10 }, caching: { mode: "custom" as const, days: 20 } };
  const bad = buildMigrationPlan([custom], [events], [], { Events: histogram }, context);
  check("cache longer than retention blocked", !bad.ready && bad.tables[0].issues.some(i => /hot cache/.test(i.message)));
  const keep = { ...defaultMapping(events, []), retention: { mode: "keep" as const }, caching: { mode: "keep" as const } };
  const kept = buildMigrationPlan([keep], [events], [], { Events: histogram }, context);
  check("keep emits no policy commands", kept.tables[0].prepare.length === 1);
  const fraction = { ...defaultMapping(events, []), retention: { mode: "custom" as const, days: 1.5 } };
  check("fractional days rejected", !buildMigrationPlan([fraction], [events], [], { Events: histogram }, context).ready);
}

console.log("\n== existing target tables ==");
{
  const histogram = parseHistogram([{ day: "2026-10-01", rows: 1 }]);
  const target: TargetTable = {
    name: "Events",
    columns: [
      { name: "DeviceId", type: "string" },
      { name: "Timestamp", type: "datetime" },
      { name: "Region", type: "string" }
    ]
  };
  const mapping = { ...defaultMapping(events, [target]) };
  const plan = buildMigrationPlan([mapping], [events], [target], { Events: histogram }, context);
  const cmd = plan.tables[0].copies[0].command;
  check("existing target: no create", !plan.tables[0].prepare.some(p => /create/.test(p.command)));
  check("projected to target order with nulls", /\| project \['DeviceId'\], \['Timestamp'\], \['Region'\]=""$/.test(cmd), cmd);
  check("dropped source column warned", plan.tables[0].issues.some(i => /'Value'/.test(i.message)));

  const clash: TargetTable = { name: "Events", columns: [{ name: "Timestamp", type: "string" }] };
  const clashPlan = buildMigrationPlan([defaultMapping(events, [clash])], [events], [clash], { Events: histogram }, context);
  check("type mismatch blocks", !clashPlan.ready);

  const missing = { ...defaultMapping(events, []), mode: "existing" as const, targetTable: "Nope" };
  check("missing existing target blocks", !buildMigrationPlan([missing], [events], [], { Events: histogram }, context).ready);
}

console.log("\n== guards ==");
{
  const noTs: SourceTable = { ...events, name: "Logs", columns: [{ name: "Message", type: "string" }] };
  const plan = buildMigrationPlan([defaultMapping(noTs, [])], [noTs], [], { Logs: { days: [], nullRows: 0 } }, context);
  check("no datetime column blocks", !plan.ready && /no datetime column/.test(plan.tables[0].issues[0]?.message || ""));

  const other: SourceTable = { ...events, name: "Events2" };
  const a = defaultMapping(events, []);
  const b = { ...defaultMapping(other, []), targetTable: "Events" };
  const h = parseHistogram([{ day: "2026-10-01", rows: 1 }]);
  check("two sources into one target blocks", !buildMigrationPlan([a, b], [events, other], [], { Events: h, Events2: h }, context).ready);

  const excluded = { ...defaultMapping(events, []), include: false };
  check("nothing included is not ready", !buildMigrationPlan([excluded], [events], [], {}, context).ready);
  check("histogram query", histogramQuery("Events", "Timestamp").indexOf(`format_datetime(bin(['Timestamp'], 1d), "yyyy-MM-dd")`) !== -1);
}

console.log("\n== verification ==");
{
  const source = parseHistogram([{ day: "2025-01-01", rows: 5 }, { day: "2025-01-02", rows: 3 }, { day: "", rows: 1 }]);
  const target = parseHistogram([{ day: "2025-01-01", rows: 5 }, { day: "2025-01-02", rows: 2 }]);
  const diff = compareHistograms(source, target);
  check("mismatch found", diff.some(d => d.day === "2025-01-02" && d.targetRows === 2));
  check("null bucket compared", diff.some(d => d.day === "(no timestamp)" && d.sourceRows === 1 && d.targetRows === 0));
  check("end of day helper", endOfDay("2024-02-29") === "2024-02-29T23:59:59.9999999Z");
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("selftest OK");
