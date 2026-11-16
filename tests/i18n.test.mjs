import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogs,
  loadProjectLocale,
  messageKeys,
  saveProjectLocale,
  translate,
} from "../dist/common/i18n.js";

const localeFile = (root) => join(root, ".pi", "pi-autoplan.locale.json");

test("English and pt-BR catalogs have exact key and placeholder parity", () => {
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs["pt-BR"]).sort());
  assert.deepEqual([...messageKeys].sort(), Object.keys(catalogs.en).sort());
  const placeholders = (value) => [...value.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
  for (const key of messageKeys) {
    assert.deepEqual(placeholders(catalogs.en[key]), placeholders(catalogs["pt-BR"][key]), key);
    assert.notEqual(translate("pt-BR", key), key, `missing pt-BR translation: ${key}`);
  }
  assert.equal(translate("pt-BR", "missing.key"), "missing.key");
});

test("missing, malformed, and untrusted project locale state safely uses English", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autoplan-locale-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(await loadProjectLocale(root, true), { locale: "en", invalid: false });
  await mkdir(join(root, ".pi"), { recursive: true });
  await writeFile(localeFile(root), JSON.stringify({ schemaVersion: 1, locale: "fr" }));
  assert.deepEqual(await loadProjectLocale(root, true), { locale: "en", invalid: true });
  assert.deepEqual(await loadProjectLocale(root, false), { locale: "en", invalid: false });

  await writeFile(localeFile(root), "not-json");
  assert.deepEqual(await loadProjectLocale(root, true), { locale: "en", invalid: true });
});

test("locale is saved only to a trusted project and never crosses projects", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "pi-autoplan-locale-isolation-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = join(base, "first");
  const second = join(base, "second");
  await mkdir(first);
  await mkdir(second);

  await saveProjectLocale(first, true, "pt-BR");
  assert.deepEqual(await loadProjectLocale(first, true), { locale: "pt-BR", invalid: false });
  assert.deepEqual(await loadProjectLocale(second, true), { locale: "en", invalid: false });
  assert.deepEqual(await loadProjectLocale(first, false), { locale: "en", invalid: false });
  const saved = await readFile(localeFile(first), "utf8");
  await assert.rejects(saveProjectLocale(first, false, "en"), /trusted-project-required/);
  assert.equal(await readFile(localeFile(first), "utf8"), saved);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(saveProjectLocale(second, true, "pt-BR", controller.signal), /operation-cancelled/);
  assert.equal(await loadProjectLocale(second, true).then((state) => state.locale), "en");
  assert.equal(await readFile(join(first, ".pi", "config.json"), "utf8").catch(() => null), null);
});

test("failed project path writes preserve existing content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-autoplan-locale-write-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const piPath = join(root, ".pi");
  await writeFile(piPath, "keep-existing-file");
  await assert.rejects(saveProjectLocale(root, true, "pt-BR"));
  assert.equal(await readFile(piPath, "utf8"), "keep-existing-file");
});
