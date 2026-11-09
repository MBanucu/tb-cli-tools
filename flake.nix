{
  description = "Thunderbird add-on + CLIs to create real replies and print mails to PDF";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      version = "1.0";
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
          xpi = pkgs.runCommand "tb-cli-reply-${version}.xpi" {
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
          host = pkgs.runCommand "tb-cli-reply-host-${version}" { } ''
            mkdir -p $out/bin $out/lib/mozilla/native-messaging-hosts
            install -m755 ${./host/tb-cli-reply-host.py} $out/bin/tb-cli-reply-host.py
            substituteInPlace $out/bin/tb-cli-reply-host.py \
              --replace-fail '#!/usr/bin/env python3' '#!${pkgs.python3}/bin/python3'
            install -m644 ${./host/tb-cli-reply.json.in} \
              $out/lib/mozilla/native-messaging-hosts/tb_cli_reply.json
            substituteInPlace $out/lib/mozilla/native-messaging-hosts/tb_cli_reply.json \
              --replace-fail '@HOST@' "$out/bin/tb-cli-reply-host.py"
          '';

          # tb-reply and tb-print on PATH.
          cli = pkgs.runCommand "tb-cli-reply-cli-${version}" { } ''
            mkdir -p $out/bin
            install -m755 ${./cli/tb-reply.py} $out/bin/tb-reply
            install -m755 ${./cli/tb-print.py} $out/bin/tb-print
            substituteInPlace $out/bin/tb-reply $out/bin/tb-print \
              --replace-fail '#!/usr/bin/env python3' '#!${pkgs.python3}/bin/python3'
          '';
        }
      );

      checks = forAllSystems (pkgs: {
        quote-tests = pkgs.runCommand "tb-cli-reply-tests" {
          nativeBuildInputs = [ pkgs.nodejs ];
        } ''
          cp -r ${./.} repo
          cd repo
          node --test tests/quote.test.mjs
          touch $out
        '';
      });
    };
}
