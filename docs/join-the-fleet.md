# Joining the fleet (any machine, anywhere)

Two commands total. The joining machine needs the kit (clone + build until
npm publish) and one invite file from any fleet machine.

## On any fleet machine (e.g. escha) — create the invite

```bash
cd ~/dsh-agent-mesh/packages/sam-mesh
node lib/cli/index.mjs fleet invite --out ~/fleet-invite.json --ssh <user@new-machine>
```

Auto-detects the hub from the local node's live store and the capability
from the dsh credentials. The invite is 0600 — it carries the fleet
capability; move it by scp/ssh, never chat.

## On the joining machine

```bash
git clone https://github.com/moreWax/dsh-agent-mesh && cd dsh-agent-mesh
corepack enable && pnpm install && pnpm -r build
node packages/sam-mesh/lib/cli/index.mjs fleet join --invite ~/fleet-invite.json
```

`fleet join` handles everything else interactively:

1. **Hub mismatch** — enrolled on a different hub? It tells you which, and
   requires typing `reset` before touching the identity (destructive stays
   deliberate, but no longer *manual*)
2. **Enrollment** — device flow (public hub: URL + code, one browser
   approval) or bootstrap token (private hub invite: unattended)
3. **Capability** — written to `~/.config/sam-mesh/fleet-capability` (0600,
   auto-read by `call`/`tail`) AND merged into `~/.dsh/.credentials.yaml`
   (never overwrites existing keys)
4. **dsh profile patch** — written/merged into the profile's cordis.patch.yml
   when dsh is present (conflicts hand back the exact block, never clobber)
5. **Node start** — offered; dsh takes over ownership later if installed
6. **Doctor epilogue** — ends with the same checks the Web UI shows

## Full dsh peer (optional, after join)

```bash
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness && corepack enable && pnpm install && pnpm -r build
node apps/cli/src/bin.ts --profile web \
  plugin add link:$HOME/dsh-agent-mesh/packages/dsh-agent-mesh
```

Start dsh with `--profile web`: the plugin sees the enrolled node, starts
it (dsh-managed), announces `morewax-dsh-task-service` with the capability
gate, and the mesh card's Onboarding wizard goes green.

## Verify (either machine)

```bash
sam-mesh peers                                  # the other machine, short id
sam-mesh call <peer-prefix> task_submit '{"idempotencyKey":"x1","input":{"hi":"there"}}'
sam-mesh tail <peer-prefix> <task-id>
# stranger sim — expect "capability required" through the public relay:
sam-mesh call <peer-prefix> task_get '{"taskId":"x"}' --capability wrong
```
