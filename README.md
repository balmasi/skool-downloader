# 🎓 Skool Downloader

A robust, platform-independent CLI tool to create local, offline backups of your [Skool.com](https://skool.com) courses. 

This tool downloads video content, localizes images, preserves course attachments, and generates a navigable, styled HTML structure that mirrors the online classroom.

## ✨ Features

- **🚀 Smart Binary Management:** Ships the correct `ffmpeg` for your OS (Windows, macOS, Linux) and architecture (Intel, Apple Silicon ARM, Linux ARM) as an install-time dependency, and downloads `yt-dlp` on first run. If the bundled `ffmpeg` cannot be installed, an `ffmpeg` on your `PATH` is used instead.
- **📹 High-Quality Video:** Downloads the highest available quality and applies `+faststart` for instant browser playback.
- **📄 Asset Localization:** Downloads all lesson images locally and rewrites HTML paths for true offline 100% viewing.
- **📎 Resource Preservation:** Automatically fetches course attachments (PDFs, DOCX, etc.) via Skool's API.
- **🎯 Single Lesson Mode:** Download a whole course or just a single lesson using a specific URL.
- **🛠 Interrupted Download Recovery:** Skips already downloaded files and includes a tool to regenerate the index page.

## 🛠 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

**Note:** No system-wide installation of `yt-dlp` or `ffmpeg` is required. `ffmpeg` arrives with `npm install`, and `yt-dlp` is fetched on first run into a per-user cache folder, so it is downloaded once no matter which directory you run the tool from:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Caches/skool-downloader/bin` |
| Linux | `~/.cache/skool-downloader/bin` |
| Windows | `%LOCALAPPDATA%\skool-downloader\bin` |

If `XDG_CACHE_HOME` is set, it wins on every platform. Set `SKOOL_DOWNLOADER_CACHE_DIR` to choose the folder yourself; it overrides everything else. Your `downloads/`, `.auth/` and `cookies.txt` stay in the directory you run the tool from.

`ffmpeg` is what merges the separate video and audio streams that most high-quality sources deliver, so it is required for video downloads. It installs automatically. If that install is blocked (an offline machine, a restrictive proxy, or an unsupported platform), install `ffmpeg` yourself and the tool will pick it up from your `PATH`:

```bash
# macOS
brew install ffmpeg
# Windows
winget install Gyan.FFmpeg
# Linux
sudo apt install ffmpeg
```

## 🚀 Getting Started

### 1. Installation

```bash
git clone https://github.com/balmasi/skool-downloader.git
cd skool-downloader
npm install
```

### 2. Authentication

Skool uses secure authentication. This tool uses a manual login flow to capture your session safely.

```bash
npm run login
```
*A browser window will open. Log in to your Skool account. Once you see your dashboard, the script will save your session and close the browser.*

### 3. Using NPX

This package is published on npm, so you can run the CLI without installing anything locally:

```bash
npx skool-downloader
```

If you prefer to stay completely local (and allow offline development), run `npm install` once and use `npm run skool` as shown below.

If you prefer to stay completely local (and allow offline development), run `npm install` once and use `npm run skool` as shown below.

### 3. Downloading a Course

To download an entire classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom/course-id
```

To download **all courses** in a community classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom
```

To download **multiple courses** interactively:

```bash
npm run skool
```
Then choose **Download multiple courses** and select the courses you want.

You can also run `npx skool-downloader` to enter the same interactive menu.

To download only a **single lesson**:

```bash
npm run skool "https://www.skool.com/your-community/classroom/course-id?md=lesson-id"
```

## 📁 Output Structure

The tool creates a `downloads/` folder with the following structure:
```text
downloads/
└── Community Name/
    └── Course Name/
        ├── index.html (Master navigation page)
        └── 1-Module Name/
            ├── 1-Lesson Title/
            │   ├── index.html (The lesson page)
            │   ├── video.mp4
            │   ├── assets/ (Localized images)
            │   └── resources/ (Attachments)
            └── ...
```

## 🔧 Advanced

### Regenerating the Index
If you manually move files or skip lessons, you can regenerate the master `index.html` file based on the current contents of your `downloads/` folder:

```bash
npm run regenerate-index
```

## 🛡 Disclaimer

This tool is for **personal backup and offline viewing purposes only**. Please respect the content creators' terms of service and intellectual property rights. Do not distribute downloaded content without permission.

## 📄 License

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** license. See `LICENSE` for the full legal code.
