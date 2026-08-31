{ lib, stdenvNoCC, nodejs_22, pnpm_9, src }:
stdenvNoCC.mkDerivation {
  pname = "dsh-imessage-release";
  version = "0.1.0";
  inherit src;
  nativeBuildInputs = [ nodejs_22 pnpm_9 ];
  dontConfigure = true;
  buildPhase = ''
    export HOME=$TMPDIR/home
    mkdir -p $HOME
    pnpm install --offline --frozen-lockfile
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
