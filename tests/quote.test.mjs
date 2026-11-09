/* Tests fuer den Zitat-Zusammenbau von tb-cli-reply.
 *
 * Aufruf:  node --test Tools/tb-reply/tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import "../quote.js"; // klassisches Script, setzt globalThis.TBQuote

const { escapeHtml, textToHtml, stripLeadingNoise, stripCharsetMeta, buildHtmlBody, buildPlainTextBody } =
  globalThis.TBQuote;

const PREFIX =
  '<div class="moz-cite-prefix">On 9/24/26 09:35, Jenny (Support) wrote:<br></div>';
const QUOTE =
  '<blockquote type="cite" cite="mid:WGE77EVW323_6ab4eeed1867d_a5a2db00bc57a5_sprut@zendesk.com">' +
  '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
  '<style type="text/css">@scope { table td { border-collapse: collapse; } }</style>' +
  "<p>Hello, sorry about that</p></blockquote>";
const NATIVE_QUOTE = PREFIX + QUOTE;

test("Modul stellt die oeffentliche API bereit", () => {
  for (const fn of [escapeHtml, textToHtml, stripLeadingNoise, stripCharsetMeta, buildHtmlBody, buildPlainTextBody]) {
    assert.equal(typeof fn, "function");
  }
});

test("escapeHtml maskiert nur HTML-kritische Zeichen", () => {
  assert.equal(escapeHtml('a & b <c> "d" \'e\''), 'a &amp; b &lt;c&gt; "d" \'e\'');
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("textToHtml macht aus Zeilenumbruechen <br> und normalisiert CRLF", () => {
  assert.equal(textToHtml("A\nB"), "A<br>B");
  assert.equal(textToHtml("A\r\nB\rC"), "A<br>B<br>C");
});

test("HTML-Antwort: eigener Text steht in genau einem Absatz vor dem Zitat", () => {
  const body = buildHtmlBody("Hallo Jenny,\n\ndanke fuer die Antwort.", NATIVE_QUOTE);
  assert.ok(body.startsWith("<p>Hallo Jenny,<br><br>danke fuer die Antwort.</p>"), body);
  assert.ok(body.endsWith(stripCharsetMeta(NATIVE_QUOTE)), "Zitat muss unveraendert folgen");
  const ownPart = body.slice(0, body.indexOf('<div class="moz-cite-prefix">'));
  assert.equal(ownPart.match(/<p>/g).length, 1, "genau ein Absatz fuer den eigenen Text");
  assert.equal(ownPart.match(/<\/p>/g).length, 1);
  assert.equal(body.match(/moz-cite-prefix/g).length, 1);
});

test("HTML-Antwort: Zitat behaelt Typ, Message-ID und Innenleben", () => {
  const body = buildHtmlBody("Antwort", NATIVE_QUOTE);
  assert.match(body, /<blockquote type="cite" cite="mid:WGE77EVW323_[^"]+">/);
  assert.ok(body.includes('cite="mid:WGE77EVW323_'), "Message-ID bleibt erhalten");
  assert.ok(body.includes("<style type=\"text/css\">@scope"), "Zitat-CSS bleibt erhalten");
  assert.ok(!body.includes("charset"), "charset-<meta> wird entfernt");
});

test("HTML-Antwort: eigener Text wird maskiert, Zitat nicht", () => {
  const body = buildHtmlBody("if (a < b) -> ok & feddich", NATIVE_QUOTE);
  assert.ok(body.startsWith("<p>if (a &lt; b) -&gt; ok &amp; feddich</p>"));
  assert.ok(body.includes('<blockquote type="cite"'), "Zitat wird nicht escaped");
});

test("stripLeadingNoise entfernt vorgezogene <meta>-Tags", () => {
  const noisy = '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">\n' + NATIVE_QUOTE;
  assert.equal(stripLeadingNoise(noisy), NATIVE_QUOTE);
  const doubleMeta =
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
    '<meta charset="utf-8">' + NATIVE_QUOTE;
  assert.equal(stripLeadingNoise(doubleMeta), NATIVE_QUOTE);
});

test("stripLeadingNoise entfernt die leere Schreibmarken-Zeile vor dem Zitatkopf", () => {
  assert.equal(stripLeadingNoise("<p><br></p>" + NATIVE_QUOTE), NATIVE_QUOTE);
  assert.equal(stripLeadingNoise("<p><br>\n</p>\n" + NATIVE_QUOTE), NATIVE_QUOTE);
  assert.equal(stripLeadingNoise("<p>&nbsp;</p>" + NATIVE_QUOTE), NATIVE_QUOTE);
  assert.equal(stripLeadingNoise("<p><br></p><p><br></p>" + NATIVE_QUOTE), NATIVE_QUOTE);
  assert.equal(
    stripLeadingNoise('<meta charset="utf-8"><p><br></p>\n' + NATIVE_QUOTE),
    NATIVE_QUOTE,
    "Meta und Leerabsatz in beliebiger Reihenfolge"
  );
});

test("stripCharsetMeta entfernt charset-<meta> in beiden Schreibweisen", () => {
  const quoted =
    '<blockquote type="cite" cite="mid:x">' +
    '<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">' +
    '<meta charset="utf-8">' +
    "<p>Inhalt</p></blockquote>";
  const cleaned = stripCharsetMeta(quoted);
  assert.ok(!/charset/i.test(cleaned), cleaned);
  assert.ok(cleaned.includes('<blockquote type="cite" cite="mid:x">'));
  assert.ok(cleaned.includes("<p>Inhalt</p></blockquote>"));
});

test("stripCharsetMeta laesst inhaltliche <meta> im Zitat stehen", () => {
  const quoted = '<blockquote type="cite" cite="mid:x"><div><meta itemprop="name" content="View ticket"></div></blockquote>';
  assert.equal(stripCharsetMeta(quoted), quoted);
});

test("HTML-Antwort enthaelt kein charset-<meta> mehr (Ursache des vorgezogenen Tags)", () => {
  const body = buildHtmlBody("Antwort", NATIVE_QUOTE);
  assert.ok(!/charset/i.test(body), body);
  assert.match(body, /<blockquote type="cite" cite="mid:WGE77EVW323_[^"]+">/);
  assert.ok(body.includes("@scope"), "Zitat-CSS bleibt erhalten");
});

test("stripLeadingNoise laesst Absaetze im Zitat unangetastet", () => {
  const quoted = PREFIX + '<blockquote type="cite" cite="mid:x"><p><br></p><p>Inhalt</p></blockquote>';
  assert.equal(stripLeadingNoise(quoted), quoted);
});

test("HTML-Antwort ohne Zitat erzeugt keinen leeren Zitatrest", () => {
  assert.equal(buildHtmlBody("Nur Text", ""), "<p>Nur Text</p>");
  assert.equal(buildHtmlBody("Nur Text", "<meta charset=\"utf-8\">"), "<p>Nur Text</p>");
});

test("HTML-Antwort schneidet Leerraum am Textende ab", () => {
  assert.equal(buildHtmlBody("Text\n\n  \n", ""), "<p>Text</p>");
  assert.equal(buildHtmlBody("Text\r\n", ""), "<p>Text</p>");
});

test("Text-Antwort trennt eigenen Text mit einer Leerzeile vom Zitat", () => {
  const plain = buildPlainTextBody("Hallo\n", "> zitierter Text\n> zweite Zeile");
  assert.equal(plain, "Hallo\n\n> zitierter Text\n> zweite Zeile");
});

test("Text-Antwort behaelt die >-Marker und verliert keine Zeilen", () => {
  const plain = buildPlainTextBody("Antwort", "> a\n>\n> b");
  assert.equal(plain.split("\n").filter((l) => l.startsWith(">")).length, 3);
  assert.ok(!plain.includes("\n\n\n"), "keine doppelte Leerzeile");
});

test("Text-Antwort ohne Zitat bleibt reiner Text", () => {
  assert.equal(buildPlainTextBody("Nur Text\n", ""), "Nur Text");
  assert.equal(buildPlainTextBody("Nur Text", "   \n"), "Nur Text");
});

test("manifest.json laedt quote.js vor background.js", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(join(here, "..", "manifest.json"), "utf8"));
  const scripts = manifest.background.scripts;
  assert.ok(scripts.includes("quote.js"), "quote.js muss im Hintergrundskript stehen");
  assert.ok(scripts.indexOf("quote.js") < scripts.indexOf("background.js"), "Reihenfolge zaehlt");
});

test("background.js nutzt die getesteten Zitat-Funktionen", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "..", "background.js"), "utf8");
  assert.match(src, /TBQuote\.buildHtmlBody\(/);
  assert.match(src, /TBQuote\.buildPlainTextBody\(/);
  assert.ok(!src.includes('"<div>" + escaped + "</div><br>"'), "alter Body-Bau muss weg sein");
});
