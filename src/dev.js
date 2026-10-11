// Development-only test harness. Inactive unless `dev/enabled` exists in the
// plugin folder (that folder is not shipped).
//
// Polls the plugin data folder for `dev-job.json`, runs it, and writes
// `dev-result.json`. Job types:
//   { id, type: "insert", spec, background?: "file in data folder", resolution?, export?: "out.png" }
//   { id, type: "update", spec, export? }   rebuilds the selected card in the active document
//   { id, type: "probe", file, modal?: true }  file in dev/ exporting async (ctx) => value
//   { id, type: "cleanup" }                    closes documents the harness opened

const { app, core, action, constants } = require("photoshop");
const uxp = require("uxp");

const lfs = uxp.storage.localFileSystem;
const opened = new Set();

async function writeJSON(folder, name, data) {
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(JSON.stringify(data, null, 2));
}

async function openTestDocument(df, background, resolution = 72) {
  if (background) {
    const doc = await app.open(await df.getEntry(background));
    opened.add(doc.id);
    return doc;
  }
  const doc = await app.createDocument({
    width: 3840, height: 2160, resolution,
    mode: constants.NewDocumentMode.RGB, fill: constants.DocumentFill.WHITE,
  });
  opened.add(doc.id);
  return doc;
}

async function exportActive(df, name) {
  await core.executeAsModal(async () => {
    const out = await df.createFile(name, { overwrite: true });
    await app.activeDocument.saveAs.png(out, { compression: 3 }, true);
  }, { commandName: "Dev: export" });
}

function describeActiveLayer() {
  const layer = app.activeDocument.activeLayers[0];
  return layer && { id: layer.id, name: layer.name, bounds: layer.boundsNoEffects, kind: layer.kind };
}

async function runJob(job, df, handlers, log) {
  if (job.type === "insert") {
    await core.executeAsModal(() => openTestDocument(df, job.background, job.resolution), { commandName: "Dev: open" });
    const t0 = Date.now();
    await handlers.insert(job.spec, log);
    const ms = Date.now() - t0;
    if (job.export) await exportActive(df, job.export);
    return { ms, layer: describeActiveLayer() };
  }
  if (job.type === "update") {
    // Updates the selected layer of the active document.
    const t0 = Date.now();
    await handlers.update(job.spec, log);
    const ms = Date.now() - t0;
    if (job.export) await exportActive(df, job.export);
    return { ms, layer: describeActiveLayer() };
  }
  if (job.type === "probe") {
    // UXP forbids eval, so probes are modules in dev/ exporting async (ctx) => value.
    // Use a fresh file name per probe to sidestep the require cache.
    const probe = require(`../dev/${job.file}`);
    const run = () => probe({ app, core, action, constants, log, require, handlers });
    return job.modal ? core.executeAsModal(run, { commandName: "Dev: probe" }) : run();
  }
  if (job.type === "cleanup") {
    await core.executeAsModal(async () => {
      for (let i = app.documents.length - 1; i >= 0; i--) {
        const d = app.documents[i];
        if (opened.has(d.id)) await d.closeWithoutSaving();
      }
    }, { commandName: "Dev: cleanup" });
    opened.clear();
    return "closed";
  }
  throw new Error(`Unknown job type ${job.type}`);
}

async function start(handlers) {
  const pluginFolder = await lfs.getPluginFolder();
  try {
    await pluginFolder.getEntry("dev/enabled");
  } catch (e) {
    return;
  }
  const df = await lfs.getDataFolder();
  await writeJSON(df, "dev-hello.json", { dataFolder: df.nativePath, at: new Date().toISOString() });

  let busy = false;
  setInterval(async () => {
    if (busy) return;
    let entry;
    try {
      entry = await df.getEntry("dev-job.json");
    } catch (e) {
      return;
    }
    busy = true;
    const log = [];
    const result = { log };
    try {
      const job = JSON.parse(await entry.read());
      await entry.delete();
      result.id = job.id;
      result.value = await runJob(job, df, handlers, (m) => log.push(String(m)));
      result.ok = true;
    } catch (e) {
      result.ok = false;
      result.error = String((e && (e.stack || e.message)) || e);
    }
    await writeJSON(df, "dev-result.json", result);
    busy = false;
  }, 700);
}

module.exports = { start };
