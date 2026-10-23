# Gym Progress

A small installable web app for taking before/after gym photos and comparing them side by side. No accounts, no server: photos stay on your device.

## Features

- **Camera capture** with a 3:4 portrait crop so every photo lines up
  - **Ghost overlay** of your last photo for the same pose, to match position and distance
  - Rule-of-thirds grid, 3s/10s self-timer, front/back camera flip
  - Upload from your photo library instead (the original date is kept)
- **Poses**: Front, Side, Back, Flex, each tracked separately
- **Compare**, in three modes:
  - **Dates**: any two photos, with days between them and the weight change
  - **Periods**: compare one month against another (e.g. Sep vs Oct), or a custom range of months on each side. Each side uses the photo closest to the start of its period, and you can pick a different photo from inside it. Shows the average bodyweight for each period (each day averaged first, across all poses) and the change between them.
  - **Timeline**: one photo per month for a pose in a horizontal strip you can scroll. Tap any two months to compare them side by side.
  - Every mode supports **Side by side** and a **Slider** you drag to reveal before vs. after
  - **Save comparison image** exports one labelled side-by-side JPG, with each side labelled by its date or period (uses the share sheet on phones)
- **Gallery** of every photo, with set-as-before/after and delete
- **Backup & restore**: one `.zip` with every photo plus dates, weights and notes. You can save it to Files, iCloud Drive or Google Drive and restore it on any phone. A dot on **Backup** reminds you when you have new photos that aren't backed up.
- **Daily reminder**: pick a time in Settings and add a repeating daily calendar event with an alert, linking back to the app (see below)
- **Streak**: the home screen shows how many days in a row you've logged a photo, and a banner appears if today's photo isn't taken yet
- **Photo guidance**: a quick tap-through checklist before the camera opens (with "Don't show again today"), plus a "How to take good progress photos" page in Settings explaining why each tip matters
- lb/kg setting, works offline once loaded

## Daily reminders

A web app with no server can't send push notifications, so the reminder lives in your phone's calendar instead:

1. Open **Settings** (the sliders icon at the top right) and set **Remind me at**.
2. Tap **Add to Calendar**. On iPhone, tap **Allow**, then **Add All**. If nothing opens, tap **Share…** and send the file to yourself in Mail or Messages, then tap the attachment.
3. You get a daily alert at that time. The event's link opens the app straight to the camera.

To change the time, add it again and delete the old event in Calendar. On iPhone, calendar links open in Safari, which keeps separate storage from the home-screen app, so open the app from its icon to take the photo.

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

1. Tap **Backup**, then **Create backup**.
2. Tap **Save / Share…** and choose **Save to Files** (iPhone) or Drive, or tap **Download**.
3. To restore, for example on a new phone, tap **Backup**, then **Restore from backup**, and pick the `.zip`. Photos already on the phone are skipped.

The backup is a normal zip: a `photos/` folder of JPGs and a `backup.json` holding the pose, date, weight and note for each photo.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell and tab bar |
| `styles.css` | All styling |
| `js/app.js` | Views (compare modes, capture, gallery, settings, tips), camera, and export |
| `js/db.js` | IndexedDB wrapper |
| `js/zip.js` | Zip writer and reader for backups |
| `js/reminders.js` | Streak calculation and the daily reminder `.ics` |
| `js/guide.js` | Photo tips used by the checklist and tips page |
| `js/periods.js` | Month periods, photo selection and average weight for Periods and Timeline |
| `sw.js` | Offline cache for the app shell |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata |
