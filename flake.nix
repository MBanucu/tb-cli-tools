{
  description = "Thunderbird add-on + CLIs to create real replies and print mails to PDF";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      version = "1.6";
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        rec {
          default = xpi;

          # Unsigned XPI for sideloading or policy install (ExtensionSettings).
          # Experiment APIs are not accepted by AMO, so signing is not an option.
          xpi = pkgs.runCommand "tb-cli-tools-${version}.xpi" {
            nativeBuildInputs = [ pkgs.zip ];
          } ''
            mkdir addon
            install -m644 ${./manifest.json} addon/manifest.json
            install -m644 ${./background.js} addon/background.js
            install -m644 ${./quote.js} addon/quote.js
            cp -r ${./experiments} addon/experiments
            chmod -R u+w addon
            find addon -type f -exec chmod 644 {} +
            cd addon
            zip -q -r -X "$out" manifest.json background.js quote.js experiments
          '';

          # Native-messaging host plus its manifest. The manifest expects a path
          # without spaces, which a store path always is.
          host = pkgs.runCommand "tb-cli-tools-host-${version}" { } ''
            mkdir -p $out/bin $out/lib/mozilla/native-messaging-hosts
            install -m755 ${./host/tb-cli-tools-host.py} $out/bin/tb-cli-tools-host.py
            substituteInPlace $out/bin/tb-cli-tools-host.py \
              --replace-fail '#!/usr/bin/env python3' '#!${pkgs.python3}/bin/python3'
            install -m644 ${./host/tb-cli-tools.json.in} \
              $out/lib/mozilla/native-messaging-hosts/tb_cli_tools.json
            substituteInPlace $out/lib/mozilla/native-messaging-hosts/tb_cli_tools.json \
              --replace-fail '@HOST@' "$out/bin/tb-cli-tools-host.py"
          '';

          # tb-reply, tb-compose, tb-print and tb-label on PATH.
          cli = pkgs.runCommand "tb-cli-tools-cli-${version}" { } ''
            mkdir -p $out/bin
            install -m755 ${./cli/tb-reply.py} $out/bin/tb-reply
            install -m755 ${./cli/tb-compose.py} $out/bin/tb-compose
            install -m755 ${./cli/tb-print.py} $out/bin/tb-print
            install -m755 ${./cli/tb-label.py} $out/bin/tb-label
            substituteInPlace $out/bin/tb-reply $out/bin/tb-compose $out/bin/tb-print $out/bin/tb-label \
              --replace-fail '#!/usr/bin/env python3' '#!${pkgs.python3}/bin/python3'
          '';
        }
      );

      checks = forAllSystems (pkgs: {
        quote-tests = pkgs.runCommand "tb-cli-tools-tests" {
          nativeBuildInputs = [ pkgs.nodejs ];
        } ''
          cp -r ${./.} repo
          cd repo
          node --test tests/quote.test.mjs
          touch $out
        '';

        compose-tests = pkgs.runCommand "tb-cli-tools-compose-tests" {
          nativeBuildInputs = [ pkgs.nodejs ];
        } ''
          cp -r ${./.} repo
          cd repo
          node --test tests/compose.test.mjs
          touch $out
        '';

        label-tests = pkgs.runCommand "tb-cli-tools-label-tests" {
          nativeBuildInputs = [ pkgs.nodejs ];
        } ''
          cp -r ${./.} repo
          cd repo
          node --test tests/label.test.mjs
          touch $out
        '';

        host-tests = pkgs.runCommand "tb-cli-tools-host-tests" {
          nativeBuildInputs = [ pkgs.python3 ];
        } ''
          cp -r ${./.} repo
          cd repo
          python3 tests/host_test.py
          touch $out
        '';
      });
    };
}
