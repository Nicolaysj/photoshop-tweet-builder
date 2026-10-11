// Builds a tweet card from native Photoshop layers and drops it into the active
// document as a single smart object, or rebuilds the contents of a card made
// earlier. Must run inside core.executeAsModal.
//
// The card is assembled in a temporary 72 ppi document so point sizes equal
// pixels and the target document's resolution, colour mode and layer state
// can't interfere. Layout is expressed in "p" units: 1p = one CSS pixel of
// X's web layout, scaled so the name font (15p) is `base` pixels tall.

const { app, action, constants } = require("photoshop");
const { storage } = require("uxp");
const profiles = require("./profiles.js");

const lfs = storage.localFileSystem;

const COLORS = {
  text: [15, 20, 25],
  muted: [83, 100, 113],
  card: [255, 255, 255],
  avatarPlaceholder: [207, 217, 222],
};

const FONTS = { regular: "SegoeUI", bold: "SegoeUI-Bold" };

// Defaults mirror a typical hand-made YouTube-thumbnail tweet card.
const DEFAULT_STYLE = {
  sizePct: 100,     // 100% = name font at 2.5% of document width (~95px on 4K)
  bodyScale: 1.7,   // body text size relative to the header
  wrapWidth: 24,    // max body line width, in multiples of the name font size
  radiusPct: 17,    // corner radius as % of card height
  shadow: true,
  tilt: 0,          // degrees, negative = counter-clockwise
};

const SHADOW_REF_BASE = 95; // base size the reference shadow values were taken at

const px = (v) => ({ _unit: "pixelsUnit", _value: v });
const rgbDesc = ([r, g, b]) => ({ _obj: "RGBColor", red: r, grain: g, blue: b });

function solid([r, g, b]) {
  const c = new app.SolidColor();
  c.rgb.red = r;
  c.rgb.green = g;
  c.rgb.blue = b;
  return c;
}

async function bp(descriptors) {
  const list = Array.isArray(descriptors) ? descriptors : [descriptors];
  const results = await action.batchPlay(list, {});
  for (const r of results) {
    if (r && r._obj === "error") throw new Error(r.message || `batchPlay failed (${r.result})`);
  }
  return results;
}

function boundsOf(layer) {
  const b = layer.boundsNoEffects;
  return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.right - b.left, height: b.bottom - b.top };
}

// Last build step started; appended to errors so failures say where they happened.
let stage = "";
const at = (name) => { stage = name; };

function isOpen(doc) {
  for (let i = 0; i < app.documents.length; i++) {
    if (app.documents[i].id === doc.id) return true;
  }
  return false;
}

function activeLayer() {
  return app.activeDocument.activeLayers[0];
}

async function selectLayer(layer) {
  await bp({ _obj: "select", _target: [{ _ref: "layer", _id: layer.id }], makeVisible: false });
}

// ---------------------------------------------------------------- primitives

async function addText(doc, { text, font, size, color, x, baseline, name }) {
  const layer = await doc.createTextLayer({
    contents: text,
    fontName: font,
    fontSize: size,
    position: { x, y: baseline },
    textColor: solid(color),
  });
  if (name) layer.name = name;
  return layer;
}

async function setLeading(layer, leading) {
  const style = layer.textItem.characterStyle;
  style.autoLeading = false;
  style.leading = leading;
}

async function addRoundedRect({ left, top, right, bottom, radius, color, name }) {
  await bp({
    _obj: "make",
    _target: [{ _ref: "contentLayer" }],
    using: {
      _obj: "contentLayer",
      type: { _obj: "solidColorLayer", color: rgbDesc(color) },
      shape: {
        _obj: "rectangle",
        unitValueQuadVersion: 1,
        top: px(top), left: px(left), bottom: px(bottom), right: px(right),
        topLeft: px(radius), topRight: px(radius), bottomLeft: px(radius), bottomRight: px(radius),
      },
    },
  });
  const layer = activeLayer();
  if (name) layer.name = name;
  return layer;
}

