import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { NotificationType } from "@ms-fabric/workload-client";

import { PageProps, ContextProps } from "../../App";
import { ItemWithDefinition, getWorkloadItem, callGetItem, saveWorkloadItem } from "../../controller/ItemCRUDController";
import { callOpenSettings } from "../../controller/SettingsController";
import { callNotificationOpen } from "../../controller/NotificationController";
import { ItemEditor, useViewNavigation } from "../../components/ItemEditor";
import {
  EventhouseMigratorItemDefinition,
  MigrationPlanRecord,
  newPlanId,
  normalizeDefinition,
  syncStartOf
} from "./EventhouseMigratorItemDefinition";
import { analyzeLoad } from "./kusto/analyzeLoad";
import { EventhouseMigratorItemHomeView } from "./EventhouseMigratorItemHomeView";
import { EventhouseMigratorItemDefaultView } from "./EventhouseMigratorItemDefaultView";
import { EventhouseMigratorItemRunView } from "./EventhouseMigratorItemRunView";
import { EventhouseMigratorItemRibbon } from "./EventhouseMigratorItemRibbon";
import { EhWizardContext, planFromContext } from "./steps/WizardContext";
import { KustoClient, describeError } from "./kusto/KustoClient";
import { MigrationRunner, RunState, emptyRunState } from "./kusto/MigrationRunner";
import "./EventhouseMigratorItem.scss";

export const EH_VIEW_TYPES = {
  HOME: "empty",
  WIZARD: "default",
  RUN: "run"
} as const;

const enum SaveStatus {
  NotSaved = "NotSaved",
  Saving = "Saving",
  Saved = "Saved"
}

/** Run state is saved at most this often while a migration runs. */
const PERSIST_INTERVAL_MS = 4000;
const LIVE_PHASES = ["preparing", "copying", "restoring", "verifying"];

/** A saved run that was in flight when its tab closed shows as stopped, ready to resume. */
function savedRun(plan: MigrationPlanRecord | undefined): RunState {
  const run = plan?.run;
  if (!run) {
    return emptyRunState();
  }
  return LIVE_PHASES.includes(run.phase) ? { ...run, phase: "stopped" } : run;
}

/**
 * Editor for the Eventhouse Migrator item. Home lists the item's migration
 * plans; the wizard creates or edits one; the run view runs and verifies it.
 * Run state is saved on its plan as it progresses, so a closed tab resumes
 * where it stopped.
 */
