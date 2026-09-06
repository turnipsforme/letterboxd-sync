import { App, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TFile } from "obsidian";
import type { EventRef } from "obsidian";

type PluginSettings = {
  username: string;
  moviesFolder: string;
  syncFrequencyMinutes: number;
  syncOnStartup: boolean;
  linkWatchDates: boolean;
  forwardLinkWatchDates: boolean;
};

type SyncState = {
  lastSyncAt: number | null;
  isSyncing: boolean;
  movieIndex: Record<string, string>;
};

type PluginData = {
  settings: PluginSettings;
  state: SyncState;
};

type ParsedLetterboxdEntry = {
  filmTitle: string;
  filmYear: string | null;
  filmKey: string;
  letterboxdUri: string;
  watchedDate: string;
  rating: number | null;
  rewatch: boolean;
  reviewText: string | null;
  entryKey: string;
};

type NoteParts = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type ExistingWatch = {
  watchedDate: string;
};

type RenderedMovieNote = {
  content: string;
  addedWatchDates: string[];
};

type ForwardLinkerResult = {
  added: number;
  skipped: number;
  failed: number;
};

type ReflectForwardLinkerApi = {
  forwardLinkFile(file: TFile): Promise<ForwardLinkerResult>;
};

type ObsidianCommand = {
  id: string;
};

type ObsidianCommands = {
  listCommands?: () => ObsidianCommand[];
  executeCommandById?: (id: string) => boolean | void;
};

function formatSyncNotice(changedMovieTitles: string[]): string {
  if (changedMovieTitles.length === 0) return "Letterboxd synced.";
  if (changedMovieTitles.length === 1) return `Added ${changedMovieTitles[0]}!`;
  return `Added ${changedMovieTitles.length} movies!`;
}

const DEFAULT_SETTINGS: PluginSettings = {
  username: "",
  moviesFolder: "Movies",
  syncFrequencyMinutes: 60 * 24,
  syncOnStartup: true,
  linkWatchDates: true,
  forwardLinkWatchDates: false,
};

const DEFAULT_STATE: SyncState = {
  lastSyncAt: null,
  isSyncing: false,
  movieIndex: {},
};

const MANAGED_FRONTMATTER_KEYS = new Set([
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
  "lb_synced_watches",
  "lb_watch_dates",
]);

const FREQUENCY_OPTIONS: Record<string, number> = {
  Manual: 0,
  "Every hour": 60,
  "Every 12 hours": 60 * 12,
  "Every 24 hours": 60 * 24,
  "Every week": 60 * 24 * 7,
};

const FORWARD_LINKER_COMMAND_ID = "reflect-forward-linker:process-current-note";
const FORWARD_LINKER_METADATA_TIMEOUT_MS = 5000;

