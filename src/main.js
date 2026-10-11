// Panel UI wiring.

const { entrypoints } = require("uxp");
const { app, core } = require("photoshop");
const builder = require("./src/builder.js");
const profiles = require("./src/profiles.js");

const STATE_FILE = "state.json";
const STYLE_KEYS = ["sizePct", "bodyScale", "wrapWidth", "radiusPct", "tilt"];

const $ = (id) => document.getElementById(id);

let savedProfiles = [];
let currentAvatar = null; // file name in the avatars folder
let selectedTweet = null; // { docId, layerId } of the selected card, if any
let busy = false; // true while an insert/update is running

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

entrypoints.setup({ panels: { tweetBuilderPanel: { show() {} } } });

// Fields with a placeholder render code-set values in placeholder style (a UXP
// quirk), so fields filled from code have labels instead of placeholders.
function setField(id, value) {
  $(id).value = value;
}

function setStatus(id, message, isError = false) {
  const el = $(id);
  el.textContent = message || "";
  el.className = isError ? "status error" : "status";
}

// ---------------------------------------------------------------- profile

async function showAvatar(name) {
  currentAvatar = name || null;
  const url = name ? await profiles.avatarDataUrl(name) : null;
  if (url) $("avatarImg").setAttribute("src", url);
  else $("avatarImg").removeAttribute("src");
}

async function applyProfile(p) {
  setField("nameInput", p.name || "");
  setField("handleInput", p.handle || "");
  $("verifiedInput").checked = !!p.verified;
  await showAvatar(p.avatar);
}

function currentProfile() {
  return {
    name: $("nameInput").value.trim(),
    handle: $("handleInput").value.trim().replace(/^@/, ""),
    verified: $("verifiedInput").checked,
    avatar: currentAvatar,
  };
}

function renderProfileMenu(selectedHandle) {
  const menu = $("profileMenu");
  while (menu.firstChild) menu.removeChild(menu.firstChild);
  savedProfiles.forEach((p, i) => {
    const item = document.createElement("sp-menu-item");
    item.textContent = `${p.name} (@${p.handle})`;
    if (selectedHandle && p.handle.toLowerCase() === selectedHandle.toLowerCase()) item.setAttribute("selected", "");
    menu.appendChild(item);
  });
}

async function onLookup() {
  const input = $("lookupInput").value;
  $("lookupBtn").disabled = true;
  setStatus("lookupStatus", "Fetching…");
  try {
    const { profile, tweet, note } = await profiles.lookup(input);
    await applyProfile(profile);
    if (tweet) {
      setField("textInput", tweet.text);
      setField("repliesInput", String(tweet.replies ?? ""));
      setField("retweetsInput", String(tweet.retweets ?? ""));
      setField("likesInput", String(tweet.likes ?? ""));
    }
    savedProfiles = await profiles.saveProfile(profile);
    renderProfileMenu(profile.handle);
    setStatus("lookupStatus", note || `Loaded @${profile.handle}${tweet ? " and the tweet" : ""}. Saved to profiles.`);
  } catch (e) {
    setStatus("lookupStatus", e.message, true);
  } finally {
    $("lookupBtn").disabled = false;
  }
}

async function onPickProfile() {
  const p = savedProfiles[$("profilePicker").selectedIndex];
  if (p) await applyProfile(p);
}

async function onSaveProfile() {
  const p = currentProfile();
  if (!p.handle) return setStatus("lookupStatus", "A handle is needed to save a profile.", true);
  savedProfiles = await profiles.saveProfile(p);
  renderProfileMenu(p.handle);
  setStatus("lookupStatus", `Saved @${p.handle}.`);
}

async function onDeleteProfile() {
  const p = savedProfiles[$("profilePicker").selectedIndex];
  if (!p) return;
  savedProfiles = await profiles.deleteProfile(p.handle);
  renderProfileMenu();
  setStatus("lookupStatus", `Removed @${p.handle} from saved profiles.`);
}

