---
description: Build, sign, and deploy iOS apps with xtool, the cross-platform Xcode replacement CLI. Use when the user asks to create, build, run, or install an iOS app on a physical iPhone/iPad without paying for the Apple Developer Program, or when xtool commands come up.
---

# xtool

xtool (https://github.com/xtool-org/xtool, docs at https://xtool.sh) is a cross-platform Xcode replacement: it builds SwiftPM packages into iOS `.ipa` files, signs them, and installs/launches them on real devices over USB. It replaces the Xcode build system, provisioning, and deployment orchestration, not the SDK.

## Install state on this machine

- App bundle: `~/Developer/xtool.app` (installed 2026-11-23, version 1.24.0)
- CLI on PATH: `/opt/homebrew/bin/xtool` -> symlink to `~/Developer/xtool.app/Contents/Resources/bin/xtool` (a launcher script; always invoke `xtool`, never the binary inside `Contents/MacOS/` directly — it hangs without app context)
- Verify: `xtool --version`, `xtool --help`
- Update: download `xtool.app.zip` from https://github.com/xtool-org/xtool/releases/latest, replace `~/Developer/xtool.app`. The PATH symlink keeps working. (xtool 2.0 is in beta on `main`; stable channel is 1.x.)

## Hard prerequisite: Xcode is still required on macOS

xtool does NOT ship or extract the iOS SDK on macOS — `xtool sdk install` is skipped on macOS ("the iOS SDK ships with Xcode on macOS"). Without Xcode.app there is no `iphoneos` SDK and no iOS `swiftc`, so iOS builds fail.

Check before any iOS build:

```bash
xcode-select -p                                        # must be .../Xcode.app/Contents/Developer
xcrun -sdk iphoneos -show-sdk-path                     # must print .../iPhoneOS*.sdk
xcodebuild -version                                    # must print a version, not an error
```

If Xcode is missing, the user must install it (free, no paid account needed): Mac App Store "Xcode", or `Xcode.xip` from https://developer.apple.com/download/all/?q=Xcode (requires free Apple ID sign-in), then launch once and accept the license. Point `xcode-select` at it if needed: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

## Setup (one time, interactive — needs the user's Apple ID)

```bash
xtool setup
```

Login modes:

- `0` API Key — requires PAID Apple Developer Program membership. Not the user's case.
- `1` Password — works with any free Apple ID via private Apple APIs. This is the mode to use. Recommend a throwaway Apple ID since private APIs could break or be revoked by Apple.

Credentials (email + password + 2FA code) are prompted interactively and sent only to Apple. The agent cannot complete this step without the user's credentials — ask the user to run `xtool setup` themselves or provide input when prompted.

## Everyday workflow

```bash
xtool new MyApp                  # scaffold a SwiftPM iOS app (interactive prompts)
cd MyApp
xtool dev                       # build, sign, install, and launch on connected iPhone
xtool devices                   # list connected devices
xtool install path/to/app.ipa   # install an existing .ipa
xtool launch / xtool uninstall  # manage installed apps
xtool auth                      # inspect/re-login Apple auth
xtool ds ...                    # App Store Connect / Developer Services queries
```

`xtool dev` needs the iPhone connected by USB and trusted. First run registers the device with the free provisioning profile.

## Free-account limits (set expectations honestly)

- Provisioning profiles expire every 7 days — the app stops launching after that; re-run `xtool dev` to re-sign and reinstall.
- Free provisioning allows a small number of App IDs and registered devices; capabilities like Push Notifications, App Groups, HealthKit etc. are unavailable or limited.
- No App Store / TestFlight distribution.
- Password auth relies on private APIs — it can break without notice; `xtool auth` re-login is the fix.

## Agent rules

- Never print, store, or echo Apple ID credentials. Let the user type them at the `xtool setup` prompt.
- Before claiming an iOS build works, verify with `xtool dev` output or `xtool devices` + install logs, not just `swift build` for macOS.
- Swift code lives in a standard SwiftPM package; `Package.swift` plus `Sources/<App>/` with an `@main` App entry point. See `xtool new` output and https://xtool.sh/tutorials/xtooldocs/first-app for the expected layout.
