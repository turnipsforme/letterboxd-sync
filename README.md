# Letterboxd Sync

Obsidian plugin to sync Letterboxd RSS watches into one note per movie.

## Install

Once the plugin is available in the Obsidian Community directory, install and enable **Letterboxd Sync** from **Settings → Community plugins**.

For a manual installation:

1. Build the plugin.
2. Copy `main.js` and `manifest.json` into `.obsidian/plugins/letterboxd-sync/`.
3. Enable the plugin in Obsidian.

## Use

1. Set your Letterboxd username in plugin settings.
2. Set the movies folder.
3. Run `Letterboxd Sync: Sync now` or wait for the timer.

## Network use

Letterboxd Sync connects to Letterboxd to download the public RSS feed for the username you provide. No Letterboxd sign-in is required. The plugin does not send vault contents or collect telemetry.

If you enable **Forward-link new watch dates**, the plugin also works with the separately installed Reflect Forward Linker plugin inside Obsidian. This integration does not add another network request.

## License

MIT