async function onChangeAvatar() {
  try {
    const name = await profiles.pickAvatar(currentProfile().handle);
    if (name) {
      await showAvatar(name);
      saveStateSoon();
    }
  } catch (e) {
    setStatus("lookupStatus", e.message, true);
  }
}

// ---------------------------------------------------------------- tweet + style

function readStyle() {
  const style = { shadow: $("shadow").checked };
  for (const key of STYLE_KEYS) style[key] = Number($(key).value);
  return style;
}

function writeStyle(style) {
  const s = { ...builder.DEFAULT_STYLE, ...style };
  for (const key of STYLE_KEYS) $(key).value = s[key];
  $("shadow").checked = !!s.shadow;
}

function collectSpec() {
  return {
    profile: currentProfile(),
    text: $("textInput").value,
    time: $("timeInput").value,
    counts: {
      replies: $("repliesInput").value,
      retweets: $("retweetsInput").value,
      likes: $("likesInput").value,
    },
    style: readStyle(),
  };
}

async function saveState() {
  await profiles.writeJSON(STATE_FILE, collectSpec());
}

const saveStateSoon = debounce(() => saveState().catch((e) => console.error(e)), 600);

// Fill every field from a spec (saved state or a selected card).
async function applySpec(spec) {
  await applyProfile(spec.profile || {});
  setField("textInput", spec.text || "");
  setField("timeInput", spec.time ?? "1m");
  setField("repliesInput", spec.counts?.replies ?? "");
  setField("retweetsInput", spec.counts?.retweets ?? "");
  setField("likesInput", spec.counts?.likes ?? "");
  writeStyle(spec.style || {});
}

async function restoreState() {
  const state = await profiles.readJSON(STATE_FILE, null);
  if (state) await applySpec(state);
  else writeStyle({});
}

// ---------------------------------------------------------------- selection

// Photoshop doesn't reliably notify plugins of layer selection changes (none
// arrive for scripted selections), so poll the selection instead. The check
// is a couple of DOM reads; the layer metadata is only read when it changes.
function selectionKey() {
  try {
    const layer = selectedLayer();
    return layer ? `${layer.document.id}:${layer.id}` : "";
  } catch (e) {
    return "";
  }
}

function watchSelection() {
  let lastKey = selectionKey();
  setInterval(() => {
    if (busy) return;
    const key = selectionKey();
    if (key === lastKey) return;
    lastKey = key;
    refreshSelection().catch((e) => console.error(e));
  }, 500);
}

function selectedLayer() {
  if (!app.documents.length) return null;
  const layers = app.activeDocument.activeLayers;
  return layers.length === 1 ? layers[0] : null;
}

// Track whether a card made by this plugin is selected. When a different card
// becomes selected, load its settings into the panel.
async function refreshSelection({ quiet = false } = {}) {
  if (busy) return;
  let layer = null;
  let spec = null;
  try {
    layer = selectedLayer();
    spec = layer ? await builder.readSpec(layer) : null;
  } catch (e) {
    spec = null;
  }
  if (!spec) {
    if (selectedTweet && $("insertStatus").textContent.startsWith("Loaded")) setStatus("insertStatus", "");
    selectedTweet = null;
    $("updateBtn").disabled = true;
    return;
  }
  $("updateBtn").disabled = false;
  const key = { docId: layer.document.id, layerId: layer.id };
  if (selectedTweet && selectedTweet.docId === key.docId && selectedTweet.layerId === key.layerId) return;
  selectedTweet = key;
  if (quiet) return;
  await applySpec(spec);
  renderProfileMenu(spec.profile?.handle);
  setStatus("lookupStatus", "");
  const avatarMissing = spec.profile?.avatar && !(await profiles.getAvatarEntry(spec.profile.avatar));
  setStatus(
    "insertStatus",
    avatarMissing
      ? `Loaded "${layer.name}", but its avatar image isn't on this computer. Fetch the profile again before updating.`
      : `Loaded "${layer.name}". Edit it, then click Update selected.`,
    !!avatarMissing
  );
}

