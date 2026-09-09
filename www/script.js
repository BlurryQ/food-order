// --- Config ---
// Meals count that counts as a "full bowl" for the fill visual.
// Anything at or above this displays as completely full.
const FULL_BOWL_MEALS = 18;

// The hour (24h, local time) each meal type is fed. The remaining count
// decrements exactly once this hour passes each day, rather than at
// midnight -- so checking at 9am still shows a pre-lunch total.
const MEAL_TIMES = {
  lunch: 13,
  dinner: 18,
};

// Will hold the set of holiday dates (strings "YYYY-MM-DD"). Seeded
// synchronously from the last successful fetch (cached in localStorage) so
// weekend/holiday roll-back still works on a cold, offline start.
let holidaySet = new Set();
const HOLIDAY_CACHE_KEY = 'dogMealTracker:holidays';

function loadCachedHolidays() {
  try {
    const raw = localStorage.getItem(HOLIDAY_CACHE_KEY);
    if (raw) JSON.parse(raw).forEach((d) => holidaySet.add(d));
  } catch {
    // Ignore a corrupt cache -- the background fetch will refill it.
  }
}

// Each meal type tracks its own count, dates, and notifications
const MEAL_TYPES = ['lunch', 'dinner'];
const storageKey = (type) => `dogMealTracker:${type}`;

// Notification IDs must be unique per scheduled item across the whole app
const NOTIF_IDS = {
  lunch: { weekBefore: 101, fiveDayBefore: 102 },
  dinner: { weekBefore: 201, fiveDayBefore: 202 },
};

// --- Holidays ---

// Refreshes the holiday list from gov.uk in the background. The UI has
// already rendered from cache by the time this runs, so a successful fetch
// only refines the order-by dates and updates the cache for next time.
// Bounded by a timeout so a flaky mobile connection fails fast instead of
// leaving the fetch (and the first render) hanging indefinitely.
async function loadHolidays() {
  try {
    const resp = await fetch('https://www.gov.uk/bank-holidays.json', {
      signal: AbortSignal.timeout(5000),
    });
    const data = await resp.json();
    const dates = data['england-and-wales'].events.map((ev) => ev.date);
    dates.forEach((d) => holidaySet.add(d));
    try {
      localStorage.setItem(HOLIDAY_CACHE_KEY, JSON.stringify(dates));
    } catch {
      // Cache write is best-effort; skip on quota/availability errors.
    }
  } catch (err) {
    console.error('Failed to load holidays:', err);
  }
  MEAL_TYPES.forEach(init);
}

function isWeekend(date) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function isHoliday(date) {
  return holidaySet.has(date.toISOString().split('T')[0]);
}

function adjustForNonWorkingDay(date) {
  while (isWeekend(date) || isHoliday(date)) {
    date.setDate(date.getDate() - 1);
  }
  return date;
}

function todayDateOnly() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysBetween(a, b) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((b - a) / msPerDay);
}

// Counts how many times the given meal's daily feed time has passed
// strictly between 'from' (last update) and 'to' (now). E.g. if lunch is
// at 13:00 and 'from' was yesterday 9am, and 'to' is today 3pm, that's 2
// boundaries crossed (yesterday 1pm and today 1pm) -- decrement by 2.
function countMealBoundariesCrossed(from, to, mealHour) {
  const boundary = new Date(from);
  boundary.setHours(mealHour, 0, 0, 0);
  if (boundary <= from) boundary.setDate(boundary.getDate() + 1);

  let count = 0;
  while (boundary <= to) {
    count++;
    boundary.setDate(boundary.getDate() + 1);
  }
  return count;
}

// --- Persistence (per meal type) ---

function loadState(type) {
  const raw = localStorage.getItem(storageKey(type));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    state.lastUpdated = new Date(state.lastUpdated);
    return state;
  } catch {
    return null;
  }
}

