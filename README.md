# Gym Progress

A small installable web app for taking before/after gym photos and comparing them side by side. No accounts, no server: photos stay on your device.

## Features

- **Camera capture** with a 3:4 portrait crop so every photo lines up
  - **Ghost overlay** of your last photo for the same pose, to match position and distance
  - Rule-of-thirds grid, 3s/10s self-timer, front/back camera flip
  - Upload from your photo library instead (the original date is kept)
- **Poses**: Front, Side, Back, Flex, each tracked separately
- **Compare**
  - **Side by side** with Before/After labels, dates, and weights
  - **Slider** mode: drag to reveal before vs. after
  - Shows days between photos and weight change
  - **Save comparison image**: exports one labelled side-by-side JPG (uses the share sheet on phones)
- **Gallery** of every photo, with set-as-before/after and delete
- lb/kg toggle, works offline once loaded

## Run it

It's a static site with no build step and no dependencies.

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

The camera needs HTTPS (or `localhost`). To use it on your phone, host the folder on any static HTTPS host, such as GitHub Pages (Settings → Pages → deploy from branch). Then open it in Safari or Chrome and choose **Add to Home Screen** so it opens like a normal app.

## Storage

Photos are stored in the browser's IndexedDB on that device, resized to at most 1600px. The app asks the browser to keep this storage persistent. Clearing site data for the app, or uninstalling it, deletes your photos. Use **Save comparison image** to keep copies of the comparisons you care about.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell and tab bar |
| `styles.css` | All styling |
| `js/app.js` | Views (compare, capture, gallery), camera, and export |
| `js/db.js` | IndexedDB wrapper |
| `sw.js` | Offline cache for the app shell |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata |
