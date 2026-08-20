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

// Will hold the set of holiday dates (strings "YYYY-MM-DD")
let holidaySet = new Set();

// Each meal type tracks its own count, dates, and notifications
const MEAL_TYPES = ['lunch', 'dinner'];
const storageKey = (type) => `dogMealTracker:${type}`;

// Notification IDs must be unique per scheduled item across the whole app
const NOTIF_IDS = {
  lunch: { weekBefore: 101, fiveDayBefore: 102 },
  dinner: { weekBefore: 201, fiveDayBefore: 202 },
};

// --- Holidays ---

async function loadHolidays() {
  try {
    const resp = await fetch('https://www.gov.uk/bank-holidays.json');
    const data = await resp.json();
    const events = data['england-and-wales'].events;
    events.forEach((ev) => holidaySet.add(ev.date));
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

function saveState(type, mealsRemaining) {
  localStorage.setItem(
    storageKey(type),
    JSON.stringify({
      mealsRemaining,
      lastUpdated: new Date().toISOString(),
    }),
  );
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

  saveState(type, newTotal);
  input.value = '';
  render(type, newTotal);
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

  saveState(type, newTotal);
  input.value = '';
  render(type, newTotal);
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
async function scheduleNotifications(type, orderDate) {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
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

// Kick everything off
loadHolidays();

// Recheck periodically so an already-open tab still decrements right at
// the meal time, rather than only on next page load.
setInterval(() => MEAL_TYPES.forEach(init), 5 * 60 * 1000);
