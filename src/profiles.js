// Profile lookup (X/Twitter) and local storage of saved profiles + avatars.
//
// Lookup sources, in order:
//   tweet link  -> api.fxtwitter.com status endpoint (author, text, counts)
//   @handle     -> api.fxtwitter.com user endpoint, falling back to
//                  unavatar.io for the avatar only (name must then be typed)

const { storage } = require("uxp");

const lfs = storage.localFileSystem;
const PROFILES_FILE = "profiles.json";

async function dataFolder() {
  return lfs.getDataFolder();
}

async function avatarsFolder() {
  const df = await dataFolder();
  try {
    return await df.getEntry("avatars");
  } catch (e) {
    return df.createFolder("avatars");
  }
}

async function readJSON(name, fallback) {
  try {
    const file = await (await dataFolder()).getEntry(name);
    return JSON.parse(await file.read());
  } catch (e) {
    return fallback;
  }
}

async function writeJSON(name, data) {
  const file = await (await dataFolder()).createFile(name, { overwrite: true });
  await file.write(JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------- saved profiles

async function loadProfiles() {
  return readJSON(PROFILES_FILE, []);
}

async function saveProfile(profile) {
  const list = await loadProfiles();
  const key = profile.handle.toLowerCase();
  const i = list.findIndex((p) => p.handle.toLowerCase() === key);
  const clean = { name: profile.name, handle: profile.handle, verified: !!profile.verified, avatar: profile.avatar || null };
  if (i >= 0) list[i] = clean;
  else list.push(clean);
  list.sort((a, b) => a.name.localeCompare(b.name));
  await writeJSON(PROFILES_FILE, list);
  return list;
}

async function deleteProfile(handle) {
  const list = (await loadProfiles()).filter((p) => p.handle.toLowerCase() !== handle.toLowerCase());
  await writeJSON(PROFILES_FILE, list);
  return list;
}

// ---------------------------------------------------------------- avatars

async function getAvatarEntry(name) {
  if (!name) return null;
  try {
    return await (await avatarsFolder()).getEntry(name);
  } catch (e) {
    return null;
  }
}

async function storeAvatar(buffer, baseName, ext) {
  const name = `${baseName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.${ext}`;
  const file = await (await avatarsFolder()).createFile(name, { overwrite: true });
  await file.write(buffer, { format: storage.formats.binary });
  return name;
}

async function downloadAvatar(url, handle) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Avatar download failed (${res.status})`);
  const type = res.headers.get("content-type") || "";
  const ext = /png/i.test(type) ? "png" : /webp/i.test(type) ? "webp" : "jpg";
  return storeAvatar(await res.arrayBuffer(), handle, ext);
}

// Let the user pick an image from disk and copy it into the avatars folder.
async function pickAvatar(handle) {
  const file = await lfs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"] });
  if (!file) return null;
  const buffer = await file.read({ format: storage.formats.binary });
  const ext = file.name.split(".").pop().toLowerCase().replace("jpeg", "jpg");
  return storeAvatar(buffer, `${handle || "custom"}_${Date.now()}`, ext);
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | (c >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

async function avatarDataUrl(name) {
  const entry = await getAvatarEntry(name);
  if (!entry) return null;
  const buffer = await entry.read({ format: storage.formats.binary });
  const ext = name.split(".").pop();
  const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${base64(buffer)}`;
}

// ---------------------------------------------------------------- lookup

function parseInput(input) {
  const s = (input || "").trim();
  const status = s.match(/(?:twitter|x|fxtwitter|fixupx|vxtwitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/i);
  if (status) return { handle: status[1], statusId: status[2] };
  const handle = s.replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "").replace(/^@/, "").split(/[/?#\s]/)[0];
  if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { handle };
  throw new Error("Enter an @handle or a tweet link.");
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

function profileFromAuthor(a) {
  return {
    name: a.name || a.screen_name,
    handle: a.screen_name,
    verified: !!(a.verification && a.verification.verified),
    avatarUrl: (a.avatar_url || "").replace(/_(normal|bigger|mini|200x200)\.(\w+)$/, "_400x400.$2"),
  };
}

// Returns { profile, tweet?, note? }. profile.avatar is a stored file name.
async function lookup(input) {
  const q = parseInput(input);
  let profile = null;
  let tweet = null;
  let note = null;

  if (q.statusId) {
    const data = await getJSON(`https://api.fxtwitter.com/${q.handle}/status/${q.statusId}`);
    if (!data.tweet) throw new Error("Tweet not found.");
    profile = profileFromAuthor(data.tweet.author);
    tweet = {
      text: data.tweet.text || "",
      replies: data.tweet.replies,
      retweets: data.tweet.retweets,
      likes: data.tweet.likes,
    };
  } else {
    try {
      const data = await getJSON(`https://api.fxtwitter.com/${q.handle}`);
      if (data.user) profile = profileFromAuthor(data.user);
    } catch (e) {
      // fall through to unavatar
    }
    if (!profile) {
      const data = await getJSON(`https://unavatar.io/x/${q.handle}?json`);
      const saved = (await loadProfiles()).find((p) => p.handle.toLowerCase() === q.handle.toLowerCase());
      if (saved) {
        // Only the avatar came back; keep the name/badge the user already saved.
        profile = { name: saved.name, handle: saved.handle, verified: saved.verified, avatarUrl: data.url };
        note = `Refreshed the avatar for @${saved.handle} and kept the saved name.`;
      } else {
        profile = { name: q.handle, handle: q.handle, verified: true, avatarUrl: data.url };
        note = "Found the avatar, but X didn't return a display name or verified status. Check them, then click Save.";
      }
    }
  }

  profile.avatar = profile.avatarUrl ? await downloadAvatar(profile.avatarUrl, profile.handle) : null;
  delete profile.avatarUrl;
  return { profile, tweet, note };
}

module.exports = {
  loadProfiles,
  saveProfile,
  deleteProfile,
  lookup,
  pickAvatar,
  getAvatarEntry,
  avatarDataUrl,
  readJSON,
  writeJSON,
};
