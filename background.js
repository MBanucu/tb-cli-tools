

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

function messageIdVariants(value) {
  const raw = String(value || "").trim();
  const bare = raw.replace(/^</, "").replace(/>$/, "");
  return [raw, bare, "<" + bare + ">"].filter((v, i, a) => v && a.indexOf(v) === i);
}

async function findMessage(job) {
  const raw = String(job.headerMessageId || job.messageId || "").trim();
  const variants = messageIdVariants(raw);
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

// Resolve the destination folder: by id, by path, or by label/folder name.
// Gmail labels are IMAP folders, so copying into the folder sets the label.
async function resolveFolder(job) {
  const folderId = String(job.folderId || "").trim();
  if (folderId) {
    return await browser.folders.get(folderId);
  }

  const wanted = String(job.folderPath || job.folder || job.folderName || "").trim();
  if (!wanted) {
    throw new Error("No destination folder given (folder, folderPath or folderId).");
  }

  const base = {};
  if (job.accountId) base.accountId = job.accountId;

  let matches = await browser.folders.query(Object.assign({ path: wanted }, base));
  if (!matches.length) {
    matches = await browser.folders.query(Object.assign({ name: wanted }, base));
  }

  const needle = wanted.toLowerCase();
  const exact = matches.filter((f) => {
    const path = String(f.path || "").toLowerCase();
    const name = String(f.name || "").toLowerCase();
    return path === needle || name === needle || path.endsWith("/" + needle);
  });

  const hits = exact.length ? exact : matches;
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error("Folder not found: " + wanted);
  throw new Error(
    "Folder name is ambiguous: " + wanted + " (" + hits.map((f) => f.path).join(", ") +
      "). Pass folderId or accountId."
  );
}

// Collect the selected messages from explicit ids, Message-IDs or a query.
async function resolveMessages(job) {
  const out = [];
  const seen = new Set();
  const add = (message) => {
    if (message && !seen.has(message.id)) {
      seen.add(message.id);
      out.push(message);
    }
  };

  for (const id of (Array.isArray(job.messageIds) ? job.messageIds : [])) {
    try {
      add(await browser.messages.get(id));
    } catch (e) {
      /* one unknown id must not abort the batch */
    }
  }

  const ids = []
    .concat(Array.isArray(job.headerMessageIds) ? job.headerMessageIds : [])
    .concat(job.headerMessageId ? [job.headerMessageId] : []);
  for (const value of ids) {
    let hits = [];
    for (const variant of messageIdVariants(value)) {
      const res = await querySafe({ headerMessageId: variant });
      if (res.messages && res.messages.length) {
        hits = res.messages;
        break;
      }
    }
    if (!hits.length) throw new Error("Message not found: " + value);
    hits.forEach(add);
  }

  if (!out.length && job.query && typeof job.query === "object") {
    const res = await querySafe(job.query);
    (res.messages || []).forEach(add);
  }

  if (!out.length) {
    throw new Error("No messages selected (messageIds, headerMessageIds or query).");
  }
  return out;
}

// label = copy into the folder and skip what is already in it (Gmail label);
// copy = always copy; move = move out of the source folder.
async function labelJob(job) {
  const folder = await resolveFolder(job);
  const messages = await resolveMessages(job);
  const skipExisting = job.action === "label" || job.skipExisting === true;
  const ids = [];
  const skipped = [];

  // Read the label folder's messages once and compare Message-IDs. Querying
  // per message with {folderId, headerMessageId} proved unreliable: it matched
  // mails that were only in INBOX/All Mail, so unlabelled mail was skipped.
  const inFolder = new Set();
  let inFolderCount = 0;
  if (skipExisting) {
    const res = await browser.messages.query({ folderId: folder.id });
    const listed = res.messages || [];
    inFolderCount = listed.length;
    for (const message of listed) {
      for (const variant of messageIdVariants(message.headerMessageId)) inFolder.add(variant);
    }
  }

  for (const message of messages) {
    if (skipExisting && messageIdVariants(message.headerMessageId).some((v) => inFolder.has(v))) {
      skipped.push(message);
      continue;
    }
    ids.push(message.id);
  }

  if (ids.length) {
    if (job.action === "move") {
      await browser.messages.move(ids, folder.id, { isUserAction: true });
    } else {
      await browser.messages.copy(ids, folder.id, { isUserAction: true });
    }
  }

  return {
    ok: true,
    action: job.action,
    folder: { id: folder.id, name: folder.name, path: folder.path, accountId: folder.accountId },
    matched: messages.length,
    inFolder: inFolderCount,
    skipped: skipped.length,
    changed: ids.length,
    messages: messages.slice(0, 100).map((m) => ({
      id: m.id,
      subject: m.subject,
      date: m.date,
      headerMessageId: m.headerMessageId,
    })),
  };
}

// Export: save the raw message as .eml through the downloads API.
function exportName(message) {
  const d = new Date(message.date || Date.now());
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
    "_" + pad(d.getHours()) + pad(d.getMinutes());
  const subject = String(message.subject || "message")
    .replace(/[^\p{L}\p{N} .()_-]+/gu, "_")
    .replace(/\s+/g, "_")
    .slice(0, 90)
    .replace(/_+$/, "");
  return "Email_" + stamp + "_" + subject + ".eml";
}

async function waitForDownload(id, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const [info] = await browser.downloads.search({ id });
    if (info && info.state === "complete") return info;
    if (info && info.state === "interrupted") {
      throw new Error("Download interrupted: " + (info.error || "unknown"));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Download did not finish in time");
}

async function saveJob(job) {
  const messages = await resolveMessages(job);
  const dir = String(job.saveDir || "tb-export")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  const saved = [];
  const seen = new Set();
  for (const message of messages) {
    // The same mail is returned from INBOX, All Mail and the label folder.
    const key = messageIdVariants(message.headerMessageId)[0] || String(message.id);
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = await browser.messages.getRaw(message.id);
    const url = URL.createObjectURL(raw);
    let downloadId;
    try {
      downloadId = await browser.downloads.download({
        url,
        filename: (dir ? dir + "/" : "") + exportName(message),
        conflictAction: "uniquify",
        saveAs: false,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    const info = await waitForDownload(downloadId);
    saved.push({
      id: message.id,
      subject: message.subject,
      date: message.date,
      headerMessageId: message.headerMessageId,
      path: info.filename,
      bytes: info.fileSize,
    });
  }
  return { ok: true, count: saved.length, saved };
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

  if (job.action === "save") {
    return await saveJob(job);
  }

  if (job.action === "folders") {
    const query = {};
    if (job.accountId) query.accountId = job.accountId;
    if (job.name) query.name = job.name;
    if (job.path) query.path = job.path;
    const list = await browser.folders.query(query);
    return {
      ok: true,
      count: list.length,
      folders: list.map((f) => ({
        id: f.id,
        name: f.name,
        path: f.path,
        accountId: f.accountId,
        specialUse: f.specialUse,
      })),
    };
  }

  if (job.action === "label" || job.action === "copy" || job.action === "move") {
    return await labelJob(job);
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
