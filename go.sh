#!/bin/sh
# WorkWire — link THIS machine (Sakura) to HINOKI with full root control.
# Run once:  sh go.sh
set -e
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "$HOME/WorkWire")
cd "$here"

echo "[WorkWire] Unpacking recovery agent..."
tar -xzf "$here/wwra.tgz" -C "$here"

# Locate Node 22 (root's PATH may not include a user-local node)
NODE=""
for c in "$(command -v node 2>/dev/null || true)" /usr/bin/node /usr/local/bin/node \
         "$HOME/.local/bin/node" "$HOME"/.local/opt/workwire/*/node /opt/workwire/*/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "[WorkWire] ERROR: Node.js not found on this machine. Screenshot this and tell HINOKI."
  exit 1
fi
NODEDIR=$(dirname "$NODE")
echo "[WorkWire] Using node: $NODE ($("$NODE" --version 2>/dev/null))"

echo "[WorkWire] Installing the root recovery agent, linking to HINOKI (192.168.8.104:4852)..."
printf '%s\n' '59163476' | sudo -S env "PATH=$NODEDIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  bash "$here/wwra/scripts/install-ww-recovery-agent.sh" install --controller http://192.168.8.104:4852

echo ""
echo "[WorkWire] ================================================="
echo "[WorkWire]  DONE. Sakura is now under HINOKI's control."
echo "[WorkWire]  Go back to HINOKI and say: 'sakura is linked'."
echo "[WorkWire] ================================================="
