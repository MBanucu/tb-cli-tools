

const HOST_NAME = "tb_cli_tools";
let port = null;
let reconnectTimer = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

function connect() {
  if (port) return;
  try {
    port = browser.runtime.connectNative(HOST_NAME);

  } catch (e) {
    port = null;
    scheduleReconnect();
    return;
  }
  port.onMessage.addListener(async (msg) => {
    if (!msg || msg.type !== "job") return;
    let res;
    try {
      res = await runJob(msg.job || {});
    } catch (e) {
      res = { ok: false, error: String((e && e.message) || e) };
    }
    try {
      port.postMessage(Object.assign({ type: "result", id: msg.id }, res));
    } catch (e) {
      /* port gone - the result is lost, the CLI reports a timeout */
    }
  });
  port.onDisconnect.addListener(() => {

    port = null;
    scheduleReconnect();
  });
}

async function querySafe(q) {
  try {
    return await browser.messages.query(q);
  } catch (e) {
    return { messages: [] };
  }
}

async function findMessage(job) {
  const raw = String(job.headerMessageId || job.messageId || "").trim();
  const bare = raw.replace(/^</, "").replace(/>$/, "");
  const variants = [raw, bare, "<" + bare + ">"].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const v of variants) {
    const res = await querySafe({ headerMessageId: v });
    if (res.messages && res.messages.length) return res.messages[0];
  }
  if (job.subject) {
    const res = await querySafe({ subject: job.subject });
    if (res.messages && res.messages.length) return res.messages[0];
  }
  throw new Error("Message not found: " + raw);
}

async function fileFromUrl(url, name) {
  const r = await fetch(url, { cache: "no-store" });
  if (r.status !== 200) throw new Error("Attachment unavailable: " + name + " (HTTP " + r.status + ")");
  const blob = await r.blob();
  return new File([blob], name, { type: blob.type || "application/octet-stream" });
}

async function runJob(job) {
  if (job.action === "ping") {
    const info = {
      ok: true,
      version: browser.runtime.getManifest().version,
      api: typeof browser.tbPrint,
      funcs: browser.tbPrint ? Object.keys(browser.tbPrint) : [],
    };
    if (typeof browser.tbPrint?.ping === "function") {
      try {
        info.ping = await browser.tbPrint.ping();
      } catch (e) {
        info.ping = "Error: " + String((e && e.message) || e);
      }
    }
    return info;
  }

  if (job.action === "print") {
    return await browser.tbPrint.printEml({
      emlPath: String(job.emlPath || ""),
      outPath: String(job.outPath || ""),
      probe: job.probe === true,
    });
  }

  if (job.action === "compose") {
    const details = { subject: String(job.subject || "") };
    const body = String(job.body || "");
    // beginNew rejects isPlainText:true together with "body" ("Conflicting
    // format setting"); in text mode the text has to go into plainTextBody.
    if (job.plainText === false) {
      details.isPlainText = false;
      details.body = body;
    } else {
      details.isPlainText = true;
      details.plainTextBody = body;
    }
    const to = (job.to || []).filter(Boolean);
    if (to.length) details.to = to;
    if ((job.cc || []).length) details.cc = job.cc;
    if ((job.bcc || []).length) details.bcc = job.bcc;

    const tab = await browser.compose.beginNew(details);
    for (const a of (job.attachmentUrls || [])) {
      await browser.compose.addAttachment(tab.id, { file: await fileFromUrl(a.url, a.name) });
    }

    const after = await browser.compose.getComposeDetails(tab.id);
    const html = !after.isPlainText;
    const finalBody = html ? (after.body || "") : (after.plainTextBody || "");
    return {
      ok: true,
      windowId: tab.windowId,
      to: (after.to || []).join(", "),
      subject: after.subject,
      format: html ? "html" : "text",
      bodyChars: finalBody.length,
      attachments: (await browser.compose.listAttachments(tab.id)).map((a) => a.name),
    };
  }

  const msg = await findMessage(job);
  const replyType = job.all ? "replyToAll" : "replyToSender";

  // Do not force a format: Thunderbird replies the way its Reply button does
  // (identity default, with Gmail that is HTML including blockquote).
  const details = {};
  if (job.plainText === true) details.isPlainText = true;
  if (job.plainText === false) details.isPlainText = false;
  const tab = await browser.compose.beginReply(msg.id, replyType, details);

  const before = await browser.compose.getComposeDetails(tab.id);
  const html = !before.isPlainText;
  const quoted = html ? (before.body || "") : (before.plainTextBody || "");
  const mine = job.body || "";

  // Prepend the own text as a paragraph and keep the quote untouched - just
  // like the Reply button does. Cleaning the quote head (hoisted <meta> tags,
  // the empty caret paragraph) lives in quote.js, see the tests.
  const patch = html
    ? { body: globalThis.TBQuote.buildHtmlBody(mine, quoted) }
    : { plainTextBody: globalThis.TBQuote.buildPlainTextBody(mine, quoted) };
  await browser.compose.setComposeDetails(tab.id, patch);

  for (const a of (job.attachmentUrls || [])) {
    await browser.compose.addAttachment(tab.id, { file: await fileFromUrl(a.url, a.name) });
  }

  const after = await browser.compose.getComposeDetails(tab.id);
  const attachments = await browser.compose.listAttachments(tab.id);
  const finalBody = html ? (after.body || "") : (after.plainTextBody || "");
  return {
    ok: true,
    windowId: tab.windowId,
    to: (after.to || []).join(", "),
    subject: after.subject,
    format: html ? "html" : "text",
    bodyChars: finalBody.length,
    quotedChars: quoted.length,
    quote: {
      blockquote: /<blockquote[^>]*type="cite"|<blockquote/i.test(quoted),
      citePrefix: /moz-cite-prefix/i.test(quoted),
      signature: /moz-signature/i.test(quoted),
    },
    quoteHead: quoted.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160),
    attachments: attachments.map((a) => a.name + " (" + (a.size || 0) + " B)"),
  };
}

// Keep the event page awake: an open native port does that, the alarm is the fallback
if (browser.alarms) {
  browser.alarms.create("tb-cli-tools-keepalive", { periodInMinutes: 1 });
}
connect();
