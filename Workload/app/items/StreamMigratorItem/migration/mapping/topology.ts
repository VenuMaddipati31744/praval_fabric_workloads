/**
 * Assembles a complete Eventstream topology from a Stream Analytics job.
 *
 * The shape is:
 *
 *   source --> DefaultStream --> SQL operator --> destination
 *
 * Each destination takes the name of an ASA output, so `INTO [output]` resolves
 * as the SQL operator's output alias. The DefaultStream takes the ASA input's
 * name until bindToEventstream renames it to the Eventstream's default stream
 * and rewrites `FROM [input]` to match. The source node is suffixed to keep
 * names unique, since the query never references it.
 */

import { AsaStreamingJob } from "../../../../clients/AzureResourceManagerTypes";
import {
  EventstreamDefinition,
  EventstreamDestination,
  EventstreamSource,
  EventstreamStream,
  EVENTSTREAM_COMPATIBILITY_LEVEL
} from "../emit/EventstreamDefinition";
import {
  MappingFinding,
  MigrationAssessment,
  approximated,
  blocked,
  buildAssessment
} from "../assess/Assessment";
import { mapInput, sanitizeNodeName } from "./sourceMap";
import { FabricTargetSelection, mapOutput } from "./destinationMap";
import { mapQuery, renameQuerySource } from "./queryMap";

export interface TopologyBuildOptions {
  /** Fabric targets per ASA output name, chosen by the user in the wizard. */
  targets?: Record<string, FabricTargetSelection>;
  /**
   * Fabric connection ids per ASA input name. ARM never returns ASA secrets, so
   * the connection backing each source is always chosen by the user.
   */
  connections?: Record<string, string>;
}

export interface MigrationPlan {
  /** The generated eventstream.json contents. Emitted even when blocked, for review. */
  definition: EventstreamDefinition;
  assessment: MigrationAssessment;
}

/**
 * ASA identifiers are case-insensitive, so `INTO dest` writes to an output named
 * `Dest`. Eventstream resolves node names exactly, so a node referenced by the
 * query takes the query's spelling, which keeps the query verbatim.
 */
function matchQuerySpelling(nodeName: string, identifiers: string[]): string {
  const lowered = nodeName.toLowerCase();
  const match = identifiers.find(
    id => id.toLowerCase() === lowered && sanitizeNodeName(id) === id
  );
  return match || nodeName;
}

/**
 * Recovers the ASA output a destination node was generated from. Destination
 * names are sanitized and may take the query's casing, so match loosely.
 */
export function asaOutputNameOf(job: AsaStreamingJob | undefined, destinationName: string): string {
  const lowered = destinationName.toLowerCase();
  const output = (job?.properties?.outputs || []).find(
    candidate => sanitizeNodeName(candidate.name).toLowerCase() === lowered
  );
  return output?.name || destinationName;
}

/**
 * Builds the Eventstream definition and the fidelity assessment for one job.
 *
 * A definition is always produced, even when the assessment reports blockers, so
 * the user can inspect what would have been created and understand the gap.
 */