export default class LetterboxdSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = { ...DEFAULT_STATE };
  private intervalId: number | null = null;

  async onload() {
    await this.loadPluginData();

    if (this.state.isSyncing) {
      this.state.isSyncing = false;
      await this.savePluginData();
      console.warn("Letterboxd sync was interrupted; reset sync lock.");
    }

    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => void this.syncNow(true),
    });

    this.addCommand({
      id: "open-settings",
      name: "Open settings",
      callback: () => {
        const setting = (this.app as App & { setting?: { open: () => void; openTabById: (id: string) => void } }).setting;
        setting?.open();
        setting?.openTabById(this.manifest.id);
      },
    });

    this.addSettingTab(new LetterboxdSyncSettingTab(this.app, this));
    this.configureTimer();

    if (this.settings.syncOnStartup && this.isSyncDue()) {
      window.setTimeout(() => void this.syncNow(false), 2000);
    }
  }

  onunload() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async updateSettings(settings: Partial<PluginSettings>) {
    this.settings = { ...this.settings, ...settings };
    await this.savePluginData();
    this.configureTimer();
  }

  private async loadPluginData() {
    const data = (await this.loadData()) as Partial<PluginData> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.state = {
      ...DEFAULT_STATE,
      ...(data?.state ?? {}),
      movieIndex: { ...(data?.state?.movieIndex ?? {}) },
    };
  }

  private async savePluginData() {
    await this.saveData({ settings: this.settings, state: this.state });
  }

  private configureTimer() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.settings.syncFrequencyMinutes <= 0) return;

    const tickMs = Math.min(this.settings.syncFrequencyMinutes * 60 * 1000, 5 * 60 * 1000);
    this.intervalId = window.setInterval(() => {
      if (!this.state.isSyncing && this.isSyncDue()) {
        void this.syncNow(false);
      }
    }, tickMs);
    this.registerInterval(this.intervalId);
  }

  private isSyncDue(): boolean {
    if (this.settings.syncFrequencyMinutes <= 0) return false;
    if (this.state.lastSyncAt === null) return true;
    const elapsedMs = Date.now() - this.state.lastSyncAt;
    return elapsedMs >= this.settings.syncFrequencyMinutes * 60 * 1000;
  }

  async syncNow(showNotice: boolean) {
    const username = this.settings.username.trim();
    const moviesFolder = normalizeFolder(this.settings.moviesFolder);

    if (!username) {
      new Notice("Letterboxd sync: username missing.");
      return;
    }

    if (!moviesFolder) {
      new Notice("Letterboxd sync: movies folder missing.");
      return;
    }

    if (this.state.isSyncing) {
      if (showNotice) new Notice("Letterboxd sync already running.");
      return;
    }

    this.state.isSyncing = true;
    await this.savePluginData();

    const failures: string[] = [];
    let changedFiles = 0;
    let movieCount = 0;
    const changedMovieTitles: string[] = [];

    try {
      const entries = await fetchLetterboxdEntries(username);
      const grouped = groupEntriesByFilm(entries);
      await ensureFolder(this.app, moviesFolder);

      for (const [filmKey, movieEntries] of grouped) {
        try {
          const changed = await this.syncMovie(moviesFolder, filmKey, movieEntries);
          movieCount += 1;
          if (changed) {
            changedFiles += 1;
            changedMovieTitles.push(movieEntries[0]?.filmTitle ?? filmKey);
          }
        } catch (error) {
          failures.push(`${movieEntries[0]?.filmTitle ?? filmKey}: ${getErrorMessage(error)}`);
          console.error("Letterboxd movie sync failed", error);
        }
      }

      if (failures.length === 0) {
        this.state.lastSyncAt = Date.now();
      }

      const summary = failures.length > 0
        ? `Letterboxd sync: ${movieCount} checked, ${changedFiles} changed, ${failures.length} failed.`
        : formatSyncNotice(changedMovieTitles);
      if (showNotice || failures.length > 0) new Notice(summary);
      if (failures.length > 0) console.warn("Letterboxd sync failures", failures);
    } catch (error) {
      new Notice(`Letterboxd sync failed: ${getErrorMessage(error)}`);
      console.error("Letterboxd sync failed", error);
    } finally {
      this.state.isSyncing = false;
      await this.savePluginData();
    }
  }

  private async syncMovie(moviesFolder: string, filmKey: string, entries: ParsedLetterboxdEntry[]): Promise<boolean> {
    const sortedEntries = [...entries].sort(compareEntries);
    const firstEntry = sortedEntries[0];
    const path = await this.resolveMoviePath(moviesFolder, firstEntry);
    const existingFile = this.app.vault.getAbstractFileByPath(path);
    const existingContent = existingFile instanceof TFile ? await this.app.vault.read(existingFile) : "";
    const rendered = renderMovieNote(existingContent, firstEntry, sortedEntries, this.settings.linkWatchDates);

    if (rendered.content === existingContent) {
      this.state.movieIndex[filmKey] = path;
      return false;
    }

    let movieFile: TFile;
    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, rendered.content);
      movieFile = existingFile;
    } else {
      movieFile = await this.app.vault.create(path, rendered.content);
    }

    this.state.movieIndex[filmKey] = path;
    await this.forwardLinkWatchDateFile(movieFile, rendered.addedWatchDates);
    return true;
  }

  private async forwardLinkWatchDateFile(file: TFile, addedWatchDates: string[]) {
    if (!this.settings.forwardLinkWatchDates || addedWatchDates.length === 0) return;

    try {
      await waitForDateLinksToBeIndexed(this.app, file, addedWatchDates);
      const api = getForwardLinkerApi(this.app);
      const result = await api.forwardLinkFile(file);
      if (!isForwardLinkerResult(result)) {
        throw new Error("Forward Linker returned an invalid result.");
      }
      if (result.failed > 0) {
        throw new Error(`Forward Linker reported ${result.failed} failed link${result.failed === 1 ? "" : "s"}.`);
      }
    } catch (error) {
      try {
        await executeForwardLinkerCommandFallback(this.app, file);
        const message = `Letterboxd sync: used Forward Linker command fallback for ${file.path} after adding ${formatDateList(addedWatchDates)}.`;
        new Notice(message, 12000);
        console.warn(message, error);
      } catch (fallbackError) {
        const message = `Letterboxd sync: Forward Linker failed for ${file.path} after adding ${formatDateList(addedWatchDates)}: ${getErrorMessage(error)}; fallback failed: ${getErrorMessage(fallbackError)}`;
        new Notice(message, 12000);
        console.error(message, { apiError: error, fallbackError });
      }
    }
  }

  private async resolveMoviePath(moviesFolder: string, entry: ParsedLetterboxdEntry): Promise<string> {
    const indexedPath = this.state.movieIndex[entry.filmKey];
    if (indexedPath && this.app.vault.getAbstractFileByPath(indexedPath) instanceof TFile) {
      return indexedPath;
    }

    const filename = buildMovieFileName(entry.filmTitle, entry.filmYear);
    return `${moviesFolder}/${filename}`;
  }
}

