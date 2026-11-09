/* Zitat-Zusammenbau fuer tb-cli-reply.
 *
 * Wird als klassisches Background-Script geladen (manifest.json: zuerst
 * quote.js, dann background.js) und von tests/quote.test.mjs geprueft.
 *
 * Zielformat ist exakt das, was Thunderbirds Antwort-Button erzeugt:
 *
 *   <p>eigener Text<br>zweite Zeile</p><div class="moz-cite-prefix">On ... wrote:<br></div><blockquote type="cite" cite="mid:...">...</blockquote>
 *
 * Thunderbird liefert den Zitatteil (Zitatkopf + blockquote) bereits fertig in
 * ComposeDetails.body. Problematisch ist nur der Anfang dieses Strings: dort
 * stehen die <meta>-Tags des zitierten HTMLs und der leere Absatz, den
 * Thunderbird als Schreibmarke anlegt. Beim Setzen per setComposeDetails
 * werden beide sichtbar (zusaetzliche Leerzeile, ungueltiges <meta> im Body),
 * nativ dagegen nicht. Darum wird nur dieser Kopfbereich aufgeraeumt.
 */
"use strict";

(function (root) {
  function escapeHtml(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function toLf(text) {
    return String(text === null || text === undefined ? "" : text).replace(/\r\n?/g, "\n");
  }

  function textToHtml(text) {
    return escapeHtml(toLf(text)).replace(/\n/g, "<br>");
  }

  // Leerer Absatz als Schreibmarke: <p><br></p>, <p><br>\n</p>, <p>&nbsp;</p> ...
  var EMPTY_PARAGRAPH = /^<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/i;
  var META_TAG = /^<meta\b[^>]*>\s*/i;
  var LEADING_SPACE = /^[\s\r\n]+/;

  // Entfernt nur den Kopf des Zitatteils (vor Zitatkopf/blockquote), niemals
  // Inhalt innerhalb des Zitats.
  function stripLeadingNoise(quoted) {
    var rest = String(quoted === null || quoted === undefined ? "" : quoted)
      .replace(/^\uFEFF/, "")
      .replace(LEADING_SPACE, "");
    for (;;) {
      if (META_TAG.test(rest)) {
        rest = rest.replace(META_TAG, "");
        continue;
      }
      if (EMPTY_PARAGRAPH.test(rest)) {
        rest = rest.replace(EMPTY_PARAGRAPH, "").replace(LEADING_SPACE, "");
        continue;
      }
      break;
    }
    return rest;
  }

  // charset-<meta> aus dem Zitat entfernen: Die Zeichenkodierung steht im
  // MIME-Header. Bleibt so ein Tag im Zitat, zieht der HTML-Parser es beim
  // Setzen des Bodys aus dem <blockquote> heraus und stellt es sichtbar vor den
  // Zitatkopf – Thunderbirds Antwort-Button erzeugt das nicht.
  var CHARSET_META = /<meta\b[^>]*(?:charset|http-equiv\s*=\s*["']?content-type)[^>]*>\s*/gi;

  function stripCharsetMeta(quoted) {
    return String(quoted === null || quoted === undefined ? "" : quoted).replace(CHARSET_META, "");
  }

  function trimBodyText(text) {
    return toLf(text).replace(/[ \t]+$/gm, "").replace(/[\s\u00a0]+$/, "");
  }

  // HTML-Antwort: eigener Text als ein Absatz, danach das unveraenderte Zitat.
  function buildHtmlBody(mine, quoted) {
    var own = trimBodyText(mine);
    var quote = stripCharsetMeta(stripLeadingNoise(quoted));
    var paragraph = "<p>" + textToHtml(own) + "</p>";
    return quote ? paragraph + quote : paragraph;
  }

  // Text-Antwort: Thunderbird stellt dem Zitat schon "> " voran.
  function buildPlainTextBody(mine, quoted) {
    var own = trimBodyText(mine);
    var quote = String(quoted === null || quoted === undefined ? "" : quoted).replace(LEADING_SPACE, "");
    if (!quote) return own;
    return own ? own + "\n\n" + quote : quote;
  }

  var api = {
    escapeHtml: escapeHtml,
    textToHtml: textToHtml,
    stripLeadingNoise: stripLeadingNoise,
    stripCharsetMeta: stripCharsetMeta,
    buildHtmlBody: buildHtmlBody,
    buildPlainTextBody: buildPlainTextBody,
  };

  root.TBQuote = api;
  if (typeof module === "object" && module && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
