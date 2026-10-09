# Shipping the iOS app

The app does not deploy from this repository, and merging to `main` does not ship it.
This is the manual path, and why it is manual.

## Why there is no deploy job

`deploy.yml` fires when CI succeeds on `main` and rolls the server out to Cloud Run.
`apps/ios` is in no Dockerfile, no compose service, and no turbo pipeline — so an iOS-only
commit produces a production rollout of byte-identical server behavior at a new SHA, and
the app changes go nowhere. That is expected, not a gap in the pipeline.

An iOS build has to be signed with an Apple Developer certificate and uploaded to App Store
Connect. Doing that from CI means putting a distribution certificate, its private key, a
provisioning profile, and an App Store Connect API key into repository secrets. That is a
real option (see [Automating it](#automating-it)) but it is a decision about where signing
material lives, not a missing workflow.

What CI *does* cover is `ios.yml`: it builds both targets and runs the test bundle on a
simulator for any change under `apps/ios/`. That proves the code compiles and the tests
pass. It produces nothing installable.

## What you need once

- Apple Developer Program membership on team `LY7X52447Z`.
- Three App IDs registered, matching the project's bundle identifiers:
  - `com.baldvinsmarason.assistant` — the app
  - `com.baldvinsmarason.assistant.AssistantActivityExtension` — the Live Activity widget
  - `com.baldvinsmarason.assistant.tests` — the test bundle (simulator only, no App ID needed)
- An App Store Connect record for `com.baldvinsmarason.assistant`.
- Automatic signing left on (`CODE_SIGN_STYLE = Automatic`), which is how the project ships.
  Xcode provisions both targets on first archive.

The app registers for remote notifications and declares the `aps-environment` entitlement.
The server has an APNs provider, enabled when `APNS_KEY_ID`, `APNS_TEAM_ID`,
`APNS_PRIVATE_KEY`, and `APNS_BUNDLE_ID` are configured. Set the bundle ID to the app's
registered identifier and use the matching Apple key and team. Confirm that the archived
app's signed entitlements contain the production APNs environment before release; the checked-in
entitlements file says `development` and is not proof of the archive's final signing value.
Notification permission is still requested from the owner in the app. The payloads use generic
lock-screen copy and open the authenticated app for details.

Live Activities are supported, but the app starts one only while an approval is waiting and the
pending approval count is positive. Ordinary work progress and completion stay in the app's
Activity view and notification path; they do not create a Dynamic Island activity. This is a
deliberate privacy and attention policy reflected in `LiveActivityManager.shouldPresentSystemActivity`.

## Releasing a build

1. Bump the version in the project's build settings. Both targets read the same values, so
   set them once at the project level:
   - `MARKETING_VERSION` — the user-visible version, currently `1.0`
   - `CURRENT_PROJECT_VERSION` — the build number, currently `1`. App Store Connect rejects
     a build number it has already seen for a given marketing version, so this always moves.
2. In Xcode, select **Any iOS Device (arm64)** as the destination. Archive is disabled while
   a simulator is selected.
3. **Product → Archive.** This builds the `Release` configuration, which is not what the
   simulator runs — the first archive after a run of Swift changes is where
   optimizer-only warnings and `#if DEBUG` mistakes surface.
4. In the Organizer window that opens: **Distribute App → TestFlight & App Store**.
5. Xcode signs, packages, and uploads. Processing in App Store Connect takes a few minutes;
   the build appears under TestFlight when it completes.
6. Add it to a tester group. External testers need a review pass; internal testers (up to 100
   people on the team) get it immediately.

## Before shipping the current branch

`docs/visual-qa.md` lists six findings still open. Five need a device to settle, and a build
you are about to hand to testers is the natural moment:

- **H6** — pull the menu open and check whether the grip handle is visible above the chat
  surface. If it is not, the swipe-to-close gesture has almost no target.
- **M1, M2** — check the crown against the real Dynamic Island, at default text size and at
  an accessibility size.
- **M3** — start a long-running turn and read the expanded island's centre label.
- **M8** — set text to the largest non-accessibility size and open the menu.

The project targets iPhone and iPad (`TARGETED_DEVICE_FAMILY = "1,2"`). The app's current
orientation declarations allow portrait on iPhone and portrait plus upside-down portrait on
iPad; they do not allow landscape. The iPad layout has not had a separate release qualification
in this guide. Decide its supported-device policy before changing the target family or
orientation contract, then verify the signed archive's supported orientations.

## Automating it

If you decide the signing material can live in repository secrets, the shape is:

- Export the distribution certificate as a `.p12` and store it base64-encoded, with its
  password.
- Create an App Store Connect API key (Keys tab, App Manager role) and store the `.p8`, its
  key ID, and the issuer ID.
- Add a macOS workflow triggered on a version tag that imports the certificate into a
  temporary keychain, runs `xcodebuild archive` then `-exportArchive` with an
  `ExportOptions.plist` set to `app-store-connect`, and uploads with
  `xcrun altool --upload-app` or `xcrun notarytool`'s App Store equivalent.

The certificate expires annually and the workflow fails opaquely when it does, so this is
worth doing when release frequency justifies the maintenance — not before.
