"use strict";

/* Experiment-API: druckt eine .eml ueber Thunderbirds eigene Druck-Pipeline.
 *
 * Weg wie beim Kontextmenue "Drucken":
 *   1. MailUtils.openEMLFile() oeffnet die Datei als echte Nachricht.
 *   2. Auf den messagepane-Browser warten, bis Nachricht und Dokument fertig
 *      geladen sind.
 *   3. browsingContext.print() mit dem Pseudo-Drucker "Mozilla Save to PDF"
 *      und gesetztem toFileName - derselbe Aufruf wie nach "In Datei
 *      speichern", nur ohne Dateidialog.
 *
 * Jeder Schritt setzt `stage`, damit Fehler zuzuordnen sind.
 */

const { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);
const { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
const { setTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);

const PSSVC = Cc["@mozilla.org/gfx/printsettings-service;1"].getService(
  Ci.nsIPrintSettingsService
);
const SAVE_TO_PDF = "Mozilla Save to PDF";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(fn, timeout = 30000, interval = 150) {
  const end = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < end) {
    try {
      const value = fn();
      if (value) {
        return value;
      }
    } catch (e) {
      lastError = e;
    }
    await sleep(interval);
  }
  throw new Error(
    "Timeout" + (lastError ? ": " + lastError.message : "")
  );
}

/* nsIPrintSettings ist ein XPCOM-Objekt, browsingContext.print() will ein
 * WebIDL-Dictionary - wie print.js nur primitive Attribute uebernehmen. */
function serializeSettings(settings) {
  const skip = /^(k[A-Z]|resolution)/;
  const types = new Set(["string", "boolean", "number", "undefined"]);
  const out = {};
  for (const key in settings) {
    try {
      if (!skip.test(key) && types.has(typeof settings[key])) {
        out[key] = settings[key];
      }
    } catch (e) {
      /* einzelne Attribute werfen beim Zugriff */
    }
  }
  return out;
}

