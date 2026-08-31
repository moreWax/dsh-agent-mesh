{ lib, stdenvNoCC, nodejs_22, pnpm_10, gnutar, gzip, runCommand, src }:
let
  sourceTar = runCommand "dsh-agent-mesh-source.tar.gz" { nativeBuildInputs = [ gnutar gzip ]; } ''
    tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner -czf $out -C ${src} .
  '';
  pnpmDeps = pnpm_10.fetchDeps {
    pname = "dsh-agent-mesh-deps";
    version = "0.1.0";
    src = sourceTar;
    fetcherVersion = 1;
    hash = lib.fakeHash;
  };
in stdenvNoCC.mkDerivation {
  pname = "dsh-imessage-release";
  version = "0.1.0";
  inherit src pnpmDeps;
  nativeBuildInputs = [ nodejs_22 pnpm_10 pnpm_10.configHook ];
  dontUnpack = true;
  dontConfigure = true;
  buildPhase = ''
    mkdir -p "$TMPDIR/source"
    cp -R ${src}/. "$TMPDIR/source/"
    chmod -R u+w "$TMPDIR/source"
    cd "$TMPDIR/source"
    export HOME=$TMPDIR/home
    mkdir -p $HOME
    pnpm --filter @morewax/dsh-imessage build
    node scripts/check-imessage-release.mjs .
    pnpm --filter @morewax/dsh-imessage pack --pack-destination $TMPDIR
  '';
  installPhase = ''
    mkdir -p $out
    cp $TMPDIR/morewax-dsh-imessage-*.tgz $out/
    cp packages/dsh-imessage/assets/runtime/artifacts.json $out/checksums.json
    (cd $out && sha256sum *.tgz checksums.json > SHA256SUMS)
  '';
  meta.platforms = [ "x86_64-linux" "aarch64-linux" ];
}