// Returns the ISO timestamp it stamped, so a caller pushing the same change to
// the sync backend uses the exact same `lastUpdated` for the local write and
// the server's `last_action_at` (the last-write-wins key).
function saveState(type, mealsRemaining) {
  const lastUpdated = new Date().toISOString();
  localStorage.setItem(
    storageKey(type),
    JSON.stringify({ mealsRemaining, lastUpdated }),
  );
  return lastUpdated;
}

// --- App bootstrap (runs once per meal type) ---

function init(type) {
  let state = loadState(type);
  const now = new Date();

  if (!state) {
    render(type, 0);
    return;
  }

  const crossed = countMealBoundariesCrossed(
    state.lastUpdated,
    now,
    MEAL_TIMES[type],
  );
  if (crossed > 0) {
    const updated = Math.max(0, state.mealsRemaining - crossed);
    saveState(type, updated);
    state = loadState(type);
  }

  render(type, state.mealsRemaining);
}

function showError(type, message) {
  document.getElementById(`error-${type}`).textContent = message;
}

function clearError(type) {
  document.getElementById(`error-${type}`).textContent = '';
}

// The "meals made" input ADDS to the current total (e.g. "just made 15
// lunches"), it does not overwrite it.
function calculate(type) {
  const input = document.getElementById(`meals-${type}`);
  const mealsMade = parseInt(input.value, 10);

  if (isNaN(mealsMade) || mealsMade < 0) {
    showError(type, 'Enter a valid number of meals.');
    return;
  }
  clearError(type);

  const state = loadState(type);
  const currentRemaining = state ? state.mealsRemaining : 0;
  const newTotal = currentRemaining + mealsMade;

  const lastActionAt = saveState(type, newTotal);
  input.value = '';
  render(type, newTotal);
  syncPush(type, newTotal, lastActionAt);
}

// Subtracts meals lost to spoilage/waste. Floors at 0.
function removeMeals(type) {
  const input = document.getElementById(`remove-${type}`);
  const mealsToRemove = parseInt(input.value, 10);

  if (isNaN(mealsToRemove) || mealsToRemove < 0) {
    showError(type, 'Enter a valid number of meals to remove.');
    return;
  }
  clearError(type);

  const state = loadState(type);
  const currentRemaining = state ? state.mealsRemaining : 0;
  const newTotal = Math.max(0, currentRemaining - mealsToRemove);

  const lastActionAt = saveState(type, newTotal);
  input.value = '';
  render(type, newTotal);
  syncPush(type, newTotal, lastActionAt);
}

// --- Rendering ---

function render(type, meals) {
  const today = todayDateOnly();

  // The stored `meals` count may still include today's not-yet-eaten meal
  // (if the current time is before that meal's feed hour). The displayed
  // count should show that honestly, but the run-out projection needs to
  // treat today's still-pending meal as day 1 of the countdown rather than
  // an extra day tacked on top.
  const mealHour = MEAL_TIMES[type];
  const todaysBoundary = new Date(today);
  todaysBoundary.setHours(mealHour, 0, 0, 0);
  const todaysMealAlreadyHappened = new Date() >= todaysBoundary;
  const effectiveMeals = todaysMealAlreadyHappened
    ? meals
    : Math.max(0, meals - 1);

  const runOutDate = new Date(today);
  runOutDate.setDate(runOutDate.getDate() + effectiveMeals);

  const orderDate = new Date(runOutDate);
  orderDate.setDate(orderDate.getDate() - 2);
  adjustForNonWorkingDay(orderDate);

  document.getElementById(`orderdate-${type}`).textContent =
    orderDate.toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });

  document.getElementById(`bowl-${type}`).innerHTML = bowlSVG(meals, type);

  document.getElementById(`tally-${type}`).innerHTML =
    tallyHTML(meals) +
    `<span class="tally-count">${meals} left &middot; runs out ${runOutDate.toLocaleDateString(
      'en-GB',
      { day: 'numeric', month: 'short' },
    )}</span>`;

  scheduleNotifications(type, orderDate);
}