this.tbPrint = class extends ExtensionAPI {
  getAPI(context) {
    return {
      tbPrint: {
        async ping() {
          return {
            ok: true,
            hasMailUtils: typeof MailUtils.openEMLFile,
            printer: SAVE_TO_PDF,
            outputFileConst: Ci.nsIPrintSettings.kOutputDestinationFile,
            windows: Services.wm.getMostRecentWindow("mail:3pane") ? 1 : 0,
          };
        },

        async printEml(details) {
          const { emlPath, outPath, probe } = details || {};
          let stage = "start";
          let tab = null;
          let tabmail = null;
          // Remote-Bilder sind in Thunderbird gesperrt; fuer den Druck kurz
          // erlauben und den alten Zustand danach wiederherstellen.
          const PREF_REMOTE = "mailnews.message_display.disable_remote_image";
          let prefSaved = false;
          let prefOld = null;
          try {
            stage = "window";
            const win = Services.wm.getMostRecentWindow("mail:3pane");
            if (!win) {
              throw new Error("Kein Thunderbird-Hauptfenster");
            }
            tabmail = win.document.getElementById("tabmail");
            if (!tabmail) {
              throw new Error("tabmail nicht gefunden");
            }

            stage = "file";
            const file = new FileUtils.File(emlPath);
            if (!file.exists() || !file.isFile()) {
              throw new Error("Datei nicht gefunden: " + emlPath);
            }

            stage = "pref";
            try {
              prefOld = Services.prefs.getBoolPref(PREF_REMOTE);
              prefSaved = true;
            } catch (e) {
              prefSaved = false;
            }
            Services.prefs.setBoolPref(PREF_REMOTE, false);

            stage = "open";
            const url = Services.io.newFileURI(file)
              .mutate()
              .setQuery("type=application/x-message-display")
              .finalize();
            tab = tabmail.openTab("mailMessageTab", { messageURI: url.spec });

            if (probe) {
              await sleep(8000);
              const diag = { tab: !!tab, hasBrowser: !!(tab && tab.browser) };
              try {
                const doc = tab.browser && tab.browser.contentDocument;
                diag.docState = doc && doc.readyState;
                diag.docURI = doc && doc.documentURI;
                const p = doc && doc.getElementById("messagepane");
                diag.pane = !!p;
                if (p) {
                  diag.paneURI = p.currentURI && p.currentURI.spec;
                  const cw = p.contentWindow;
                  diag.paneState = cw && cw.document && cw.document.readyState;
                  diag.bodyChildren =
                    cw && cw.document && cw.document.body
                      ? cw.document.body.childElementCount
                      : -1;
                  diag.text =
                    cw && cw.document && cw.document.body
                      ? String(cw.document.body.textContent || "").slice(0, 100)
                      : null;
                }
                diag.tabs = tabmail.tabs.map(t => (t.mode && t.mode.name) || "?");
                diag.browsers = doc
                  ? Array.from(doc.querySelectorAll("browser")).map(b => b.id)
                  : null;
              } catch (e) {
                diag.err = String(e);
              }
              return { ok: true, diag };
            }

            stage = "wait-doc";
            const target = await waitFor(() => {
              const doc = tab.browser && tab.browser.contentDocument;
              if (!doc || doc.readyState !== "complete") {
                return null;
              }
              const inner = doc.getElementById("messagepane");
              const browser =
                inner && inner.browsingContext ? inner : tab.browser;
              const content = browser && browser.contentWindow;
              if (!content || !content.document) {
                return null;
              }
              if (content.document.readyState !== "complete") {
                return null;
              }
              const body = content.document.body;
              if (!body || body.childElementCount === 0) {
                return null;
              }
              return browser;
            }, 40000);

            stage = "settle";
            await sleep(300);
            const imgDeadline = Date.now() + 8000;
            while (Date.now() < imgDeadline) {
              const idoc = target.contentWindow && target.contentWindow.document;
              const imgs = idoc ? Array.from(idoc.images) : [];
              if (!imgs.length || imgs.every(i => i.complete)) {
                break;
              }
              await sleep(200);
            }

            stage = "settings";
            const settings = PSSVC.createNewPrintSettings();
            const set = (k, v) => {
              try {
                settings[k] = v;
              } catch (e) {
                /* schreibgeschuetztes Attribut */
              }
            };
            set("printerName", SAVE_TO_PDF);
            set("outputDestination", Ci.nsIPrintSettings.kOutputDestinationFile);
            set("toFileName", outPath);
            set("paperSizeUnit", Ci.nsIPrintSettings.kPaperSizeInches);
            set("paperWidth", 8.27); // A4
            set("paperHeight", 11.69);
            set("marginTop", 0.47);
            set("marginBottom", 0.47);
            set("marginLeft", 0.47);
            set("marginRight", 0.47);
            set("printBackgrounds", true);
            set("printBGImages", true);
            set("printBGColors", true);
            set("shrinkToFit", true);
            set("headerStrLeft", "");
            set("headerStrCenter", "");
            set("headerStrRight", "");
            set("footerStrLeft", "");
            set("footerStrCenter", "");
            set("footerStrRight", "");

            stage = "print";
            await target.browsingContext.print(settings);

            stage = "verify";
            const result = new FileUtils.File(outPath);
            if (!result.exists()) {
              throw new Error("PDF wurde nicht geschrieben: " + outPath);
            }
            const idoc = target.contentWindow && target.contentWindow.document;
            const imgs = idoc ? Array.from(idoc.images) : [];
            return {
              ok: true,
              path: outPath,
              size: result.fileSize,
              images: imgs.length,
              loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
            };
          } catch (e) {
            return {
              ok: false,
              stage,
              error: String((e && e.name) || "Error") + ": " +
                String((e && e.message) || e) +
                (e && e.result ? " (result " + e.result + ")" : ""),
            };
          } finally {
            try {
              if (prefSaved) {
                Services.prefs.setBoolPref(PREF_REMOTE, prefOld);
              } else {
                Services.prefs.clearUserPref(PREF_REMOTE);
              }
            } catch (e) {
              /* Pref liess sich nicht zuruecksetzen */
            }
            if (tab && tabmail) {
              try {
                tabmail.closeTab(tab);
              } catch (e) {
                /* Tab schon zu */
              }
            }
          }
        },
      },
    };
  }
};
