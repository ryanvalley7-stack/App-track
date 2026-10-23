# Reminder server (Cloudflare Worker)

This small Worker sends the app's daily photo reminder as a push notification. It stores your push subscription, reminder time and time zone in Workers KV. A cron trigger runs every 15 minutes and sends any reminder that falls in that window, unless you've already logged a photo that day.

Everything here fits in Cloudflare's free plan, and no payment card is needed. The cron runs 96 times a day; each run does one KV list and one read per subscription, plus one write on days a reminder is sent. That is far below the free limits (100,000 Worker requests, 100,000 KV reads, 1,000 KV writes and 1,000 KV lists per day).

You need a computer with [Node.js](https://nodejs.org) 18 or newer and this repo cloned. Steps 1–7 take about 10 minutes and are done once.

## 1. Create a Cloudflare account

1. Go to <https://dash.cloudflare.com/sign-up>, and sign up with your email and a password.
2. Open the verification email and click the link.
3. You don't need to add a website or domain. Skip any "add a site" prompts. The free plan is the default.

## 2. Install and log in

In a terminal, from the repo folder:

```sh
cd worker
npm install
npx wrangler login
```

`wrangler login` opens a browser window. Click **Allow** to let Wrangler (Cloudflare's command-line tool) use your account.

## 3. Create the KV namespace

```sh
npx wrangler kv namespace create SUBS
```

It prints a block that includes a line like `id = "0f2b6c…"`. Open `worker/wrangler.toml` and replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` with that id. The id isn't secret, so it's fine to commit.

## 4. Set the app's address

In `worker/wrangler.toml`, set `APP_ORIGIN` to the address the app is hosted at. Use only the origin: scheme and host, no path, no trailing slash.

- GitHub Pages: `https://ryanvalley7-stack.github.io` (already filled in)
- Netlify: `https://your-site-name.netlify.app`

The Worker refuses requests from any other site.

## 5. Deploy the Worker

```sh
npx wrangler deploy
```

On your first deploy, Wrangler asks you to pick a `workers.dev` subdomain. Choose any name. At the end it prints your Worker's URL, for example:

```
https://gym-progress-push.yourname.workers.dev
```

Copy it, because you need it in step 7.

## 6. Generate VAPID keys and store them as secrets

VAPID keys identify your server to Apple's and Google's push services.

```sh
npm run vapid
```

This prints two lines:

```
VAPID_PUBLIC_KEY=BPx…
VAPID_PRIVATE_KEY=k3J…
```

Store each value as a Worker secret. Paste only the part after the `=` when Wrangler prompts you:

```sh
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT
```

For `VAPID_SUBJECT`, enter `mailto:` followed by your email, e.g. `mailto:you@example.com`. Push services use it to contact you if something goes wrong.

**Never put the private key in a file in this repo, in `wrangler.toml`, or in the app.** Secrets are encrypted by Cloudflare and only the Worker can read them. Close the terminal or clear it afterwards. If the private key ever leaks, run `npm run vapid` again, re-set both keys, and tap **Enable reminders** again in the app.

To check it worked, open `https://gym-progress-push.yourname.workers.dev/vapid-public-key` in a browser. It should show `{"key":"BPx…"}` with your public key.

## 7. Point the app at the Worker

Edit `js/config.js` in the repo root:

```js
export const PUSH_WORKER_URL = 'https://gym-progress-push.yourname.workers.dev';
```

Commit and push. GitHub Pages or Netlify redeploys the app in a minute or two. The URL isn't a secret.

## 8. Turn reminders on (iPhone)

1. Open Gym Progress **from its Home Screen icon**. iOS (16.4 or later) only allows notifications for apps added to the Home Screen, not for Safari tabs. If the app was already open, close it from the app switcher and reopen it, so it loads the new version.
2. Open the **Settings** tab, set **Remind me at**, and tap **Enable reminders**.
3. Tap **Allow** when iOS asks.
4. Tap **Send test**. It should arrive within a few seconds.

Reminders then come every day at that time, saying something like "Progress pic time. Day 12 streak." They're skipped on days you've already taken a photo. Tapping one opens the camera. Change the time in Settings at any time, or tap **Turn off**.

## Troubleshooting

- **No permission prompt:** make sure you opened the app from the Home Screen icon and that iOS is 16.4 or later. If you tapped **Don't Allow** before, enable notifications in the iPhone's **Settings → Notifications → Gym Progress**.
- **"Origin not allowed":** `APP_ORIGIN` in `wrangler.toml` doesn't match where the app is hosted. Fix it, then run `npx wrangler deploy` again.
- **"Couldn't reach the reminder server":** check the URL in `js/config.js`, and that `/vapid-public-key` loads in a browser.
- **Watch it run:** `npx wrangler tail` streams the Worker's logs live. You can also check the Cloudflare dashboard → **Workers & Pages → gym-progress-push → Logs**. Each cron run logs how many reminders it sent.

## Developing locally

```sh
npm test                           # unit tests: encryption, VAPID signing, schedule window
npx wrangler dev --test-scheduled  # runs the Worker on http://localhost:8787
```

For `wrangler dev`, create a `worker/.dev.vars` file (it's gitignored) with `VAPID_PUBLIC_KEY=…`, `VAPID_PRIVATE_KEY=…`, `VAPID_SUBJECT=mailto:…` and `APP_ORIGIN=http://localhost:8000`, one per line. To run the cron once, open `http://localhost:8787/__scheduled?cron=*/15+*+*+*+*`.

## API

| Request | Body | What it does |
| --- | --- | --- |
| `GET /vapid-public-key` | | Returns the public key the app subscribes with |
| `POST /subscribe` | `{ subscription, time, timezone, lastPhotoDay, streak }` | Saves or updates a subscription |
| `POST /unsubscribe` | `{ endpoint }` | Deletes it |
| `POST /logged` | `{ endpoint, lastPhotoDay, streak }` | Sent by the app when photos change, so today's reminder is skipped |
| `POST /test` | `{ endpoint }` | Sends a notification right away |

A subscription's endpoint is a long, unguessable URL issued by the push service, and knowing it is what authorizes changes to that subscription. Endpoints must belong to a known push service (Apple, Google, Mozilla or Microsoft). Subscriptions that the push service reports as expired are deleted automatically.