async function addEllipse({ left, top, size, color, name }) {
  await bp({
    _obj: "make",
    _target: [{ _ref: "contentLayer" }],
    using: {
      _obj: "contentLayer",
      type: { _obj: "solidColorLayer", color: rgbDesc(color) },
      shape: { _obj: "ellipse", unitValueQuadVersion: 1, top: px(top), left: px(left), bottom: px(top + size), right: px(left + size) },
    },
  });
  const layer = activeLayer();
  if (name) layer.name = name;
  return layer;
}

// Full (untrimmed) box of a placed smart object, so icons line up by their
// 24x24 viewBox rather than by their visible pixels.
async function smartObjectBox(layer) {
  try {
    const r = await bp({ _obj: "get", _target: [{ _property: "smartObjectMore" }, { _ref: "layer", _id: layer.id }] });
    const t = r[0].smartObjectMore.transform;
    const xs = [t[0], t[2], t[4], t[6]];
    const ys = [t[1], t[3], t[5], t[7]];
    const left = Math.min(...xs), top = Math.min(...ys);
    return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
  } catch (e) {
    const b = boundsOf(layer);
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  }
}

async function placeFile(entry, name) {
  const token = await lfs.createSessionToken(entry);
  await bp({
    _obj: "placeEvent",
    null: { _path: token, _kind: "local" },
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    offset: { _obj: "offset", horizontal: px(0), vertical: px(0) },
    _options: { dialogOptions: "dontDisplay" },
  });
  const layer = activeLayer();
  if (name) layer.name = name;
  return layer;
}

// Scale a placed smart object so its box is `size` px square, with its
// top-left corner at (left, top).
async function fitBox(layer, { left, top, size }) {
  let box = await smartObjectBox(layer);
  const pct = (size / Math.max(box.width, box.height)) * 100;
  await layer.scale(pct, pct, constants.AnchorPosition.TOPLEFT);
  box = await smartObjectBox(layer);
  await layer.translate(left - box.left, top - box.top);
}

async function placeIcon(name, box) {
  const folder = await lfs.getPluginFolder();
  const entry = await folder.getEntry(`assets/icons/${name}.svg`);
  const layer = await placeFile(entry, name);
  await fitBox(layer, box);
  return layer;
}

// ---------------------------------------------------------------- text utils

function formatCount(value) {
  if (value === undefined || value === null) return "";
  const raw = String(value).trim();
  if (!raw || raw === "0") return "";
  const plain = raw.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(plain)) return raw; // already formatted, e.g. "2.4K"
  const n = Number(plain);
  const short = (x) => String(Math.floor(x * 10) / 10);
  if (n >= 1e9) return short(n / 1e9) + "B";
  if (n >= 1e6) return short(n / 1e6) + "M";
  if (n >= 1e3) return short(n / 1e3) + "K";
  return String(n);
}

// Greedy word wrap, measured with a scratch text layer in the real font.
async function wrapText(doc, text, font, size, maxWidth) {
  const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
  const scratch = await addText(doc, { text: "x", font, size, color: COLORS.text, x: 0, baseline: size * 2 });
  const measure = (s) => {
    scratch.textItem.contents = s;
    return boundsOf(scratch).width;
  };
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/ +/).filter((w) => w.length);
    if (!words.length) { lines.push(""); continue; }
    let line = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (measure(candidate) > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  await scratch.delete();
  return lines;
}

// ---------------------------------------------------------------- the card

async function buildCardDocument(spec, base) {
  const style = { ...DEFAULT_STYLE, ...spec.style };
  const profile = spec.profile;
  const p = base / 15;
  const bodySize = 15 * p * style.bodyScale;
  const lineHeight = bodySize * 1.3;
  const L = { padL: 16 * p, padR: 20 * p, padT: 12 * p, padB: 12 * p, avatar: 40 * p, gap: 12 * p };
  const cx = L.padL + L.avatar + L.gap;
  const wrapWidth = style.wrapWidth * base;

  const text = (spec.text || "").trim() || " ";
  const estLines = Math.min(40, Math.ceil((text.length * bodySize * 0.6) / wrapWidth) + text.split("\n").length + 2);
  const doc = await app.createDocument({
    name: "Tweet Builder (temp)",
    width: Math.ceil(cx + Math.max(wrapWidth, 40 * base) + 60 * p),
    height: Math.ceil(L.padT + 40 * p + estLines * lineHeight + 60 * p),
    resolution: 72,
    mode: constants.NewDocumentMode.RGB,
    fill: constants.DocumentFill.TRANSPARENT,
  });
  try {
    return await layoutCard(doc, { spec, profile, style, base, p, bodySize, lineHeight, L, cx, wrapWidth, text });
  } catch (e) {
    await doc.closeWithoutSaving();
    throw e;
  }
}

