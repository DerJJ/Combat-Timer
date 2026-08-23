# Foundry VTT Combat Timer

A Tampermonkey userscript for [Foundry VTT](https://foundryvtt.com/) that tracks how much time each player — and the GM — spends during combat. Runs entirely in your own browser: no module installation, no GM permission needed, nothing written to the server.

> Built with [Claude Sonnet 5](https://claude.ai/) (Anthropic).

## What it does

- Tracks time automatically as turns change, using Foundry's own combat tracker — no manual clock-starting required.
- Shows a small floating panel with live per-player totals, who's up next, and whether the game is currently paused.
- Separates real "thinking time" from time spent paused, and from setup/administrative overhead.
- Lets you re-categorize any slice of time after the fact: attribute it to a **Player**, the **GM**, the **Team** (shared/group time), or **Setup** (overhead) — including handing a slice to a *different* player than whoever's turn it technically was (e.g. an Attack of Opportunity).
- Merges multiple combatants belonging to the same player (a character plus their familiar/summon) into one entry.
- Automatically excludes turns from already-defeated monsters, so instantly-skipped dead combatants don't skew the averages.
- Uses each player's own Foundry-configured color for a consistent look.
- Posts two kinds of chat report — a bar chart of time per person, and a player overview with average turn length, average gap between turns, and total wait time. Both render identically for everyone in chat, whether or not they have this script installed.
- Keeps a short history: the current combat plus the last 2 finished ones, switchable via tabs, so you don't lose data when a new fight starts.
- Everything persists across page reloads and browser restarts (stored locally in your browser).

## Requirements

- The [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Firefox, Edge, etc.).
- Foundry VTT v13 or v14. Built and tested against v14; most of it should keep working on v13.
- Tuned for the **dnd5e** and **pf2e** game systems (player/NPC detection, etc.). Basic time tracking will likely work on other systems too, but hasn't been tested there.

## Installation

1. Install the Tampermonkey extension for your browser.
2. **Chrome/Edge/other Chromium browsers:** open `chrome://extensions`, find Tampermonkey, and make sure **"Allow User Scripts"** (sometimes shown as Developer Mode) is turned on. Without this, Chromium-based browsers silently refuse to run any userscript at all — Tampermonkey itself will usually show a banner about this in its dashboard if it's missing. Firefox doesn't need this step.
3. Open the Tampermonkey dashboard and create a new script (the **+** tab).
4. Delete the default template and paste in the full contents of `foundry-combat-timer.user.js`.
5. Near the top of the script, replace the placeholder `@match` lines with your own Foundry server URL(s):
   ```
   // @match        https://your-server.example.com/*
   ```
   Add one `@match` line per server you play on — there's no limit.
6. Save (Ctrl+S). Make sure the script's toggle is switched on in the Tampermonkey dashboard.
7. Open your Foundry server and refresh the page.

## Using it

### Opening the panel

The panel opens automatically. If you close it (✕), a small reopen button appears on the left edge of the screen, vertically centered — that's the way back in.

### The panel

- **🆕 / 🗑️** (top right): starts a new session (archiving the current one) when you're viewing "Now", or permanently deletes an archived session when viewing "-1"/"-2".
- **🧪**: loads randomized dummy data (3 players, 3 monsters, 3 rounds) so you can try out the panel and chat reports without a live combat. Only works when the current session is empty.
- **✕**: hides the panel (use the reopen button on the left edge to bring it back).
- **Session tabs** (🟢 Now / 📦 -1 / 📦 -2): switch which session's data is shown and posted to chat. Greyed-out tabs have no data yet.
- **✂️**: splits the currently running segment right now, e.g. to carve out a reaction or interrupt mid-turn so it can be categorized separately.
- **Segment list**: every tracked slice of time, each with four small icons (🧑 Player / 🎲 GM / 👥 Team / 🛠️ Setup) to change its category. Tapping 🧑 opens a picker so you can assign that time to *any* player, not just whoever's turn it technically was.

### Chat reports

Two buttons post a report to chat, visible only to you at first ("self roll" / whisper to yourself). Right-click your own message in the chat log and choose **Reveal to Everyone** if you want to share it — Foundry handles that natively, no extra step needed on our side.

- **📊 Post bar chart**: total time per player plus one combined GM bar, sorted by time spent.
- **🧑 Post player list**: per player, average turn length, average gap between their turns, and total time spent waiting.

### A new combat, a new session

Starting a new combat encounter automatically archives the previous session and starts tracking fresh. The last 2 sessions stay available under the "-1" / "-2" tabs so you can still post a report from a fight that already ended.

## Notes and limitations

- This is entirely **client-side**. It never writes anything to the Foundry server or world — everything lives in your own browser's local storage, scoped per Foundry world. If you want your own copy of the tracker, each person installs the script themselves; it doesn't sync between players or the GM.
- Chat reports use fixed, self-contained styling and don't depend on anyone else having this script installed — they'll look the same for everyone who sees them, in light or dark Foundry theme.