export function buildMigrationPlan(
  job: AsaStreamingJob,
  options: TopologyBuildOptions = {}
): MigrationPlan {
  const findings: MappingFinding[] = [];
  const jobProperties = job.properties || {};

  // ---- inputs -------------------------------------------------------------
  const inputs = jobProperties.inputs || [];
  const sources: EventstreamSource[] = [];
  const streams: EventstreamStream[] = [];
  let defaultStreamName = "";

  if (inputs.length === 0) {
    findings.push(
      blocked("Job", job.name, "inputs", "The job has no inputs, so there is nothing to ingest.")
    );
  }

  for (const input of inputs) {
    const result = mapInput(input);
    findings.push(result.finding);

    if (!result.node) {
      continue;
    }

    const streamName = sanitizeNodeName(input.name);
    if (streamName !== input.name) {
      findings.push(
        approximated(
          "Input",
          input.name,
          result.finding.asaType,
          result.node.type,
          `Input name was normalized to '${streamName}' for Eventstream. Update any ` +
            "FROM clause that referenced the original name."
        )
      );
    }

    if (sources.length === 0) {
      defaultStreamName = streamName;
      const connectionId = options.connections?.[input.name];
      sources.push({
        ...result.node,
        name: `${streamName}-source`,
        properties: { ...result.node.properties, dataConnectionId: connectionId || "" }
      });
      streams.push({
        name: streamName,
        type: "DefaultStream",
        properties: {},
        inputNodes: [{ name: `${streamName}-source` }]
      });
    } else {
      findings.push(
        blocked(
          "Input",
          input.name,
          result.finding.asaType,
          "The job has more than one stream input. Eventstream funnels all sources into a " +
            "single default stream, so a query that reads from several named inputs cannot " +
            "be carried over automatically. Split the job or design the topology by hand."
        )
      );
    }
  }

  // ---- query --------------------------------------------------------------
  const queryResult = mapQuery(job);
  findings.push(...queryResult.findings);

  const operatorName = `${sanitizeNodeName(job.name)}-query`;
  const operators = [
    {
      name: operatorName,
      type: "SQL",
      inputNodes: defaultStreamName ? [{ name: defaultStreamName }] : [],
      properties: {
        query: queryResult.query,
        advancedSettings: queryResult.advancedSettings
      }
    }
  ];

  // ---- outputs ------------------------------------------------------------
  const outputs = jobProperties.outputs || [];
  const destinations: EventstreamDestination[] = [];

  if (outputs.length === 0) {
    findings.push(
      blocked("Job", job.name, "outputs", "The job has no outputs, so there is nowhere to write.")
    );
  }

  for (const output of outputs) {
    const result = mapOutput(output, options.targets?.[output.name]);
    findings.push(result.finding);

    if (!result.node) {
      continue;
    }

    // Fabric rejects a destination behind "SQL operator -> derived stream", so the
    // operator feeds the destination directly and the destination is the INTO alias.
    destinations.push({
      ...result.node,
      name: matchQuerySpelling(result.node.name, queryResult.intoTargets),
      inputNodes: [{ name: operatorName }]
    });
  }

  // ---- cross-checks -------------------------------------------------------
  // The query's identifiers must line up with the nodes we generated. A mismatch
  // means the created Eventstream would fail validation server-side, which is
  // exactly what we want to catch here.
  const destinationNames = destinations.map(destination => destination.name);

  for (const target of queryResult.intoTargets) {
    if (destinationNames.indexOf(target) === -1) {
      findings.push(
        blocked(
          "Query",
          job.name,
          "INTO target",
          `The query writes INTO '${target}', but no destination was generated for it. ` +
            "That output is either unsupported or missing, and the Eventstream would fail validation."
        )
      );
    }
  }

  if (defaultStreamName && queryResult.fromSources.length > 0) {
    const readsDefaultStream = queryResult.fromSources.indexOf(defaultStreamName) !== -1;
    if (!readsDefaultStream) {
      findings.push(
        approximated(
          "Query",
          job.name,
          "FROM source",
          "SQL",
          `The query reads from ${queryResult.fromSources.map(s => `'${s}'`).join(", ")} ` +
            `rather than '${defaultStreamName}'. This is expected when the query uses common ` +
            "table expressions or step names, but verify the first step reads the input stream."
        )
      );
    }
  }

  const definition: EventstreamDefinition = {
    sources,
    destinations,
    streams,
    operators,
    compatibilityLevel: EVENTSTREAM_COMPATIBILITY_LEVEL
  };

  return { definition, assessment: buildAssessment(job.name, findings) };
}

/**
 * Renames the default stream to `<eventstreamName>-stream`, the name Fabric
 * gives an Eventstream's default stream, and repoints everything that read it,
 * including FROM/JOIN clauses in the SQL query.
 *
 * Applied once the Eventstream name is final, so the plan can be built before
 * the user has chosen one.
 */
export function bindToEventstream(
  definition: EventstreamDefinition,
  eventstreamName: string
): EventstreamDefinition {
  const defaultStream = definition.streams.find(stream => stream.type === "DefaultStream");
  if (!defaultStream || !eventstreamName) {
    return definition;
  }

  const oldName = defaultStream.name;
  const newName = `${eventstreamName}-stream`;
  const repoint = <T extends { name: string }>(nodes?: T[]): T[] | undefined =>
    nodes?.map(node => (node.name === oldName ? { ...node, name: newName } : node));

  return {
    ...definition,
    streams: definition.streams.map(stream => ({
      ...stream,
      name: stream === defaultStream ? newName : stream.name,
      inputNodes: repoint(stream.inputNodes)
    })),
    operators: definition.operators.map(operator => ({
      ...operator,
      inputNodes: repoint(operator.inputNodes),
      properties:
        operator.type === "SQL" && operator.properties
          ? {
              ...operator.properties,
              query: renameQuerySource(operator.properties.query || "", oldName, newName)
            }
          : operator.properties
    })),
    destinations: definition.destinations.map(destination => ({
      ...destination,
      inputNodes: repoint(destination.inputNodes)
    }))
  };
}
