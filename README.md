# tb-cli-tools

Thunderbird-Add-on plus CLI, das per Kommandozeile eine **echte Antwort**
erzeugt — mit Betreff, Empfänger, `In-Reply-To`/`References` und dem Zitat, das
Thunderbird selbst beim Klick auf „Antworten“ einfügt — und das eine `.eml` mit
Thunderbirds eigener Druck-Pipeline als PDF ausgibt. Das Verfassen-Fenster
bleibt offen und wird von Hand gesendet; nichts wird automatisch verschickt.

## Aufbau

| Pfad | Zweck |
|---|---|
| `manifest.json`, `background.js`, `quote.js`, `experiments/` | Add-on (Manifest V3, ID `tb-cli-tools@local`, Version 1.0) |
| `host/tb-cli-tools-host.py` | Native-Messaging-Host: Socket für das CLI, HTTP für Anhangsdaten |
| `host/tb-cli-tools.json.in` | Host-Manifest, `@HOST@` wird ersetzt (Pfad ohne Leerzeichen!) |
| `cli/tb-reply.py` | CLI für Antworten |
| `cli/tb-print.py` | CLI für PDF-Druck |
| `tests/quote.test.mjs` | Unit-Tests für `quote.js` (`node --test tests/`) |
| `flake.nix` | XPI, Host und CLI-Wrapper als Nix-Pakete |

## Installation mit Nix / NixOS

Das Flake liefert drei Pakete:

```bash
nix build github:MBanucu/tb-cli-tools#xpi   # -> result: tb-cli-tools-1.0.xpi
nix build github:MBanucu/tb-cli-tools#host  # Native-Messaging-Host + Manifest
nix build github:MBanucu/tb-cli-tools#cli   # tb-reply und tb-print
```

Das Add-on nutzt eine Experiment-API (`tbPrint`) und ist daher unsigniert;
AMO-Signierung ist keine Option. Eingebunden wird es über die
Thunderbird-Enterprise-Policies, nicht durch Kopieren in das Profil:

```nix
# flake.nix
inputs.tb-cli-tools = {
  url = "github:MBanucu/tb-cli-tools";
  inputs.nixpkgs.follows = "nixpkgs";
};

# configuration.nix
users.users.michi.packages = [
  (pkgs.thunderbird-latest.override {
    extraPolicies.ExtensionSettings."tb-cli-tools@local" = {
      installation_mode = "force_installed";
      install_url = "file://${tb-cli-tools.packages.${system}.xpi}";
      updates_disabled = true;
    };
  })
];

# Home Manager: Host-Manifest und CLIs
home.file.".mozilla/native-messaging-hosts/tb_cli_tools.json".source =
  "${tb-cli-tools.packages.${system}.host}/lib/mozilla/native-messaging-hosts/tb_cli_tools.json";
home.packages = [ tb-cli-tools.packages.${system}.cli ];
```

Nach Änderungen Thunderbird neu starten. Die Version im `manifest.json` muss
sich ändern, damit Thunderbird eine neue XPI übernimmt.

## Manuelle Installation (ohne Nix)

```bash
P=~/.thunderbird/<profil>
mkdir -p "$P/extensions/tb-cli-tools@local" "$P/NativeMessagingHosts"
cp manifest.json background.js quote.js "$P/extensions/tb-cli-tools@local/"
cp -r experiments "$P/extensions/tb-cli-tools@local/"
cp host/tb-cli-tools.json.in "$P/NativeMessagingHosts/tb_cli_tools.json"
# @HOST@ im Manifest durch den absoluten Pfad zu tb-cli-tools-host.py ersetzen
grep -q extensions.autoDisableScopes "$P/prefs.js" || \
  echo 'user_pref("extensions.autoDisableScopes", 0);' >> "$P/prefs.js"
```

Der Host muss an einem Pfad **ohne Leerzeichen** liegen, weil `connectNative`
`path` an Leerzeichen zerlegt.

## Antworten

```bash
tb-reply.py \
  --message-id '<WGE77EVW323_...@zendesk.com>' \
  --body-file antwort.txt \
  --attach anhang.pdf
```

Optionen: `--all` (allen antworten), `--text` / `--html` (Format erzwingen; ohne
Angabe gilt das Format der Identity, also normalerweise HTML wie beim
Antwort-Button), `--timeout`, `--socket`.
Ausgabe ist JSON mit `windowId`, `to`, `subject`, `bodyChars`, `quoted` und den
angehängten Dateien. Exitcode 0 = Fenster steht bereit, 1 = Fehler der
Erweiterung, 2 = Zeitüberschreitung, 3 = kein Host (Thunderbird aus).

## PDF drucken

```bash
tb-print.py --eml "/pfad/mail.eml" --out "/pfad/mail.pdf"
```

`experiments/print_parent.js` öffnet die `.eml` via `MailUtils.openEMLFile()`,
wartet auf den fertig gerenderten messagepane und druckt dann mit
`browsingContext.print()` und dem Pseudo-Drucker „Mozilla Save to PDF“: A4,
12 mm Rand, ohne Kopf-/Fußzeile. Exitcodes wie oben.

Hinweise:

- Die Experiment-API braucht `extensions.experiments.enabled` (standardmäßig
  aktiv).
- Thunderbird druckt einen Kopfblock (Subject/From/Date/To) und am Ende die
  Anhangsliste; die Seitenumbrüche weichen von Browser-Druckausgaben ab.
- Bei großen PDFs (Type-3-Schrift) hilft Ghostscript:
  `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress -o out.pdf in.pdf`

## Technische Notizen

- Native Messaging statt HTTP-Polling: ein offener Port hält die Event-Page
  wach. Mit Polling schlief sie nach ~30 s ein und Aufträge kamen nie an.
- Das Zitat erzeugt Thunderbird selbst (`beginReply` = derselbe Code wie der
  Antwort-Button). Der Antworttext wird nur davorgesetzt; das Zitat bleibt
  unverändert, inklusive `moz-cite-prefix` und `blockquote type="cite"`.
- Anhänge gehen nicht durch die 1-MB-Grenze von Native Messaging, sondern
  werden vom Host kurzzeitig unter `http://127.0.0.1:8767/f/<token>/<name>`
  bereitgestellt und von der Erweiterung als `File` angehängt.
- `quote.js` baut den Antwort-Body; Details und Tests siehe
  `tests/quote.test.mjs`.

## Entfernen

```bash
rm -rf ~/.thunderbird/<profil>/extensions/tb-cli-tools@local
rm -f  ~/.mozilla/native-messaging-hosts/tb_cli_tools.json
```
