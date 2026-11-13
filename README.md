# own downloader

A local web app to download videos from **YouTube, TikTok, Instagram and Facebook** — with quality selection, MP3 audio extraction and live progress.

## Quick start

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

## Requirements (already installed on this machine)

| Tool | Purpose |
|------|---------|
| Node.js | Runs the server |
| Python 3.12 | Hosts yt-dlp (`python -m yt_dlp`) |
| yt-dlp | The actual download engine — `pip install -U yt-dlp` |
| ffmpeg | Merging video+audio streams & MP3 conversion |

## Features

- 🎯 Paste a link → auto-detects the platform and shows title, thumbnail, uploader, duration
- 🎚️ Choose video quality (up to the max available, e.g. 4K) or **Best available**
- 🎵 Audio-only mode → extracts MP3
- 📊 Live progress bar with speed and ETA
- 📁 Files saved to the `downloads/` folder
- 🖥️ Works for: youtube.com / youtu.be, tiktok.com / vm.tiktok.com, instagram.com, facebook.com / fb.watch

## Notes

- **Private / login-required content** (e.g. private Instagram accounts, members-only videos) can't be downloaded. Public posts work.
- yt-dlp needs regular updates to keep up with platform changes: `python -m pip install -U yt-dlp`
- Downloading is intended for content you have the right to save — respect copyright and each platform's terms of service.

## API (for your own scripts)

| Endpoint | Description |
|----------|-------------|
| `POST /api/info` `{url}` | Fetch title/thumbnail/qualities |
| `POST /api/download` `{url, mode:"video"\|"audio", qualityId:"h1080"}` | Start a job, returns `jobId` |
| `GET /api/progress/:jobId` | Poll progress (`downloading` / `done` / `error`) |
| `GET /api/downloads` | List files in `downloads/` |