function bowlSVG(meals, type) {
  const pct = Math.min(meals / FULL_BOWL_MEALS, 1);
  const rimY = 20;
  const bottomY = 50;
  const fillTopY = rimY + (1 - pct) * (bottomY - rimY);
  const fillColor = type === 'lunch' ? '#E8B23B' : '#6FA8C7';
  const clipId = `bowlClip-${type}`;

  return `
    <svg width="64" height="52" viewBox="0 0 64 52">
      <defs>
        <clipPath id="${clipId}">
          <path d="M10 20 L54 20 L47 44 Q32 50 17 44 Z"/>
        </clipPath>
      </defs>
      <path d="M10 20 L54 20 L47 44 Q32 50 17 44 Z" fill="none" stroke="#9CA79C" stroke-width="2"/>
      ${pct > 0 ? `<rect x="8" y="${fillTopY}" width="48" height="${60 - fillTopY}" fill="${fillColor}" clip-path="url(#${clipId})"/>` : ''}
      <ellipse cx="32" cy="20" rx="22" ry="5" fill="#232A25" stroke="#9CA79C" stroke-width="2"/>
    </svg>
  `;
}

// Groups meals into chalk tally marks (5 per group, completed groups
// struck through), the way you'd actually count on a kitchen board.
function tallyHTML(meals) {
  if (meals <= 0) return '<div class="tally"></div>';

  const fullGroups = Math.floor(meals / 5);
  const remainder = meals % 5;
  let groups = '';

  for (let i = 0; i < fullGroups; i++) {
    groups += `<div class="tally-group struck">${'<div class="tally-mark"></div>'.repeat(5)}</div>`;
  }
  if (remainder > 0) {
    groups += `<div class="tally-group">${'<div class="tally-mark"></div>'.repeat(remainder)}</div>`;
  }

  return `<div class="tally">${groups}</div>`;
}

// --- Notifications ---
// Fires a reminder 7 days before the order date, and again at 5 days before.
// Uses Capacitor's LocalNotifications plugin, which schedules via the OS
// itself -- it fires even if the app stays closed the whole time. In a
// plain browser (window.Capacitor absent) this silently no-ops, meaning
// no notifications fire until the app is wrapped with Capacitor.

// Android won't deliver notifications unless the app has asked for
// permission first. Safe to call on every load -- if already granted,
// this just resolves immediately without prompting again.
async function requestNotificationPermission() {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
  try {
    const result = await LocalNotifications.requestPermissions();
    if (result.display !== 'granted') {
      console.warn('Notification permission not granted:', result.display);
    }
  } catch (err) {
    console.error('Failed to request notification permission:', err);
  }
}

// Remembers the order date each meal type was last scheduled against, so
// the repeated renders (every add/remove, plus the 5-minute interval)
// don't cancel-and-reschedule an unchanged alarm each time -- which, right
// at the 09:00 fire moment, could otherwise cancel it microseconds before
// it delivers.
const lastScheduledFor = {};

async function scheduleNotifications(type, orderDate) {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;

  const { display } = await LocalNotifications.checkPermissions();
  if (display !== 'granted') return;

  const orderKey = orderDate.toDateString();
  if (lastScheduledFor[type] === orderKey) return;
  lastScheduledFor[type] = orderKey;

  const ids = NOTIF_IDS[type];
  const now = new Date();

  await LocalNotifications.cancel({
    notifications: [{ id: ids.weekBefore }, { id: ids.fiveDayBefore }],
  });

  const weekBeforeAt = new Date(orderDate);
  weekBeforeAt.setDate(weekBeforeAt.getDate() - 7);
  weekBeforeAt.setHours(9, 0, 0, 0);

  const fiveDayBeforeAt = new Date(orderDate);
  fiveDayBeforeAt.setDate(fiveDayBeforeAt.getDate() - 5);
  fiveDayBeforeAt.setHours(9, 0, 0, 0);

  const label = type.charAt(0).toUpperCase() + type.slice(1);
  const notifications = [];

  if (weekBeforeAt > now) {
    notifications.push({
      id: ids.weekBefore,
      title: `${label}: order in a week`,
      body: `Order by ${orderDate.toDateString()} -- one week to go.`,
      schedule: { at: weekBeforeAt, allowWhileIdle: true },
    });
  }
  if (fiveDayBeforeAt > now) {
    notifications.push({
      id: ids.fiveDayBefore,
      title: `${label}: order soon`,
      body: `Order by ${orderDate.toDateString()} -- 5 days left.`,
      schedule: { at: fiveDayBeforeAt, allowWhileIdle: true },
    });
  }

  if (notifications.length) {
    await LocalNotifications.schedule({ notifications });
  }
}

