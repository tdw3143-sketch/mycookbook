# MyCookbook

A personal cooking and grocery web app. Import recipes from any URL, plan your week, and generate a shopping list.

## Requirements

- Python 3.8+
- pip

## Setup & Run

```bash
# 1. Install dependencies
pip install flask requests beautifulsoup4

# 2. Start the server
python app.py
```

Then open **http://localhost:5000** in your browser.

## Features

- **Recipe Import** — paste any recipe URL (AllRecipes, BBC Good Food, NYT Cooking, etc.). The scraper reads JSON-LD schema.org data embedded in most recipe sites.
- **Recipe Library** — all recipes saved locally in `data/recipes.json`.
- **Meal Plan** — drag recipes into a 7-day grid. Set number of people.
- **Shopping List** — auto-generated from your meal plan, grouped by category (Produce, Dairy, Meat, Pantry). Check off items as you shop.

## Project Structure

```
Cooking app/
├── app.py              # Flask backend + scraper
├── requirements.txt
├── data/
│   └── recipes.json    # Persistent recipe storage
├── static/
│   ├── style.css
│   └── app.js
└── templates/
    └── index.html
```

## Notes

- Recipes are stored in `data/recipes.json` — back this file up to keep your collection.
- YouTube URLs return a placeholder (video scraping is not supported yet).
- The store selector (Albert Heijn / Lidl) is cosmetic for now.
