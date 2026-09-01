/**
 * Assembles a complete Eventstream topology from a Stream Analytics job.
 *
 * The shape is:
 *
 *   source --> DefaultStream --> SQL operator --> DerivedStream --> destination
 *
 * Node naming is chosen so the ASA query needs no rewriting. The DefaultStream
 * takes the name of the ASA input, so `FROM [input]` resolves; each DerivedStream
 * takes the name of an ASA output, so `INTO [output]` resolves. The source node
 * is suffixed to keep names unique, since it is never referenced by the query.
 */

import { AsaStreamingJob } from "../../../../clients/AzureResourceManagerTypes";
import {
  EventstreamDefinition,
  EventstreamDestination,
  EventstreamSource,
  EventstreamStream,
  EVENTSTREAM_COMPATIBILITY_LEVEL,
  DEFAULT_JSON_SERIALIZATION
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
import { mapQuery } from "./queryMap";

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

    const derivedStreamName = sanitizeNodeName(output.name);
    streams.push({
      name: derivedStreamName,
      type: "DerivedStream",
      properties: { inputSerialization: DEFAULT_JSON_SERIALIZATION },
      inputNodes: [{ name: operatorName }]
    });

    destinations.push({
      ...result.node,
      inputNodes: [{ name: derivedStreamName }]
    });
  }

  // ---- cross-checks -------------------------------------------------------
  // The query is passed through verbatim, so its identifiers must line up with
  // the nodes we generated. A mismatch means the created Eventstream would fail
  // validation server-side, which is exactly what we want to catch here.
  const derivedStreamNames = streams
    .filter(stream => stream.type === "DerivedStream")
    .map(stream => stream.name);

  for (const target of queryResult.intoTargets) {
    if (derivedStreamNames.indexOf(target) === -1) {
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