class LetterboxdSyncSettingTab extends PluginSettingTab {
  plugin: LetterboxdSyncPlugin;

  constructor(app: App, plugin: LetterboxdSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions() {
    return [
      {
        type: "group",
        heading: "Letterboxd Sync",
        items: [
          {
            name: "Letterboxd username",
            desc: "Username only, not full URL.",
            control: { type: "text", key: "username", placeholder: "wren" },
          },
          {
            name: "Movies folder",
            desc: "Plugin creates nested folders when needed.",
            control: { type: "text", key: "moviesFolder", placeholder: "Movies" },
          },
          {
            name: "Sync frequency",
            desc: "Startup catch-up runs when interval has elapsed.",
            control: {
              type: "dropdown",
              key: "syncFrequencyMinutes",
              options: Object.fromEntries(
                Object.entries(FREQUENCY_OPTIONS).map(([label, minutes]) => [String(minutes), label]),
              ),
            },
          },
          {
            name: "Sync on startup",
            desc: "Syncs on app load if interval expired.",
            control: { type: "toggle", key: "syncOnStartup" },
          },
          {
            name: "Link watch dates",
            desc: "Render watch dates as [[YYYY-MM-DD]].",
            control: { type: "toggle", key: "linkWatchDates" },
          },
          {
            name: "Forward-link new watch dates",
            desc: "When new watched dates are added, call Reflect Forward Linker so daily notes can backlink the movie note.",
            control: { type: "toggle", key: "forwardLinkWatchDates" },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof PluginSettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "username" && typeof value === "string") {
      await this.plugin.updateSettings({ username: value.trim() });
      return;
    }

    if (key === "moviesFolder" && typeof value === "string") {
      await this.plugin.updateSettings({ moviesFolder: value });
      return;
    }

    if (key === "syncFrequencyMinutes" && typeof value === "string") {
      const syncFrequencyMinutes = Number(value);
      if (Object.values(FREQUENCY_OPTIONS).includes(syncFrequencyMinutes)) {
        await this.plugin.updateSettings({ syncFrequencyMinutes });
      }
      return;
    }

    if (
      (key === "syncOnStartup" || key === "linkWatchDates" || key === "forwardLinkWatchDates") &&
      typeof value === "boolean"
    ) {
      await this.plugin.updateSettings({ [key]: value });
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Letterboxd Sync").setHeading();
    containerEl.createEl("p", {
      text: "RSS only includes recent diary items. Keep plugin enabled for continuous history.",
    });

    new Setting(containerEl)
      .setName("Letterboxd username")
      .setDesc("Username only, not full URL.")
      .addText((text) =>
        text
          .setPlaceholder("wren")
          .setValue(this.plugin.settings.username)
          .onChange(async (value) => this.plugin.updateSettings({ username: value.trim() })),
      );

    new Setting(containerEl)
      .setName("Movies folder")
      .setDesc("Plugin creates nested folders when needed.")
      .addText((text) =>
        text
          .setPlaceholder("Movies")
          .setValue(this.plugin.settings.moviesFolder)
          .onChange(async (value) => this.plugin.updateSettings({ moviesFolder: value })),
      );

    new Setting(containerEl)
      .setName("Sync frequency")
      .setDesc("Startup catch-up runs when interval has elapsed.")
      .addDropdown((dropdown) => {
        for (const [label, minutes] of Object.entries(FREQUENCY_OPTIONS)) {
          dropdown.addOption(String(minutes), label);
        }
        dropdown
          .setValue(String(this.plugin.settings.syncFrequencyMinutes))
          .onChange(async (value) => this.plugin.updateSettings({ syncFrequencyMinutes: Number(value) }));
      });

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Syncs on app load if interval expired.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => this.plugin.updateSettings({ syncOnStartup: value })),
      );

    new Setting(containerEl)
      .setName("Link watch dates")
      .setDesc("Render watch dates as [[YYYY-MM-DD]].")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.linkWatchDates)
          .onChange(async (value) => this.plugin.updateSettings({ linkWatchDates: value })),
      );

    new Setting(containerEl)
      .setName("Forward-link new watch dates")
      .setDesc("When new watched dates are added, call Reflect Forward Linker so daily notes can backlink the movie note.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.forwardLinkWatchDates)
          .onChange(async (value) => this.plugin.updateSettings({ forwardLinkWatchDates: value })),
      );
  }
}

async function fetchLetterboxdEntries(username: string): Promise<ParsedLetterboxdEntry[]> {
  const response = await requestUrl({
    url: `https://letterboxd.com/${encodeURIComponent(username)}/rss/`,
    method: "GET",
    headers: { Accept: "application/rss+xml, application/xml, text/xml" },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`RSS request returned ${response.status}`);
  }

  return parseLetterboxdRss(response.text);
}

function parseLetterboxdRss(xml: string): ParsedLetterboxdEntry[] {
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const parseError = document.querySelector("parsererror");
  if (parseError) throw new Error("RSS XML parse failed");

  return Array.from(document.querySelectorAll("item"))
    .map((item) => parseRssItem(item))
    .filter((entry): entry is ParsedLetterboxdEntry => entry !== null);
}

function parseRssItem(item: Element): ParsedLetterboxdEntry | null {
  const filmTitle = getNodeText(item, "letterboxd\\:filmTitle, filmTitle") ?? inferTitle(getNodeText(item, "title"));
  const watchedDate = getWatchedDate(item);
  const link = normalizeLetterboxdUrl(getNodeText(item, "link") ?? "");
  const filmYear = normalizeYear(getNodeText(item, "letterboxd\\:filmYear, filmYear"));

  if (!filmTitle || !watchedDate || !link) return null;

  const rating = parseRating(getNodeText(item, "letterboxd\\:memberRating, memberRating"));
  const rewatch = parseBoolean(getNodeText(item, "letterboxd\\:rewatch, rewatch"));
  const reviewText = extractReviewText(getNodeText(item, "description"));
  const guid = getNodeText(item, "guid");
  const filmKey = canonicalizeLetterboxdFilmUrl(link);
  const entryKey = buildEntryKey(guid, filmKey, watchedDate, rating, rewatch, reviewText);

  return {
    filmTitle,
    filmYear,
    filmKey,
    letterboxdUri: filmKey,
    watchedDate,
    rating,
    rewatch,
    reviewText,
    entryKey,
  };
}

function getNodeText(parent: Element, selector: string): string | null {
  const node = parent.querySelector(selector);
  const text = node?.textContent?.trim();
  return text ? decodeHtml(text) : null;
}

function inferTitle(title: string | null): string | null {
  if (!title) return null;
  return title.replace(/^.*? watched /i, "").replace(/, \d{4}$/, "").trim() || title.trim();
}

function normalizeYear(year: string | null): string | null {
  const match = year?.match(/\d{4}/);
  return match?.[0] ?? null;
}

function normalizeDate(date: string): string | null {
  const match = date.match(/\d{4}-\d{2}-\d{2}/);
  if (match) return match[0];
  const naturalDate = parseNaturalDate(date);
  if (naturalDate) return naturalDate;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function parseNaturalDate(date: string): string | null {
  const months: Record<string, string> = {
    january: "01",
    february: "02",
    march: "03",
    april: "04",
    may: "05",
    june: "06",
    july: "07",
    august: "08",
    september: "09",
    october: "10",
    november: "11",
    december: "12",
  };
  const cleaned = normalizeWhitespace(date)
    .replace(/\.$/u, "")
    .replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+/iu, "");
  const match = cleaned.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/iu);
  if (!match) return null;

  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return null;
  return `${match[3]}-${month}-${String(day).padStart(2, "0")}`;
}

