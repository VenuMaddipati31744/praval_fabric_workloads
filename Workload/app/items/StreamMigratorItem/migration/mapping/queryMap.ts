/**
 * Carries the Stream Analytics transformation query into an Eventstream SQL
 * operator.
 *
 * Phase 1 is deliberately a pass-through rather than a compiler: the Eventstream
 * SQL operator accepts a raw query, so most jobs move without decomposing the
 * query into Filter/GroupBy/ManageFields nodes.
 *
 * The catch is that Eventstream's SQL dialect is a subset of ASA's, and an
 * unsupported construct fails server-side at create time rather than here. So
 * this module scans for constructs known to have no counterpart and reports them
 * up front, where the user can still do something about it.
 */

import { AsaStreamingJob } from "../../../../clients/AzureResourceManagerTypes";
import { EventstreamSqlAdvancedSettings } from "../emit/EventstreamDefinition";
import { MappingFinding, approximated, blocked, mapped } from "../assess/Assessment";

export interface QueryMappingResult {
  query: string;
  advancedSettings: EventstreamSqlAdvancedSettings;
  findings: MappingFinding[];
  /** Identifiers the query writes to, i.e. the targets of INTO clauses. */
  intoTargets: string[];
  /** Identifiers the query reads from, i.e. the sources of FROM clauses. */
  fromSources: string[];
}

/**
 * Constructs with no Eventstream equivalent. Each entry is matched against the
 * query with comments stripped, so a mention inside a comment does not trip it.
 */
const UNSUPPORTED_CONSTRUCTS: { pattern: RegExp; label: string; reason: string }[] = [
  {
    pattern: /\budf\s*\./i,
    label: "user-defined function",
    reason:
      "The query calls a user-defined function (udf.*). Eventstream has no UDF support, " +
      "so this logic must be rewritten or moved downstream into an Eventhouse update policy."
  },
  {
    pattern: /\b(ST_WITHIN|ST_OVERLAPS|ST_INTERSECTS|ST_DISTANCE|CreatePoint|CreatePolygon|CreateLineString)\s*\(/i,
    label: "geospatial function",
    reason:
      "The query uses Stream Analytics geospatial functions, which Eventstream's SQL " +
      "operator does not provide."
  },
  {
    pattern: /\bAnomalyDetection_(SpikeAndDip|ChangePoint)\s*\(/i,
    label: "anomaly detection function",
    reason:
      "The query uses built-in anomaly detection, which has no Eventstream equivalent. " +
      "Consider running this as a KQL query over an Eventhouse instead."
  }
];

/** Constructs that usually survive but are worth a second look. */
const REVIEW_CONSTRUCTS: { pattern: RegExp; label: string; reason: string }[] = [
  {
    pattern: /\bPARTITION\s+BY\b/i,
    label: "explicit partitioning",
    reason:
      "The query partitions explicitly. Eventstream manages partitioning differently, so " +
      "verify throughput and ordering behaviour after migrating."
  },
  {
    pattern: /\bINTO\s+(\[[^\]]+\]|[A-Za-z0-9_]+)[\s\S]*\bINTO\s+/i,
    label: "multiple output targets",
    reason:
      "The query writes to more than one target. Each becomes a separate derived stream; " +
      "confirm every target has a matching destination."
  }
];

/** Removes line and block comments so scanning does not match commented-out code. */
export function stripSqlComments(query: string): string {
  return (query || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

function extractIdentifiers(query: string, keyword: "INTO" | "FROM"): string[] {
  const pattern = new RegExp(`\\b${keyword}\\s+(?:\\[([^\\]]+)\\]|([A-Za-z0-9_]+))`, "gi");
  const found: string[] = [];
  let match = pattern.exec(query);

  while (match) {
    const identifier = match[1] || match[2];
    if (identifier && found.indexOf(identifier) === -1) {
      found.push(identifier);
    }
    match = pattern.exec(query);
  }

  return found;
}

/**
 * Builds the SQL operator payload from the job's transformation.
 *
 * The out-of-order and late-arrival policies are job-level in ASA but
 * operator-level in Eventstream, so they move onto advancedSettings here.
 */
export function mapQuery(job: AsaStreamingJob): QueryMappingResult {
  const jobProperties = job.properties || {};
  const query = jobProperties.transformation?.properties?.query || "";
  const findings: MappingFinding[] = [];

  const advancedSettings: EventstreamSqlAdvancedSettings = {
    eventsOutOfOrderPolicy: jobProperties.eventsOutOfOrderPolicy,
    eventsOutOfOrderMaxDelayInSeconds: jobProperties.eventsOutOfOrderMaxDelayInSeconds,
    eventsLateArrivalMaxDelayInSeconds: jobProperties.eventsLateArrivalMaxDelayInSeconds
  };

  if (!query.trim()) {
    findings.push(
      blocked(
        "Query",
        job.name,
        "transformation",
        "The job has no transformation query. There is nothing for the Eventstream SQL " +
          "operator to run."
      )
    );
    return { query, advancedSettings, findings, intoTargets: [], fromSources: [] };
  }

  const scannable = stripSqlComments(query);

  for (const construct of UNSUPPORTED_CONSTRUCTS) {
    if (construct.pattern.test(scannable)) {
      findings.push(blocked("Query", job.name, construct.label, construct.reason));
    }
  }

  for (const construct of REVIEW_CONSTRUCTS) {
    if (construct.pattern.test(scannable)) {
      findings.push(
        approximated("Query", job.name, construct.label, "SQL", construct.reason)
      );
    }
  }

  // A job carrying UDF definitions is unmigratable even if the query text does
  // not obviously reference them.
  const functions = jobProperties.functions || [];
  if (functions.length > 0) {
    findings.push(
      blocked(
        "Query",
        job.name,
        "functions",
        `The job defines ${functions.length} user-defined function(s) ` +
          `(${functions.map(f => f.name).join(", ")}). Eventstream cannot host them.`
      )
    );
  }

  if (findings.length === 0) {
    findings.push(
      mapped(
        "Query",
        job.name,
        "transformation",
        "SQL",
        "The transformation query is carried into an Eventstream SQL operator unchanged, " +
          "along with the job's out-of-order and late-arrival policies."
      )
    );
  }

  return {
    query,
    advancedSettings,
    findings,
    intoTargets: extractIdentifiers(scannable, "INTO"),
    fromSources: extractIdentifiers(scannable, "FROM")
  };
}
