# Linux iMessage Setup

iMessage on Linux via the corten-matrix bridge (rustpush). One-time Mac access required for hardware key extraction; no Mac needed at runtime.

## Step 1: Extract the hardware key (on a Mac, once)

1. Download `extract-key-cli.zip` from [corten-matrix tools](https://github.com/lrhodin/corten-matrix/tree/master/tools)
2. Unzip and run on any Mac (Intel or Apple Silicon)
3. It prints a validation blob — save this

## Step 2: Deploy corten-matrix (on escha or your Linux server)

```bash
curl -sL https://github.com/lrhodin/corten-matrix/releases/download/1.2.2/corten-matrix-linux-amd64 -o corten-matrix
chmod +x corten-matrix
./corten-matrix setup   # follow the interactive prompts
# paste the hardware key blob when asked for validation data
```

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