async function layoutCard(doc, { spec, profile, style, base, p, bodySize, lineHeight, L, cx, wrapWidth, text }) {
  const initialLayerId = doc.layers[0].id;

  at("adding the avatar");
  // Avatar: circle with the image clipped into it.
  await addEllipse({ left: L.padL, top: L.padT, size: L.avatar, color: COLORS.avatarPlaceholder, name: "Avatar mask" });
  const avatarEntry = await profiles.getAvatarEntry(profile.avatar);
  if (avatarEntry) {
    const img = await placeFile(avatarEntry, "Avatar");
    await fitBox(img, { left: L.padL, top: L.padT, size: L.avatar });
    await bp({ _obj: "groupEvent", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] });
  }

  at("adding the name and handle");
  // Header: name, badge, handle · time.
  const headerBaseline = L.padT + 15.5 * p;
  const nameLayer = await addText(doc, {
    text: profile.name || profile.handle || "Name", font: FONTS.bold, size: 15 * p,
    color: COLORS.text, x: cx, baseline: headerBaseline, name: "Name",
  });
  let x = boundsOf(nameLayer).right;
  if (profile.verified) {
    const badge = 18.75 * p;
    await placeIcon("verified", { left: x + 2 * p, top: headerBaseline - 5 * p - badge / 2, size: badge });
    x += 2 * p + badge;
  }
  const meta = [`@${(profile.handle || "handle").replace(/^@/, "")}`];
  if (spec.time && spec.time.trim()) meta.push(spec.time.trim());
  const handleLayer = await addText(doc, {
    text: meta.join(" · "), font: FONTS.regular, size: 15 * p,
    color: COLORS.muted, x: x + 4 * p, baseline: headerBaseline, name: "Handle",
  });

  at("laying out the tweet text");
  // Body.
  const lines = await wrapText(doc, text, FONTS.regular, bodySize, wrapWidth);
  const bodyBaseline = L.padT + 22 * p + bodySize * 0.95;
  const bodyLayer = await addText(doc, {
    text: lines.join("\r"), font: FONTS.regular, size: bodySize,
    color: COLORS.text, x: cx, baseline: bodyBaseline, name: "Body",
  });
  if (lines.length > 1) await setLeading(bodyLayer, lineHeight);
  const bodyBottom = bodyBaseline + (lines.length - 1) * lineHeight + 0.22 * bodySize;

  at("adding the reply/retweet/like row");
  // Actions row: reply, retweet, like (+ counts).
  const iconSize = 18.75 * p;
  const rowTop = bodyBottom + 6 * p;
  const rowCenter = rowTop + 10 * p;
  const counts = spec.counts || {};
  const actions = [["reply", counts.replies], ["retweet", counts.retweets], ["like", counts.likes]];
  let ix = cx;
  let actionsRight = cx;
  for (const [icon, value] of actions) {
    await placeIcon(icon, { left: ix, top: rowCenter - iconSize / 2, size: iconSize });
    let right = ix + iconSize;
    const label = formatCount(value);
    if (label) {
      const countLayer = await addText(doc, {
        text: label, font: FONTS.regular, size: 13 * p,
        color: COLORS.muted, x: ix + iconSize + 4 * p, baseline: rowCenter + 4.6 * p, name: `${icon} count`,
      });
      right = boundsOf(countLayer).right;
    }
    actionsRight = right;
    ix = Math.max(ix + 98 * p, right + 22 * p);
  }

  at("drawing the card background");
  // Card background, sized to the content.
  const contentRight = Math.max(boundsOf(handleLayer).right, boundsOf(bodyLayer).right, actionsRight);
  const width = Math.ceil(contentRight + L.padR);
  const height = Math.ceil(rowTop + 20 * p + L.padB);
  const radius = Math.min(height / 2, (height * style.radiusPct) / 100);
  const card = await addRoundedRect({ left: 0, top: 0, right: width, bottom: height, radius, color: COLORS.card, name: "Card" });
  await card.move(doc.layers[doc.layers.length - 1], constants.ElementPlacement.PLACEAFTER);

  // Photoshop sometimes discards the untouched starting layer by itself.
  for (let i = 0; i < doc.layers.length; i++) {
    if (doc.layers[i].id === initialLayerId) {
      await doc.layers[i].delete();
      break;
    }
  }
  return { doc, width, height };
}