function getWatchedDate(item: Element): string | null {
  return (
    normalizeDate(getNodeText(item, "letterboxd\\:watchedDate, watchedDate") ?? "") ??
    extractWatchedDate(getNodeText(item, "description")) ??
    normalizeDate(getNodeText(item, "pubDate, dc\\:date") ?? "")
  );
}

function extractWatchedDate(description: string | null): string | null {
  if (!description) return null;
  const html = decodeHtml(description);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const watchedText = Array.from(doc.querySelectorAll("p"))
    .map((p) => normalizeWhitespace(p.textContent ?? ""))
    .find((text) => /^Watched on\b/i.test(text));
  const watchedDate = watchedText?.replace(/^Watched on\s+/i, "").replace(/\.$/u, "");
  return watchedDate ? normalizeDate(watchedDate) : null;
}

function normalizeLetterboxdUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  }
}

function canonicalizeLetterboxdFilmUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const filmIndex = parts.indexOf("film");
    if (filmIndex !== -1 && parts.length > filmIndex + 2 && /^\d+$/.test(parts[parts.length - 1])) {
      parts.pop();
      parsed.pathname = `/${parts.join("/")}/`;
    }
    return normalizeLetterboxdUrl(parsed.toString());
  } catch {
    return url.replace(/\/\d+$/u, "");
  }
}

