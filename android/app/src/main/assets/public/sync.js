// --- Cloud sync adapter (the ONLY file that touches the Appwrite SDK) ---
//
// Everything backend-specific lives behind window.MealSync so a later swap to
// a different backend (e.g. self-hosted PocketBase) is a one-file rewrite --
// script.js never imports or names the Appwrite SDK.
//
// The Appwrite web SDK is loaded as a plain <script> in index.html (pinned to
// an exact version), exposing the global `Appwrite`. Method names below are
// confirmed against appwrite@18.2.0:
//   - Account.createEmailPasswordSession(email, password)   (v14+ name)
//   - Account.get()  / Account.deleteSession('current')
//   - Databases.getDocument / updateDocument(dbId, colId, docId, data)
//   - Client.subscribe(channel, cb)  -> cb receives { events, channels, payload }
//
// Documents use custom IDs 'lunch' and 'dinner' (see README console steps), so
// a document id IS the meal type.

(function () {
  'use strict';

  var AUTH_CACHE_KEY = 'dogMealTracker:syncAuthed';
  var MEAL_DOC_IDS = ['lunch', 'dinner'];

  var client = null;
  var account = null;
  var databases = null;

  // Lazily builds the SDK client. Throws if the CDN <script> failed to load
  // (e.g. cold offline start) -- callers treat that as "sync unavailable".
  function ensureClient() {
    if (client) return;
    if (typeof Appwrite === 'undefined') {
      throw new Error('Appwrite SDK not loaded');
    }
    var cfg = window.MEAL_SYNC_CONFIG;
    client = new Appwrite.Client()
      .setEndpoint(cfg.endpoint)
      .setProject(cfg.projectId);
    account = new Appwrite.Account(client);
    databases = new Appwrite.Databases(client);
  }

  function isPlaceholder(value) {
    return (
      typeof value !== 'string' ||
      value.length === 0 ||
      /^<.*>$/.test(value.trim())
    );
  }

  window.MealSync = {
    // Config values are all present and non-placeholder.
    isConfigured: function () {
      var cfg = window.MEAL_SYNC_CONFIG;
      if (!cfg) return false;
      return (
        !isPlaceholder(cfg.endpoint) &&
        !isPlaceholder(cfg.projectId) &&
        !isPlaceholder(cfg.databaseId) &&
        !isPlaceholder(cfg.collectionId)
      );
    },

    // True if there is a usable session. On a network failure we can't ask the
    // server, so fall back to the last known-good result while the browser
    // reports itself offline -- that keeps an already-signed-in user's cards
    // visible on a cold offline start. A genuine 401 while online clears it.
    isAuthed: async function () {
      if (!this.isConfigured()) return false;
      try {
        ensureClient();
        await account.get();
        try {
          localStorage.setItem(AUTH_CACHE_KEY, '1');
        } catch (e) {
          /* best-effort */
        }
        return true;
      } catch (err) {
        var offline =
          typeof navigator !== 'undefined' && navigator.onLine === false;
        var wasAuthed = false;
        try {
          wasAuthed = localStorage.getItem(AUTH_CACHE_KEY) === '1';
        } catch (e) {
          /* ignore */
        }
        if (offline && wasAuthed) return true;
        return false;
      }
    },

    // Throws on bad credentials / unreachable server.
    login: async function (email, password) {
      ensureClient();
      await account.createEmailPasswordSession(email, password);
      try {
        localStorage.setItem(AUTH_CACHE_KEY, '1');
      } catch (e) {
        /* best-effort */
      }
    },

    logout: async function () {
      try {
        localStorage.removeItem(AUTH_CACHE_KEY);
      } catch (e) {
        /* ignore */
      }
      ensureClient();
      await account.deleteSession('current');
    },

    // -> [{ type, meals_remaining, last_action_at }, ...]
    pullState: async function () {
      ensureClient();
      var cfg = window.MEAL_SYNC_CONFIG;
      var out = [];
      for (var i = 0; i < MEAL_DOC_IDS.length; i++) {
        var type = MEAL_DOC_IDS[i];
        var doc = await databases.getDocument(
          cfg.databaseId,
          cfg.collectionId,
          type,
        );
        out.push({
          type: type,
          meals_remaining: doc.meals_remaining,
          last_action_at: doc.last_action_at,
        });
      }
      return out;
    },

    // Caller has already written localStorage; this pushes the absolute value
    // plus the exact timestamp of that local write (last-write-wins key).
    pushAction: async function (type, mealsRemaining, lastActionAtISO) {
      ensureClient();
      var cfg = window.MEAL_SYNC_CONFIG;
      await databases.updateDocument(cfg.databaseId, cfg.collectionId, type, {
        type: type,
        meals_remaining: mealsRemaining,
        last_action_at: lastActionAtISO,
      });
    },

    // Realtime. Invokes cb(type, meals_remaining, last_action_at) on any remote
    // change to the meal_state collection (including echoes of our own writes --
    // the caller filters those out by timestamp).
    subscribe: function (cb) {
      ensureClient();
      var cfg = window.MEAL_SYNC_CONFIG;
      var channel =
        'databases.' +
        cfg.databaseId +
        '.collections.' +
        cfg.collectionId +
        '.documents';
      client.subscribe(channel, function (message) {
        try {
          var doc = message && message.payload;
          if (!doc || MEAL_DOC_IDS.indexOf(doc.type) === -1) return;
          cb(doc.type, doc.meals_remaining, doc.last_action_at);
        } catch (err) {
          console.error('MealSync realtime handler failed:', err);
        }
      });
    },
  };
})();
