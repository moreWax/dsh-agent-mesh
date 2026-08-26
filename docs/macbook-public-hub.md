# MacBook → public hub migration (2026-08-26)

escha is live on the public hub with the capability-gated task service.
Run this on the MacBook to join it. Everything is dial-out; no network config.

```bash
cd ~/dsh-agent-mesh && git pull && pnpm install && pnpm -r build
cd packages/sam-mesh

# 1. public-hub posture: never publish LAN addresses to the swarm
export SAM_ANNOUNCE_PRIVATE=false   # add to ~/.zshrc

# 2. abandon the private-hub identity, enroll on the public hub
~/.local/bin/sam-node reset --data-dir ~/.config/sam-mesh   # if enrolled before
node lib/cli/index.mjs node join --control-plane https://hub.sam-mesh.dev
#    → device flow: open the printed URL, enter the code (browser approval)
#    → when asked "Start the node now?" say yes

# 3. fleet capability: required to CALL escha's task service
export SAM_MESH_CAPABILITY=731835d637ba515831e431c31fe1dafd76adb907f4e280fd   # add to ~/.zshrc — keep secret

# 4. verify
node lib/cli/index.mjs doctor          # all checks green
node lib/cli/index.mjs services        # should list morewax-dsh-task-service on escha's peer
node lib/cli/index.mjs peers

# 5. the two proofs
# stranger sim — omit the capability, expect rejection THROUGH the public relay:
node lib/cli/index.mjs call <escha-peer-prefix> task_get '{"taskId":"x"}' --capability wrong
#   → capability required
# fleet call — env var is picked up automatically:
node lib/cli/index.mjs call <escha-peer-prefix> task_submit \
  '{"idempotencyKey":"mac-public-1","input":{"from":"macbook via public hub"}}'
#   → task accepted
```
