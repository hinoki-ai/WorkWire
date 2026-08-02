# WorkWire agent identity rules

Read [docs/AGENT-OPERATIONS.md](docs/AGENT-OPERATIONS.md) completely before
operating either machine. It is the canonical fleet contract.

## Physical-machine identity (mandatory)

- The workspace `/home/hinoki/WorkWire` and the active local shell are on the
  physical machine **HINOKI**.
- **Sakura is a separate physical Dell OptiPlex 990 reached over the LAN.** A
  request mentioning "Sakura", "Sakura's disk", or "the secondary disk on
  Sakura" is remote work on that machine. It never means a local HINOKI disk,
  `/mnt/sakura`, or a similarly named local directory unless the user explicitly
  says that a verified Sakura network share has already been mounted there.
- Identify physical machines by stable hardware/service identity. Sakura's NIC
  MAC is `18:03:73:2e:3f:42`. Its IP address, operating system, hostname, boot
  environment, and recovery-agent session may change.
- Before any disk or partition operation, prove both the physical host and the
  target disk from live remote inventory. Never infer that a disk is absent
  from HINOKI's local `lsblk` when the request names Sakura.
- Sakura is dual-boot and may appear as Windows, Fedora, or a PXE/recovery Linux
  environment with a transient hostname such as `debian`. Those observations do
  not change its physical identity.
- Never select or write Sakura's Windows partition when the user specifies its
  secondary/non-Windows disk. Record filesystem, label, UUID, size, model,
  serial, and mount state before creating data there.

