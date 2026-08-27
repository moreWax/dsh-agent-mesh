# Release notes — first public publish (draft)

## Packages

| package | version | notes |
|---|---|---|
| `@morewax/dsh-agent-mesh` | 0.1.0 | the dsh plugin: mesh node lifecycle, fleet pairing, task service, capability-gated inference, vendored-runtime model serving, card UI with first-run wizard |
| `@morewax/sam-mesh` | 0.0.1 | client + node kit + CLI (`sam-mesh`), no dsh dependency |
| `@morewax/sam-node-{darwin-arm64,darwin-x64,linux-x64,linux-arm64}` | 0.2.0-ci.6502323 | sam-node CI-built from pinned google/sam commit 6502323 (releases ≤ alpha.7 cannot poll dex device flow; switch back when upstream tags the fix — google/sam#320) |
| `@morewax/llama-cpp-{…}` | 0.10642.0 | llama.cpp b10642 binaries (version tracks upstream tag) |

## Version scheme (decision)

- **Our own packages** (sam-mesh, dsh-agent-mesh): independent 0.x semver. Breaking changes bump minor until 1.0.
- **Vendored-binary packages**: version tracks the upstream artifact they carry
  (`llama.cpp` b10642 → 0.10642.0; sam CI build → 0.2.0-ci.<commit>), so the
  version string is provenance, not marketing.
- optionalDependencies pin via workspace:* → exact versions at publish.

## Headline features

- One-command install: `dsh plugin add @morewax/dsh-agent-mesh` — sam-node AND llama.cpp binaries vendored per-platform, zero install-time network
- Card-driven everything: first-run wizard (enroll → start → join fleet → ready), fleet administration from any paired machine, serve models with backend auto-detection or the vendored llama.cpp runtime
- Security posture for the public hub: listing open, execution capability-gated (tasks AND inference); pairing = human approval with ECIES-sealed capability delivery; stale-identity self-heal via stored refresh token
- Degrade-never-crash serve rows, status-file truth, orphan adoption, HF sha256-verified model downloads

## Known limitations (honest README section)

- Vendored llama.cpp builds are CPU/Metal (vulkan/CUDA follow-ups)
- One shared fleet capability (no per-member keys/revocation yet)
- sam-node is a CI build, not an official release (see provenance above)
