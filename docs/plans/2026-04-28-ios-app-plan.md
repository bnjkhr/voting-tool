# Voting Tool iOS App Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the existing Voting Tool as a private iOS app on one personal device with the least new code and lowest operational risk.

**Architecture:** Build a small native SwiftUI app that wraps the already deployed Voting Tool in `WKWebView`. Keep the current Vercel/Express/Firebase backend and the current `public/` frontend as the source of truth; the iOS app is only a native shell, launch surface, and device install target.

**Tech Stack:** SwiftUI, WebKit `WKWebView`, Xcode automatic signing, existing Vercel deployment, existing Express API, existing Firebase/Firestore data.

---

## Recommendation

Use a native `WKWebView` wrapper first.

This is the fastest path because the repository is already a responsive web app:

- `public/index.html` already includes iOS web-app metadata and mobile viewport settings.
- `public/style.css` already has mobile breakpoints and safe-area handling.
- `public/script.js` uses relative API calls such as `/api/apps`, `/api/apps/:appId/suggestions`, votes, comments, roadmap, changelog, and uploads.
- `api/index.js` already exposes the app and API from one deployed host through Vercel.

Do not start with a full SwiftUI rewrite. It would duplicate the frontend state machine, screenshot compression, voting behavior, comments, roadmap/changelog views, admin-related flows, and API mapping before we get any value on the device.

## Distribution Assumption

For “erstmal nur für mich auf meinem Gerät”, use Xcode direct install with automatic signing. Apple’s current documentation says you can install apps on your personal device with Xcode without joining the paid Apple Developer Program; paid membership is needed for broader distribution, TestFlight, App Store, and some capabilities.

If the app should stay installed long-term without frequent redeploys, or if it should go to more devices, upgrade to the paid Apple Developer Program and use registered-device distribution or TestFlight.

## Options Considered

### Option A: Add To Home Screen / PWA polish

Effort: 30-60 minutes.

Pros:
- No Xcode project.
- No signing.
- Uses the current deployment directly.

Cons:
- Not a real app binary.
- Less control over native navigation, app lifecycle, loading states, and future native features.
- Still feels like Safari in several edge cases.

Use only if “app icon on my phone” is enough.

### Option B: SwiftUI + WKWebView wrapper

Effort: 2-4 hours for a clean first version.

Pros:
- Real iOS app installed from Xcode.
- Reuses the current web app and backend.
- Minimal maintenance.
- Can later add native affordances incrementally.

Cons:
- Still depends on the deployed web app being online.
- Native offline behavior is limited unless the web app gets explicit offline support later.

Recommended.

### Option C: Full native SwiftUI client

Effort: several days for feature parity.

Pros:
- Best native feel.
- Clean path to native notifications, widgets, offline cache, and OS integrations.

Cons:
- Reimplements a lot of working JavaScript UI and validation.
- Requires API client layer, models, state management, form handling, image handling, and test coverage.

Defer until the wrapper proves useful and the desired native-only features are clear.

## Proposed File Structure

- Create: `ios/VotingTool/VotingTool.xcodeproj`
  Xcode project for the private iOS app.
- Create: `ios/VotingTool/VotingTool/VotingToolApp.swift`
  SwiftUI app entry point.
- Create: `ios/VotingTool/VotingTool/ContentView.swift`
  Root screen that hosts the web view and connection/loading state.
- Create: `ios/VotingTool/VotingTool/VotingWebView.swift`
  `UIViewRepresentable` wrapper around `WKWebView`.
- Create: `ios/VotingTool/VotingTool/WebViewModel.swift`
  Observable loading/error/reload state and the configured production URL.
- Create: `ios/VotingTool/VotingTool/Info.plist`
  App transport, camera/photo usage strings for screenshot/file upload, display name.
- Create: `ios/VotingTool/README.md`
  Local install instructions for the personal device.
- Optional modify: `public/index.html`
  Add/verify app icon metadata only if the same polish is also useful for Home Screen/PWA.
