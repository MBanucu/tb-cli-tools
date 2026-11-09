/* Quote assembly for tb-cli-tools.
 *
 * Loaded as a classic background script (manifest.json: quote.js first, then
 * background.js) and exercised by tests/quote.test.mjs.
 *
 * Target format is exactly what Thunderbird's Reply button produces:
 *
 *   <p>own text<br>second line</p><div class="moz-cite-prefix">On ... wrote:<br></div><blockquote type="cite" cite="mid:...">...</blockquote>
 *
 * Thunderbird already delivers the quote part (cite prefix + blockquote)
 * complete in ComposeDetails.body. Only the start of that string is
 * problematic: it carries the <meta> tags of the quoted HTML and the empty
 * paragraph Thunderbird uses as a caret. Setting it via setComposeDetails
 * makes both visible (an extra blank line, an invalid <meta> in the body),
 * while the native path hides them. So only that head is cleaned up.
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

  // Empty paragraph as caret: <p><br></p>, <p><br>\n</p>, <p>&nbsp;</p> ...
  var EMPTY_PARAGRAPH = /^<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/i;
  var META_TAG = /^<meta\b[^>]*>\s*/i;
  var LEADING_SPACE = /^[\s\r\n]+/;

  // Removes only the head of the quote part (before cite prefix/blockquote),
  // never anything inside the quote.
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

  // Strip the charset <meta> from the quote: the encoding is in the MIME
  // header. Left in the quote, the HTML parser hoists such a tag out of the
  // <blockquote> and shows it in front of the cite prefix - the Reply button
  // never produces that.
  var CHARSET_META = /<meta\b[^>]*(?:charset|http-equiv\s*=\s*["']?content-type)[^>]*>\s*/gi;

  function stripCharsetMeta(quoted) {
    return String(quoted === null || quoted === undefined ? "" : quoted).replace(CHARSET_META, "");
  }

  function trimBodyText(text) {
    return toLf(text).replace(/[ \t]+$/gm, "").replace(/[\s\u00a0]+$/, "");
  }

  // HTML reply: own text as one paragraph, then the untouched quote.
  function buildHtmlBody(mine, quoted) {
    var own = trimBodyText(mine);
    var quote = stripCharsetMeta(stripLeadingNoise(quoted));
    var paragraph = "<p>" + textToHtml(own) + "</p>";
    return quote ? paragraph + quote : paragraph;
  }

  // Text reply: Thunderbird already prefixes the quote with "> ".
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
