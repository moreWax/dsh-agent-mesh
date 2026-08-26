# Joining the fleet (any machine, anywhere)

The fleet announces itself on the public mesh. A new machine discovers it,
requests to pair, an operator approves, and the capability arrives sealed to
the requester's ephemeral key — **no ssh, no files, no copied secrets**.

## New machine (two commands)

```bash
git clone https://github.com/moreWax/dsh-agent-mesh && cd dsh-agent-mesh
corepack enable && pnpm install && pnpm -r build
alias sam-mesh='node packages/sam-mesh/lib/cli/index.mjs'

sam-mesh node join --control-plane https://hub.sam-mesh.dev   # device flow, one browser approval
sam-mesh fleet join --fleet morewax-dsh-task-service          # pairing request → waits for approval
```

(`fleet discover` browses fleets if you don't know the name.)

## Operator (any fleet machine)

```bash
sam-mesh fleet approvals                       # pending requests, with labels
sam-mesh fleet approvals approve <requestId>   # seals + delivers the invite
# or: fleet approvals reject <requestId>
```

The moment you approve, the joiner's poll returns the fleet invite — sealed
so only their ephemeral key can open it — and `fleet join` finishes
provisioning: capability file (0600, auto-used by `call`/`tail`), dsh
credential merge, profile patch, done.

## Full dsh peer (optional, after pairing)

```bash
git clone https://github.com/deepseek-ai/deepseek-harness
cd deepseek-harness && corepack enable && pnpm install && pnpm -r build
node apps/cli/src/bin.ts --profile web \
  plugin add link:$HOME/dsh-agent-mesh/packages/dsh-agent-mesh
```

Start dsh with `--profile web` — the plugin starts the node, announces the
gated task service, and the mesh card's Onboarding wizard goes green.

## Alternative: invite file (air-gapped / scripted / private hubs)

```bash
# operator:                        # joiner:
sam-mesh fleet invite --out i.json  sam-mesh fleet join --invite i.json
```

Carries the same payload as a sealed pairing, as a 0600 file. Move it by
whatever channel you trust. Private-hub invites can embed a bootstrap token
for unattended enrollment.

## Security model (why strangers lose)

- Discovery is public by design: the swarm can see the fleet's phone-book
  entry. Presence, never content.
- `fleet_pair_request`/`poll` are ungated but powerless: request ids are
  128-bit random, pending lists and approvals sit behind the capability.
- The capability only ever travels sealed to an ephemeral X25519 key, over
  an already end-to-end-encrypted channel, after a human approves.
- Delivery is single-use; requests expire in 10 minutes; pending caps at 16.

## Verify (either machine)

```bash
sam-mesh doctor
sam-mesh peers
sam-mesh call <peer-prefix> task_submit '{"idempotencyKey":"x1","input":{"hi":"there"}}'
sam-mesh tail <peer-prefix> <task-id>
# stranger sim — expect "capability required" through the public relay:
sam-mesh call <peer-prefix> task_get '{"taskId":"x"}' --capability wrong
```
