var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => LetterboxdSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  username: "",
  moviesFolder: "Movies",
  syncFrequencyMinutes: 60 * 24,
  syncOnStartup: true,
  linkWatchDates: true
};
var DEFAULT_STATE = {
  lastSyncAt: null,
  isSyncing: false,
  movieIndex: {}
};
var MANAGED_FRONTMATTER_KEYS = /* @__PURE__ */ new Set([
  "title",
  "year",
  "letterboxd_uri",
  "film_key",
  "director",
  "producer",
  "studio",
  "genre",
  "review",
  "watch_count",
  "first_watched",
  "last_watched",
  "lb_last_sync",
  "lb_synced_watches"
]);
var FREQUENCY_OPTIONS = {
  Manual: 0,
  "Every hour": 60,
  "Every 12 hours": 60 * 12,
  "Every 24 hours": 60 * 24,
  "Every week": 60 * 24 * 7
};
var LetterboxdSyncPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.state = { ...DEFAULT_STATE };
    this.intervalId = null;
  }
  async onload() {
    await this.loadPluginData();
    if (this.state.isSyncing) {
      this.state.isSyncing = false;
      await this.savePluginData();
      console.warn("Letterboxd sync was interrupted; reset sync lock.");
    }
    this.addCommand({
      id: "sync-letterboxd-now",
      name: "Sync Letterboxd now",
      callback: () => void this.syncNow(true)
    });
    this.addCommand({
      id: "open-letterboxd-sync-settings",
      name: "Open Letterboxd sync settings",
      callback: () => {
        const setting = this.app.setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
      }
    });
    this.addSettingTab(new LetterboxdSyncSettingTab(this.app, this));
    this.configureTimer();
    if (this.settings.syncOnStartup && this.isSyncDue()) {
      window.setTimeout(() => void this.syncNow(false), 2e3);
    }
  }
  onunload() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
  async updateSettings(settings) {
    this.settings = { ...this.settings, ...settings };
    await this.savePluginData();
    this.configureTimer();
  }
  async loadPluginData() {
    const data = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...data?.settings ?? {} };
    this.state = {
      ...DEFAULT_STATE,
      ...data?.state ?? {},
      movieIndex: { ...data?.state?.movieIndex ?? {} }
    };
  }
  async savePluginData() {
    await this.saveData({ settings: this.settings, state: this.state });
  }
  configureTimer() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.settings.syncFrequencyMinutes <= 0)
      return;
    const tickMs = Math.min(this.settings.syncFrequencyMinutes * 60 * 1e3, 5 * 60 * 1e3);
    this.intervalId = window.setInterval(() => {
      if (!this.state.isSyncing && this.isSyncDue()) {
        void this.syncNow(false);
      }
    }, tickMs);
    this.registerInterval(this.intervalId);
  }
  isSyncDue() {
    if (this.settings.syncFrequencyMinutes <= 0)
      return false;
    if (this.state.lastSyncAt === null)
      return true;
    const elapsedMs = Date.now() - this.state.lastSyncAt;
    return elapsedMs >= this.settings.syncFrequencyMinutes * 60 * 1e3;
  }
  async syncNow(showNotice) {
    const username = this.settings.username.trim();
    const moviesFolder = normalizeFolder(this.settings.moviesFolder);
    if (!username) {
      new import_obsidian.Notice("Letterboxd sync: username missing.");
      return;
    }
    if (!moviesFolder) {
      new import_obsidian.Notice("Letterboxd sync: movies folder missing.");
      return;
    }
    if (this.state.isSyncing) {
      if (showNotice)
        new import_obsidian.Notice("Letterboxd sync already running.");
      return;
    }
    this.state.isSyncing = true;
    await this.savePluginData();
    const failures = [];
    let changedFiles = 0;
    let movieCount = 0;
    try {
      const entries = await fetchLetterboxdEntries(username);
      const grouped = groupEntriesByFilm(entries);
      await ensureFolder(this.app, moviesFolder);
      for (const [filmKey, movieEntries] of grouped) {
        try {
          const changed = await this.syncMovie(moviesFolder, filmKey, movieEntries);
          movieCount += 1;
          if (changed)
            changedFiles += 1;
        } catch (error) {
          failures.push(`${movieEntries[0]?.filmTitle ?? filmKey}: ${getErrorMessage(error)}`);
          console.error("Letterboxd movie sync failed", error);
        }
      }
      if (failures.length === 0) {
        this.state.lastSyncAt = Date.now();
      }
      const summary = `Letterboxd sync: ${movieCount} movies, ${changedFiles} changed${failures.length ? `, ${failures.length} failed` : ""}.`;
      if (showNotice || failures.length > 0)
        new import_obsidian.Notice(summary);
      if (failures.length > 0)
        console.warn("Letterboxd sync failures", failures);
    } catch (error) {
      new import_obsidian.Notice(`Letterboxd sync failed: ${getErrorMessage(error)}`);
      console.error("Letterboxd sync failed", error);
    } finally {
      this.state.isSyncing = false;
      await this.savePluginData();
    }
  }
  async syncMovie(moviesFolder, filmKey, entries) {
    const sortedEntries = [...entries].sort(compareEntries);
    const firstEntry = sortedEntries[0];
    const path = await this.resolveMoviePath(moviesFolder, firstEntry);
    const existingFile = this.app.vault.getAbstractFileByPath(path);
    const existingContent = existingFile instanceof import_obsidian.TFile ? await this.app.vault.read(existingFile) : "";
    const rendered = renderMovieNote(existingContent, firstEntry, sortedEntries, this.settings.linkWatchDates);
    if (rendered === existingContent) {
      this.state.movieIndex[filmKey] = path;
      return false;
    }
    if (existingFile instanceof import_obsidian.TFile) {
      await this.app.vault.modify(existingFile, rendered);
    } else {
      await this.app.vault.create(path, rendered);
    }
    this.state.movieIndex[filmKey] = path;
    return true;
  }
  async resolveMoviePath(moviesFolder, entry) {
    const indexedPath = this.state.movieIndex[entry.filmKey];
    if (indexedPath && this.app.vault.getAbstractFileByPath(indexedPath) instanceof import_obsidian.TFile) {
      return indexedPath;
    }
    const filename = buildMovieFileName(entry.filmTitle, entry.filmYear);
    return `${moviesFolder}/${filename}`;
  }
};
var LetterboxdSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Wren's Letterboxd Sync" });
    containerEl.createEl("p", {
      text: "RSS only includes recent diary items. Keep plugin enabled for continuous history."
    });
    new import_obsidian.Setting(containerEl).setName("Letterboxd username").setDesc("Username only, not full URL.").addText(
      (text) => text.setPlaceholder("wren").setValue(this.plugin.settings.username).onChange(async (value) => this.plugin.updateSettings({ username: value.trim() }))
    );
    new import_obsidian.Setting(containerEl).setName("Movies folder").setDesc("Plugin creates nested folders when needed.").addText(
      (text) => text.setPlaceholder("Movies").setValue(this.plugin.settings.moviesFolder).onChange(async (value) => this.plugin.updateSettings({ moviesFolder: value }))
    );
    new import_obsidian.Setting(containerEl).setName("Sync frequency").setDesc("Startup catch-up runs when interval has elapsed.").addDropdown((dropdown) => {
      for (const [label, minutes] of Object.entries(FREQUENCY_OPTIONS)) {
        dropdown.addOption(String(minutes), label);
      }
      dropdown.setValue(String(this.plugin.settings.syncFrequencyMinutes)).onChange(async (value) => this.plugin.updateSettings({ syncFrequencyMinutes: Number(value) }));
    });
    new import_obsidian.Setting(containerEl).setName("Sync on startup").setDesc("Syncs on app load if interval expired.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => this.plugin.updateSettings({ syncOnStartup: value }))
    );
    new import_obsidian.Setting(containerEl).setName("Link watch dates").setDesc("Render watch dates as [[YYYY-MM-DD]].").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.linkWatchDates).onChange(async (value) => this.plugin.updateSettings({ linkWatchDates: value }))
    );
  }
};
async function fetchLetterboxdEntries(username) {
  const response = await (0, import_obsidian.requestUrl)({
    url: `https://letterboxd.com/${encodeURIComponent(username)}/rss/`,
    method: "GET",
    headers: { Accept: "application/rss+xml, application/xml, text/xml" }
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RSS request returned ${response.status}`);
  }
  return parseLetterboxdRss(response.text);
}
function parseLetterboxdRss(xml) {
  const document2 = new DOMParser().parseFromString(xml, "text/xml");
  const parseError = document2.querySelector("parsererror");
  if (parseError)
    throw new Error("RSS XML parse failed");
  return Array.from(document2.querySelectorAll("item")).map((item) => parseRssItem(item)).filter((entry) => entry !== null);
}
function parseRssItem(item) {
  const filmTitle = getNodeText(item, "letterboxd\\:filmTitle, filmTitle") ?? inferTitle(getNodeText(item, "title"));
  const watchedDate = normalizeDate(getNodeText(item, "letterboxd\\:watchedDate, watchedDate") ?? "");
  const link = normalizeLetterboxdUrl(getNodeText(item, "link") ?? "");
  const filmYear = normalizeYear(getNodeText(item, "letterboxd\\:filmYear, filmYear"));
  if (!filmTitle || !watchedDate || !link)
    return null;
  const rating = parseRating(getNodeText(item, "letterboxd\\:memberRating, memberRating"));
  const rewatch = parseBoolean(getNodeText(item, "letterboxd\\:rewatch, rewatch"));
  const reviewText = extractReviewText(getNodeText(item, "description"));
  const guid = getNodeText(item, "guid");
  const filmKey = link;
  const entryKey = buildEntryKey(guid, filmKey, watchedDate, rating, rewatch, reviewText);
  return {
    filmTitle,
    filmYear,
    filmKey,
    letterboxdUri: link,
    watchedDate,
    rating,
    rewatch,
    reviewText,
    entryKey
  };
}
function getNodeText(parent, selector) {
  const node = parent.querySelector(selector);
  const text = node?.textContent?.trim();
  return text ? decodeHtml(text) : null;
}
function inferTitle(title) {
  if (!title)
    return null;
  return title.replace(/^.*? watched /i, "").replace(/, \d{4}$/, "").trim() || title.trim();
}
function normalizeYear(year) {
  const match = year?.match(/\d{4}/);
  return match?.[0] ?? null;
}
function normalizeDate(date) {
  const match = date.match(/\d{4}-\d{2}-\d{2}/);
  if (match)
    return match[0];
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime()))
    return null;
  return parsed.toISOString().slice(0, 10);
}
function normalizeLetterboxdUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}
function parseRating(value) {
  if (!value)
    return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function parseBoolean(value) {
  return value?.toLowerCase() === "yes" || value?.toLowerCase() === "true";
}
function extractReviewText(description) {
  if (!description)
    return null;
  const html = decodeHtml(description);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = Array.from(doc.querySelectorAll("p")).map((p) => normalizeWhitespace(p.textContent ?? "")).filter((text) => text && !/^Watched on\b/i.test(text));
  const review = paragraphs.join(" ").trim();
  return review || null;
}
function decodeHtml(value) {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = value;
  return textarea.value;
}
function buildEntryKey(guid, filmKey, watchedDate, rating, rewatch, reviewText) {
  if (guid?.trim())
    return `guid:${guid.trim()}`;
  return `hash:${fnv1a([filmKey, watchedDate, rating ?? "", rewatch ? "1" : "0", normalizeWhitespace(reviewText ?? "")].join("|"))}`;
}
function fnv1a(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function groupEntriesByFilm(entries) {
  const grouped = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    const list = grouped.get(entry.filmKey) ?? [];
    list.push(entry);
    grouped.set(entry.filmKey, list);
  }
  return grouped;
}
function renderMovieNote(existingContent, entry, incomingEntries, linkDates) {
  const existing = parseNote(existingContent);
  const syncedKeys = readStringArray(existing.frontmatter.lb_synced_watches);
  const syncedKeySet = new Set(syncedKeys);
  const knownDates = readStringArray(existing.frontmatter.lb_watch_dates).filter(isIsoDate);
  const knownDateSet = new Set(knownDates);
  const existingWatches = parseExistingWatches(existing.body);
  const newEntries = [];
  for (const watch of [...incomingEntries].sort(compareEntries)) {
    if (isDuplicateWatch(watch, syncedKeySet, knownDateSet, existingWatches))
      continue;
    newEntries.push(watch);
    syncedKeySet.add(watch.entryKey);
    knownDateSet.add(watch.watchedDate);
  }
  const allKeys = [...syncedKeys, ...newEntries.map((watch) => watch.entryKey)];
  const allDates = [...knownDates, ...newEntries.map((watch) => watch.watchedDate)].sort();
  const uniqueDates = Array.from(new Set(allDates));
  const hasReview = Boolean(existing.frontmatter.review === "yes" || incomingEntries.some((watch) => watch.reviewText));
  const frontmatter = buildFrontmatter(existing.frontmatter, entry, allKeys, uniqueDates, hasReview, newEntries.length > 0 || existingContent.length === 0);
  const body = renderBody(existing.body, entry, newEntries, linkDates, existingContent.length === 0);
  return `${renderFrontmatter(frontmatter)}
${body}`.replace(/\s+$/u, "") + "\n";
}
function parseNote(content) {
  if (!content.startsWith("---\n"))
    return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1)
    return { frontmatter: {}, body: content };
  const yaml = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: parseSimpleYaml(yaml), body };
}
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch)
      continue;
    const key = keyMatch[1];
    const rawValue = keyMatch[2] ?? "";
    if (rawValue === "") {
      const list = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const itemMatch = next.match(/^\s*-\s*(.*)$/);
        if (!itemMatch)
          break;
        list.push(unquoteYaml(itemMatch[1].trim()));
        i += 1;
      }
      result[key] = list.length > 0 ? list : "";
    } else {
      result[key] = parseYamlScalar(rawValue.trim());
    }
  }
  return result;
}
function parseYamlScalar(value) {
  if (value === '""' || value === "''")
    return "";
  if (value === "true")
    return true;
  if (value === "false")
    return false;
  if (/^-?\d+(\.\d+)?$/.test(value))
    return Number(value);
  return unquoteYaml(value);
}
function unquoteYaml(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return value;
}
function buildFrontmatter(existing, entry, syncedKeys, dates, hasReview, touched) {
  const result = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key) && key !== "lb_watch_dates")
      result[key] = value;
  }
  result.title = entry.filmTitle;
  result.year = entry.filmYear ?? "";
  result.letterboxd_uri = entry.letterboxdUri;
  result.film_key = entry.filmKey;
  result.director = "";
  result.producer = "";
  result.studio = "";
  result.genre = "";
  result.review = hasReview ? "yes" : "no";
  result.watch_count = syncedKeys.length;
  result.first_watched = dates[0] ?? "";
  result.last_watched = dates[dates.length - 1] ?? "";
  result.lb_last_sync = touched || typeof existing.lb_last_sync !== "string" ? (/* @__PURE__ */ new Date()).toISOString() : existing.lb_last_sync;
  result.lb_synced_watches = syncedKeys;
  result.lb_watch_dates = dates;
  return result;
}
function renderFrontmatter(frontmatter) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value)
        lines.push(`- ${formatYamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${formatYamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}
function formatYamlScalar(value) {
  if (value === null || value === void 0 || value === "")
    return '""';
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_./:#?=&%+-]+$/.test(text) && !/^(yes|no|true|false|null)$/i.test(text))
    return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function renderBody(body, entry, newEntries, linkDates, isNewNote) {
  const cleanedBody = cleanWatchHistoryFields(body);
  if (isNewNote || body.trim() === "") {
    const heading = `# ${entry.filmTitle}${entry.filmYear ? ` (${entry.filmYear})` : ""}`;
    const historyLines = newEntries.map((watch) => renderWatchLine(watch, linkDates));
    return `${heading}

#movies

## Watch history

${historyLines.join("\n")}

## Notes
`;
  }
  const history = findWatchHistorySection(cleanedBody);
  const linesToAppend = newEntries.map((watch) => renderWatchLine(watch, linkDates));
  if (linesToAppend.length === 0)
    return cleanedBody;
  if (!history) {
    const insert = `

## Watch history

${linesToAppend.join("\n")}
`;
    return cleanedBody.replace(/\s*$/u, "") + insert;
  }
  const before = cleanedBody.slice(0, history.end).replace(/\s*$/u, "");
  const after = cleanedBody.slice(history.end);
  const separator = before.endsWith("## Watch history") ? "\n\n" : "\n";
  return `${before}${separator}${linesToAppend.join("\n")}${after.startsWith("\n") ? after : `
${after}`}`;
}
function cleanWatchHistoryFields(body) {
  const history = findWatchHistorySection(body);
  if (!history)
    return body;
  const section = body.slice(history.start, history.end).replace(/\s+—\s+rating:\s*(?=\s+—|\n|$)/giu, "").replace(/\s+—\s+review:\s*(?=\s+—|\n|$)/giu, "").replace(/\s+—\s+rewatch:\s*(?!yes\b|true\b)[^—\n]*?(?=\s+—|\n|$)/giu, "");
  return body.slice(0, history.start) + section + body.slice(history.end);
}
function findWatchHistorySection(body) {
  const headingMatch = /^## Watch history\s*$/im.exec(body);
  if (!headingMatch)
    return null;
  const afterHeading = headingMatch.index + headingMatch[0].length;
  const nextHeadingMatch = /^##\s+/im.exec(body.slice(afterHeading));
  const end = nextHeadingMatch ? afterHeading + nextHeadingMatch.index : body.length;
  return { start: headingMatch.index, end };
}
function renderWatchLine(watch, linkDates) {
  const parts = [linkDates ? `[[${watch.watchedDate}]]` : watch.watchedDate];
  if (watch.rating !== null)
    parts.push(`rating: ${watch.rating}`);
  if (watch.rewatch)
    parts.push("rewatch: yes");
  const reviewText = watch.reviewText?.replace(/\s+/g, " ").trim();
  if (reviewText)
    parts.push(`review: ${reviewText}`);
  return `- ${parts.join(" \u2014 ")}`;
}
function isDuplicateWatch(watch, syncedKeySet, knownDateSet, existingWatches) {
  if (syncedKeySet.has(watch.entryKey))
    return true;
  if (knownDateSet.has(watch.watchedDate))
    return true;
  return existingWatches.filter((existingWatch) => existingWatch.watchedDate === watch.watchedDate).some((existingWatch) => isFuzzyWatchMatch(watch, existingWatch));
}
function parseExistingWatches(body) {
  return body.split("\n").map((line) => parseExistingWatchLine(line)).filter((watch) => watch !== null);
}
function parseExistingWatchLine(line) {
  const dateMatch = line.match(/^\s*-\s*(?:\[\[(?:[^\]\n]*\/)?(\d{4}-\d{2}-\d{2})(?:\|[^\]\n]*)?\]\]|\[(?:[^\]\n]*\/)?(\d{4}-\d{2}-\d{2})\]\(<?[^)\n>]*>?\)|(\d{4}-\d{2}-\d{2}))/);
  if (!dateMatch)
    return null;
  const parts = line.split("\u2014").slice(1).map((part) => part.trim());
  const ratingPart = parts.find((part) => /^rating:/i.test(part));
  const reviewPart = parts.find((part) => /^review:/i.test(part));
  return {
    watchedDate: dateMatch[1] ?? dateMatch[2] ?? dateMatch[3],
    rating: ratingPart ? parseRating(ratingPart.replace(/^rating:\s*/i, "")) : null,
    rewatch: parts.some((part) => /^rewatch:\s*yes$/i.test(part)),
    reviewText: reviewPart ? normalizeWhitespace(reviewPart.replace(/^review:\s*/i, "")) || null : null
  };
}
function isFuzzyWatchMatch(incoming, existing) {
  if (incoming.rating !== existing.rating || incoming.rewatch !== existing.rewatch)
    return false;
  if (!incoming.reviewText && !existing.reviewText)
    return true;
  return areReviewsSimilar(incoming.reviewText, existing.reviewText);
}
function areReviewsSimilar(a, b) {
  const left = normalizeReviewForComparison(a ?? "");
  const right = normalizeReviewForComparison(b ?? "");
  if (!left || !right)
    return left === right;
  if (left === right)
    return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (shorter.length >= 40 && longer.includes(shorter))
    return true;
  return bigramSimilarity(left, right) >= 0.88;
}
function normalizeReviewForComparison(value) {
  return normalizeWhitespace(value.toLowerCase().replace(/[^a-z0-9\s]/g, ""));
}
function bigramSimilarity(a, b) {
  if (a.length < 2 || b.length < 2)
    return a === b ? 1 : 0;
  const counts = /* @__PURE__ */ new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const bigram = a.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const bigram = b.slice(i, i + 2);
    const count = counts.get(bigram) ?? 0;
    if (count === 0)
      continue;
    counts.set(bigram, count - 1);
    overlap += 1;
  }
  return 2 * overlap / (a.length + b.length - 2);
}
function readStringArray(value) {
  if (!Array.isArray(value))
    return [];
  return value.map((item) => String(item)).filter(Boolean);
}
function compareEntries(a, b) {
  return a.watchedDate.localeCompare(b.watchedDate) || a.entryKey.localeCompare(b.entryKey);
}
function buildMovieFileName(title, year) {
  const normalizedTitle = normalizeFilename(title) || "Untitled Movie";
  return year ? `${normalizedTitle} (${year}).md` : `${normalizedTitle}.md`;
}
function normalizeFilename(value) {
  return value.replace(/[:/\\?*"<>|]/g, " - ").replace(/\s+/g, " ").replace(/^[\s.]+|[\s.]+$/g, "");
}
function normalizeFolder(value) {
  return value.replace(/\\/g, "/").split("/").map((part) => normalizeFilename(part)).filter(Boolean).join("/");
}
async function ensureFolder(app, folderPath) {
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}
function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}
function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
