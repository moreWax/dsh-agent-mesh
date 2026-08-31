# Linux iMessage Setup

iMessage on Linux via the corten-matrix bridge (rustpush). One-time Mac access required for hardware key extraction; no Mac needed at runtime.

## Step 1: Extract the hardware key (on a Mac, once)

1. Download `extract-key-cli.zip` from [corten-matrix tools](https://github.com/lrhodin/corten-matrix/tree/master/tools)
2. Unzip and run on any Mac (Intel or Apple Silicon)
3. It prints a validation blob — save this

## Step 2: Choose a Matrix runtime (explicit first-run action)

In dsh Settings → iMessage → Linux setup, choose one of:

- **Use an existing Kubernetes cluster**
- **Create a private rootless k3s cluster** (user-owned; no sudo)
- **Use an external Matrix server**

The plugin downloads only pinned, checksum-verified artifacts after explicit confirmation. It resumes after restart and never runs `curl | sh` or silently escalates privileges.

For a manual bridge install, download corten-matrix v1.2.2 from its release page and run `corten-matrix setup`; the plugin then connects using Matrix credentials stored by reference.

## Step 3: Install the dsh-imessage plugin

```bash
dsh plugin add @morewax/dsh-imessage
```

Configure the bridge backend in the plugin config:
```yaml
fleetChannel:
  serviceName: dsh-task-service
bridge:
  homeserverUrl: http://your-homeserver:8008
  accessToken: <token from the bridge setup>
  roomId: <room id from the bridge setup>
```

## Step 4: Verify

```bash
# the doctor should show trust health
sam-mesh doctor
# the chat should show imessage messages
# the fleet channel should show system events
```

## Current support boundary

Linux deployment is experimental until the rootless runtime and fresh clean-room acceptance matrix pass. The macOS native backend is independent and does not require k3s or Matrix.