// --- Cloud sync wiring ---
// Every backend call goes through window.MealSync (see sync.js). Nothing here
// references the Appwrite SDK directly. All of it is best-effort: any failure
// is caught and logged, and the app keeps working from localStorage -- the
// same resilient style as loadHolidays().
//
// Only explicit user actions (Add / Remove) push to the server. The time-based
// auto-decrement in init() is a local display projection and must never push.

const SYNC_QUEUE_KEY = 'dogMealTracker:syncQueue';

function syncEnabled() {
  return !!(window.MealSync && window.MealSync.isConfigured());
}

function readSyncQueue() {
  try {
    return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY)) || {};
  } catch {
    return {};
  }
}

function writeSyncQueue(queue) {
  try {
    if (queue && (queue.lunch || queue.dinner)) {
      localStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
    } else {
      localStorage.removeItem(SYNC_QUEUE_KEY);
    }
  } catch {
    // Best-effort; a failed queue write just means this action isn't retried.
  }
}

// Latest desired absolute value per type wins -- no history is kept.
function enqueueSync(type, mealsRemaining, lastActionAt) {
  const queue = readSyncQueue();
  queue[type] = { mealsRemaining, lastActionAt };
  writeSyncQueue(queue);
}

function clearSyncQueueEntry(type) {
  const queue = readSyncQueue();
  if (queue[type]) {
    delete queue[type];
    writeSyncQueue(queue);
  }
}

// Fire-and-forget push from a user action. localStorage has already been
// written by the caller. On failure the value is queued (latest wins) and
// retried on next bootstrap and on the window 'online' event.
async function syncPush(type, mealsRemaining, lastActionAt) {
  if (!syncEnabled()) return;
  try {
    await window.MealSync.pushAction(type, mealsRemaining, lastActionAt);
    clearSyncQueueEntry(type);
  } catch (err) {
    console.error(`Sync push failed for ${type}; queued for retry:`, err);
    enqueueSync(type, mealsRemaining, lastActionAt);
  }
}

async function flushSyncQueue() {
  if (!syncEnabled()) return;
  const queue = readSyncQueue();
  for (const type of MEAL_TYPES) {
    const entry = queue[type];
    if (!entry) continue;
    try {
      await window.MealSync.pushAction(
        type,
        entry.mealsRemaining,
        entry.lastActionAt,
      );
      clearSyncQueueEntry(type);
    } catch (err) {
      console.error(`Sync queue flush failed for ${type}:`, err);
    }
  }
}

// Converges one meal type's localStorage with a remote value using
// last-write-wins on the timestamp.
//   remote newer            -> write remote locally, re-init (auto-decrement
//                              then ticks down correctly from the remote ts)
//   local newer & differs   -> push local up (only when pushBack is set, i.e.
//                              the bootstrap/reconnect pull -- never for a
//                              realtime echo of our own write)
//   equal                   -> nothing
function applyRemoteState(type, remoteMeals, remoteISO, pushBack) {
  const local = loadState(type);
  const remoteTime = new Date(remoteISO).getTime();
  const localTime = local ? local.lastUpdated.getTime() : -Infinity;

  if (Number.isNaN(remoteTime)) return;

  if (!local || remoteTime > localTime) {
    localStorage.setItem(
      storageKey(type),
      JSON.stringify({ mealsRemaining: remoteMeals, lastUpdated: remoteISO }),
    );
    init(type);
  } else if (
    pushBack &&
    localTime > remoteTime &&
    local.mealsRemaining !== remoteMeals
  ) {
    syncPush(type, local.mealsRemaining, local.lastUpdated.toISOString());
  }
}