- Optional create: `public/manifest.webmanifest`
  Only needed if we want a better PWA fallback.

## Implementation Tasks

### Task 1: Confirm the hosted URL

- [ ] Decide the production URL the app should open, for example `https://<your-voting-tool>.vercel.app/`.
- [ ] Open that URL on iPhone Safari and verify app selection, voting, creating entries, screenshots, comments, roadmap, changelog, and dark mode.
- [ ] Confirm all API calls stay same-origin. Current code uses relative fetch paths, so a hosted URL is the right base.

### Task 2: Create the Xcode app shell

- [ ] Create a new iOS App project under `ios/VotingTool`.
- [ ] Product name: `VotingTool`.
- [ ] Interface: SwiftUI.
- [ ] Language: Swift.
- [ ] Bundle identifier: `de.benkohler.votingtool` or another unique personal identifier.
- [ ] Minimum iOS target: latest practical target on your device; iOS 17+ is fine unless your device requires lower.
- [ ] Enable automatic signing with your Apple Account / Personal Team.

### Task 3: Add the web view wrapper

- [ ] Implement `VotingWebView` using `WKWebView`.
- [ ] Load the production Voting Tool URL with `URLRequest`.
- [ ] Use `WKWebsiteDataStore.default()` so cookies, local storage, and the web app’s `localStorage` state persist.
- [ ] Allow JavaScript, file uploads, and normal web navigation.
- [ ] Keep external non-HTTP(S) links out of the web view and open them through the system.
- [ ] Add a simple loading indicator and an error/retry view in SwiftUI.

### Task 4: Configure app permissions and network policy

- [ ] Keep App Transport Security strict if the Voting Tool URL is HTTPS.
- [ ] Do not add broad arbitrary-load exceptions unless local HTTP development inside the app is required.
- [ ] Add `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` because the web app supports screenshot/file selection for bug reports and comments.
- [ ] Set display name, app icon placeholders, supported orientations, and accent color.

### Task 5: Device install

- [ ] Connect the iPhone to the Mac.
- [ ] Trust the Mac on the device if prompted.
- [ ] In Xcode, select the physical iPhone as the run destination.
- [ ] Build and Run.
- [ ] Enable Developer Mode on the device if iOS asks for it.
- [ ] Verify the icon launches directly into the Voting Tool.

### Task 6: Smoke test on device

- [ ] Load app list.
- [ ] Open one app board.
- [ ] Switch between Einträge, Roadmap, and Changelog.
- [ ] Submit a feature suggestion.
- [ ] Submit or draft a bug with a screenshot.
- [ ] Vote and unvote if the UI supports it.
- [ ] Add a public comment with and without screenshot.
- [ ] Toggle dark mode, quit the app, reopen, and verify state persists.
- [ ] Test poor-network behavior by disabling Wi-Fi/cellular briefly and using retry.

### Task 7: Document personal maintenance

- [ ] Add `ios/VotingTool/README.md` with:
  - required Xcode version,
  - Apple Account signing setup,
  - bundle identifier,
  - production URL,
  - device install steps,
  - known limitation that the app is a web wrapper,
  - note that broader distribution needs Apple Developer Program/TestFlight/App Store.

## Follow-Up Enhancements

- Add pull-to-refresh.
- Add native share sheet for suggestion links.
- Add native push notifications only after joining the paid Apple Developer Program and deciding on notification semantics.
- Add offline read cache only if real offline use becomes important.
- Add deep links/universal links only if boards or suggestions should open from email directly into the app.
- Later, replace individual screens with native SwiftUI one at a time if needed.

## Fastest Execution Order

1. Verify deployed web app on iPhone Safari.
2. Create Xcode SwiftUI shell.
3. Add `WKWebView` wrapper and load production URL.
4. Add permissions, icon, display name.
5. Install on device from Xcode.
6. Smoke test critical flows.
7. Write the iOS README.

Expected first usable app: same day, likely under half a day if signing is straightforward.

