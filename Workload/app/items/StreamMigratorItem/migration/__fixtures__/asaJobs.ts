/**
 * Captured-shape Stream Analytics jobs used to exercise the mapping engine.
 *
 * These follow the response shape of
 * GET .../streamingjobs/{job}?$expand=inputs,outputs,transformation,functions
 * documented at https://learn.microsoft.com/en-us/rest/api/streamanalytics/streaming-jobs/get
 */

import { AsaStreamingJob } from "../../../../clients/AzureResourceManagerTypes";

function job(name: string, properties: AsaStreamingJob["properties"]): AsaStreamingJob {
  return {
    id: `/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg1/providers/Microsoft.StreamAnalytics/streamingjobs/${name}`,
    name,
    type: "Microsoft.StreamAnalytics/streamingjobs",
    location: "West US",
    properties
  };
}

/** The happy path: Event Hub in, Azure Data Explorer out, simple query. */
export const eventHubToKustoJob = job("telemetry-job", {
  compatibilityLevel: "1.2",
  eventsOutOfOrderPolicy: "Adjust",
  eventsOutOfOrderMaxDelayInSeconds: 5,
  eventsLateArrivalMaxDelayInSeconds: 300,
  inputs: [
    {
      name: "deviceInput",
      properties: {
        type: "Stream",
        datasource: {
          type: "Microsoft.ServiceBus/EventHub",
          properties: {
            serviceBusNamespace: "contoso-ns",
            eventHubName: "telemetry",
            consumerGroupName: "$Default"
          }
        },
        serialization: { type: "Json", properties: { encoding: "UTF8" } }
      }
    }
  ],
  transformation: {
    name: "Transformation",
    properties: {
      streamingUnits: 3,
      query: "SELECT deviceId, temperature INTO [kustoOutput] FROM [deviceInput] WHERE temperature > 20"
    }
  },
  outputs: [
    {
      name: "kustoOutput",
      properties: {
        datasource: {
          type: "Microsoft.Kusto/clusters/databases",
          properties: { database: "telemetryDb", table: "Readings" }
        }
      }
    }
  ],
  functions: []
});

/** Blob stream input and a SQL sink: both unsupported. */
export const blobToSqlJob = job("archive-job", {
  eventsOutOfOrderPolicy: "Drop",
  inputs: [
    {
      name: "blobInput",
      properties: {
        type: "Stream",
        datasource: {
          type: "Microsoft.Storage/Blob",
          properties: { container: "raw", pathPattern: "{date}/{time}" }
        },
        serialization: { type: "Csv", properties: { encoding: "UTF8", fieldDelimiter: "," } }
      }
    }
  ],
  transformation: {
    name: "Transformation",
    properties: { query: "SELECT * INTO [sqlOutput] FROM [blobInput]" }
  },
  outputs: [
    {
      name: "sqlOutput",
      properties: {
        datasource: {
          type: "Microsoft.Sql/Server/Database",
          properties: { server: "srv", database: "db", table: "tbl" }
        }
      }
    }
  ],
  functions: []
});

/** Reference-data join plus a UDF: two independent blockers. */
export const referenceAndUdfJob = job("enrich-job", {
  eventsOutOfOrderPolicy: "Adjust",
  eventsOutOfOrderMaxDelayInSeconds: 10,
  eventsLateArrivalMaxDelayInSeconds: 60,
  inputs: [
    {
      name: "eventInput",
      properties: {
        type: "Stream",
        datasource: {
          type: "Microsoft.EventHub/EventHub",
          properties: { eventHubName: "events", consumerGroupName: "cg1" }
        },
        serialization: { type: "Json", properties: { encoding: "UTF8" } }
      }
    },
    {
      name: "lookupInput",
      properties: {
        type: "Reference",
        datasource: {
          type: "Microsoft.Storage/Blob",
          properties: { container: "ref", pathPattern: "lookup.json" }
        },
        serialization: { type: "Json", properties: { encoding: "UTF8" } }
      }
    }
  ],
  transformation: {
    name: "Transformation",
    properties: {
      query:
        "-- enrich events with lookup data\n" +
        "SELECT e.deviceId, udf.normalize(e.payload) AS payload INTO [lakeOutput] " +
        "FROM [eventInput] e JOIN [lookupInput] l ON e.deviceId = l.deviceId"
    }
  },
  outputs: [
    {
      name: "lakeOutput",
      properties: {
        datasource: {
          type: "Microsoft.DataLake/Accounts",
          properties: { accountName: "lake", filePathPrefix: "out/{date}" }
        }
      }
    }
  ],
  functions: [
    {
      name: "normalize",
      properties: { type: "Scalar", properties: { language: "JavaScript" } }
    }
  ]
});

/** A commented-out UDF reference must not trip the scanner. */
export const commentedUdfJob = job("comment-job", {
  eventsOutOfOrderPolicy: "Drop",
  inputs: [
    {
      name: "input1",
      properties: {
        type: "Stream",
        datasource: {
          type: "Microsoft.Devices/IotHubs",
          properties: { iotHubNamespace: "hub", consumerGroupName: "$Default" }
        },
        serialization: { type: "Json", properties: { encoding: "UTF8" } }
      }
    }
  ],
  transformation: {
    name: "Transformation",
    properties: {
      query: "-- previously used udf.cleanup here\nSELECT * INTO [ehOut] FROM [input1]"
    }
  },
  outputs: [
    {
      name: "ehOut",
      properties: {
        datasource: {
          type: "Microsoft.Storage/Blob",
          properties: { container: "out" }
        }
      }
    }
  ],
  functions: []
});