async function reconcile() {
  if (!syncEnabled()) return;
  let remoteStates;
  try {
    remoteStates = await window.MealSync.pullState();
  } catch (err) {
    console.error('Sync pull failed; staying on local state:', err);
    return;
  }
  for (const remote of remoteStates) {
    try {
      applyRemoteState(
        remote.type,
        remote.meals_remaining,
        remote.last_action_at,
        true,
      );
    } catch (err) {
      console.error(`Sync reconcile failed for ${remote.type}:`, err);
    }
  }
}

function startRealtime() {
  if (!syncEnabled()) return;
  try {
    window.MealSync.subscribe((type, meals, ts) => {
      try {
        if (!MEAL_TYPES.includes(type)) return;
        // Ignore echoes of our own writes (ts equal or older than local).
        applyRemoteState(type, meals, ts, false);
      } catch (err) {
        console.error('Sync realtime apply failed:', err);
      }
    });
  } catch (err) {
    console.error('Sync realtime subscribe failed:', err);
  }
}

// --- Login gate ---

function revealCards() {
  document.querySelectorAll('.card').forEach((el) => {
    el.hidden = false;
  });
}

function showSignOut() {
  const btn = document.getElementById('signout-btn');
  if (!btn) return;
  btn.hidden = false;
  btn.addEventListener('click', onSignOut, { once: true });
}

async function onSignOut() {
  try {
    await window.MealSync.logout();
  } catch (err) {
    console.error('Sign out failed:', err);
  }
  location.reload();
}

function showLoginGate() {
  const gate = document.getElementById('login-gate');
  if (!gate) return;
  document.querySelectorAll('.card').forEach((el) => {
    el.hidden = true;
  });
  gate.hidden = false;
  gate.addEventListener('submit', onLoginSubmit);
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const emailEl = document.getElementById('login-email');
  const passEl = document.getElementById('login-password');
  const errorEl = document.getElementById('login-error');
  const submitEl = document.getElementById('login-submit');

  errorEl.textContent = '';
  submitEl.disabled = true;
  try {
    await window.MealSync.login(emailEl.value.trim(), passEl.value);
    passEl.value = '';
    document.getElementById('login-gate').hidden = true;
    revealCards();
    showSignOut();
    // First paint already happened at load; re-render from localStorage, then
    // run the normal (post-auth) bootstrap.
    MEAL_TYPES.forEach(init);
    runBootstrap();
  } catch (err) {
    console.error('Login failed:', err);
    errorEl.textContent = 'Sign in failed. Check your email and password.';
  } finally {
    submitEl.disabled = false;
  }
}

// --- App bootstrap ---

// The part that runs once we're past the login gate (or when there's no gate).
function runBootstrap() {
  requestNotificationPermission();
  loadHolidays();

  if (syncEnabled()) {
    flushSyncQueue()
      .then(reconcile)
      .then(startRealtime)
      .catch((err) => console.error('Sync bootstrap failed:', err));

    window.addEventListener('online', () => {
      flushSyncQueue().then(reconcile);
    });
  }

  // Recheck periodically so an already-open tab still decrements right at
  // the meal time, rather than only on next page load.
  setInterval(() => MEAL_TYPES.forEach(init), 5 * 60 * 1000);
}

async function bootstrap() {
  if (syncEnabled()) {
    let authed = false;
    try {
      authed = await window.MealSync.isAuthed();
    } catch (err) {
      console.error('Sync auth check failed:', err);
    }
    if (!authed) {
      showLoginGate();
      return; // runBootstrap() runs after a successful sign-in
    }
    showSignOut();
  }
  runBootstrap();
}

// Kick everything off. Render immediately from localStorage (plus any
// cached holidays) so the counts and dates show even with no connection;
// nothing is awaited before this first paint. The holiday fetch and any
// cloud sync then refine things whenever they can.
loadCachedHolidays();
MEAL_TYPES.forEach(init);
bootstrap();