async function insert(spec, log) {
  return core.executeAsModal((ctx) => builder.insertTweet(spec, ctx, log), { commandName: "Insert Tweet" });
}

async function update(spec, log) {
  const layer = selectedLayer();
  return core.executeAsModal((ctx) => builder.updateTweet(layer, spec, ctx, log), { commandName: "Update Tweet" });
}

async function onInsert() {
  const spec = collectSpec();
  if (!app.documents.length) return setStatus("insertStatus", "Open a document first.", true);
  if (!spec.text.trim()) return setStatus("insertStatus", "Write the tweet text first.", true);
  await runBuild("Building…", "Inserted", () => insert(spec, (m) => console.warn(m)));
}

async function onUpdate() {
  const spec = collectSpec();
  if (!spec.text.trim()) return setStatus("insertStatus", "Write the tweet text first.", true);
  await runBuild("Updating…", "Updated", () => update(spec, (m) => console.warn(m)));
}

async function runBuild(progress, done, fn) {
  busy = true;
  $("insertBtn").disabled = true;
  $("updateBtn").disabled = true;
  setStatus("insertStatus", progress);
  const t0 = Date.now();
  let ok = false;
  try {
    await fn();
    ok = true;
    await saveState();
  } catch (e) {
    console.error(e);
    setStatus("insertStatus", e.message || String(e), true);
  } finally {
    busy = false;
    $("insertBtn").disabled = false;
    // The finished card is selected; track it without reloading the fields.
    await refreshSelection({ quiet: true });
  }
  if (ok) setStatus("insertStatus", `${done} in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
}

function setStyleOpen(open) {
  $("styleBody").className = open ? "style-body open" : "style-body";
  $("styleToggle").textContent = open ? "Style ▾" : "Style ▸";
  try {
    localStorage.setItem("styleOpen", open ? "1" : "0");
  } catch (e) {
    // per-viewer convenience only
  }
}

function onRandomTilt() {
  const magnitude = 3 + Math.random() * 5;
  $("tilt").value = Math.round((Math.random() < 0.5 ? -magnitude : magnitude) * 2) / 2;
}

// ---------------------------------------------------------------- init

async function init() {
  $("lookupBtn").addEventListener("click", onLookup);
  $("lookupInput").addEventListener("keydown", (e) => { if (e.key === "Enter") onLookup(); });
  $("profilePicker").addEventListener("change", onPickProfile);
  $("saveProfileBtn").addEventListener("click", onSaveProfile);
  $("deleteProfileBtn").addEventListener("click", onDeleteProfile);
  $("avatarBtn").addEventListener("click", onChangeAvatar);
  $("resetStyleBtn").addEventListener("click", () => writeStyle({}));
  $("styleToggle").addEventListener("click", () => setStyleOpen(!$("styleBody").className.includes("open")));
  $("randomTiltBtn").addEventListener("click", onRandomTilt);
  $("insertBtn").addEventListener("click", onInsert);
  $("updateBtn").addEventListener("click", onUpdate);

  // Remember the last-used values as they change, not only after an insert.
  for (const id of ["nameInput", "handleInput", "textInput", "timeInput", "repliesInput", "retweetsInput", "likesInput", ...STYLE_KEYS]) {
    $(id).addEventListener("input", saveStateSoon);
    $(id).addEventListener("change", saveStateSoon);
  }
  for (const id of ["verifiedInput", "shadow"]) $(id).addEventListener("change", saveStateSoon);
  $("profilePicker").addEventListener("change", saveStateSoon);

  let styleOpen = false;
  try {
    styleOpen = localStorage.getItem("styleOpen") === "1";
  } catch (e) {
    // ignore
  }
  setStyleOpen(styleOpen);

  savedProfiles = await profiles.loadProfiles();
  renderProfileMenu();
  await restoreState();

  await refreshSelection();
  watchSelection();

  require("./src/dev.js").start({ insert, update, refreshSelection, getSelectedTweet: () => selectedTweet });
}

init().catch((e) => console.error(e));
