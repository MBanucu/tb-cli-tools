// Regressionstest fuer den "compose"-Auftrag in background.js.
//
// Thunderbird lehnt compose.beginNew mit isPlainText:true UND "body" ab
// ("Conflicting format setting: isPlainText = true and providing a body but no
// plainTextBody."). Genau daran ist tb-compose 1.1 gescheitert: das Fenster
// ging auf, blieb aber leer. Der Fake unten bildet diese Regel nach, damit der
// Test bei falschem Payload fehlschlaegt statt still durchzulaufen.
//
// Kontrolllauf gegen die alte Fassung:
//   TB_BACKGROUND_JS=/tmp/bg_old.js node --test tests/compose.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const defaultSource = fileURLToPath(new URL("../background.js", import.meta.url));
const sourcePath = process.env.TB_BACKGROUND_JS || defaultSource;
const source = fs.readFileSync(sourcePath, "utf8");

function loadExtension() {
  const opened = [];
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
    compose: {
      beginNew: async (details) => {
        // Regel der echten API: Textmodus braucht plainTextBody, nicht body.
        if (details.isPlainText === true && "body" in details && !("plainTextBody" in details)) {
          throw new Error(
            "Conflicting format setting: isPlainText = true and providing a body but no plainTextBody.",
          );
        }
        opened.push({ ...details });
        return { id: 1, windowId: 7 };
      },
      getComposeDetails: async () => {
        const d = opened[opened.length - 1] || {};
        return {
          isPlainText: d.isPlainText !== false,
          subject: d.subject || "",
          to: d.to || [],
          cc: d.cc || [],
          bcc: d.bcc || [],
          body: d.body ?? "",
          plainTextBody: d.plainTextBody ?? "",
        };
      },
      listAttachments: async () => [],
      addAttachment: async () => {},
    },
  };

  vm.runInNewContext(source, { browser, setTimeout, clearTimeout, console });

  return {
    opened,
    results,
    run: (job) => onJob({ type: "job", id: "1", job }),
    last: () => results[results.length - 1],
  };
}

const BODY = "Sehr geehrter Herr Kuhn,\n\nbitte um Auskunft.\n";

test("Textmodus legt den Text in plainTextBody ab", async () => {
  const ext = loadExtension();
  await ext.run({
    action: "compose",
    to: ["artur.kuhn@jobcenter-ge.de"],
    cc: [],
    bcc: [],
    subject: "Kundennummer: 000D343391 - Bearbeitungsstand des Antrags",
    body: BODY,
    plainText: true,
    attachments: [],
  });

  const details = ext.opened[0];
  assert.equal(details.isPlainText, true);
  assert.equal(details.plainTextBody, BODY);
  assert.equal("body" in details, false, "body darf im Textmodus nicht gesetzt sein");

  const result = ext.last();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.format, "text");
  assert.equal(result.bodyChars, BODY.length);
  assert.equal(result.subject, "Kundennummer: 000D343391 - Bearbeitungsstand des Antrags");
  assert.equal(result.to, "artur.kuhn@jobcenter-ge.de");
});

test("ohne Formatangabe gilt ebenfalls plainTextBody", async () => {
  const ext = loadExtension();
  await ext.run({
    action: "compose",
    to: ["artur.kuhn@jobcenter-ge.de"],
    subject: "Test",
    body: BODY,
    plainText: null,
    attachments: [],
  });

  assert.equal(ext.opened[0].plainTextBody, BODY);
  assert.equal("body" in ext.opened[0], false);
  assert.equal(ext.last().ok, true, ext.last().error);
});

test("HTML-Modus setzt body und kein plainTextBody", async () => {
  const ext = loadExtension();
  const html = "<p>Sehr geehrter Herr Kuhn,</p>";
  await ext.run({
    action: "compose",
    to: ["artur.kuhn@jobcenter-ge.de"],
    subject: "Test",
    body: html,
    plainText: false,
    attachments: [],
  });

  const details = ext.opened[0];
  assert.equal(details.isPlainText, false);
  assert.equal(details.body, html);
  assert.equal("plainTextBody" in details, false);
  assert.equal(ext.last().ok, true, ext.last().error);
  assert.equal(ext.last().format, "html");
});