function parseRating(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseBoolean(value: string | null): boolean {
  return value?.toLowerCase() === "yes" || value?.toLowerCase() === "true";
}

function extractReviewText(description: string | null): string | null {
  if (!description) return null;
  const html = decodeHtml(description);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = Array.from(doc.querySelectorAll("p"))
    .map((p) => normalizeWhitespace(p.textContent ?? ""))
    .filter((text) => text && !/^Watched on\b/i.test(text));

  const review = paragraphs.join(" ").trim();
  return review || null;
}

function decodeHtml(value: string): string {
  const textareaSource = value.replace(/<\/textarea/giu, "&lt;/textarea");
  const document = new DOMParser().parseFromString(`<textarea>${textareaSource}</textarea>`, "text/html");
  return document.querySelector("textarea")?.value ?? value;
}

function buildEntryKey(guid: string | null, filmKey: string, watchedDate: string, rating: number | null, rewatch: boolean, reviewText: string | null): string {
  if (guid?.trim()) return `guid:${guid.trim()}`;
  return `hash:${fnv1a([filmKey, watchedDate, rating ?? "", rewatch ? "1" : "0", normalizeWhitespace(reviewText ?? "")].join("|"))}`;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function groupEntriesByFilm(entries: ParsedLetterboxdEntry[]): Map<string, ParsedLetterboxdEntry[]> {
  const grouped = new Map<string, ParsedLetterboxdEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.filmKey) ?? [];
    list.push(entry);
    grouped.set(entry.filmKey, list);
  }
  return grouped;
}

