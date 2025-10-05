# 🐶 Dog Meal / Order Planner

A simple web tool to help track your dog's meals and calculate the **latest order date** for food delivery/prep, taking into account:

* Remaining number of meals
* Whether a meal is eaten today
* UK weekends
* UK bank holidays (fetched live from [gov.uk](https://www.gov.uk/bank-holidays.json))

The app makes sure you always know when to place an order so food can defrost and be prepared in time.

---

## 🚀 Features

* Input the number of meals you have left
* Checkbox to skip today’s meal if your dog hasn’t eaten yet
* Calculates:

  * Meals left (after today)
  * The exact date meals will run out
  * The **latest safe order date** (2 days before run-out, adjusted for weekends/holidays)
* Mobile-friendly layout (fonts and key info scale up on small screens)
* The **order date** is displayed prominently in a highlighted card

---

## 🛠️ Tech Stack

* **HTML5**
* **CSS3** (with responsive media queries)
* **JavaScript (Vanilla)** – fetches UK holiday data and performs calculations

---

## 📂 Project Structure

```
/ (root)
│
├── index.html      # Main HTML page
├── style.css       # Styling (desktop + mobile)
└── script.js       # Logic for date calculations & holiday fetching
```

---

## 📖 How to Use

1. Open `index.html` in your browser.
2. Enter how many meals you currently have.
3. Tick the checkbox if your dog **hasn’t eaten today**.
4. Press **Calculate**.
5. See:

   * Meals left
   * Run-out date
   * Big highlighted card with the **order by date**

---


## 🌍 Region Support

Currently defaults to **England & Wales** for bank holidays.
To switch to Scotland or Northern Ireland, update this line in `script.js`:

```js
const events = data['england-and-wales'].events;
```

Replace with:

* `"scotland"`
* `"northern-ireland"`

---

## ✅ Example

If you have **10 meals left**, and your dog eats today:

* Meals left after today: **9**
* Meals run out on: **(today + 9 days)**
* Latest order date: **2 days before**, adjusted if that falls on a weekend or holiday

---

## 🐾 License

Free to use and modify for personal use.
