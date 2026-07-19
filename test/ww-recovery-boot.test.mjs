import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createRecoveryBootManager,
  renderDnsmasqConfig,
  renderIpxeScript,
  selectPxeBootTarget,
  selectPxeInterface,
} from "../lib/recovery/ww-recovery-boot.mjs";

const interfaceRecord = {
  name: "eno1",
  address: "192.168.8.104",
  netmask: "255.255.255.0",
  prefix: 24,
  network: 0xc0a80800,
  broadcast: 0xc0a808ff,
};

test("PXE architecture matrix selects BIOS, UEFI x64, and already-iPXE targets", () => {
  assert.equal(selectPxeBootTarget({ architecture: 0 }), "ipxe.pxe");
  assert.equal(selectPxeBootTarget({ architecture: 7 }), "ipxe.efi");
  assert.equal(selectPxeBootTarget({ architecture: 9 }), "ipxe.efi");
  assert.equal(selectPxeBootTarget({ architecture: 0, userClass: "iPXE" }), "boot.ipxe");
});

test("PXE dnsmasq config remains proxyDHCP and chains iPXE over HTTP", () => {
  const rendered = renderDnsmasqConfig({
    interfaceRecord,
    tftpRoot: "/var/lib/workwire/tftp",
    logPath: "/var/log/workwire-pxe.log",
    bootUrl: "http://192.168.8.104:4853/v1/recovery/boot/x86_64/boot.ipxe",
  });
  assert.match(rendered, /^port=0$/m);
  assert.match(rendered, /^user=root$/m);
  assert.match(rendered, /^interface=eno1$/m);
  assert.match(rendered, /^dhcp-range=192\.168\.8\.0,proxy,255\.255\.255\.0$/m);
  assert.match(rendered, /dhcp-userclass=set:ipxe,iPXE/);
  assert.match(rendered, /dhcp-boot=tag:bios,tag:!ipxe,pxelinux\.0/);
  assert.match(rendered, /dhcp-boot=tag:efi-x64,tag:!ipxe,ipxe\.efi/);
  assert.match(rendered, /pxe-service=tag:bios,tag:!ipxe,x86PC/);
  assert.doesNotMatch(rendered, /dhcp-authoritative/);
  // the generic bios/efi chainloads must never shadow the iPXE HTTP boot rule
  assert.ok(
    rendered.indexOf("dhcp-boot=tag:ipxe,") > rendered.indexOf("dhcp-boot=tag:bios,"),
    "iPXE dhcp-boot rule must come after the bios rule so it wins for iPXE clients",
  );
});

test("PXE script carries controller, live fetch, local exit, shell, and alternate nomodeset", () => {
  const rendered = renderIpxeScript({
    controllerUrl: "http://192.168.8.104:4852",
    bootUrl: "http://192.168.8.104:4853",
  });
  assert.match(rendered, /ww\.controller=\$\{controller\}/);
  assert.match(rendered, /fetch=\$\{boot\}\/v1\/recovery\/boot\/live\/filesystem\.squashfs/);
  assert.match(rendered, /item local Local boot/);
  assert.match(rendered, /item shell iPXE shell/);
  assert.match(rendered, /recovery_nomodeset/);
  assert.match(rendered, /ww\.mac=\$\{net0\/mac\}/);
});

test("PXE interface selection uses an explicit valid wired interface", () => {
  const wireless = { ...interfaceRecord, name: "wlp1s0", address: "10.0.0.2" };
  assert.equal(selectPxeInterface({ interfaceName: "eno1", records: [wireless, interfaceRecord] }).name, "eno1");
  assert.equal(selectPxeInterface({ records: [interfaceRecord] }).name, "eno1");
  assert.throws(() => selectPxeInterface({ interfaceName: "missing", records: [interfaceRecord] }), /no usable IPv4/);
});

test("PXE one-shot machine policy persists and consumes to local boot", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ww-recovery-boot-"));
  const config = {
    stateDir,
    host: "127.0.0.1",
    port: 4852,
    bootHost: "127.0.0.1",
    bootPort: 4853,
    advertisedHost: "127.0.0.1",
    pxe: { bootRoot: path.join(stateDir, "boot"), tftpRoot: path.join(stateDir, "boot", "ipxe") },
  };
  const manager = createRecoveryBootManager({ config });
  try {
    await manager.arm("00:11:22:33:44:55", { after: "local", name: "patient" });
    assert.equal(await manager.policyFor("0011.2233.4455"), "recovery");
    await manager.consumeMachinePolicy("00-11-22-33-44-55");
    assert.equal(await manager.policyFor("001122334455"), "local");
    const reloaded = createRecoveryBootManager({ config });
    assert.equal(await reloaded.policyFor("00:11:22:33:44:55"), "local");
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
