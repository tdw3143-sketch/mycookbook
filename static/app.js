/* ============================================================
   MyCookbook — frontend app
   ============================================================ */

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  recipes: [],
  mealPlan: JSON.parse(localStorage.getItem("mealPlan") || "{}"),
  people: parseInt(localStorage.getItem("people") || "2", 10),
  store: localStorage.getItem("store") || "Albert Heijn",
  currentRecipe: null,
  currentServings: 1,
  baseServings: 1,
  searchQuery: "",
  activeTag: "All",
  savedPlans: [],
  savedWeeksOpen: false,
  previewData: null,
  ahAuthenticated: false,
};

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const ALL_TAGS = ["Vegetarian", "Vegan", "Quick", "Pasta", "Chicken", "Fish", "Beef", "Soup"];

const CATEGORY_KEYWORDS = {
  Produce:  ["lettuce","spinach","kale","tomato","tomatoes","onion","garlic","pepper","peppers","cucumber","carrot","carrots","potato","potatoes","broccoli","mushroom","mushrooms","zucchini","avocado","lime","lemon","lemons","limes","ginger","celery","corn","cabbage","arugula","basil","parsley","cilantro","thyme","rosemary","chive","chives","scallion","scallions","fruit","apple","banana","berry","berries","strawberr","blueberr","raspberry","mango","pineapple","peach","grape","grapes","orange","oranges","herbs","herb"],
  Dairy:    ["milk","cream","butter","cheese","yogurt","egg","eggs","mozzarella","parmesan","cheddar","ricotta","feta","brie","gouda","sour cream","cream cheese","whipped","half-and-half","oat milk","almond milk"],
  Meat:     ["chicken","beef","pork","lamb","turkey","bacon","sausage","salmon","tuna","shrimp","fish","steak","ground beef","mince","prawn","prawns","crab","lobster","anchov","anchovy","pancetta","chorizo","duck","veal"],
  Pantry:   ["flour","sugar","salt","pepper","oil","olive oil","vinegar","soy sauce","pasta","rice","bread","broth","stock","can","canned","chickpea","chickpeas","lentils","bean","beans","coconut milk","tomato paste","tomato sauce","cumin","paprika","oregano","cinnamon","nutmeg","baking","honey","maple syrup","mustard","ketchup","mayonnaise","sriracha","hot sauce","worcestershire","cornstarch","cornflour","oats","quinoa","noodle","noodles","tortilla","wrap","crouton","panko","breadcrumb"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(id) { return document.getElementById(id); }

function toast(msg, type = "success") {
  const wrap = $("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function saveMealPlan() {
  localStorage.setItem("mealPlan", JSON.stringify(state.mealPlan));
}

function savePeople() {
  localStorage.setItem("people", String(state.people));
}

function categoriseIngredient(text) {
  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  return "Other";
}

function totalTime(recipe) {
  const parts = [];
  if (recipe.prepTime) parts.push(recipe.prepTime);
  if (recipe.cookTime) parts.push(recipe.cookTime);
  return parts.join(" + ") || "—";
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}

function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(isoStr) {
  if (!isoStr) return "";
  try {
    return new Date(isoStr).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return isoStr;
  }
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function apiGetRecipes() {
  const r = await fetch("/api/recipes");
  return r.json();
}

async function apiSaveRecipe(recipe) {
  const r = await fetch("/api/recipes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(recipe),
  });
  return { status: r.status, data: await r.json() };
}

async function apiUpdateRecipe(id, updates) {
  const r = await fetch(`/api/recipes/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  return r.json();
}

async function apiDeleteRecipe(id) {
  const r = await fetch(`/api/recipes/${id}`, { method: "DELETE" });
  return r.json();
}

async function apiImport(url) {
  const r = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return r.json();
}

async function apiGetPlans() {
  const r = await fetch("/api/plans");
  return r.json();
}

async function apiSavePlan(payload) {
  const r = await fetch("/api/plans", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json();
}

async function apiDeletePlan(id) {
  const r = await fetch(`/api/plans/${id}`, { method: "DELETE" });
  return r.json();
}

async function apiAhStatus() {
  const r = await fetch("/api/ah/status");
  return r.json();
}

async function apiAhConnect(code) {
  const r = await fetch("/api/ah/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return { status: r.status, data: await r.json() };
}

async function apiAhDisconnect() {
  const r = await fetch("/api/ah/disconnect", { method: "DELETE" });
  return r.json();
}


// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
function showView(viewId) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-links a").forEach(a => a.classList.remove("active"));
  $(`view-${viewId}`).classList.add("active");
  const link = document.querySelector(`.nav-links a[data-view="${viewId}"]`);
  if (link) link.classList.add("active");

  if (viewId === "mealplan") renderMealPlan();
  if (viewId === "shopping") renderShoppingList();
}

// ---------------------------------------------------------------------------
// Search & Filter
// ---------------------------------------------------------------------------
function getFilteredRecipes() {
  let list = state.recipes;

  // Text search
  const q = state.searchQuery.toLowerCase().trim();
  if (q) {
    list = list.filter(r => {
      const titleMatch = r.title.toLowerCase().includes(q);
      const ingMatch = (r.ingredients || []).some(i => i.toLowerCase().includes(q));
      return titleMatch || ingMatch;
    });
  }

  // Tag filter
  if (state.activeTag === "Favourites") {
    list = list.filter(r => r.favourite);
  } else if (state.activeTag && state.activeTag !== "All") {
    list = list.filter(r => (r.tags || []).includes(state.activeTag));
  }

  return list;
}

function initSearchFilter() {
  const searchInput = $("search-input");
  searchInput.addEventListener("input", () => {
    state.searchQuery = searchInput.value;
    renderRecipes();
  });

  const chips = document.querySelectorAll(".tag-chip");
  chips.forEach(chip => {
    chip.addEventListener("click", () => {
      chips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      state.activeTag = chip.dataset.tag;
      renderRecipes();
    });
  });
}

// ---------------------------------------------------------------------------
// Recipe Cards
// ---------------------------------------------------------------------------
function renderRecipes() {
  const grid = $("recipe-grid");
  const count = $("recipe-count");
  const filtered = getFilteredRecipes();
  count.textContent = `(${state.recipes.length})`;

  if (state.recipes.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🥗</div>
        <h3>No recipes yet</h3>
        <p>Paste a recipe URL above and click Import to get started.</p>
      </div>`;
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="empty-icon">🔍</div>
        <h3>No recipes match</h3>
        <p>Try a different search term or tag.</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(r => cardHTML(r)).join("");

  grid.querySelectorAll(".recipe-card").forEach(card => {
    const id = card.dataset.id;
    card.addEventListener("click", e => {
      if (e.target.closest(".card-action-btn")) return;
      openModal(id);
    });
    card.querySelector(".card-action-btn.fav").addEventListener("click", e => {
      e.stopPropagation();
      toggleFavourite(id);
    });
    card.querySelector(".card-action-btn.delete").addEventListener("click", e => {
      e.stopPropagation();
      deleteRecipe(id);
    });
  });
}

function cardHTML(r) {
  const imgEl = r.image
    ? `<img src="${escHtml(r.image)}" alt="${escHtml(r.title)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'card-img-placeholder\\'>🍽️</div>'">`
    : `<div class="card-img-placeholder">🍽️</div>`;

  const time = totalTime(r);
  const servings = r.servings ? `<span class="card-meta-item">👤 ${r.servings}</span>` : "";
  const timeEl = time !== "—" ? `<span class="card-meta-item">⏱ ${escHtml(time)}</span>` : "";

  const tags = (r.tags || []);
  const tagsHTML = tags.length
    ? `<div class="card-tags">${tags.map(t => `<span class="card-tag">${escHtml(t)}</span>`).join("")}</div>`
    : "";

  return `
    <div class="recipe-card" data-id="${r.id}">
      <div class="card-img-wrap">${imgEl}</div>
      <div class="card-actions">
        <button class="card-action-btn fav${r.favourite ? " active" : ""}" title="Favourite">♥</button>
        <button class="card-action-btn delete" title="Delete recipe">🗑️</button>
      </div>
      <div class="card-body">
        <div class="card-title">${escHtml(r.title)}</div>
        <div class="card-meta">${timeEl}${servings}</div>
        ${tagsHTML}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function handleImport() {
  const input = $("import-url");
  const url = input.value.trim();
  if (!url) { toast("Please enter a URL", "error"); return; }

  setImportLoading(true);

  try {
    const data = await apiImport(url);
    if (data.error) { toast(`Import failed: ${data.error}`, "error"); return; }

    if (data.multi) {
      // Multiple recipes found — show picker (saves directly, no preview)
      input.value = "";
      setImportLoading(false);
      openMultiPicker(data.recipes);
      return;
    }

    // Single recipe — show preview modal instead of auto-saving
    input.value = "";
    setImportLoading(false);
    openPreviewModal(data);
  } catch (err) {
    toast(`Error: ${err.message}`, "error");
  } finally {
    setImportLoading(false);
  }
}

// ---------------------------------------------------------------------------
// Import Preview Modal
// ---------------------------------------------------------------------------
function openPreviewModal(data) {
  state.previewData = data;

  $("preview-title").value = data.title || "";
  $("preview-desc").value = data.description || "";
  $("preview-servings").value = data.servings || "";
  $("preview-preptime").value = data.prepTime || "";
  $("preview-cooktime").value = data.cookTime || "";
  $("preview-ingredients").value = (data.ingredients || []).join("\n");
  $("preview-instructions").value = (data.instructions || []).join("\n");

  // Render tag checkboxes
  const tagsEl = $("preview-tags-checkboxes");
  const existingTags = data.tags || [];
  tagsEl.innerHTML = ALL_TAGS.map(tag => `
    <label class="edit-tag-item">
      <input type="checkbox" value="${escHtml(tag)}" ${existingTags.includes(tag) ? "checked" : ""}>
      ${escHtml(tag)}
    </label>`).join("");

  $("preview-modal").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closePreviewModal() {
  $("preview-modal").classList.remove("open");
  document.body.style.overflow = "";
  state.previewData = null;
}

async function handlePreviewSave() {
  const btn = $("preview-save-btn");
  btn.disabled = true;

  const ingredients = $("preview-ingredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  const instructions = $("preview-instructions").value.split("\n").map(s => s.trim()).filter(Boolean);
  const tags = [...$("preview-tags-checkboxes").querySelectorAll("input:checked")].map(cb => cb.value);

  const payload = {
    title: $("preview-title").value.trim() || "Untitled Recipe",
    description: $("preview-desc").value.trim(),
    servings: parseInt($("preview-servings").value, 10) || null,
    prepTime: $("preview-preptime").value.trim(),
    cookTime: $("preview-cooktime").value.trim(),
    ingredients,
    instructions,
    tags,
    image: state.previewData ? state.previewData.image || "" : "",
    nutrition: state.previewData ? state.previewData.nutrition || {} : {},
    source_url: state.previewData ? state.previewData.source_url || "" : "",
  };

  try {
    const { status, data } = await apiSaveRecipe(payload);

    if (status === 409 && data.duplicate) {
      toast(`Already in your library: ${data.existing.title}`, "warning");
      closePreviewModal();
      return;
    }

    if (data.error) {
      toast(`Save failed: ${data.error}`, "error");
      return;
    }

    state.recipes.unshift(data);
    renderRecipes();
    closePreviewModal();
    toast(`"${data.title}" saved!`, "success");
  } catch (err) {
    toast(`Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Multi-recipe picker
// ---------------------------------------------------------------------------
function openMultiPicker(recipes) {
  const modal = $("multi-picker-modal");
  const list  = $("multi-picker-list");
  const count = $("multi-picker-count");

  count.textContent = `${recipes.length} recipes found on this page`;

  list.innerHTML = recipes.map((r, i) => {
    const thumb = r.image
      ? `<img src="${escHtml(r.image)}" alt="" onerror="this.style.display='none'">`
      : `<div class="picker-thumb-placeholder">🍽️</div>`;
    const ingCount  = r.ingredients.length  ? `${r.ingredients.length} ingredients` : "ingredients not detected";
    const stepCount = r.instructions.length ? `${r.instructions.length} steps`       : "steps not detected";
    return `
      <label class="multi-picker-item" for="mp-check-${i}">
        <input type="checkbox" id="mp-check-${i}" data-index="${i}" checked>
        <div class="picker-thumb">${thumb}</div>
        <div class="multi-picker-item-info">
          <div class="multi-picker-item-title">${escHtml(r.title)}</div>
          <div class="multi-picker-item-meta">${ingCount} · ${stepCount}</div>
        </div>
      </label>`;
  }).join("");

  $("multi-picker-save-btn").onclick = async () => {
    const checked = [...list.querySelectorAll("input[type=checkbox]:checked")];
    if (!checked.length) { toast("Select at least one recipe", "error"); return; }

    $("multi-picker-save-btn").disabled = true;
    let savedCount = 0;
    let dupCount = 0;

    for (const cb of checked) {
      const recipe = recipes[parseInt(cb.dataset.index, 10)];
      const { status, data } = await apiSaveRecipe(recipe);
      if (status === 409 && data.duplicate) {
        dupCount++;
      } else if (!data.error) {
        state.recipes.unshift(data);
        savedCount++;
      }
    }

    closeMultiPicker();
    renderRecipes();

    let msg = `${savedCount} recipe${savedCount !== 1 ? "s" : ""} saved!`;
    if (dupCount > 0) msg += ` ${dupCount} already in library.`;
    toast(msg);
  };

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeMultiPicker() {
  $("multi-picker-modal").classList.remove("open");
  document.body.style.overflow = "";
  $("multi-picker-save-btn").disabled = false;
}

function setImportLoading(on) {
  $("import-btn").disabled = on;
  $("import-spinner").classList.toggle("hidden", !on);
}

async function handleImageImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";

  const spinner = $("import-spinner");
  const spinnerText = spinner.querySelector("p");
  const origText = spinnerText.textContent;
  spinnerText.textContent = "Reading recipe from photo…";
  spinner.classList.remove("hidden");
  $("import-photo-btn").disabled = true;

  try {
    const base64 = await fileToBase64(file);
    const resp = await fetch("/api/import/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64, mediaType: "image/jpeg" }),
    });
    const data = await resp.json();
    if (data.error) { toast(data.error, "error"); return; }
    openPreviewModal(data);
  } catch (err) {
    toast(`Error: ${err.message}`, "error");
  } finally {
    spinner.classList.add("hidden");
    spinnerText.textContent = origText;
    $("import-photo-btn").disabled = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 800;
      let { width, height } = img;
      if (width > MAX || height > MAX) {
        if (width > height) { height = Math.round(height * MAX / width); width = MAX; }
        else { width = Math.round(width * MAX / height); height = MAX; }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Recipe Modal
// ---------------------------------------------------------------------------
function openModal(id) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe) return;
  state.currentRecipe = recipe;
  state.baseServings = recipe.servings || 1;
  state.currentServings = state.baseServings;

  // Always open in view mode
  showViewMode();
  fillModal(recipe);
  $("recipe-modal").classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("recipe-modal").classList.remove("open");
  document.body.style.overflow = "";
  showViewMode();
}

function showViewMode() {
  $("modal-view-mode").style.display = "";
  $("modal-edit-mode").style.display = "none";
  $("modal-edit-btn").style.display = "";
}

function showEditMode() {
  $("modal-view-mode").style.display = "none";
  $("modal-edit-mode").style.display = "";
  $("modal-edit-btn").style.display = "none";
  populateEditMode(state.currentRecipe);
}

function populateEditMode(r) {
  $("edit-title").value = r.title || "";
  $("edit-desc").value = r.description || "";
  $("edit-servings").value = r.servings || "";
  $("edit-preptime").value = r.prepTime || "";
  $("edit-cooktime").value = r.cookTime || "";
  $("edit-image").value = r.image || "";
  $("edit-ingredients").value = (r.ingredients || []).join("\n");
  $("edit-instructions").value = (r.instructions || []).join("\n");

  const tagsEl = $("edit-tags-checkboxes");
  const existingTags = r.tags || [];
  tagsEl.innerHTML = ALL_TAGS.map(tag => `
    <label class="edit-tag-item">
      <input type="checkbox" value="${escHtml(tag)}" ${existingTags.includes(tag) ? "checked" : ""}>
      ${escHtml(tag)}
    </label>`).join("");
}

async function handleEditSave() {
  const btn = $("edit-save-btn");
  btn.disabled = true;

  const ingredients = $("edit-ingredients").value.split("\n").map(s => s.trim()).filter(Boolean);
  const instructions = $("edit-instructions").value.split("\n").map(s => s.trim()).filter(Boolean);
  const tags = [...$("edit-tags-checkboxes").querySelectorAll("input:checked")].map(cb => cb.value);

  const updates = {
    title: $("edit-title").value.trim() || "Untitled Recipe",
    description: $("edit-desc").value.trim(),
    servings: parseInt($("edit-servings").value, 10) || null,
    prepTime: $("edit-preptime").value.trim(),
    cookTime: $("edit-cooktime").value.trim(),
    image: $("edit-image").value.trim(),
    ingredients,
    instructions,
    tags,
  };

  try {
    const updated = await apiUpdateRecipe(state.currentRecipe.id, updates);
    if (updated.error) { toast(`Save failed: ${updated.error}`, "error"); return; }

    // Update state
    const idx = state.recipes.findIndex(r => r.id === updated.id);
    if (idx !== -1) state.recipes[idx] = updated;
    state.currentRecipe = updated;
    state.baseServings = updated.servings || 1;
    state.currentServings = state.baseServings;

    renderRecipes();
    showViewMode();
    fillModal(updated);
    toast("Recipe updated!", "success");
  } catch (err) {
    toast(`Error: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

function fillModal(r) {
  // Hero
  const hero = $("modal-hero");
  if (r.image) {
    hero.innerHTML = `<img src="${escHtml(r.image)}" alt="${escHtml(r.title)}" onerror="this.parentElement.innerHTML='<div class=\\'modal-hero-placeholder\\'>🍽️</div>'">`;
  } else {
    hero.innerHTML = `<div class="modal-hero-placeholder">🍽️</div>`;
  }

  $("modal-title").textContent = r.title;
  $("modal-desc").textContent = r.description ? stripHtml(r.description) : "";

  // Meta
  const metaItems = [];
  if (r.prepTime) metaItems.push(`<div class="modal-meta-item">🥄 Prep: ${escHtml(r.prepTime)}</div>`);
  if (r.cookTime) metaItems.push(`<div class="modal-meta-item">🔥 Cook: ${escHtml(r.cookTime)}</div>`);
  $("modal-meta").innerHTML = metaItems.join("") + `
    <div class="servings-ctrl">
      👤 Serves:
      <button class="servings-btn" id="srv-minus">−</button>
      <span id="servings-display">${r.servings || 1}</span>
      <button class="servings-btn" id="srv-plus">+</button>
    </div>`;

  $("srv-minus").onclick = () => adjustServings(-1);
  $("srv-plus").onclick  = () => adjustServings(1);

  // Nutrition
  const nutr = r.nutrition || {};
  const nutrKeys = Object.keys(nutr);
  if (nutrKeys.length) {
    $("modal-nutrition").innerHTML = nutrKeys.map(k =>
      `<div class="nutrition-badge">${escHtml(nutr[k])}<span>${escHtml(k)}</span></div>`
    ).join("");
    $("modal-nutrition").classList.remove("hidden");
  } else {
    $("modal-nutrition").innerHTML = "";
    $("modal-nutrition").classList.add("hidden");
  }

  // Ingredients
  renderIngredients(r.ingredients, state.currentServings, state.baseServings);

  // Instructions
  const instrEl = $("modal-instructions");
  if (r.instructions && r.instructions.length) {
    instrEl.innerHTML = r.instructions.map(step =>
      `<li>${escHtml(stripHtml(step))}</li>`
    ).join("");
  } else {
    instrEl.innerHTML = `<li style="color:var(--text-muted)">No instructions extracted — visit the source link below.</li>`;
  }

  // Source
  const srcEl = $("modal-source");
  if (r.source_url) {
    srcEl.innerHTML = `<a href="${escHtml(r.source_url)}" target="_blank" rel="noopener">View original ↗</a>`;
    srcEl.classList.remove("hidden");
  } else {
    srcEl.classList.add("hidden");
  }

  // Add to meal plan button
  $("add-to-mealplan-btn").onclick = () => promptAddToDay(r);
}

function renderIngredients(ingredients, currentServings, baseServings) {
  const ratio = baseServings > 0 ? currentServings / baseServings : 1;
  const el = $("modal-ingredients");
  if (ingredients && ingredients.length) {
    el.innerHTML = ingredients.map(ing => {
      const scaled = scaleIngredient(ing, ratio);
      return `<li>${escHtml(scaled)}</li>`;
    }).join("");
  } else {
    el.innerHTML = `<li style="color:var(--text-muted)">No ingredients extracted.</li>`;
  }
}

function scaleIngredient(text, ratio) {
  if (ratio === 1) return text;
  return text.replace(/^([\d½¼¾⅓⅔⅛⅜⅝⅞\/\. ]+)/, match => {
    const num = parseFraction(match.trim());
    if (isNaN(num)) return match;
    const scaled = num * ratio;
    return formatNum(scaled) + " ";
  });
}

function parseFraction(s) {
  const unicodeMap = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1/3, "⅔": 2/3, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
  for (const [ch, val] of Object.entries(unicodeMap)) {
    if (s.includes(ch)) {
      const base = parseFloat(s.replace(ch, "").trim()) || 0;
      return base + val;
    }
  }
  if (s.includes("/")) {
    const parts = s.split("/");
    return parseFloat(parts[0]) / parseFloat(parts[1]);
  }
  return parseFloat(s);
}

function formatNum(n) {
  if (n === Math.round(n)) return String(Math.round(n));
  return Math.round(n * 10) / 10;
}

function adjustServings(delta) {
  const next = Math.max(1, state.currentServings + delta);
  state.currentServings = next;
  $("servings-display").textContent = next;
  renderIngredients(state.currentRecipe.ingredients, next, state.baseServings);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------
async function deleteRecipe(id) {
  if (!confirm("Delete this recipe?")) return;
  try {
    await apiDeleteRecipe(id);
    state.recipes = state.recipes.filter(r => r.id !== id);

    // Remove from meal plan too
    for (const day of Object.keys(state.mealPlan)) {
      state.mealPlan[day] = (state.mealPlan[day] || []).filter(rid => rid !== id);
    }
    saveMealPlan();

    renderRecipes();
    toast("Recipe deleted");
  } catch (err) {
    toast("Delete failed", "error");
  }
}

// ---------------------------------------------------------------------------
// Meal Plan
// ---------------------------------------------------------------------------
function renderMealPlan() {
  const grid = $("day-grid");
  grid.innerHTML = DAYS.map((day, i) => {
    const dayKey = `day${i}`;
    const recipeIds = state.mealPlan[dayKey] || [];
    const chips = recipeIds.map(rid => {
      const r = state.recipes.find(x => x.id === rid);
      if (!r) return "";
      return `<div class="day-recipe-chip" data-day="${dayKey}" data-rid="${rid}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(r.title)}</span>
        <button class="chip-remove" data-day="${dayKey}" data-rid="${rid}" title="Remove">×</button>
      </div>`;
    }).join("");

    return `<div class="day-card">
      <div class="day-header">${day}</div>
      <div class="day-body" id="day-body-${i}">
        ${chips}
        <button class="day-add-btn" data-day="${dayKey}">＋</button>
      </div>
    </div>`;
  }).join("");

  grid.querySelectorAll(".day-add-btn").forEach(btn => {
    btn.addEventListener("click", () => openRecipePicker(btn.dataset.day));
  });

  grid.querySelectorAll(".chip-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const { day, rid } = btn.dataset;
      state.mealPlan[day] = (state.mealPlan[day] || []).filter(id => id !== rid);
      saveMealPlan();
      renderMealPlan();
    });
  });

  $("people-display").textContent = state.people;

  renderSavedWeeks();
}

function promptAddToDay(recipe) {
  const day = prompt(`Add "${recipe.title}" to which day?\n${DAYS.map((d, i) => `${i}: ${d}`).join("\n")}`);
  if (day === null) return;
  const idx = parseInt(day, 10);
  if (isNaN(idx) || idx < 0 || idx > 6) { toast("Invalid day", "error"); return; }
  const dayKey = `day${idx}`;
  if (!state.mealPlan[dayKey]) state.mealPlan[dayKey] = [];
  if (!state.mealPlan[dayKey].includes(recipe.id)) {
    state.mealPlan[dayKey].push(recipe.id);
    saveMealPlan();
    toast(`Added to ${DAYS[idx]}!`);
  } else {
    toast("Already in that day");
  }
  closeModal();
  showView("mealplan");
}

// Recipe Picker (for + button on day card)
function openRecipePicker(dayKey) {
  const modal = $("picker-modal");
  const list  = $("picker-list");

  if (state.recipes.length === 0) {
    toast("No recipes saved yet", "error");
    return;
  }

  list.innerHTML = state.recipes.map(r => {
    const thumb = r.image
      ? `<img src="${escHtml(r.image)}" alt="" onerror="this.parentElement.innerHTML='🍽️'">`
      : "🍽️";
    return `<div class="picker-item" data-id="${r.id}">
      <div class="picker-thumb">${thumb}</div>
      <div class="picker-item-name">${escHtml(r.title)}</div>
    </div>`;
  }).join("");

  list.querySelectorAll(".picker-item").forEach(item => {
    item.addEventListener("click", () => {
      const rid = item.dataset.id;
      if (!state.mealPlan[dayKey]) state.mealPlan[dayKey] = [];
      if (!state.mealPlan[dayKey].includes(rid)) {
        state.mealPlan[dayKey].push(rid);
        saveMealPlan();
        toast("Recipe added!");
      }
      modal.classList.remove("open");
      document.body.style.overflow = "";
      renderMealPlan();
    });
  });

  modal.classList.add("open");
  document.body.style.overflow = "hidden";
}

// ---------------------------------------------------------------------------
// Meal Plan — Save / Clear week
// ---------------------------------------------------------------------------
async function handleSaveWeek() {
  const hasAny = Object.values(state.mealPlan).some(arr => arr && arr.length > 0);
  if (!hasAny) { toast("Nothing in the meal plan to save", "error"); return; }

  const today = new Date();
  const defaultName = `Week of ${today.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
  const name = prompt("Name for this week:", defaultName);
  if (name === null) return; // cancelled

  try {
    const saved = await apiSavePlan({
      name: name.trim() || defaultName,
      plan: state.mealPlan,
      people: state.people,
    });
    state.savedPlans.push(saved);
    renderSavedWeeks();
    toast(`Week saved: "${saved.name}"`, "success");
  } catch (err) {
    toast("Save failed", "error");
  }
}

function handleClearWeek() {
  const hasAny = Object.values(state.mealPlan).some(arr => arr && arr.length > 0);
  if (!hasAny) { toast("Meal plan is already empty"); return; }
  if (!confirm("Clear the entire meal plan?")) return;
  state.mealPlan = {};
  saveMealPlan();
  renderMealPlan();
  toast("Meal plan cleared");
}

// ---------------------------------------------------------------------------
// Saved Weeks
// ---------------------------------------------------------------------------
function renderSavedWeeks() {
  const listEl = $("saved-weeks-list");
  const arrow = $("toggle-arrow");

  // Keep open/closed state
  listEl.style.display = state.savedWeeksOpen ? "" : "none";
  arrow.classList.toggle("open", state.savedWeeksOpen);

  if (!state.savedPlans.length) {
    listEl.innerHTML = `<div class="saved-weeks-empty">No saved weeks yet.</div>`;
    return;
  }

  listEl.innerHTML = state.savedPlans.map(p => `
    <div class="saved-week-row" data-plan-id="${escHtml(p.id)}">
      <div class="saved-week-info">
        <div class="saved-week-name">${escHtml(p.name)}</div>
        <div class="saved-week-date">${formatDate(p.created_at)}</div>
      </div>
      <div class="saved-week-actions">
        <button class="btn btn-secondary btn-sm load-plan-btn" data-plan-id="${escHtml(p.id)}">Load</button>
        <button class="btn btn-danger btn-sm delete-plan-btn" data-plan-id="${escHtml(p.id)}" title="Delete">×</button>
      </div>
    </div>`).join("");

  listEl.querySelectorAll(".load-plan-btn").forEach(btn => {
    btn.addEventListener("click", () => loadSavedPlan(btn.dataset.planId));
  });

  listEl.querySelectorAll(".delete-plan-btn").forEach(btn => {
    btn.addEventListener("click", () => deleteSavedPlan(btn.dataset.planId));
  });
}

function loadSavedPlan(planId) {
  const plan = state.savedPlans.find(p => p.id === planId);
  if (!plan) return;

  const hasAny = Object.values(state.mealPlan).some(arr => arr && arr.length > 0);
  if (hasAny && !confirm(`Load "${plan.name}"? This will replace your current meal plan.`)) return;

  state.mealPlan = { ...(plan.plan || {}) };
  saveMealPlan();
  renderMealPlan();
  toast(`Loaded: "${plan.name}"`);
}

async function deleteSavedPlan(planId) {
  const plan = state.savedPlans.find(p => p.id === planId);
  if (!plan) return;
  if (!confirm(`Delete saved week "${plan.name}"?`)) return;

  try {
    await apiDeletePlan(planId);
    state.savedPlans = state.savedPlans.filter(p => p.id !== planId);
    renderSavedWeeks();
    toast("Saved week deleted");
  } catch (err) {
    toast("Delete failed", "error");
  }
}

// ---------------------------------------------------------------------------
// Shopping List
// ---------------------------------------------------------------------------
function renderShoppingList() {
  const panel = $("shopping-list-panel");

  const allIds = Object.values(state.mealPlan).flat();
  if (allIds.length === 0) {
    panel.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:60px 0">
      <div style="font-size:2.5rem;margin-bottom:12px">🛒</div>
      <p>Add recipes to your meal plan first,<br>then generate the shopping list here.</p>
    </div>`;
    return;
  }

  const categorised = { Produce: [], Dairy: [], Meat: [], Pantry: [], Other: [] };

  const seen = new Set();
  for (const rid of allIds) {
    if (seen.has(rid)) continue;
    seen.add(rid);
    const recipe = state.recipes.find(r => r.id === rid);
    if (!recipe) continue;
    const ratio = state.people / (recipe.servings || 1);
    for (const ing of recipe.ingredients || []) {
      const scaled = scaleIngredient(ing, ratio);
      const cat = categoriseIngredient(scaled);
      categorised[cat].push({ text: scaled, id: `item-${Math.random().toString(36).slice(2)}` });
    }
  }

  const hasItems = Object.values(categorised).some(arr => arr.length > 0);
  if (!hasItems) {
    panel.innerHTML = `<div style="text-align:center;color:var(--text-muted);padding:40px 0">No ingredients found.</div>`;
    return;
  }

  let html = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
    <h2 style="font-size:1.2rem">Shopping List</h2>
    <div style="display:flex;gap:8px">
      <button class="btn btn-secondary btn-sm" id="copy-list-btn">📋 Copy</button>
      <button class="btn btn-secondary btn-sm" id="share-list-inline-btn">📤 Share</button>
    </div>
  </div>`;

  for (const [cat, items] of Object.entries(categorised)) {
    if (!items.length) continue;
    html += `<div class="category-section">
      <div class="category-title">${cat}</div>
      ${items.map(item => `
        <div class="shopping-item">
          <input type="checkbox" id="${item.id}">
          <label for="${item.id}">${escHtml(item.text)}</label>
        </div>`).join("")}
    </div>`;
  }

  panel.innerHTML = html;

  $("copy-list-btn").addEventListener("click", copyShoppingList);
  $("share-list-inline-btn").addEventListener("click", shareShoppingList);
}

function buildShoppingListText() {
  const sections = document.querySelectorAll(".category-section");
  const lines = ["🛒 Shopping List", ""];
  sections.forEach(sec => {
    const title = sec.querySelector(".category-title")?.textContent;
    const items = Array.from(sec.querySelectorAll(".shopping-item label")).map(l => "• " + l.textContent);
    if (items.length) {
      lines.push(title.toUpperCase());
      lines.push(...items);
      lines.push("");
    }
  });
  return lines.join("\n").trim();
}

function copyShoppingList() {
  const text = buildShoppingListText();
  navigator.clipboard.writeText(text)
    .then(() => toast("Copied to clipboard!"))
    .catch(() => toast("Copy failed", "error"));
}

async function shareShoppingList() {
  const text = buildShoppingListText();
  if (navigator.share) {
    try {
      await navigator.share({ title: "Shopping List", text });
    } catch (e) {
      if (e.name !== "AbortError") toast("Share failed", "error");
    }
  } else {
    // Fallback: copy to clipboard
    navigator.clipboard.writeText(text)
      .then(() => toast("Copied to clipboard!"))
      .catch(() => toast("Copy failed", "error"));
  }
}



// ---------------------------------------------------------------------------
// Favourites
// ---------------------------------------------------------------------------
async function toggleFavourite(id) {
  const recipe = state.recipes.find(r => r.id === id);
  if (!recipe) return;
  const updated = await apiUpdateRecipe(id, { favourite: !recipe.favourite });
  const idx = state.recipes.findIndex(r => r.id === id);
  if (idx !== -1) state.recipes[idx] = updated;
  if (state.currentRecipe?.id === id) state.currentRecipe = updated;
  renderRecipes();
}

// ---------------------------------------------------------------------------
// Create from scratch
// ---------------------------------------------------------------------------
function openCreateModal() {
  openPreviewModal({
    title: "", description: "", image: "", ingredients: [], instructions: [],
    prepTime: "", cookTime: "", servings: null, tags: [], source_url: "",
  });
}

// ---------------------------------------------------------------------------
// Cook Mode
// ---------------------------------------------------------------------------
const cookState = { recipe: null, step: 0, wakeLock: null, timers: {} };

function openCookMode(recipe) {
  if (!recipe.instructions?.length) { toast("No instructions to cook through.", "error"); return; }
  cookState.recipe = recipe;
  cookState.step = 0;
  cookState.timers = {};
  $("cook-title").textContent = recipe.title;
  showCookStep(0);
  $("cook-mode").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  if ("wakeLock" in navigator) {
    navigator.wakeLock.request("screen").then(wl => { cookState.wakeLock = wl; }).catch(() => {});
  }
}

function closeCookMode() {
  $("cook-mode").classList.add("hidden");
  document.body.style.overflow = "";
  if (cookState.wakeLock) { cookState.wakeLock.release(); cookState.wakeLock = null; }
  Object.values(cookState.timers).forEach(t => { if (t.interval) clearInterval(t.interval); });
  cookState.timers = {};
}

function showCookStep(index) {
  const steps = cookState.recipe.instructions || [];
  const total = steps.length;
  cookState.step = index;
  $("cook-progress").textContent = `${index + 1} / ${total}`;
  $("cook-step-number").textContent = `Step ${index + 1}`;
  $("cook-step-text").textContent = steps[index];
  renderCookTimers(steps[index], index);
  $("cook-prev-btn").disabled = index === 0;
  $("cook-next-btn").textContent = index === total - 1 ? "Done ✓" : "Next →";
}

// ---------------------------------------------------------------------------
// Cook Mode Timers
// ---------------------------------------------------------------------------
function parseTimers(text) {
  const results = [];
  const seen = new Set();
  const patterns = [
    { re: /(\d+)\s*h(?:ou?r?s?)?\s*(?:and\s*)?(\d+)\s*min(?:ute)?s?/gi, secs: m => +m[1]*3600 + +m[2]*60, label: m => `${m[1]}h ${m[2]}m` },
    { re: /(\d+)\s*h(?:ou?r?s?)?/gi,    secs: m => +m[1]*3600, label: m => `${m[1]}h` },
    { re: /(\d+)\s*min(?:ute)?s?/gi,    secs: m => +m[1]*60,   label: m => `${m[1]} min` },
    { re: /(\d+)\s*sec(?:ond)?s?/gi,    secs: m => +m[1],      label: m => `${m[1]}s` },
  ];
  for (const { re, secs, label } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const s = secs(m);
      if (s > 0 && !seen.has(m[0].toLowerCase())) {
        seen.add(m[0].toLowerCase());
        results.push({ seconds: s, label: label(m) });
      }
    }
  }
  return results;
}

function formatTime(secs) {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function renderCookTimers(stepText, stepIndex) {
  const area = $("cook-timer-area");
  const durations = parseTimers(stepText);
  if (!durations.length) { area.innerHTML = ""; return; }
  area.innerHTML = durations.map((d, i) => {
    const key = `${stepIndex}-${i}`;
    const t = cookState.timers[key];
    if (t && t.running) {
      return `<div class="cook-timer running">
        <span class="cook-timer-display">⏱ ${formatTime(t.remaining)}</span>
        <button class="cook-timer-stop" onclick="stopCookTimer('${key}')">■ Stop</button>
      </div>`;
    }
    return `<button class="cook-timer-start" onclick="startCookTimer('${key}',${d.seconds},'${escHtml(d.label)}')">⏱ Start ${d.label} timer</button>`;
  }).join("");
}

function startCookTimer(key, seconds, label) {
  if (cookState.timers[key]?.interval) clearInterval(cookState.timers[key].interval);
  cookState.timers[key] = { running: true, remaining: seconds, label, interval: null };
  cookState.timers[key].interval = setInterval(() => {
    cookState.timers[key].remaining--;
    if (cookState.timers[key].remaining <= 0) {
      clearInterval(cookState.timers[key].interval);
      cookState.timers[key].running = false;
      toast(`⏱ Timer done: ${label}`, "success");
    }
    const stepIndex = parseInt(key.split("-")[0], 10);
    if (cookState.step === stepIndex) renderCookTimers(cookState.recipe.instructions[stepIndex], stepIndex);
  }, 1000);
  renderCookTimers(cookState.recipe.instructions[cookState.step], cookState.step);
}

function stopCookTimer(key) {
  if (cookState.timers[key]?.interval) clearInterval(cookState.timers[key].interval);
  if (cookState.timers[key]) cookState.timers[key].running = false;
  const stepIndex = parseInt(key.split("-")[0], 10);
  renderCookTimers(cookState.recipe.instructions[stepIndex], stepIndex);
}

async function loadApp() {
  try {
    state.recipes = await apiGetRecipes();
  } catch (e) {
    console.error(e);
    state.recipes = [];
  }
  try {
    state.savedPlans = await apiGetPlans();
  } catch (e) {
    console.error(e);
    state.savedPlans = [];
  }
  renderRecipes();
  showView("recipes");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  try { await loadApp(); } catch(e) { console.warn("loadApp failed:", e); }
  initSearchFilter();

  // Handle ?import= from Recipe Scanner
  const importParam = new URLSearchParams(window.location.search).get("import");
  if (importParam) {
    try {
      const recipe = JSON.parse(decodeURIComponent(escape(atob(importParam))));
      history.replaceState(null, "", "/");
      setTimeout(() => openPreviewModal(recipe), 300);
    } catch (e) { /* ignore malformed param */ }
  }

  // Home button
  $("home-btn").addEventListener("click", () => showView("recipes"));

  // Nav
  document.querySelectorAll(".nav-links a").forEach(a => {
    a.addEventListener("click", e => {
      e.preventDefault();
      showView(a.dataset.view);
    });
  });

  // Import
  $("import-btn").addEventListener("click", handleImport);
  $("import-url").addEventListener("keydown", e => { if (e.key === "Enter") handleImport(); });
  $("import-photo-btn").addEventListener("click", () => $("import-image-input").click());
  $("import-image-input").addEventListener("change", handleImageImport);

  // Recipe modal close
  $("modal-close").addEventListener("click", closeModal);
  $("recipe-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Recipe modal edit button
  $("modal-edit-btn").addEventListener("click", showEditMode);

  // Edit mode save / cancel
  $("edit-save-btn").addEventListener("click", handleEditSave);
  $("edit-cancel-btn").addEventListener("click", () => {
    showViewMode();
    fillModal(state.currentRecipe);
  });

  // Preview modal
  $("preview-close").addEventListener("click", closePreviewModal);
  $("preview-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) closePreviewModal();
  });
  $("preview-save-btn").addEventListener("click", handlePreviewSave);
  $("preview-discard-btn").addEventListener("click", closePreviewModal);

  // Picker modal close
  $("picker-close").addEventListener("click", () => {
    $("picker-modal").classList.remove("open");
    document.body.style.overflow = "";
  });
  $("picker-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) {
      $("picker-modal").classList.remove("open");
      document.body.style.overflow = "";
    }
  });

  // People controls
  $("people-minus").addEventListener("click", () => {
    state.people = Math.max(1, state.people - 1);
    savePeople();
    $("people-display").textContent = state.people;
  });

  $("people-plus").addEventListener("click", () => {
    state.people = state.people + 1;
    savePeople();
    $("people-display").textContent = state.people;
  });

  // Generate shopping list button
  $("gen-shopping-btn").addEventListener("click", () => showView("shopping"));

  // Multi-picker modal close
  $("multi-picker-close").addEventListener("click", closeMultiPicker);
  $("multi-picker-modal").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeMultiPicker();
  });

  // Meal plan week controls
  $("save-week-btn").addEventListener("click", handleSaveWeek);
  $("clear-week-btn").addEventListener("click", handleClearWeek);

  // Saved weeks toggle
  $("saved-weeks-toggle").addEventListener("click", () => {
    state.savedWeeksOpen = !state.savedWeeksOpen;
    renderSavedWeeks();
  });

  // Share list button
  $("share-list-btn").addEventListener("click", shareShoppingList);

  // Create from scratch
  $("create-btn").addEventListener("click", openCreateModal);

  // Cook mode
  $("cook-mode-btn").addEventListener("click", () => openCookMode(state.currentRecipe));
  $("cook-close-btn").addEventListener("click", closeCookMode);
  $("cook-prev-btn").addEventListener("click", () => showCookStep(cookState.step - 1));
  $("cook-next-btn").addEventListener("click", () => {
    const total = cookState.recipe?.instructions?.length || 0;
    if (cookState.step >= total - 1) closeCookMode();
    else showCookStep(cookState.step + 1);
  });
}

document.addEventListener("DOMContentLoaded", init);

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
