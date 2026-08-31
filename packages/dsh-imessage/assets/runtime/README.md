# Rootless runtime artifact manifest

`artifacts.json` is immutable release input, not a mutable update channel.

| Component | Version | Checksum source |
|---|---:|---|
| k3s | v1.36.4+k3s1 | release `sha256sum-amd64.txt` / `sha256sum-arm64.txt` |
| RootlessKit | v3.1.0 | release `SHA256SUMS` |
| slirp4netns | v1.3.5 | release `SHA256SUMS` |

The plugin downloads the exact URL to a private `.partial` file, computes SHA-256 locally, and only then atomically installs declared regular-file executables. Archives reject absolute paths, `..`, missing members, symlinks, and non-regular executable members. Updating any component requires a reviewed manifest change and acceptance rerun.
