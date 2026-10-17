# Recording the Pallas demo GIF (with fake data)

`docs/demo.gif` doesn't exist yet. This is how to make it **without showing any real grades, courses or calendar**.
Pallas can run against a fake Canvas (`scripts/demo-canvas.ts`): fictional courses DATA 101, ECON 210 and ENGL 150, with
dates relative to today so something is always due. Calendar features are switched off in demo mode.

## 1. Before you start: one bot per Photon line

Only one process may answer your Photon number. The demo runs on your Mac, so pause the live bot first
(the dashboard route is the same thing: Railway → canvas-bot → Deployments → ⋮ → Remove):

```sh
railway down -s canvas-bot -y        # stops the live deployment; the volume and variables stay
```

> I haven't run this stop/start pair myself. If anything looks off, use the dashboard.

## 2. Start the demo bot

From the repo, with your normal `.env` (PROVIDER=cloud, Photon credentials, ALLOWED_SENDERS = your number):

```sh
bun run demo
```

It starts the fake Canvas on `localhost:8787`, uses a throwaway database (`$TMPDIR/pallas-demo.db`), and clears
`ICLOUD_*`, `PUBLIC_URL` and `ENCRYPTION_KEY` so nothing real is reachable. You'll see `Pallas DEMO MODE` in the terminal.

## 3. Get the iPhone ready (privacy checklist)

- Turn on **Do Not Disturb / a Focus** so no notification slides into the recording.
- Open Messages, and check the conversation header: if the contact shows a real name or number you don't want in the GIF, rename the contact to **Pallas** first.
- Close other apps; set the screen to a plain wallpaper; hide the status-bar clock/battery by cropping (step 5).
- Add **Screen Recording** to Control Center if needed: Settings → Control Center → Screen Recording (+).

## 4. Record

Swipe into Control Center → tap the record button (3-second countdown) → open Messages → send these, waiting for each reply:

1. `what's due this week`  → instant (answered by code, no AI): Lab 5 and Problem Set 4
2. `what do I need on the final to get an A in econ 210`  → "need 93.1% on Final Exam", a tight, interesting one
3. `late policy in data 101`  → quotes the syllabus (10% per day, three days)
4. `any announcements`

Stop recording from the red status-bar pill. Aim for **under 30 seconds** of footage.

## 5. Turn it into a GIF (pick one)

**Easiest:** import the video into Photos → Share → save to Files, AirDrop it to your Mac, and drag it into [Gifski](https://gif.ski) (free in the Mac App Store). Width 480-600 px, 10-15 fps.

**Command line** (needs `brew install ffmpeg gifsicle`; the crop removes ~120 px from the top status bar):

```sh
ffmpeg -i demo.mov -vf "crop=iw:ih-120:0:120,fps=12,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" -loop 0 demo.gif
gifsicle -O3 --lossy=60 demo.gif -o docs/demo.gif
```

Keep it under ~8 MB (GitHub renders larger ones slowly). If it's too big: lower `fps` to 10 or `scale` to 480.

## 6. Add it to the README

In `README.md`, replace the line `*Demo GIF coming soon (see docs/DEMO.md).*` with:

```md
![Pallas answering questions over iMessage](docs/demo.gif)
```

Commit `docs/demo.gif` and the README change.

## 7. Put production back

Stop the demo with **Ctrl+C**, then:

```sh
railway redeploy -s canvas-bot --from-source -y     # pulls the latest commit from GitHub and starts it
```

Check `https://<your-domain>/health` says `ok` and text `/status` to the bot. The demo database lives in your temp folder
and is wiped on the next demo run; nothing from the demo touches the production database.
