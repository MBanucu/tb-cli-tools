# tb-cli-tools

Thunderbird add-on plus CLI tools that create a **real reply** from the command
line — with subject, recipients, `In-Reply-To`/`References` and the quote that
Thunderbird itself inserts when you click "Reply" — and that print an `.eml` to
PDF through Thunderbird's own print pipeline. The compose window stays open and
is sent by hand; nothing is ever sent automatically.

## Layout

| Path | Purpose |
|---|---|
| `manifest.json`, `background.js`, `quote.js`, `experiments/` | Add-on (Manifest V3, ID `tb-cli-tools@local`, version 1.7) |
| `host/tb-cli-tools-host.py` | Native-messaging host: socket for the CLIs, HTTP for attachment data |
| `host/tb-cli-tools.json.in` | Host manifest, `@HOST@` is substituted (path must be free of spaces!) |
| `cli/tb-compose.py` | CLI for new messages |
| `cli/tb-reply.py` | CLI for replies |
| `cli/tb-print.py` | CLI for PDF printing |
| `cli/tb-label.py` | CLI to label/copy/move messages (Gmail labels are folders) |
| `tests/quote.test.mjs` | Unit tests for `quote.js` (`node --test tests/quote.test.mjs`) |
| `tests/compose.test.mjs` | Regression test for the `compose` job: the text belongs in `plainTextBody`, otherwise `beginNew` rejects it and the window stays empty |
| `tests/host_test.py` | Tests for the native-messaging host (`python3 tests/host_test.py`) |
| `flake.nix` | XPI, host and CLI wrappers as Nix packages |

## Installing with Nix / NixOS

The flake provides three packages:

```bash
nix build github:MBanucu/tb-cli-tools#xpi   # -> result: tb-cli-tools-1.7.xpi
nix build github:MBanucu/tb-cli-tools#host  # native-messaging host + manifest
nix build github:MBanucu/tb-cli-tools#cli   # tb-reply, tb-compose and tb-print
```

The add-on uses an experiment API (`tbPrint`), so it is unsigned and AMO signing
is not an option. It is installed through the Thunderbird enterprise policies,
not by copying it into the profile:

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

# Home Manager: host manifest and CLIs
home.file.".mozilla/native-messaging-hosts/tb_cli_tools.json".source =
  "${tb-cli-tools.packages.${system}.host}/lib/mozilla/native-messaging-hosts/tb_cli_tools.json";
home.packages = [ tb-cli-tools.packages.${system}.cli ];
```

Restart Thunderbird after changes. The version in `manifest.json` has to change
for Thunderbird to pick up a new XPI.

## Manual installation (without Nix)

```bash
P=~/.thunderbird/<profile>
mkdir -p "$P/extensions/tb-cli-tools@local" "$P/NativeMessagingHosts"
cp manifest.json background.js quote.js "$P/extensions/tb-cli-tools@local/"
cp -r experiments "$P/extensions/tb-cli-tools@local/"
cp host/tb-cli-tools.json.in "$P/NativeMessagingHosts/tb_cli_tools.json"
# replace @HOST@ in the manifest with the absolute path to tb-cli-tools-host.py
grep -q extensions.autoDisableScopes "$P/prefs.js" || \
  echo 'user_pref("extensions.autoDisableScopes", 0);' >> "$P/prefs.js"
```

The host has to live at a path **without spaces**, because `connectNative` splits
`path` on spaces.

## Starting Thunderbird from a shell

`scripts/tb-launch.sh` starts Thunderbird inside the running graphical session
via a transient `systemd-run --user` unit, waits until the host socket answers,
and handles the profile lock correctly:

```bash
scripts/tb-launch.sh                                  # start, or say it is already running
TB_PROFILE=~/.thunderbird/work scripts/tb-launch.sh   # other profile
```

It never deletes `lock`/`.parentlock` while a Thunderbird process is alive, waits
for an exiting instance instead of starting a second one on the same profile, and
retries once if the first start dies. Startup crashes seen here are `SIGSEGV`
inside `libfontconfig` (`FcStrBufString`), not the profile lock - the
`nsProfileLock::FatalSignalHandler` frame in the core dump only re-raises the
signal so a core is written. Unit name, waits and binary can be overridden with
`TB_UNIT`, `TB_WAIT_STOP`, `TB_WAIT_READY` and `TB_BIN`.

## New message

```bash
tb-compose --to artur.kuhn@jobcenter-ge.de \
           --subject 'Kundennummer: 000D343391 - Bearbeitungsstand des Antrags' \
           --body-file reply.txt
