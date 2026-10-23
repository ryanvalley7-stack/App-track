# Gym Progress

A small installable web app for taking before/after gym photos and comparing them side by side. No accounts, no server: photos stay on your device.

## Features

- **Camera capture** with a 3:4 portrait crop so every photo lines up
  - **Ghost overlay** of your last photo for the same pose, to match position and distance
  - Rule-of-thirds grid, 3s/10s self-timer, front/back camera flip
  - Upload from your photo library instead (the original date is kept)
- **Poses**: Front, Side, Back, Flex, each tracked separately
- **Compare**
  - Pick a pose with the big tabs at the top, then tap the **Before** or **After** slot to choose a photo from a grid of thumbnails (newest first, date under each)
  - Quick picks: **First vs latest**, **Last 30 days**, **Last 90 days** (latest photo against the one taken closest to 30 or 90 days ago)
  - **Side by side** or a **Slider** you drag to reveal before vs. after, with the days between photos and the weight change
  - Each pose remembers its own picks; a pose with one photo fills only Before
  - **Save comparison image** exports one labelled side-by-side JPG (uses the share sheet on phones)
- **Gallery** of every photo grouped by month, with each month's average weight. Tap a photo to set it as Before or After, or delete it.
- **Meals** tab: reserved for meal tracking (coming soon)
- **Backup & restore** (in Settings): one `.zip` with every photo plus dates, weights and notes. You can save it to Files, iCloud Drive or Google Drive and restore it on any phone. A dot on the **Settings** tab reminds you when you have new photos that aren't backed up.
- **Daily reminder**: a push notification at the time you pick, like "Progress pic time. Day 12 streak." It's skipped on days you've already taken a photo, and tapping it opens the camera (see below)
- **Streak**: the home screen shows how many days in a row you've logged a photo, and a banner appears if today's photo isn't taken yet
- **Photo guidance**: a quick tap-through checklist before the camera opens (with "Don't show again today"), plus a "How to take good progress photos" page in Settings explaining why each tip matters
- lb/kg setting, works offline once loaded
- Built for the iPhone home screen: respects the notch and home bar, no accidental zoom, no page bounce behind sheets, 44pt+ tap targets, and animations that follow Reduce Motion

## Daily reminders

Reminders are real push notifications, sent by a small free Cloudflare Worker in [`worker/`](worker/). The app itself has no server, so the Worker remembers your reminder time and sends the notification. Only your push subscription, reminder time, time zone, latest photo date and streak count are sent to it, never photos.

1. Set up the Worker once by following [`worker/README.md`](worker/README.md). It takes about 10 minutes on Cloudflare's free plan and ends with putting the Worker URL in `js/config.js`.
2. On iPhone (iOS 16.4 or later), open the app **from its Home Screen icon**, open the **Settings** tab, set **Remind me at**, and tap **Enable reminders**.
3. Tap **Send test** to check it works. **Turn off** stops reminders.

## Install it on your phone

It's a web app, so there's no app store. You put it on a website once, then add it to your home screen, where it opens full-screen and works offline like a normal app.

### 1. Put it online (one time)

The camera needs an `https://` address. Pick one option:

**Option A: GitHub Pages (free).** GitHub Pages on a private repo needs a paid GitHub plan, so on a free account you first make the repo public. Only the app's code is in the repo; your photos never leave your phone.
1. Go to the repo's **Settings → General**, then under **Danger Zone** choose **Change visibility → Public**.
2. Go to **Settings → Pages**. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick the branch, keep the folder at `/ (root)`, and **Save**.
3. After about a minute the page shows your link, for example `https://ryanvalley7-stack.github.io/App-track/`.

**Option B: Netlify (free, repo stays private).** Sign in at netlify.com with GitHub, choose **Add new site → Import an existing project**, and pick this repo. Leave the build command empty and set the publish directory to `/`. Netlify gives you an `https://….netlify.app` link and redeploys whenever the repo changes.

### 2. Add it to your home screen

- **iPhone:** open the link in **Safari**, tap the **Share** button, then **Add to Home Screen**.
- **Android:** open the link in **Chrome**, tap **⋮**, then **Install app** (or **Add to Home screen**).

Open it from the new icon and allow camera access when it asks.

### Run it locally

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Storage and backups

Photos are stored in the browser's IndexedDB on that device, resized to at most 1600px. The app asks the browser to keep this storage persistent. Clearing site data for the app, or deleting it from your home screen, deletes your photos, so back up regularly:

1. Open the **Settings** tab, tap **Backup & restore**, then **Create backup**.
2. Tap **Save / Share…** and choose **Save to Files** (iPhone) or Drive, or tap **Download**.
3. To restore, for example on a new phone, go to **Settings → Backup & restore → Restore from backup** and pick the `.zip`. Photos already on the phone are skipped.

The backup is a normal zip: a `photos/` folder of JPGs and a `backup.json` holding the pose, date, weight and note for each photo.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell: header, scroll area and the five-tab bar |
| `styles.css` | All styling |
| `js/app.js` | Views (compare, camera, gallery, meals, settings, tips), sheets, camera, and export |
| `js/db.js` | IndexedDB wrapper |
| `js/zip.js` | Zip writer and reader for backups |
| `js/streak.js` | Streak calculation |
| `js/push.js` | Push subscription and talking to the reminder Worker |
| `js/config.js` | URL of your reminder Worker |
| `js/guide.js` | Photo tips used by the checklist and tips page |
| `js/periods.js` | Month grouping and average weight for the gallery |
| `sw.js` | Offline cache for the app shell; shows reminder notifications and opens the camera when tapped |
| `worker/` | Cloudflare Worker that sends the daily reminders ([setup](worker/README.md)) |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata |
