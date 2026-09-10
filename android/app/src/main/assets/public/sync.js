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
//   - Databases.listDocuments / updateDocument(dbId, colId, ...)
//   - Client.subscribe(channel, cb)  -> cb receives { events, channels, payload }
//
// Rows are matched on the `type` attribute ('lunch' / 'dinner'), NOT on the
// document id -- the two rows can have any ids (auto-generated is fine). The
// collection only ever holds these two rows, so pullState lists them all (no
// Query, so no index needed) and pushAction updates the row whose `type`
// matches. The type -> $id map is cached from the first list / realtime event.

(function () {
  'use strict';

  var AUTH_CACHE_KEY = 'dogMealTracker:syncAuthed';
  var MEAL_TYPES = ['lunch', 'dinner'];

  var client = null;
  var account = null;
  var databases = null;
  var docIdByType = {}; // 'lunch' -> '<$id>', filled lazily

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
      try {
        await account.createEmailPasswordSession(email, password);
      } catch (err) {
        // Already signed in on this client (e.g. a previous attempt that
        // created the session but didn't return cleanly). Treat as success
        // only if the session is actually usable.
        const alreadyActive =
          err && (err.type === 'user_session_already_exists' || err.code === 409);
        if (!alreadyActive) throw err;
        await account.get();
      }
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

    // The signed-in account's email, for the header account menu. Throws if
    // there is no usable session -- the caller treats that as "nothing to show".
    currentEmail: async function () {
      ensureClient();
      var user = await account.get();
      return user && user.email;
    },

    // -> [{ type, meals_remaining, last_action_at }, ...] for whichever of the
    // two rows exist. Also (re)builds the type -> $id cache.
    pullState: async function () {
      ensureClient();
      var cfg = window.MEAL_SYNC_CONFIG;
      var res = await databases.listDocuments(cfg.databaseId, cfg.collectionId);
      var rows = (res && res.documents) || [];
      var out = [];
      for (var t = 0; t < MEAL_TYPES.length; t++) {
        var type = MEAL_TYPES[t];
        // Newest row wins if setup left duplicates lying around.
        var match = null;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].type !== type) continue;
          if (!match || rows[i].$updatedAt > match.$updatedAt) match = rows[i];
        }
        if (!match) continue;
        docIdByType[type] = match.$id;
        out.push({
          type: type,
          meals_remaining: match.meals_remaining,
          last_action_at: match.last_action_at,
        });
      }
      return out;
    },

    // Caller has already written localStorage; this pushes the absolute value
    // plus the exact timestamp of that local write (last-write-wins key).
    pushAction: async function (type, mealsRemaining, lastActionAtISO) {
      ensureClient();
      var cfg = window.MEAL_SYNC_CONFIG;
      var id = docIdByType[type];
      if (!id) {
        // Not seen yet (push before the first pull) -- look it up now.
        await this.pullState();
        id = docIdByType[type];
      }
      if (!id) {
        throw new Error(
          "No '" +
            type +
            "' row in the meal_state collection. Add a row with type=\"" +
            type +
            '" in the Appwrite console.',
        );
      }
      await databases.updateDocument(cfg.databaseId, cfg.collectionId, id, {
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
          if (!doc || MEAL_TYPES.indexOf(doc.type) === -1) return;
          if (doc.$id) docIdByType[doc.type] = doc.$id;
          cb(doc.type, doc.meals_remaining, doc.last_action_at);
        } catch (err) {
          console.error('MealSync realtime handler failed:', err);
        }
      });
    },
  };
})();