export function EventhouseMigratorItemEditor(props: PageProps) {
  const { workloadClient } = props;
  const pageContext = useParams<ContextProps>();
  const { pathname } = useLocation();
  const { t } = useTranslation();

  const [isLoading, setIsLoading] = useState(true);
  const [item, setItem] = useState<ItemWithDefinition<EventhouseMigratorItemDefinition>>();
  const [definition, setDefinition] = useState<EventhouseMigratorItemDefinition>({ plans: [] });
  const [activePlanId, setActivePlanId] = useState<string | undefined>();
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(SaveStatus.NotSaved);
  const [viewSetter, setViewSetter] = useState<((view: string) => void) | null>(null);
  const [runningPlanId, setRunningPlanId] = useState<string | undefined>();
  const [liveRun, setLiveRun] = useState<RunState | undefined>();

  const runnerRef = useRef<MigrationRunner | null>(null);
  const latestRef = useRef<EventhouseMigratorItemDefinition>({ plans: [] });
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const plans = definition.plans || [];
  const activePlan = plans.find(plan => plan.id === activePlanId);

  useEffect(() => {
    async function load() {
      if (!pageContext.itemObjectId || (item && item.id === pageContext.itemObjectId)) {
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      try {
        const loaded = await getWorkloadItem<EventhouseMigratorItemDefinition>(workloadClient, pageContext.itemObjectId);
        const normalized = normalizeDefinition(loaded.definition as any);
        setItem({ ...loaded, definition: normalized });
        setDefinition(normalized);
        latestRef.current = normalized;
        setActivePlanId(normalized.activePlanId);
        setSaveStatus(loaded.definition ? SaveStatus.Saved : SaveStatus.NotSaved);
      } catch (error) {
        console.error("Failed to load Eventhouse Migrator item:", error);
        setItem(undefined);
      }
      setIsLoading(false);
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageContext, pathname]);

  // Warn before closing the tab mid-run; progress is saved, but in-flight polling stops.
  useEffect(() => {
    if (!runningPlanId) {
      return undefined;
    }
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [runningPlanId]);

  /** Updates the in-memory definition; persist() writes it to Fabric. */
  function commit(next: EventhouseMigratorItemDefinition) {
    latestRef.current = next;
    setDefinition(next);
    setSaveStatus(SaveStatus.NotSaved);
  }

  async function persist(next: EventhouseMigratorItemDefinition, options: { notify?: boolean } = {}): Promise<boolean> {
    if (!item) {
      return false;
    }
    setSaveStatus(SaveStatus.Saving);
    let saved = false;
    let message = "";
    try {
      saved = Boolean(await saveWorkloadItem<EventhouseMigratorItemDefinition>(workloadClient, { ...item, definition: next }));
    } catch (error) {
      message = describeError(error);
    }
    if (saved) {
      item.definition = next;
      setSaveStatus(SaveStatus.Saved);
      if (options.notify) {
        callNotificationOpen(workloadClient, t("ItemEditor_Saved_Notification_Title"),
          t("ItemEditor_Saved_Notification_Text", { itemName: item.displayName }), undefined, undefined);
      }
    } else {
      setSaveStatus(SaveStatus.NotSaved);
      callNotificationOpen(workloadClient, t("ItemEditor_SaveFailed_Notification_Title"),
        `${t("ItemEditor_SaveFailed_Notification_Text", { itemName: item.displayName })} ${message}`.trim(),
        NotificationType.Error, undefined);
    }
    return saved;
  }

  function updatePlan(planId: string, patch: Partial<MigrationPlanRecord>): EventhouseMigratorItemDefinition {
    const current = latestRef.current;
    const next = {
      ...current,
      plans: (current.plans || []).map(plan =>
        plan.id === planId ? { ...plan, ...patch, updatedAt: new Date().toISOString() } : plan
      )
    };
    commit(next);
    return next;
  }

  /** Saves the run state onto the plan it belongs to, throttled while it runs. */
  function schedulePersist(planId: string, state: RunState, immediate = false) {
    updatePlan(planId, { run: state });
    if (persistTimer.current) {
      if (!immediate) {
        return;
      }
      clearTimeout(persistTimer.current);
    }
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null;
      persist(latestRef.current);
    }, immediate ? 0 : PERSIST_INTERVAL_MS);
  }

  const plan = useMemo(() => (activePlan ? planFromContext(activePlan) : undefined), [activePlan]);
  const run = activePlan && activePlan.id === runningPlanId && liveRun ? liveRun : savedRun(activePlan);

  async function savePlan(context: EhWizardContext) {
    const inputs = {
      sourceClusterUri: context.sourceClusterUri,
      sourceDatabase: context.sourceDatabase,
      sourceDatabaseLabel: context.sourceDatabaseLabel,
      target: context.target,
      sourceTables: context.sourceTables,
      targetTables: context.targetTables,
      mappings: context.mappings,
      histograms: context.histograms,
      plannedAt: context.plannedAt,
      window: context.window
    };
    const now = new Date().toISOString();
    let next: EventhouseMigratorItemDefinition;
    let planId = activePlanId;
    if (activePlan) {
      // Within one load window, copy ids are stable per table and day, so progress
      // carries over to an edited plan. A new window is a new load: start fresh.
      const newLoad = context.window?.to !== activePlan.window?.to;
      next = updatePlan(activePlan.id, newLoad ? { ...inputs, run: emptyRunState() } : inputs);
    } else {
      planId = newPlanId();
      const record: MigrationPlanRecord = { id: planId, createdAt: now, updatedAt: now, ...inputs, run: emptyRunState() };
      next = { ...latestRef.current, plans: [...(latestRef.current.plans || []), record] };
    }
    next = { ...next, activePlanId: planId };
    commit(next);
    setActivePlanId(planId);
    if (await persist(next)) {
      viewSetter?.(EH_VIEW_TYPES.RUN);
    }
  }

  /** Runs (or resumes) a plan's current load. Takes the record so a sync can start right after updating it. */
  async function startRun(record: MigrationPlanRecord | undefined = activePlan) {
    const migration = record ? planFromContext(record) : undefined;
    if (!record || !migration || !record.target || !record.sourceClusterUri) {
      return;
    }
    const planId = record.id;
    const runner = new MigrationRunner(migration, savedRun(record), {
      source: new KustoClient(workloadClient, record.sourceClusterUri),
      target: new KustoClient(workloadClient, record.target.queryServiceUri),
      targetDatabase: record.target.databaseName,
      onState: state => {
        setLiveRun(state);
        schedulePersist(planId, state);
      }
    });
    runnerRef.current = runner;
    setRunningPlanId(planId);
    try {
      const final = await runner.run();
      if (final.phase === "done") {
        recordLoad(planId, migration.totals.rows, final);
      }
      schedulePersist(planId, final, true);
      callNotificationOpen(
        workloadClient,
        final.phase === "done" ? "Migration complete" : final.phase === "stopped" ? "Migration stopped" : "Migration finished with errors",
        final.phase === "done" ? "All daily buckets were copied and verified." : "Open the plan to resume.",
        final.phase === "done" ? undefined : NotificationType.Warning,
        undefined
      );
    } finally {
      runnerRef.current = null;
      setRunningPlanId(undefined);
      setLiveRun(undefined);
    }
  }

  /** A finished load moves the plan's watermark: the next sync starts where this one ended. */
  function recordLoad(planId: string, rows: number, final: RunState) {
    const record = (latestRef.current.plans || []).find(p => p.id === planId);
    if (!record) {
      return;
    }
    updatePlan(planId, {
      watermark: record.window?.to || syncStartOf({ ...record, run: final }),
      loads: [
        ...(record.loads || []),
        { window: record.window, phase: final.phase, rows, startedAt: final.startedAt, finishedAt: final.finishedAt }
      ]
    });
  }

  /**
   * Copies only what arrived in the source since the plan's watermark: reads the
   * new window's daily counts, and if there is anything to copy, starts the load.
   */
  async function syncNewData(): Promise<string | undefined> {
    const record = activePlan;
    const from = record ? syncStartOf(record) : undefined;
    if (!record || !from || !record.sourceClusterUri || !record.sourceDatabase) {
      return undefined;
    }
    const analysis = await analyzeLoad(
      new KustoClient(workloadClient, record.sourceClusterUri),
      record.sourceDatabase,
      record.mappings || [],
      from
    );
    if (analysis.rows === 0) {
      return `Up to date: nothing new has arrived in the source since ${new Date(from).toLocaleString()}.`;
    }
    const next = updatePlan(record.id, {
      window: analysis.window,
      histograms: analysis.histograms,
      plannedAt: new Date().toISOString(),
      run: emptyRunState()
    });
    await persist(next);
    startRun((next.plans || []).find(p => p.id === record.id));
    return undefined;
  }

  const handleOpenSettings = async () => {
    if (item) {
      const result = await callGetItem(workloadClient, item.id);
      await callOpenSettings(workloadClient, result.item, "About");
    }
  };

  const HomeViewWrapper = () => {
    const { setCurrentView } = useViewNavigation();
    return (
      <EventhouseMigratorItemHomeView
        plans={plans}
        runningPlanId={runningPlanId}
        onNew={() => {
          setActivePlanId(undefined);
          setCurrentView(EH_VIEW_TYPES.WIZARD);
        }}
        onOpen={id => {
          setActivePlanId(id);
          setCurrentView(EH_VIEW_TYPES.RUN);
        }}
        onEdit={id => {
          setActivePlanId(id);
          setCurrentView(EH_VIEW_TYPES.WIZARD);
        }}
      />
    );
  };

  const WizardViewWrapper = () => {
    const { setCurrentView } = useViewNavigation();
    return (
      <EventhouseMigratorItemDefaultView
        key={activePlanId || "new"}
        workloadClient={workloadClient}
        plan={activePlan}
        onWizardComplete={savePlan}
        onWizardCancel={() => setCurrentView(activePlan ? EH_VIEW_TYPES.RUN : EH_VIEW_TYPES.HOME)}
      />
    );
  };

  const RunViewWrapper = () => {
    const { setCurrentView } = useViewNavigation();
    return (
      <EventhouseMigratorItemRunView
        plan={plan}
        run={run}
        running={Boolean(runningPlanId) && runningPlanId === activePlan?.id}
        sourceLabel={`${activePlan?.sourceClusterUri || ""} / ${activePlan?.sourceDatabaseLabel || activePlan?.sourceDatabase || ""}`}
        targetLabel={activePlan?.target?.displayName || ""}
        onStart={() => startRun()}
        onSync={syncNewData}
        syncedUpTo={activePlan ? syncStartOf(activePlan) : undefined}
        loads={activePlan?.loads || []}
        onStop={() => runnerRef.current?.stop()}
        onEditPlan={() => setCurrentView(EH_VIEW_TYPES.WIZARD)}
        onHome={() => setCurrentView(EH_VIEW_TYPES.HOME)}
      />
    );
  };

  const views = [
    { name: EH_VIEW_TYPES.HOME, component: <HomeViewWrapper /> },
    { name: EH_VIEW_TYPES.WIZARD, component: <WizardViewWrapper /> },
    { name: EH_VIEW_TYPES.RUN, component: <RunViewWrapper /> }
  ];

  useEffect(() => {
    if (!isLoading && item && viewSetter) {
      viewSetter(EH_VIEW_TYPES.HOME);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, item, viewSetter]);

  return (
    <ItemEditor
      isLoading={isLoading}
      loadingMessage={t("EventhouseMigratorItemEditor_Loading", "Loading item...")}
      ribbon={context => (
        <EventhouseMigratorItemRibbon
          {...props}
          viewContext={context}
          isSaveButtonEnabled={saveStatus !== SaveStatus.Saved && !runningPlanId}
          saveItemCallback={async () => {
            await persist(latestRef.current, { notify: true });
          }}
          openSettingsCallback={handleOpenSettings}
        />
      )}
      views={views}
      viewSetter={setCurrentView => {
        if (!viewSetter) {
          setViewSetter(() => setCurrentView);
        }
      }}
    />
  );
}
