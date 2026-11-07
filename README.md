# ISeeYou

ISeeYou is a macOS menu bar utility for inspecting audio and video files in Finder. It shows duration, codec, sample rate, bit depth, channels, resolution, nominal frame rate, bitrate, and the file's creation and modification dates when available. Audio files get a compact waveform sampled across the recording.

## Build

On macOS 13 or later, run this from the repository directory:

```sh
./build.sh "$PWD/ISeeYou.app"
```

The script uses macOS's built-in tools and ad hoc signs the resulting app. It requires no Xcode installation. Use a fresh output path if you've already built the app.

## Use

1. Move **ISeeYou.app** to Applications and open it. Look for the eye icon in the menu bar.
2. Select a file in Finder and press **⇧⌘E**, or choose **Finder → Services → Show ISeeYou**. For multiple files, use the picker in the inspector to switch between them.
3. Click **Preview** or press **⌘P** to open the selected file in Quick Look. Use **Copy Details** to copy a text report.
4. Press **Escape** to close the inspector. Use the menu bar icon to reopen the inspector, open a file, or quit.
5. Choose **Check for Updates…** from the eye menu to compare your installed version with the latest stable GitHub release. If a newer version is available, **View Release** opens its download page.

If the Finder shortcut is missing or conflicts with another command, assign **Show ISeeYou** under **System Settings → Keyboard → Keyboard Shortcuts → Services**. If you previously used Frame Info, quit the old app and disable its service if both shortcuts appear.

Use **Hold to Inspect** in the [ISeeYou Stream Deck plugin](https://github.com/theoverloadstudio/StreamDeckPlugins/tree/main/plugins/iseeyou) to show the current Finder selection while the key is held. Finder stays active. Release the key to hide the panel. When you select several files, use the picker to switch between them.

The waveform is a visual cue scaled to fit. Sampling can miss brief peaks in long files. File and preview support depend on the media formats macOS can read.

To distribute an update, build the app with the new version in `build.sh`, zip it with `ditto -c -k --keepParent ISeeYou.app ISeeYou.zip`, and attach the ZIP to a stable GitHub release tagged with that version, such as `v1.4`.
