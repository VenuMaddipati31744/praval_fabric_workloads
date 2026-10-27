/**
 * Self-test for MigrationRunner against in-memory fake Kusto clients.
 * Build and run like engine/selftest.ts (entry: kusto/runner.selftest.ts).
 */

import { MigrationRunner, RunState, emptyRunState } from "./MigrationRunner";
import { buildMigrationPlan, defaultMapping, parseHistogram, SourceTable } from "../engine";
import { normalizeDefinition } from "../EventhouseMigratorItemDefinition";
import { analyzeLoad } from "./analyzeLoad";

let failures = 0;
let checks = 0;
function check(label: string, condition: boolean, detail?: string): void {
  checks++;
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${label}${!condition && detail ? ` -- ${detail}` : ""}`);
  if (!condition) {
    failures++;
  }
}

const events: SourceTable = {
  name: "Events",
  columns: [{ name: "Timestamp", type: "datetime" }, { name: "Value", type: "real" }],
  rowCount: 3,
  originalSizeBytes: 300,
  retentionDays: 365,
  cacheDays: 30
};
const histogram = parseHistogram([{ day: "2025-01-01", rows: 2 }, { day: "2025-01-02", rows: 1 }]);
const plan = buildMigrationPlan([defaultMapping(events, [])], [events], [], { Events: histogram }, {
  sourceClusterUri: "https://adx1.kusto.windows.net",
  sourceDatabase: "src",
  now: new Date("2025-01-10T00:00:00Z")
});

/** A fake target: records commands, fails the first copy of chosen days once. */
function fakeTarget(options: { failOnce?: string[]; mergePolicy?: string | null } = {}) {
  const commands: string[] = [];
  const failed = new Set<string>();
  let op = 0;
  const ops: Record<string, string> = {};
  const client: any = {
    clusterUri: "https://target.kusto.fabric.microsoft.com",
    async mgmt(_db: string, csl: string) {
      commands.push(csl);
      if (csl.startsWith(".show table ['Events'] policy merge")) {
        return [{ Policy: options.mergePolicy === undefined ? null : options.mergePolicy }];
      }
      if (csl.startsWith(".set-or-append")) {
        const day = /ssmig:Events:([0-9-]+)/.exec(csl)?.[1] || "";
        const id = `00000000-0000-0000-0000-${String(++op).padStart(12, "0")}`;
        ops[id] = options.failOnce?.includes(day) && !failed.has(day) ? (failed.add(day), "Failed") : "Completed";
        return [{ OperationId: id }];
      }
      if (csl.startsWith(".show operations")) {
        const id = csl.split(" ").pop() as string;
        return [{ State: ops[id], Status: ops[id] === "Failed" ? "transient" : "" }];
      }
      if (csl.indexOf("extents") !== -1) {
        return [{ Count: 2 }];
      }
      return [];
    },
    async query() {
      return [{ day: "2025-01-01", rows: 2 }, { day: "2025-01-02", rows: 1 }];
    }
  };
  return { client, commands };
}
const fakeSource: any = {
  async query() {
    return [{ day: "2025-01-01", rows: 2 }, { day: "2025-01-02", rows: 1 }];
  }
};

async function main() {
  console.log("\n== happy path with one retry ==");
  {
    const { client, commands } = fakeTarget({ failOnce: ["2025-01-02"] });
    let last: RunState = emptyRunState();
    const runner = new MigrationRunner(plan, undefined, {
      source: fakeSource, target: client, targetDatabase: "tgt", pollIntervalMs: 1, concurrency: 2,
      onState: state => (last = state)
    });
    const final = await runner.run();
    check("run done", final.phase === "done", final.phase + " " + JSON.stringify(final.log.slice(-3)));
    check("table created first", commands[0].startsWith(".create-merge table ['Events']"));
    check("merge captured before widening", commands.indexOf(".show table ['Events'] policy merge") < commands.findIndex(c => c.startsWith(".alter-merge table ['Events'] policy merge")));
    check("failed day retried", final.copies["ssmig:Events:2025-01-02"].attempts === 2);
    check("merge restored by delete (none existed)", commands.some(c => c === ".delete table ['Events'] policy merge"));
    check("restore happens after copies", commands.lastIndexOf(".delete table ['Events'] policy merge") > commands.map(c => c.startsWith(".set-or-append")).lastIndexOf(true));
    check("verification clean", final.verification?.[0]?.mismatches.length === 0 && final.verification?.[0]?.extentCreationDays === 2);
    check("state emitted", last.phase === "done");
  }

  console.log("\n== resume skips finished work and keeps the original merge policy ==");
  {
    const { client, commands } = fakeTarget();
    const interrupted: RunState = {
      ...emptyRunState(),
      phase: "copying",
      prepared: Object.fromEntries(plan.tables[0].prepare.map(p => [p.id, true])),
      // The table still carries our widened policy; the true original was captured earlier.
      originalMerge: { Events: '{"Lookback":{"Kind":"Default"}}' },
      mergeWidened: { Events: true },
      copies: { "ssmig:Events:2025-01-01": { status: "done", attempts: 1 } }
    };
    const final = await new MigrationRunner(plan, interrupted, {
      source: fakeSource, target: client, targetDatabase: "tgt", pollIntervalMs: 1, onState: () => undefined
    }).run();
    check("resumed run done", final.phase === "done");
    check("prepare not repeated", !commands.some(c => c.startsWith(".create-merge")));
    check("original merge not re-read", !commands.some(c => c.startsWith(".show table ['Events'] policy merge")));
    check("finished day skipped", commands.filter(c => c.startsWith(".set-or-append")).length === 1);
    check("original policy restored", commands.some(c => c === `.alter table ['Events'] policy merge @'{"Lookback":{"Kind":"Default"}}'`));
  }

  console.log("\n== permanent failure still restores merge ==");
  {
    const { client, commands } = fakeTarget({ failOnce: [] });
    client.mgmt = (orig => async (db: string, csl: string) => {
      if (csl.startsWith(".set-or-append")) {
        commands.push(csl);
        throw new Error("Forbidden");
      }
      return orig(db, csl);
    })(client.mgmt.bind(client));
    const final = await new MigrationRunner(plan, undefined, {
      source: fakeSource, target: client, targetDatabase: "tgt", pollIntervalMs: 1, maxAttempts: 2, onState: () => undefined
    }).run();
    check("run failed", final.phase === "failed");
    check("each day tried maxAttempts times", Object.values(final.copies).every(c => c.attempts === 2 && c.status === "failed"));
    check("merge restored anyway", commands.some(c => c === ".delete table ['Events'] policy merge") && !final.mergeWidened.Events);
  }

  console.log("\n== incremental sync ==");
  {
    // analyzeLoad: watermark from the source clock, windowed histograms, ingestion-time fallback.
    const seen: string[] = [];
    const source: any = {
      async query(_db: string, csl: string) {
        seen.push(csl);
        if (csl.startsWith("print")) {
          return [{ Now: "2026-10-30T09:30:00Z" }];
        }
        if (csl.indexOf("Missing=") !== -1) {
          return [{ Missing: csl.indexOf("['Legacy']") !== -1 ? 4 : 0 }];
        }
        return [{ day: "2026-10-29", rows: 7 }];
      }
    };
    const legacyTable = { ...defaultMapping({ ...events, name: "Legacy" }, []) };
    const delta = await analyzeLoad(source, "src", [defaultMapping(events, []), legacyTable], "2026-10-27T07:00:00.000Z");
    check("window runs from the watermark to the source clock", delta.window.from === "2026-10-27T07:00:00.000Z" && delta.window.to === "2026-10-30T09:30:00.000Z");
    check("delta histogram windowed", seen.some(c => c.indexOf("['Events']") !== -1 && c.indexOf("ingestion_time() > ") !== -1));
    check("tables without ingestion time don't count toward a delta", delta.rows === 7);

    const first = await analyzeLoad(source, "src", [legacyTable], undefined);
    check("first load reads such a table in full", first.rows === 7 && seen.filter(c => c.indexOf("['Legacy']") !== -1 && c.indexOf("summarize rows") !== -1).pop()?.indexOf("ingestion_time()") === -1);

    // Verification on a sync compares the source up to the watermark with the whole target.
    const deltaPlan = buildMigrationPlan([defaultMapping(events, [])], [events], [], { Events: parseHistogram([{ day: "2026-10-29", rows: 7 }]) }, {
      sourceClusterUri: "https://adx1.kusto.windows.net",
      sourceDatabase: "src",
      now: new Date("2026-10-30T10:00:00Z"),
      window: { from: "2026-10-27T07:00:00Z", to: "2026-10-30T09:30:00Z" }
    });
    const verifySeen: string[] = [];
    const verifySource: any = { async query(_db: string, csl: string) { verifySeen.push(csl); return [{ day: "2026-10-29", rows: 7 }]; } };
    const { client } = fakeTarget();
    const final = await new MigrationRunner(deltaPlan, undefined, {
      source: verifySource, target: client, targetDatabase: "tgt", pollIntervalMs: 1, onState: () => undefined
    }).run();
    check("sync run done", final.phase === "done");
    check("verification is cumulative up to the watermark", verifySeen.some(c => /ingestion_time\(\) <= datetime\(2026-10-30T09:30:00\.000Z\)/.test(c) && c.indexOf("ingestion_time() >") === -1));
  }

  console.log("\n== saved items from before plans became a list ==");
  {
    const legacy: any = {
      sourceClusterUri: "https://src.kusto.windows.net",
      sourceDatabase: "db",
      mappings: [],
      plannedAt: "2026-10-27T07:00:00Z",
      run: { ...emptyRunState(), phase: "done", finishedAt: "2026-10-27T07:12:21Z" }
    };
    const normalized = normalizeDefinition(legacy);
    check("legacy plan kept as first plan", normalized.plans?.length === 1 && normalized.plans[0].sourceDatabase === "db");
    check("legacy run kept", normalized.plans?.[0].run?.phase === "done");
    check("legacy plan is active", normalized.activePlanId === normalized.plans?.[0].id);
    check("new shape passes through", normalizeDefinition({ plans: [], activePlanId: undefined }).plans?.length === 0);
    check("empty item has no plans", normalizeDefinition(undefined).plans?.length === 0);
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log("selftest OK");
}

main();
