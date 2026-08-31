{
  description = "Reproducible dsh-imessage release checks";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));
    in {
      packages = forAllSystems (pkgs: {
        dsh-imessage-release = pkgs.callPackage ./nix/release.nix { src = self; };
        default = self.packages.${pkgs.system}.dsh-imessage-release;
      });
      checks = forAllSystems (pkgs: {
        matrix-assets = pkgs.runCommand "dsh-imessage-matrix-assets" { nativeBuildInputs = [ pkgs.nodejs_22 ]; } ''
          node ${self}/scripts/check-imessage-release.mjs ${self}
          touch $out
        '';
      });
    };
}
