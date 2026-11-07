#!/bin/zsh
set -eu
src=${0:A:h}
app=${1:?Pass a new path ending in .app}
[[ ! -e "$app" ]] || { print -u2 "Choose a new output path."; exit 1; }
/usr/bin/osacompile -l JavaScript -s -o "$app" "$src/ISeeYou.js"
p="$app/Contents/Info.plist"
for key in $(/usr/libexec/PlistBuddy -c Print "$p" | /usr/bin/awk '/UsageDescription/{print $1}'); do
  /usr/libexec/PlistBuddy -c "Delete :$key" "$p"
done
/usr/bin/plutil -replace CFBundleName -string 'ISeeYou' "$p"
/usr/bin/plutil -insert CFBundleDisplayName -string 'ISeeYou' "$p"
/usr/bin/plutil -insert CFBundleIdentifier -string 'com.theoverloadstudio.iseeyou' "$p"
/usr/bin/plutil -insert CFBundleVersion -string '6' "$p"
/usr/bin/plutil -insert CFBundleShortVersionString -string '1.5' "$p"
/usr/bin/plutil -insert ISeeYouStreamDeckProtocol -integer 2 "$p"
/usr/bin/plutil -insert LSMinimumSystemVersion -string '13.0' "$p"
/usr/bin/plutil -insert LSUIElement -bool YES "$p"
/usr/bin/plutil -insert NSHighResolutionCapable -bool YES "$p"
/usr/bin/plutil -insert NSServices -xml '<array><dict>
  <key>NSMessage</key><string>inspect</string>
  <key>NSPortName</key><string>ISeeYou</string>
  <key>NSMenuItem</key><dict><key>default</key><string>Show ISeeYou</string></dict>
  <key>NSKeyEquivalent</key><dict><key>default</key><string>E</string></dict>
  <key>NSSendFileTypes</key><array><string>public.item</string></array>
  <key>NSSendTypes</key><array><string>NSFilenamesPboardType</string></array>
  <key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
  <key>NSServiceDescription</key><string>Show detailed audio and video metadata for the selected files.</string>
</dict></array>' "$p"
if [[ -f "$src/ISeeYou.icns" ]]; then
  /bin/cp "$src/ISeeYou.icns" "$app/Contents/Resources/ISeeYou.icns"
  /usr/bin/plutil -replace CFBundleIconFile -string ISeeYou "$p"
fi
/bin/cp "$src/Waveform.js" "$app/Contents/Resources/Waveform.js"
/bin/cp "$src/CheckForUpdates.js" "$app/Contents/Resources/CheckForUpdates.js"
/usr/bin/plutil -lint "$p"
/usr/bin/codesign --force --sign - "$app"
/usr/bin/codesign --verify --strict "$app"