function renderMovieNote(existingContent: string, entry: ParsedLetterboxdEntry, incomingEntries: ParsedLetterboxdEntry[], linkDates: boolean): RenderedMovieNote {
  const existing = parseNote(existingContent);
  const syncedKeys = readStringArray(existing.frontmatter.lb_synced_watches);
  const syncedKeySet = new Set(syncedKeys);
  const knownDates = readStringArray(existing.frontmatter.lb_watch_dates).filter(isIsoDate);
  const knownDateSet = new Set(knownDates);
  const existingWatches = parseExistingWatches(existing.body);
  const newEntries: ParsedLetterboxdEntry[] = [];

  for (const watch of [...incomingEntries].sort(compareEntries)) {
    if (isDuplicateWatch(watch, syncedKeySet, knownDateSet, existingWatches)) continue;
    newEntries.push(watch);
    syncedKeySet.add(watch.entryKey);
    knownDateSet.add(watch.watchedDate);
  }

  if (existingContent.length > 0 && newEntries.length === 0) {
    return { content: existingContent, addedWatchDates: [] };
  }

  const allKeys = [...syncedKeys, ...newEntries.map((watch) => watch.entryKey)];
  const allDates = [...knownDates, ...newEntries.map((watch) => watch.watchedDate)].sort();
  const uniqueDates = Array.from(new Set(allDates));
  const hasReview = Boolean(existing.frontmatter.review === "yes" || incomingEntries.some((watch) => watch.reviewText));
  const frontmatter = buildFrontmatter(existing.frontmatter, entry, allKeys, uniqueDates, hasReview, newEntries.length > 0 || existingContent.length === 0);
  const body = renderBody(existing.body, entry, newEntries, linkDates, existingContent.length === 0);

  return {
    content: `${renderFrontmatter(frontmatter)}\n${body}`.replace(/\s+$/u, "") + "\n",
    addedWatchDates: newEntries.map((watch) => watch.watchedDate),
  };
}

function parseNote(content: string): NoteParts {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 4);
  if (end === -1) return { frontmatter: {}, body: content };
  const yaml = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  return { frontmatter: parseSimpleYaml(yaml), body };
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const keyMatch = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!keyMatch) continue;

    const key = keyMatch[1];
    const rawValue = keyMatch[2] ?? "";
    if (rawValue === "") {
      const list: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const itemMatch = next.match(/^\s*-\s*(.*)$/);
        if (!itemMatch) break;
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

function parseYamlScalar(value: string): unknown {
  if (value === "\"\"" || value === "''") return "";
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return unquoteYaml(value);
}

function unquoteYaml(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return value;
}

function buildFrontmatter(existing: Record<string, unknown>, entry: ParsedLetterboxdEntry, syncedKeys: string[], dates: string[], hasReview: boolean, touched: boolean): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!MANAGED_FRONTMATTER_KEYS.has(key)) result[key] = value;
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
  result.watch_count = dates.length;
  result.first_watched = dates[0] ?? "";
  result.last_watched = dates[dates.length - 1] ?? "";
  result.lb_last_sync = touched || typeof existing.lb_last_sync !== "string" ? new Date().toISOString() : existing.lb_last_sync;
  result.lb_synced_watches = syncedKeys;
  result.lb_watch_dates = dates;

  return result;
}

function renderFrontmatter(frontmatter: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`- ${formatYamlScalar(item)}`);
    } else {
      lines.push(`${key}: ${formatYamlScalar(value)}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined || value === "") return '""';
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_./:#?=&%+-]+$/.test(text) && !/^(yes|no|true|false|null)$/i.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderBody(body: string, entry: ParsedLetterboxdEntry, newEntries: ParsedLetterboxdEntry[], linkDates: boolean, isNewNote: boolean): string {
  const cleanedBody = cleanWatchHistoryFields(body);

  if (isNewNote || body.trim() === "") {
    const heading = `# ${entry.filmTitle}${entry.filmYear ? ` (${entry.filmYear})` : ""}`;
    const historyLines = newEntries.map((watch) => renderWatchLine(watch, linkDates));
    return `${heading}\n\n#movies\n\n## Watch history\n\n${historyLines.join("\n")}\n\n## Notes\n`;
  }

  const history = findWatchHistorySection(cleanedBody);
  const linesToAppend = newEntries.map((watch) => renderWatchLine(watch, linkDates));
  if (linesToAppend.length === 0) return cleanedBody;

  if (!history) {
    const insert = `\n\n## Watch history\n\n${linesToAppend.join("\n")}\n`;
    return cleanedBody.replace(/\s*$/u, "") + insert;
  }

  const before = cleanedBody.slice(0, history.end).replace(/\s*$/u, "");
  const after = cleanedBody.slice(history.end);
  const separator = before.endsWith("## Watch history") ? "\n\n" : "\n";
  return `${before}${separator}${linesToAppend.join("\n")}${after.startsWith("\n") ? after : `\n${after}`}`;
}

