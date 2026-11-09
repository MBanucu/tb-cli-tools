// Tests for the "label", "copy", "move" and "folders" jobs in background.js.
//
// The fake browser below mirrors the documented behaviour of the real API:
// copy()/move() take (messageIds, folderId, {isUserAction}), folders.query()
// returns MailFolder objects, and a Gmail label is just a folder. If the job
// resolves the wrong folder or forgets to skip already-labelled mail, these
// tests fail.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const source = fs.readFileSync(
  fileURLToPath(new URL("../background.js", import.meta.url)),
  "utf8",
);

const LABEL = {
  id: "account1://Blackview XPLORE 2",
  name: "Blackview XPLORE 2",
  path: "/Blackview XPLORE 2",
  accountId: "account1",
};

const MESSAGES = [
  { id: 11, headerMessageId: "<a@example.com>", subject: "Order information required" },
  { id: 12, headerMessageId: "<b@example.com>", subject: "XPLORE 2 camera bug" },
];

function loadExtension({ folders = [LABEL], messages = MESSAGES, inFolder = [] } = {}) {
  const calls = { copy: [], move: [], queries: [], downloads: [] };
  const results = [];
  let onJob = null;

  const port = {
    onMessage: { addListener: (fn) => { onJob = fn; } },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => results.push(msg),
  };

  const browser = {
    runtime: {
      connectNative: () => port,
      getManifest: () => ({ version: "test" }),
    },
    folders: {
      query: async (q) => {
        calls.queries.push(q);
        if (q.path === LABEL.path || q.name === LABEL.name) return folders;
        return folders;
      },
      get: async (id) => folders.find((f) => f.id === id),
    },
    messages: {
      query: async (q) => {
        calls.queries.push(q);
        if (q.headerMessageId) {
          return { messages: messages.filter((m) => m.headerMessageId === q.headerMessageId) };
        }
        if (q.folderId) return { messages: inFolder };
        return { messages: [] };
      },
      get: async (id) => messages.find((m) => m.id === id),
      copy: async (ids, folderId, options) => {
        calls.copy.push({ ids, folderId, options });
      },
      move: async (ids, folderId, options) => {
        calls.move.push({ ids, folderId, options });
      },
      getRaw: async () => new Blob(["raw message"]),
    },
    downloads: {
      download: async (options) => {
        calls.downloads.push(options);
        return 1;
      },
      search: async () => [{ state: "complete", filename: "/tmp/Downloads/x.eml", fileSize: 11 }],
    },
  };

  vm.runInNewContext(source, { browser, setTimeout, clearTimeout, console, URL });

  return {
    calls,
    run: (job) => onJob({ type: "job", id: "1", job }),
    last: () => results[results.length - 1],
  };
}

test("label copies matching Message-IDs into the folder and skips existing", async () => {
  const ext = loadExtension({ inFolder: [MESSAGES[1]] });
  await ext.run({
    action: "label",
    folder: "Blackview XPLORE 2",
    headerMessageIds: ["<a@example.com>", "<b@example.com>"],
  });

  assert.equal(ext.calls.copy.length, 1);
  assert.deepEqual(Array.from(ext.calls.copy[0].ids), [11], "already labelled mail must be skipped");
  assert.equal(ext.calls.copy[0].folderId, LABEL.id);
  assert.equal(ext.calls.copy[0].options.isUserAction, true);
  assert.equal(ext.calls.move.length, 0);

  const result = ext.last();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.action, "label");
  assert.equal(result.matched, 2);
  assert.equal(result.inFolder, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.changed, 1);
  assert.equal(result.folder.path, LABEL.path);
});

test("mail that is only in another folder is labelled, not skipped", async () => {
  const ext = loadExtension({ inFolder: [] });
  await ext.run({ action: "label", folder: "Blackview XPLORE 2", headerMessageIds: ["<b@example.com>"] });

  assert.deepEqual(Array.from(ext.calls.copy[0].ids), [12]);
  const result = ext.last();
  assert.equal(result.skipped, 0, "mail outside the folder must not count as labelled");
  assert.equal(result.changed, 1);
});

test("copy always copies, even if the message is already in the folder", async () => {
  const ext = loadExtension({ inFolder: MESSAGES });
  await ext.run({
    action: "copy",
    folderPath: "/Blackview XPLORE 2",
    headerMessageIds: ["<a@example.com>"],
  });

  assert.deepEqual(Array.from(ext.calls.copy[0].ids), [11]);
  assert.equal(ext.last().skipped, 0);
});

test("move calls messages.move, not copy", async () => {
  const ext = loadExtension();
  await ext.run({
    action: "move",
    folderId: LABEL.id,
    headerMessageIds: ["<b@example.com>"],
  });

  assert.equal(ext.calls.move.length, 1);
  assert.deepEqual(Array.from(ext.calls.move[0].ids), [12]);
  assert.equal(ext.calls.copy.length, 0);
  assert.equal(ext.last().changed, 1);
});

test("unknown folder fails with a clear error", async () => {
  const ext = loadExtension({ folders: [] });
  await ext.run({ action: "label", folder: "Nope", headerMessageIds: ["<a@example.com>"] });

  const result = ext.last();
  assert.equal(result.ok, false);
  assert.match(result.error, /Folder not found/);
});

test("unknown Message-ID fails with a clear error", async () => {
  const ext = loadExtension();
  await ext.run({ action: "label", folder: "Blackview XPLORE 2", headerMessageIds: ["<missing@example.com>"] });

  const result = ext.last();
  assert.equal(result.ok, false);
  assert.match(result.error, /Message not found/);
});

test("the same Message-ID in several folders is copied once", async () => {
  const dupes = [
    { id: 21, headerMessageId: "<c@example.com>", subject: "Bestellt" },
    { id: 22, headerMessageId: "<c@example.com>", subject: "Bestellt" },
  ];
  const ext = loadExtension({ messages: dupes, inFolder: [] });
  await ext.run({ action: "label", folder: "Blackview XPLORE 2", headerMessageIds: ["<c@example.com>"] });

  assert.deepEqual(Array.from(ext.calls.copy[0].ids), [21]);
  assert.equal(ext.last().changed, 1);
});

test("save exports the raw message through downloads", async () => {
  const ext = loadExtension();
  await ext.run({ action: "save", saveDir: "tb-export", headerMessageIds: ["<a@example.com>"] });

  const result = ext.last();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.count, 1);
  assert.equal(result.saved[0].headerMessageId, "<a@example.com>");
  assert.equal(result.saved[0].path, "/tmp/Downloads/x.eml");
  assert.match(ext.calls.downloads[0].filename, /^tb-export\/Email_\d{4}-\d{2}-\d{2}_\d{4}_/);
});

test("folders action lists folders", async () => {
  const ext = loadExtension();
  await ext.run({ action: "folders" });

  const result = ext.last();
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.folders[0].name, "Blackview XPLORE 2");
});
