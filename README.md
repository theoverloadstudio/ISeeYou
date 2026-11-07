# ISeeYou

ISeeYou shows the Codex quota included with your ChatGPT sign-in. Two compact meters in the macOS menu bar show your weekly and session limits. The fill represents quota used and the tick marks how much of the window has elapsed.

Double-click **ISeeYou.app** to open the usage panel. Close the panel to leave the meters running in the menu bar, then click **Week / Session** to see the percentages, countdowns, and local reset times again. If your menu bar is crowded, double-click the app in Finder to reopen the panel. ISeeYou runs without a Dock icon.

The panel highlights when your usage is ahead of the window's pace. It refreshes every two minutes and offers a **Refresh** button for a new reading. If a refresh fails, the panel marks the last reading as stale.

Requires macOS 13 or later and the ChatGPT desktop app with Codex, or a Codex CLI signed in with ChatGPT. Usage comes from the local Codex app server.

Build on a Mac with `bash build.sh`, then open the resulting **ISeeYou.app**. The build uses tools bundled with macOS.
