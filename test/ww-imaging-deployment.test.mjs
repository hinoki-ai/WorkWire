import assert from "node:assert/strict";
import test from "node:test";

import { createProvisioningEngine } from "../lib/imaging/index.mjs";

test("canary deployment stops the rest on deterministic failure", async () => {
  const engine = createProvisioningEngine({
    executor: {
      async executeMachine(machine) {
        return { ok: machine.machineId !== "canary-b", observedDisk: machine.target };
      },
    },
  });
  const plan = engine.buildDeploymentPlan({
    id: "canary-plan",
    imageId: "image-1",
    machines: [{ id: "canary-a" }, { id: "canary-b" }, { id: "rest-a" }, { id: "rest-b" }],
    rollout: { mode: "canary-then-rest", canaryCount: 2, concurrency: 2 },
    unattendedBundle: { items: [{ type: "file", source: "answer.toml", destination: "/etc/answer.toml" }] },
    postImageBundle: { items: [{ type: "command", command: ["systemctl", "enable", "workwire"] }] },
  });
  assert.equal(plan.machines[0].steps.some((step) => step.type === "apply-bundle"), true);
  const report = await engine.executeDeploymentPlan(plan);
  assert.deepEqual(report.observed, { complete: 1, failed: 1, skipped: 2 });
  assert.equal(report.stopped, true);
});

test("bounded-parallel deployment respects concurrency and aggregates observed results", async () => {
  let active = 0;
  let peak = 0;
  const engine = createProvisioningEngine({
    executor: {
      async executeMachine(machine) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { ok: true, serial: `written-${machine.machineId}` };
      },
    },
  });
  const plan = engine.createDeploymentPlan({
    imageId: "image-2",
    machines: Array.from({ length: 6 }, (_, index) => ({ id: `node-${index}` })),
    rollout: { mode: "bounded-parallel", concurrency: 2 },
    verification: "full",
  });
  const report = await engine.execute(plan);
  assert.equal(peak, 2);
  assert.deepEqual(report.observed, { complete: 6, failed: 0, skipped: 0 });
  assert.equal(report.ok, true);
  assert.equal(report.results.every((result) => result.intended && result.observed.serial), true);
});

test("stop-on-first-failure never starts later machines", async () => {
  const started = [];
  const engine = createProvisioningEngine({ executor: { async executeMachine(machine) { started.push(machine.machineId); return { ok: machine.machineId !== "node-1" }; } } });
  const plan = engine.buildDeploymentPlan({ imageId: "image", machines: [{ id: "node-0" }, { id: "node-1" }, { id: "node-2" }], rollout: { mode: "stop-on-first-failure" } });
  const report = await engine.execute(plan);
  assert.deepEqual(started, ["node-0", "node-1"]);
  assert.deepEqual(report.observed, { complete: 1, failed: 1, skipped: 1 });
});