async function mergeToSmartObject(doc) {
  await bp({ _obj: "selectAllLayers", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] });
  await bp({ _obj: "newPlacedLayer" });
  const so = activeLayer();
  so.name = "Tweet";
  return so;
}

// ---------------------------------------------------------------- finishing

async function applyShadow(layer, base) {
  const k = base / SHADOW_REF_BASE;
  await selectLayer(layer);
  await bp({
    _obj: "set",
    _target: [{ _ref: "property", _property: "layerEffects" }, { _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    to: {
      _obj: "layerEffects",
      scale: { _unit: "percentUnit", _value: 100 },
      dropShadow: {
        _obj: "dropShadow",
        enabled: true,
        present: true,
        showInDialog: true,
        mode: { _enum: "blendMode", _value: "normal" },
        color: rgbDesc([0, 0, 0]),
        opacity: { _unit: "percentUnit", _value: 56 },
        useGlobalAngle: false,
        localLightingAngle: { _unit: "angleUnit", _value: 50 },
        distance: px(8 * k),
        chokeMatte: px(3),
        blur: px(76 * k),
        noise: { _unit: "percentUnit", _value: 0 },
        antiAlias: false,
        transferSpec: { _obj: "shapeCurveType", name: "Linear" },
        layerConceals: true,
      },
    },
  });
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Photoshop may re-serialise layer XMP after a save, so accept both the
// element form we write and the attribute form.
function parseSpecXmp(xmp) {
  if (!xmp) return null;
  const m = xmp.match(/<tweetbuilder:spec>([\s\S]*?)<\/tweetbuilder:spec>/) || xmp.match(/tweetbuilder:spec="([^"]*)"/);
  if (!m) return null;
  try {
    return JSON.parse(unescapeXml(m[1]));
  } catch (e) {
    return null;
  }
}

// The spec stored on a card made by this plugin, or null for any other layer.
// Safe to call outside a modal scope.
async function readSpec(layer) {
  if (!layer || layer.kind !== constants.LayerKind.SMARTOBJECT) return null;
  const results = await action.batchPlay(
    [{ _obj: "get", _target: [{ _property: "metadata" }, { _ref: "layer", _id: layer.id }, { _ref: "document", _id: layer.document.id }] }],
    {}
  );
  const md = results[0] && results[0].metadata;
  return parseSpecXmp(md && md.layerXMP);
}

// Stash the spec on the layer so a later version can re-open it for editing.
async function writeSpecMetadata(layer, spec) {
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:tweetbuilder="http://ns.nixo.local/tweetbuilder/1.0/">' +
    `<tweetbuilder:spec>${escapeXml(JSON.stringify(spec))}</tweetbuilder:spec>` +
    "</rdf:Description></rdf:RDF></x:xmpmeta>";
  await bp({
    _obj: "set",
    _target: [{ _ref: "property", _property: "metadata" }, { _ref: "layer", _id: layer.id }],
    to: { _obj: "metadata", layerXMP: xmp },
  });
}

function withStage(e) {
  const err = e instanceof Error ? e : new Error(String(e));
  if (stage) err.message = `${err.message} (while ${stage})`;
  return err;
}

async function insertTweet(spec, executionContext, log = () => {}) {
  if (!app.documents.length) throw new Error("Open a document first.");
  const target = app.activeDocument;
  const previous = target.activeLayers[0];
  const style = { ...DEFAULT_STYLE, ...spec.style };
  const base = Math.max(8, Math.round(target.width * 0.025 * (style.sizePct / 100)));

  at("creating the card document");
  let temp;
  try {
    temp = await buildCardDocument(spec, base);
    at("converting the card to a smart object");
    temp.layer = await mergeToSmartObject(temp.doc);
  } catch (e) {
    if (temp && isOpen(temp.doc)) await temp.doc.closeWithoutSaving();
    throw withStage(e);
  }
  at("placing the card in your document");
  const history = await executionContext.hostControl.suspendHistory({ documentID: target.id, name: "Insert Tweet" });
  try {
    let placed = await temp.layer.duplicate(target);
    await temp.doc.closeWithoutSaving();
    app.activeDocument = target;
    if (!placed) placed = target.activeLayers[0];

    if (previous && previous.id !== placed.id) {
      await placed.move(previous, constants.ElementPlacement.PLACEBEFORE);
    }
    const b = boundsOf(placed);
    await placed.translate(target.width / 2 - (b.left + b.width / 2), target.height / 2 - (b.top + b.height / 2));
    if (style.tilt) await placed.rotate(style.tilt, constants.AnchorPosition.MIDDLECENTER);
    if (style.shadow) {
      at("adding the drop shadow");
      await applyShadow(placed, base);
    }
    placed.name = autoName(spec);
    try {
      await writeSpecMetadata(placed, spec);
    } catch (e) {
      log(`metadata: ${e.message}`);
    }
    await selectLayer(placed);
    await executionContext.hostControl.resumeHistory(history);
    return placed;
  } catch (e) {
    if (isOpen(temp.doc)) await temp.doc.closeWithoutSaving();
    await executionContext.hostControl.resumeHistory(history, false);
    throw withStage(e);
  }
}

const AUTO_NAME_PREFIX = "Tweet · ";

function autoName(spec) {
  return `${AUTO_NAME_PREFIX}${(spec.text || "").trim().slice(0, 40)}`;
}

// Rebuild the contents of an existing card in place. Replacing the smart
// object's contents keeps the layer itself (id, position, rotation, scale,
// effects, masks, blend mode, stacking), so tilt and shadow from the spec are
// not re-applied here.
async function updateTweet(layer, spec, executionContext, log = () => {}) {
  if (!layer) throw new Error("Select a tweet layer first.");
  const target = layer.document;
  if (!(await readSpec(layer))) throw new Error("The selected layer isn't a tweet made by Tweet Builder.");
  const style = { ...DEFAULT_STYLE, ...spec.style };
  const base = Math.max(8, Math.round(target.width * 0.025 * (style.sizePct / 100)));

  at("creating the card document");
  let file;
  let temp;
  try {
    temp = await buildCardDocument(spec, base);
    at("saving the new card contents");
    await temp.doc.resizeCanvas(temp.width, temp.height, constants.AnchorPosition.TOPLEFT);
    file = await (await lfs.getTemporaryFolder()).createFile("tweet-card.psd", { overwrite: true });
    await temp.doc.saveAs.psd(file, {}, true);
    await temp.doc.closeWithoutSaving();
  } catch (e) {
    if (temp && isOpen(temp.doc)) await temp.doc.closeWithoutSaving();
    throw withStage(e);
  }

  app.activeDocument = target;
  at("replacing the card contents");
  const history = await executionContext.hostControl.suspendHistory({ documentID: target.id, name: "Update Tweet" });
  try {
    await selectLayer(layer);
    await bp({
      _obj: "placedLayerReplaceContents",
      null: { _path: await lfs.createSessionToken(file), _kind: "local" },
      _options: { dialogOptions: "dontDisplay" },
    });
    if (!layer.name || layer.name.startsWith(AUTO_NAME_PREFIX)) layer.name = autoName(spec);
    try {
      await writeSpecMetadata(layer, spec);
    } catch (e) {
      log(`metadata: ${e.message}`);
    }
    await executionContext.hostControl.resumeHistory(history);
    return layer;
  } catch (e) {
    await executionContext.hostControl.resumeHistory(history, false);
    throw withStage(e);
  }
}

module.exports = { insertTweet, updateTweet, readSpec, formatCount, DEFAULT_STYLE };
