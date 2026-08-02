import fs from "node:fs/promises";
import path from "node:path";
import {
  createPlannerProcess,
  createOperatorPlanner,
} from "./ww-recovery-planner-process.mjs";
import { createRecoveryError, RECOVERY_ERROR_CODES } from "./ww-recovery-protocol.mjs";

function wait(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, Number(delayMs) || 0));
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Recovery case stopped."));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function summarizeCase(caseRecord, initialFacts, actions, finalFacts, conclusion) {
  return `# WorkWire Recovery Case ${caseRecord.id}

Goal: ${caseRecord.goal}

Target: ${caseRecord.targetAgentId}

## Initial facts

\`\`\`json
${JSON.stringify(initialFacts, null, 2)}
\`\`\`

## Actions

${actions.map((action, index) => `${index + 1}. ${action.action} — ${action.result?.state || (action.result?.ok === true ? "completed" : "observed")}`).join("\n") || "No actions were submitted."}

## Final facts

\`\`\`json
${JSON.stringify(finalFacts, null, 2)}
\`\`\`

## Planner conclusion

${conclusion || "No conclusion supplied."}
`;
}

export function createRecoveryAutonomyEngine({
  store,
  controller,
  plannerFactory = null,
  plannerConfig = {},
  playbooks = [],
  fsImpl = fs,
  pollMs = 100,
  log = () => {},
} = {}) {
  if (!store || !controller) throw new TypeError("Recovery autonomy requires store and controller.");
  const runs = new Map();
  const operatorPlanners = new Map();

  function buildPlanner(caseId, options = {}) {
    if (options.planner) return options.planner;
    if (plannerFactory) return plannerFactory(caseId, options);
    if (Array.isArray(plannerConfig.command) && plannerConfig.command.length > 0) {
      return createPlannerProcess({ command: plannerConfig.command, log });
    }
    const planner = createOperatorPlanner();
    operatorPlanners.set(caseId, planner);
    return planner;
  }

  async function checkpoint(caseRecord, value) {
    const caseDirectory = path.join(store.getPaths().cases, caseRecord.id);
    const filename = path.join(caseDirectory, "planner-checkpoint.json");
    const temporaryPath = `${filename}.${process.pid}.tmp`;
    await fsImpl.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.rename(temporaryPath, filename);
  }

  async function loadCheckpoint(caseRecord) {
    const filename = path.join(store.getPaths().cases, caseRecord.id, "planner-checkpoint.json");
    try {
      return JSON.parse(await fsImpl.readFile(filename, "utf8"));
    } catch {
      return null;
    }
  }

  async function waitForJob(jobId, signal) {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const job = store.getJob(jobId);
      if (!job) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Planner job ${jobId} disappeared.`);
      if (["succeeded", "failed", "canceled", "interrupted", "abandoned"].includes(job.state)) {
        return { job, events: await store.readJobEvents(job.id) };
      }
      await wait(pollMs, signal);
    }
  }

  async function ensureOnline(agentId, signal) {
    while (!controller.getConnectedAgent(agentId)) {
      await wait(500, signal);
    }
  }

  async function executePlannerAction(caseRecord, message, signal) {
    const actions = message.type === "planner.actions" ? message.actions : [{
      id: message.requestId || `planner_step_${Date.now()}`,
      action: message.action,
      params: message.params || {},
      timeoutMs: message.timeoutMs,
      force: message.force ?? message.params?.force,
    }];
    const job = await store.createJob(caseRecord.id, {
      targetAgentId: caseRecord.targetAgentId,
      goal: message.expectedObservation || caseRecord.goal,
      mode: "autonomous-unrestricted",
      force: message.force === true,
      createdBy: "planner",
      steps: actions.map((action, index) => ({
        id: String(action.id || action.stepId || `${message.requestId || "planner"}_${index + 1}`),
        action: action.action,
        params: action.params || {},
        timeoutMs: action.timeoutMs ?? plannerConfig.iterationTimeoutMs ?? 1_800_000,
        continueOnError: action.continueOnError === true,
        force: action.force === true,
      })),
    });
    await store.appendCaseEvent(caseRecord.id, {
      type: "planner.action",
      requestId: message.requestId,
      jobId: job.id,
      actions,
      expectedObservation: message.expectedObservation,
    });
    await controller.dispatchNext(caseRecord.targetAgentId);
    return waitForJob(job.id, signal);
  }

  async function runLoop(caseId, options, abortController) {
    let caseRecord = store.getCase(caseId);
    if (!caseRecord) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `Recovery case ${caseId} was not found.`);
    const planner = buildPlanner(caseId, options);
    const actions = [];
    let initialFacts = null;
    let finalFacts = null;
    let conclusion = "";
    let iterations = 0;
    const repeatedFailures = new Map();
    const maxIterations = Number(options.maxIterations ?? plannerConfig.maxIterations ?? 100);
    try {
      await store.appendCaseEvent(caseId, { type: "planner.started", adapter: planner.type || "custom" });
      await ensureOnline(caseRecord.targetAgentId, abortController.signal);
      await controller.requestInventory(caseRecord.targetAgentId, { wait: true, timeoutMs: 120_000 }).catch(() => null);
      initialFacts = await store.readInventory(caseRecord.targetAgentId);
      await store.writeFacts(caseId, { initial: initialFacts });
      const agent = store.getAgent(caseRecord.targetAgentId);
      const previousCheckpoint = options.resume ? await loadCheckpoint(caseRecord) : null;
      const recentEvents = (await store.readCaseEvents(caseId)).slice(-200);
      await planner.start();
      await planner.send({
        type: options.resume ? "planner.resume" : "planner.init",
        protocol: 1,
        case: caseRecord,
        target: agent,
        toolCatalog: agent?.capabilities?.actions || [],
        operatingDoctrine: "Operator-owned isolated LAN. Typed disk actions and unrestricted root argv/Bash are available without per-action confirmation. Preserve exact device identities, commands, output, artifacts, and force values.",
        inventory: initialFacts,
        playbooks,
        checkpoint: previousCheckpoint,
        recentEvents,
        previousFailures: recentEvents.filter((event) => event.type === "planner.observation" && event.state !== "succeeded"),
      });
      while (!abortController.signal.aborted) {
        if (maxIterations > 0 && iterations >= maxIterations) {
          throw createRecoveryError(RECOVERY_ERROR_CODES.PLANNER_LIMIT, `Recovery planner reached ${maxIterations} iterations.`);
        }
        const message = await planner.next({
          timeoutMs: Number(plannerConfig.iterationTimeoutMs) || 0,
          signal: abortController.signal,
        });
        iterations += 1;
        await checkpoint(caseRecord, { iterations, lastMessage: message, actions, at: new Date().toISOString() });
        if (message.type === "planner.note") {
          await store.appendCaseEvent(caseId, { type: "planner.thought-summary", note: String(message.note || message.summary || "") });
          continue;
        }
        if (message.type === "planner.inventory") {
          const inventory = await controller.requestInventory(caseRecord.targetAgentId, { wait: true, timeoutMs: message.timeoutMs || 120_000 });
          await planner.send({ type: "planner.observation", requestId: message.requestId, inventory });
          await checkpoint(caseRecord, { iterations, lastMessage: message, lastObservation: { inventory }, actions, at: new Date().toISOString() });
          continue;
        }
        if (["planner.action", "planner.actions"].includes(message.type)) {
          await ensureOnline(caseRecord.targetAgentId, abortController.signal);
          const result = await executePlannerAction(caseRecord, message, abortController.signal);
          const observation = {
            type: "planner.observation",
            requestId: message.requestId,
            job: result.job,
            events: result.events.slice(-200),
            stdoutTail: result.job.result?.steps?.map((step) => step.result?.stdoutTail || step.result?.result?.stdoutTail || "").filter(Boolean).join("\n"),
            stderrTail: result.job.result?.steps?.map((step) => step.result?.stderrTail || step.result?.result?.stderrTail || "").filter(Boolean).join("\n"),
            error: result.job.state === "succeeded" ? null : result.job.result || { state: result.job.state },
          };
          const failureSignature = JSON.stringify({
            action: message.action || message.actions?.map((item) => item.action),
            params: message.params || message.actions?.map((item) => item.params),
            state: result.job.state,
          });
          if (result.job.state === "succeeded") repeatedFailures.delete(failureSignature);
          else {
            const repeatedFailureCount = (repeatedFailures.get(failureSignature) || 0) + 1;
            repeatedFailures.set(failureSignature, repeatedFailureCount);
            observation.repeatedFailureCount = repeatedFailureCount;
            if (repeatedFailureCount >= 3) {
              observation.warning = `The same failing action has been repeated ${repeatedFailureCount} times; revise the approach or use raw shell for additional diagnosis.`;
              await store.appendCaseEvent(caseId, {
                type: "planner.repeated-failure",
                requestId: message.requestId,
                count: repeatedFailureCount,
                warning: observation.warning,
              });
            }
          }
          actions.push({ action: message.action || message.actions?.map((item) => item.action).join(", "), request: message, result: result.job });
          await store.appendCaseEvent(caseId, { type: "planner.observation", requestId: message.requestId, jobId: result.job.id, state: result.job.state });
          if (result.job.steps?.some((step) => {
            const descriptor = agent?.capabilities?.actions?.find((item) => item.name === step.action);
            return descriptor?.mutates;
          })) {
            await controller.requestInventory(caseRecord.targetAgentId, { wait: true, timeoutMs: 120_000 }).catch(() => null);
          }
          await planner.send(observation);
          await checkpoint(caseRecord, { iterations, lastMessage: message, lastObservation: observation, actions, at: new Date().toISOString() });
          continue;
        }
        if (message.type === "planner.wait") {
          await store.appendCaseEvent(caseId, { type: "planner.wait", reason: message.reason, durationMs: message.durationMs || 0 });
          if (message.until === "agent-online") await ensureOnline(caseRecord.targetAgentId, abortController.signal);
          else if (message.until === "agent-rebooted") {
            const previousBootId = String(message.previousBootId || store.getAgent(caseRecord.targetAgentId)?.bootId || "");
            while (true) {
              await ensureOnline(caseRecord.targetAgentId, abortController.signal);
              const currentAgent = store.getAgent(caseRecord.targetAgentId);
              if (currentAgent?.bootId && currentAgent.bootId !== previousBootId) break;
              await wait(500, abortController.signal);
            }
          }
          else await wait(message.durationMs || 1_000, abortController.signal);
          const waitObservation = { type: "planner.observation", requestId: message.requestId, waited: true, agent: store.getAgent(caseRecord.targetAgentId) };
          await planner.send(waitObservation);
          await checkpoint(caseRecord, { iterations, lastMessage: message, lastObservation: waitObservation, actions, at: new Date().toISOString() });
          continue;
        }
        if (message.type === "planner.complete") {
          conclusion = String(message.summary || message.outcome || "Recovery goal completed.");
          finalFacts = await store.readInventory(caseRecord.targetAgentId);
          caseRecord = await store.updateCase(caseId, { state: "completed", conclusion, completedAt: new Date().toISOString() });
          await store.appendCaseEvent(caseId, { type: "planner.completed", summary: conclusion, verification: message.verification || null });
          await store.writeSummary(caseId, summarizeCase(caseRecord, initialFacts, actions, finalFacts, conclusion));
          await planner.stop();
          return { completed: true, iterations, conclusion };
        }
        if (message.type === "planner.fail") {
          conclusion = String(message.reason || "Planner reported failure.");
          caseRecord = await store.updateCase(caseId, { state: "failed", conclusion, failedAt: new Date().toISOString() });
          await store.appendCaseEvent(caseId, { type: "planner.failed", reason: conclusion });
          finalFacts = await store.readInventory(caseRecord.targetAgentId);
          await store.writeSummary(caseId, summarizeCase(caseRecord, initialFacts, actions, finalFacts, conclusion));
          await planner.stop();
          return { completed: false, failed: true, iterations, conclusion };
        }
      }
      return { stopped: true, iterations };
    } catch (error) {
      if (!abortController.signal.aborted) {
        const current = store.getCase(caseId);
        if (current?.state === "running") await store.updateCase(caseId, { state: "failed", plannerError: { code: error.code, message: error.message } }).catch(() => {});
        await store.appendCaseEvent(caseId, { type: "planner.failed", error: { code: error.code || RECOVERY_ERROR_CODES.PLANNER_EXIT, message: error.message } }).catch(() => {});
      }
      await planner.stop(abortController.signal.aborted ? { type: "planner.stop", reason: abortController.signal.reason?.message || "operator-stopped" } : null).catch(() => {});
      throw error;
    } finally {
      runs.delete(caseId);
      operatorPlanners.delete(caseId);
    }
  }

  function start(caseId, options = {}) {
    if (runs.has(caseId)) return { started: false, alreadyRunning: true };
    const abortController = new AbortController();
    const promise = runLoop(caseId, options, abortController).catch((error) => {
      log(`Recovery autonomy ${caseId} failed: ${error.message}`);
      return { completed: false, error: { code: error.code, message: error.message } };
    });
    runs.set(caseId, { abortController, promise });
    return { started: true, caseId };
  }

  async function stop(caseId) {
    const run = runs.get(caseId);
    if (!run) return { stopped: false };
    run.abortController.abort(new Error("Operator stopped recovery case."));
    await run.promise;
    return { stopped: true };
  }

  function submitOperatorAction(caseId, message) {
    const planner = operatorPlanners.get(caseId);
    if (!planner) throw createRecoveryError(RECOVERY_ERROR_CODES.NOT_FOUND, `No operator planner is active for ${caseId}.`);
    planner.submit(message);
  }

  return {
    start,
    stop,
    submitOperatorAction,
    getRun(caseId) { return runs.get(caseId) || null; },
    async wait(caseId) { return runs.get(caseId)?.promise || null; },
  };
}

export { summarizeCase };