function cleanWatchHistoryFields(body: string): string {
  const history = findWatchHistorySection(body);
  if (!history) return body;

  const section = body
    .slice(history.start, history.end)
    .replace(/\s+—\s+rating:\s*(?=\s+—|\n|$)/giu, "")
    .replace(/\s+—\s+review:\s*(?=\s+—|\n|$)/giu, "")
    .replace(/\s+—\s+rewatch:\s*(?!yes\b|true\b)[^—\n]*?(?=\s+—|\n|$)/giu, "");
  return body.slice(0, history.start) + section + body.slice(history.end);
}

function findWatchHistorySection(body: string): { start: number; end: number } | null {
  const headingMatch = /^## Watch history\s*$/im.exec(body);
  if (!headingMatch) return null;

  const afterHeading = headingMatch.index + headingMatch[0].length;
  const nextHeadingMatch = /^##\s+/im.exec(body.slice(afterHeading));
  const end = nextHeadingMatch ? afterHeading + nextHeadingMatch.index : body.length;
  return { start: headingMatch.index, end };
}

function renderWatchLine(watch: ParsedLetterboxdEntry, linkDates: boolean): string {
  const parts = [linkDates ? `[[${watch.watchedDate}]]` : watch.watchedDate];
  if (watch.rating !== null) parts.push(`rating: ${watch.rating}`);
  if (watch.rewatch) parts.push("rewatch: yes");
  const reviewText = watch.reviewText?.replace(/\s+/g, " ").trim();
  if (reviewText) parts.push(`review: ${reviewText}`);
  return `- ${parts.join(" — ")}`;
}

function isDuplicateWatch(watch: ParsedLetterboxdEntry, syncedKeySet: Set<string>, knownDateSet: Set<string>, existingWatches: ExistingWatch[]): boolean {
  if (syncedKeySet.has(watch.entryKey)) return true;
  if (knownDateSet.has(watch.watchedDate)) return true;
  return existingWatches.some((existingWatch) => existingWatch.watchedDate === watch.watchedDate);
}

function parseExistingWatches(body: string): ExistingWatch[] {
  return body
    .split("\n")
    .map((line) => parseExistingWatchLine(line))
    .filter((watch): watch is ExistingWatch => watch !== null);
}

function parseExistingWatchLine(line: string): ExistingWatch | null {
  const dateMatch = line.match(/^\s*-\s*(?:\[\[(?:[^\]\n]*\/)?(\d{4}-\d{2}-\d{2})(?:\|[^\]\n]*)?\]\]|\[(?:[^\]\n]*\/)?(\d{4}-\d{2}-\d{2})\]\(<?[^)\n>]*>?\)|(\d{4}-\d{2}-\d{2}))/);
  if (!dateMatch) return null;

  return {
    watchedDate: dateMatch[1] ?? dateMatch[2] ?? dateMatch[3],
  };
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item)).filter(Boolean);
}

function compareEntries(a: ParsedLetterboxdEntry, b: ParsedLetterboxdEntry): number {
  return a.watchedDate.localeCompare(b.watchedDate) || a.entryKey.localeCompare(b.entryKey);
}

function buildMovieFileName(title: string, year: string | null): string {
  const normalizedTitle = normalizeFilename(title) || "Untitled Movie";
  return year ? `${normalizedTitle} (${year}).md` : `${normalizedTitle}.md`;
}

