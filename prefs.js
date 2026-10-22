/* eslint-disable no-undef */
/**
 * Default preferences for Pop-Fish.
 *
 * Zotero loads this file as the *default* branch of every pref declared here,
 * so nothing is written into the user's prefs.js until they actually change a
 * value. Keys are namespaced under extensions.zotero.popfish.
 */

pref("extensions.zotero.popfish.apiKey", "");
// Off by default: browsing must not spend money until the user opts in.
// A user's existing explicit `true` in prefs.js still wins over this default.
pref("extensions.zotero.popfish.lazyLookup", false);
// Session budget for automatic (browsing) lookups, in journal names. 0..400.
pref("extensions.zotero.popfish.lazyBudget", 40);
pref("extensions.zotero.popfish.writeExtra", true);
pref("extensions.zotero.popfish.extraTag", "Pop-Fish");
pref("extensions.zotero.popfish.cacheDays", 90);
pref("extensions.zotero.popfish.column.impactFactor", true);
pref("extensions.zotero.popfish.column.jcr", true);
pref("extensions.zotero.popfish.column.cas", true);
pref("extensions.zotero.popfish.column.warning", true);
pref("extensions.zotero.popfish.welcomeShown", false);
pref("extensions.zotero.popfish.usageJson", "");
pref("extensions.zotero.popfish.lastRun", "");
pref("extensions.zotero.popfish.selfTestOnStartup", false);
pref("extensions.zotero.popfish.seedTestItems", false);
