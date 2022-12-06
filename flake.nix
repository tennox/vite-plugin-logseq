{
  description = "nodejs app";

  inputs = {
    devshell.url = "github:numtide/devshell";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, flake-utils, devshell, nixpkgs }:
    flake-utils.lib.eachDefaultSystem (system: {
      devShell =
        let
          pkgs = import nixpkgs {
            inherit system;

            overlays = [
              (final: prev: {
                # nodejs = prev.nodejs-18_x; # <== Set desired node version here
              })
              devshell.overlay
            ];
          };
        in
        pkgs.devshell.mkShell {
          #imports = [ (pkgs.devshell.importTOML ./devshell.toml) ]; - in case you want to enable devshell.toml support

          devshell.packages = with pkgs; [
            nodejs
            nodePackages.pnpm
            
            nixpkgs-fmt
          ];
        };
    });
}