function normalizeFilename(value: string): string {
  return value
    .replace(/[:/\\?*"<>|]/g, " - ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "");
}

function normalizeFolder(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => normalizeFilename(part))
    .filter(Boolean)
    .join("/");
}

async function ensureFolder(app: App, folderPath: string) {
  const parts = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

async function waitForDateLinksToBeIndexed(app: App, file: TFile, dates: string[]): Promise<void> {
  const pendingDates = Array.from(new Set(dates.filter(isIsoDate)));
  if (pendingDates.length === 0 || hasIndexedDateLinks(app, file, pendingDates)) return;

  await new Promise<void>((resolve) => {
    let resolved = false;
    let timeoutId: number | null = null;
    let changedRef: EventRef | null = null;
    let resolveRef: EventRef | null = null;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      if (changedRef) app.metadataCache.offref(changedRef);
      if (resolveRef) app.metadataCache.offref(resolveRef);
      resolve();
    };
    const check = (changedFile?: TFile) => {
      if (changedFile && changedFile.path !== file.path) return;
      if (hasIndexedDateLinks(app, file, pendingDates)) finish();
    };
    changedRef = app.metadataCache.on("changed", (changedFile) => check(changedFile));
    resolveRef = app.metadataCache.on("resolve", (resolvedFile) => check(resolvedFile));

    timeoutId = window.setTimeout(finish, FORWARD_LINKER_METADATA_TIMEOUT_MS);
    check();
  });
}

function hasIndexedDateLinks(app: App, file: TFile, dates: string[]): boolean {
  const cache = app.metadataCache.getFileCache(file);
  const indexedDates = new Set<string>();
  cache?.links?.forEach((link) => {
    const leaf = link.link.split("|")[0].split("/").pop() ?? link.link;
    const match = leaf.match(/^<?(\d{4}-\d{2}-\d{2})(?:\.md)?>?$/);
    if (match) indexedDates.add(match[1]);
  });

  return dates.every((date) => indexedDates.has(date));
}

function getForwardLinkerApi(app: App): ReflectForwardLinkerApi {
  const api = (app as App & { plugins?: { plugins?: Record<string, { api?: unknown }> } }).plugins?.plugins?.["reflect-forward-linker"]?.api;
  if (!isForwardLinkerApi(api)) {
    throw new Error("Reflect Forward Linker plugin is not enabled or API is unavailable.");
  }

  return api;
}

async function executeForwardLinkerCommandFallback(app: App, file: TFile): Promise<void> {
  const commands = (app as App & { commands?: ObsidianCommands }).commands;
  if (typeof commands?.executeCommandById !== "function") {
    throw new Error("Obsidian command API is unavailable.");
  }

  const listedCommands = typeof commands.listCommands === "function" ? commands.listCommands() : null;
  if (listedCommands && !listedCommands.some((command) => command.id === FORWARD_LINKER_COMMAND_ID)) {
    throw new Error("Forward Linker command is unavailable.");
  }

  const previousFile = app.workspace.getActiveFile();
  const leaf = app.workspace.getLeaf(false);
  try {
    await leaf.openFile(file, { active: true });
    app.workspace.setActiveLeaf(leaf, { focus: false });

    const executed = commands.executeCommandById(FORWARD_LINKER_COMMAND_ID);
    if (executed === false) {
      throw new Error("Forward Linker command declined to run.");
    }
  } finally {
    if (previousFile && previousFile.path !== file.path) {
      await leaf.openFile(previousFile, { active: true });
      app.workspace.setActiveLeaf(leaf, { focus: false });
    }
  }
}

function isForwardLinkerApi(api: unknown): api is ReflectForwardLinkerApi {
  return typeof api === "object" && api !== null && typeof (api as ReflectForwardLinkerApi).forwardLinkFile === "function";
}

function isForwardLinkerResult(result: unknown): result is ForwardLinkerResult {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as ForwardLinkerResult).added === "number" &&
    typeof (result as ForwardLinkerResult).skipped === "number" &&
    typeof (result as ForwardLinkerResult).failed === "number"
  );
}

function formatDateList(dates: string[]): string {
  return dates.length === 1 ? dates[0] : `${dates.length} watched dates`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
