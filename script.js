// Will hold the set of holiday dates (strings "YYYY-MM-DD")
let holidaySet = new Set();

// Fetch UK bank holidays from gov.uk API (includes England & Wales, Scotland, etc.)
async function loadHolidays() {
  try {
    const resp = await fetch('https://www.gov.uk/bank-holidays.json');
    const data = await resp.json();
    // Choose region: “england-and-wales” for most of UK (adjust if you want Scotland etc.)
    const events = data['england-and-wales'].events;
    events.forEach((ev) => {
      holidaySet.add(ev.date); // e.g. "2025-12-25"
    });
    document.getElementById('output').innerHTML = ''; // clear “loading” notice
  } catch (err) {
    console.error('Failed to load holidays:', err);
    document.getElementById('output').innerHTML =
      "<p style='color:red'>Error loading holiday data. Using empty holiday list.</p>";
  }
}

function isWeekend(date) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function isHoliday(date) {
  const ymd = date.toISOString().split('T')[0];
  return holidaySet.has(ymd);
}

function adjustForNonWorkingDay(date) {
  // If the date is a weekend or holiday, roll backward until we hit a working day
  while (isWeekend(date) || isHoliday(date)) {
    date.setDate(date.getDate() - 1);
  }
  return date;
}

function calculate() {
  const meals = parseInt(document.getElementById('meals').value, 10);
  const skipToday = document.getElementById('skipToday').checked;

  if (isNaN(meals) || meals < 0) {
    document.getElementById('output').innerHTML =
      '<p>Please enter a valid (>=0) number of meals.</p>';
    return;
  }

  const today = new Date();
  // Determine how many meals will remain after today
  let daysLeft = meals - (skipToday ? 1 : 0);
  if (daysLeft < 0) daysLeft = 0;

  // Run-out date (the date at which meals are exhausted)
  const runOutDate = new Date(today);
  runOutDate.setDate(runOutDate.getDate() + daysLeft);

  // Order date = runOutDate minus 2 days
  const orderDate = new Date(runOutDate);
  orderDate.setDate(orderDate.getDate() - 2);
  adjustForNonWorkingDay(orderDate);

  // Display results
  document.getElementById('output').innerHTML = `
    <div class="card order-card">
      Order by: ${orderDate.toDateString()}
    </div>
    <div class="small-info">
      <p><strong>Meals left (after today):</strong> ${daysLeft}</p>
      <p><strong>Meals run out on:</strong> ${runOutDate.toDateString()}</p>
    </div>
      `;
}

// On load, fetch holidays so the data is ready
loadHolidays();
