/**
 * Minimal Kusto REST client for the browser, used against both the source ADX
 * cluster and the target Eventhouse query URI.
 *
 * Follows the pattern the Eventhouse sample in this repo already uses: a token
 * for `<uri>/user_impersonation` from the workload client, then POST to
 * /v1/rest/mgmt or /v1/rest/query. Each endpoint gets its own token.
 */

import { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { v4 as uuidv4 } from "uuid";
import { callAcquireFrontendAccessToken } from "../../../controller/AuthenticationController";
import { EnvironmentConstants } from "../../../constants";

const FABRIC_KQL_SCOPE = "https://api.fabric.microsoft.com/KQLDatabase.ReadWrite.All";

export type KustoRow = Record<string, any>;

export class KustoRequestError extends Error {
  constructor(message: string, readonly status?: number, readonly clientRequestId?: string) {
    super(message);
  }
}

interface V1Response {
  Tables?: { TableName: string; Columns: { ColumnName: string }[]; Rows: any[][] }[];
}

function toRows(response: V1Response): KustoRow[] {
  const table = response?.Tables?.[0];
  if (!table) {
    return [];
  }
  const names = table.Columns.map(column => column.ColumnName);
  return table.Rows.map(row => {
    const record: KustoRow = {};
    names.forEach((name, i) => (record[name] = row[i]));
    return record;
  });
}

/** Pulls the human-readable part out of a Kusto error payload. */
function errorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error;
    return error?.["@message"] || error?.message || parsed?.Message || body;
  } catch {
    return body || `HTTP ${status}`;
  }
}

export class KustoClient {
  readonly clusterUri: string;

  constructor(private readonly workloadClient: WorkloadClientAPI, clusterUri: string) {
    this.clusterUri = clusterUri.replace(/\/+$/, "");
  }

  private async token(): Promise<string> {
    const resource = `${this.clusterUri}/user_impersonation`;
    const scopes = this.clusterUri.includes(".fabric.microsoft.com") ? `${FABRIC_KQL_SCOPE} ${resource}` : resource;
    const token = await callAcquireFrontendAccessToken(this.workloadClient, scopes);
    return token.token;
  }

  private async post(path: string, database: string, csl: string): Promise<KustoRow[]> {
    const clientRequestId = `StreamShift.EventhouseMigrator;${uuidv4()}`;
    const response = await fetch(`${this.clusterUri}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        "Content-Type": "application/json",
        "x-ms-client-request-id": clientRequestId,
        "x-ms-app": "StreamShift"
      },
      body: JSON.stringify({ db: database, csl })
    });
    if (!response.ok) {
      throw new KustoRequestError(errorMessage(response.status, await response.text()), response.status, clientRequestId);
    }
    return toRows(await response.json());
  }

  /** Runs a management (dot) command. */
  mgmt(database: string, csl: string): Promise<KustoRow[]> {
    return this.post("/v1/rest/mgmt", database, csl);
  }

  /** Runs a query. */
  query(database: string, csl: string): Promise<KustoRow[]> {
    return this.post("/v1/rest/query", database, csl);
  }
}

export type OperationState = "InProgress" | "Completed" | "Failed" | "Other";

export interface OperationStatus {
  state: OperationState;
  /** Kusto's raw state, e.g. Throttled, Abandoned, BadInput. */
  rawState: string;
  message?: string;
}

/** `.show operations <id>` → a coarse state the runner can act on. */
export async function getOperationStatus(client: KustoClient, database: string, operationId: string): Promise<OperationStatus> {
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) {
    throw new Error(`Unexpected operation id ${operationId}`);
  }
  const rows = await client.mgmt(database, `.show operations ${operationId}`);
  const row = rows[rows.length - 1];
  const rawState = String(row?.State || "Unknown");
  const state: OperationState =
    rawState === "InProgress" || rawState === "Scheduled" ? "InProgress"
      : rawState === "Completed" ? "Completed"
        : ["Failed", "Abandoned", "BadInput", "Canceled", "Throttled", "PartiallySucceeded"].indexOf(rawState) !== -1 ? "Failed"
          : "Other";
  return { state, rawState, message: row?.Status };
}

export interface KqlDatabaseInfo {
  id: string;
  workspaceId: string;
  displayName: string;
  queryServiceUri: string;
  /** Name to use in Kusto commands; in Fabric this is the item's display name. */
  databaseName: string;
}

/** Fabric item metadata for a KQL database, including the query URI its commands go to. */
export async function getKqlDatabase(
  workloadClient: WorkloadClientAPI,
  workspaceId: string,
  itemId: string
): Promise<KqlDatabaseInfo> {
  const token = await callAcquireFrontendAccessToken(workloadClient, FABRIC_KQL_SCOPE);
  const response = await fetch(
    `${EnvironmentConstants.FabricApiBaseUrl}/v1/workspaces/${encodeURIComponent(workspaceId)}/kqlDatabases/${encodeURIComponent(itemId)}`,
    { headers: { Authorization: `Bearer ${token.token}` } }
  );
  if (!response.ok) {
    throw new KustoRequestError(errorMessage(response.status, await response.text()), response.status);
  }
  const item = await response.json();
  return {
    id: item.id,
    workspaceId: item.workspaceId,
    displayName: item.displayName,
    queryServiceUri: item.properties?.queryServiceUri,
    databaseName: item.displayName
  };
}
