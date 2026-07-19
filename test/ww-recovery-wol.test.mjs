import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { once } from "node:events";
import {
  buildWakeMagicPacket,
  normalizeMacAddress,
  sendWakeOnLan,
} from "../lib/recovery/ww-recovery-wol.mjs";

test("Wake-on-LAN accepts every common MAC format and builds exact packet bytes", () => {
  for (const value of ["00:11:22:33:44:55", "00-11-22-33-44-55", "0011.2233.4455", "001122334455"]) {
    assert.equal(normalizeMacAddress(value), "00:11:22:33:44:55");
  }
  const packet = buildWakeMagicPacket("00:11:22:33:44:55");
  assert.equal(packet.length, 102);
  assert.deepEqual(packet.subarray(0, 6), Buffer.alloc(6, 0xff));
  for (let offset = 6; offset < packet.length; offset += 6) {
    assert.deepEqual(packet.subarray(offset, offset + 6), Buffer.from("001122334455", "hex"));
  }
  assert.throws(() => normalizeMacAddress("bad-mac"), /Invalid/);
});

test("Wake-on-LAN sends a real magic packet over loopback without claiming power-on", async () => {
  const receiver = dgram.createSocket("udp4");
  receiver.bind(0, "127.0.0.1");
  await once(receiver, "listening");
  const port = receiver.address().port;
  const received = once(receiver, "message");
  const result = await sendWakeOnLan({
    mac: "aa:bb:cc:dd:ee:ff",
    broadcast: "127.0.0.1",
    port,
    burst: 1,
  });
  const [packet] = await received;
  receiver.close();
  assert.deepEqual(packet, buildWakeMagicPacket("aa:bb:cc:dd:ee:ff"));
  assert.equal(result.packetSent, true);
  assert.equal(result.machineOnline, false);
});