```

Opens a compose window with recipient, subject and body (`compose.beginNew`); it
is sent by hand. By default the text is set as plain text (`isPlainText` plus
`plainTextBody`); with `--html` it is treated as HTML. `--cc`, `--bcc` and
`--attach` work as they do for `tb-reply`.

## Labels, copy and move

Gmail labels are IMAP folders, so copying a message into the folder sets the
label on the server; no duplicate is created and nothing is removed.

```bash
tb-label --list-folders
tb-label --folder "Blackview XPLORE 2" --message-id '<abc@example.com>'
tb-label --folder "Blackview XPLORE 2" --ids-file ids.txt           # label (skip existing)
tb-label --folder "Blackview XPLORE 2" --ids-file ids.txt --copy    # always copy
tb-label --folder "Blackview XPLORE 2" --ids-file ids.txt --move    # move out of the source
```

`--message-id` may be repeated, `--ids-file` holds one Message-ID per line.
`--folder` is matched by name or path, `--folder-id` takes the id printed by
`--list-folders`, and `--account` disambiguates equal names in several accounts.
The `label` mode skips messages that already carry the label (reported as
`skipped`); `--query '<json>'` passes a `messages.query` object instead of ids.
The job returns `folder`, `matched`, `inFolder` (mails already in the label),
`skipped`, `changed` and the handled
messages as JSON.

## Replies

```bash
tb-reply.py \
  --message-id '<WGE77EVW323_...@zendesk.com>' \
  --body-file reply.txt \
  --attach attachment.pdf
```

Options: `--all` (reply to all), `--text` / `--html` (force a format; without
either the identity's format applies, which is normally HTML, as with the Reply
button), `--timeout`, `--socket`.
Output is JSON with `windowId`, `to`, `subject`, `bodyChars`, `quoted` and the
attached files. Exit code 0 = window is ready, 1 = error from the extension,
2 = timeout, 3 = no host (Thunderbird not running).

## Printing a PDF

```bash
tb-print.py --eml "/path/mail.eml" --out "/path/mail.pdf"
```

`experiments/print_parent.js` opens the `.eml` via `MailUtils.openEMLFile()`,
waits for the messagepane to finish rendering and then prints with
`browsingContext.print()` and the "Mozilla Save to PDF" pseudo-printer: A4,
12 mm margin, no header or footer. Exit codes as above.

Notes:

- The experiment API needs `extensions.experiments.enabled` (enabled by default).
- Thunderbird prints a header block (subject/from/date/to) and the attachment
  list at the end; page breaks differ from browser print output.
- For large PDFs (Type 3 fonts) Ghostscript helps:
  `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/prepress -o out.pdf in.pdf`

## Technical notes

- Native messaging instead of HTTP polling: an open port keeps the event page
  awake. With polling it fell asleep after ~30 s and jobs never arrived.
- Thunderbird builds the quote itself (`beginReply` = the same code as the Reply
  button). The reply text is only prepended; the quote stays untouched,
  including `moz-cite-prefix` and `blockquote type="cite"`.
- Attachments do not go through the 1 MB limit of native messaging; the host
  serves them briefly at `http://127.0.0.1:8767/f/<token>/<name>` and the
  extension attaches them as a `File`.
- `quote.js` builds the reply body; see `tests/quote.test.mjs` for details and
  tests.

## Uninstalling

```bash
rm -rf ~/.thunderbird/<profile>/extensions/tb-cli-tools@local
rm -f  ~/.mozilla/native-messaging-hosts/tb_cli_tools.json
```

## Tests

```bash
node --test tests/quote.test.mjs   # quote assembly
node --test tests/compose.test.mjs # compose payload against Thunderbird's format rules
node --test tests/label.test.mjs   # label/copy/move: folder resolution, skip logic
python3 tests/host_test.py         # host: port already taken, second instance, dead socket
```

All of them also run as flake checks:

```bash
nix build .#checks.x86_64-linux.quote-tests .#checks.x86_64-linux.compose-tests \
          .#checks.x86_64-linux.label-tests .#checks.x86_64-linux.host-tests
```
