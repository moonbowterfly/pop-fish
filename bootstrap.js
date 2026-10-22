/* eslint-disable no-undef */

/**
 * Entry point of the Pop-Fish plugin.
 *
 * Zotero calls into this file to start and stop the add-on. All the real work
 * lives in chrome/content/scripts/, which is loaded into a sandbox that exposes
 * `Zotero` and the platform globals (Services, ChromeUtils, IOUtils, ...).
 */

var chromeHandle;

function install(_data, _reason) {}

async function startup({ id, version, resourceURI, rootURI }, _reason) {
  // Wait until the Zotero core is ready before touching any of its APIs.
  await Zotero.initializationPromise;

  // Zotero 7+ passes `rootURI`; keep a `resourceURI` fallback for older hosts.
  if (!rootURI) {
    rootURI = typeof resourceURI === "string" ? resourceURI : resourceURI.spec;
  }

  const aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  const manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "popfish", rootURI + "chrome/content/"],
  ]);

  const ctx = { rootURI, id, version };
  ctx._globalThis = ctx;

  Services.scriptloader.loadSubScript(
    `${rootURI}chrome/content/scripts/popfish.js`,
    ctx,
  );

  await Zotero.PopFish.hooks.onStartup({ id, version, rootURI });
}

async function onMainWindowLoad({ window }, _reason) {
  await Zotero.PopFish?.hooks.onMainWindowLoad(window);
}

async function onMainWindowUnload({ window }, _reason) {
  Zotero.PopFish?.hooks.onMainWindowUnload(window);
}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (typeof Zotero === "undefined") {
    Zotero = Components.classes["@zotero.org/Zotero;1"]
      .getService(Components.interfaces.nsISupports)
      .wrappedJSObject;
  }

  const appShutdown = reason === APP_SHUTDOWN;

  try {
    // Even when the application is quitting, the newest cache snapshot has to
    // reach the disk. The host awaits this function, so return a promise that
    // only settles once the plugin has stopped and flushed.
    await Zotero.PopFish?.hooks.onShutdown({ appShutdown });
  }
  catch (e) {
    Zotero.logError(e);
  }

  if (appShutdown) {
    return;
  }

  Cc["@mozilla.org/intl/stringbundle;1"]
    .getService(Components.interfaces.nsIStringBundleService)
    .flushBundles();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(_data, _reason) {}
