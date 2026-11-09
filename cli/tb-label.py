#!/usr/bin/env python3
"""Label, copy or move messages from the command line.

Gmail labels are IMAP folders, so putting a message into the folder sets the
label. "label" skips messages that already carry it, "copy" always copies and
"move" removes the message from its current folder.

Examples:
  ./tb-label.py --list-folders
  ./tb-label.py --folder "Blackview XPLORE 2" --message-id '<abc@example.com>'
  ./tb-label.py --folder "Blackview XPLORE 2" --ids-file /tmp/ids.txt
  ./tb-label.py --folder "Blackview XPLORE 2" --query '{"subject": "XPLORE 2"}'
  ./tb-label.py --folder "Blackview XPLORE 2" --ids-file /tmp/ids.txt --move
"""
import argparse
import json
import os
import socket
import sys


def socket_path():
    return os.environ.get("TB_CLI_TOOLS_SOCK") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "tb-cli-tools.sock"
    )


def send(job, sock_path, timeout):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(sock_path)
    except (FileNotFoundError, ConnectionRefusedError):
        print("No host reachable (%s). Is Thunderbird running with the add-on enabled?" % sock_path,
              file=sys.stderr)
        return None, 3
    try:
        with sock, sock.makefile("rwb") as stream:
            stream.write((json.dumps(job) + "\n").encode("utf-8"))
            stream.flush()
            line = stream.readline()
    except socket.timeout:
        print("Timeout: no answer from the add-on.", file=sys.stderr)
        return None, 2
    if not line:
        print("Connection closed without an answer.", file=sys.stderr)
        return None, 2
    result = json.loads(line.decode("utf-8"))
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return result, 0 if result.get("ok") else 1


def read_ids(path):
    ids = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#"):
                ids.append(line)
    return ids


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--message-id", action="append", default=[],
                    help="Message-ID header of a mail to act on (may be repeated)")
    ap.add_argument("--ids-file", help="File with one Message-ID per line")
    ap.add_argument("--query", help='Message query as JSON, e.g. \'{"subject": "XPLORE 2"}\'')
    ap.add_argument("--folder", help='Folder/label name, e.g. "Blackview XPLORE 2"')
    ap.add_argument("--folder-id", help="Folder id (from --list-folders)")
    ap.add_argument("--account", help="Account id, needed if the folder name is ambiguous")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--copy", action="store_true", help="Copy instead of labelling")
    mode.add_argument("--move", action="store_true", help="Move instead of labelling")
    ap.add_argument("--list-folders", action="store_true", help="List folders/labels and exit")
    ap.add_argument("--timeout", type=float, default=180.0)
    ap.add_argument("--socket", default=socket_path())
    args = ap.parse_args()

    if args.list_folders:
        job = {"action": "folders"}
        if args.account:
            job["accountId"] = args.account
        _, code = send(job, args.socket, args.timeout)
        return code

    if not (args.folder or args.folder_id):
        ap.error("--folder or --folder-id is required")

    ids = list(args.message_id)
    if args.ids_file:
        ids.extend(read_ids(args.ids_file))
    if not ids and not args.query:
        ap.error("give at least one --message-id, --ids-file or --query")

    job = {
        "action": "move" if args.move else ("copy" if args.copy else "label"),
        "folder": args.folder,
        "folderId": args.folder_id,
        "accountId": args.account,
    }
    if ids:
        job["headerMessageIds"] = ids
    if args.query:
        job["query"] = json.loads(args.query)

    _, code = send(job, args.socket, args.timeout)
    return code


if __name__ == "__main__":
    sys.exit(main())
