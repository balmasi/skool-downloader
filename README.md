# 🎓 Skool Downloader

A robust, platform-independent CLI tool to create local, offline backups of your [Skool.com](https://skool.com) courses. 

This tool downloads video content, localizes images, preserves course attachments, and generates a navigable, styled HTML structure that mirrors the online classroom.

## ✨ Features

- **🚀 Smart Binary Management:** Automatically downloads the correct `yt-dlp` and `ffmpeg` binaries for your OS (Windows, macOS, Linux) and architecture (Intel, Apple Silicon ARM, Linux ARM).
- **📹 High-Quality Video:** Downloads the highest available quality and applies `+faststart` for instant browser playback.
- **📄 Asset Localization:** Downloads all lesson images locally and rewrites HTML paths for true offline 100% viewing.
- **📎 Resource Preservation:** Automatically fetches course attachments (PDFs, DOCX, etc.) via Skool's API.
- **🎯 Single Lesson Mode:** Download a whole course or just a single lesson using a specific URL.
- **🛠 Interrupted Download Recovery:** Skips already downloaded files and includes a tool to regenerate the index page.

## 🛠 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

**Note:** No system-wide installation of `yt-dlp` or `ffmpeg` is required. The tool manages these locally in the `bin/` folder.

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

### 3. Downloading a Course

To download an entire classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom/course-id
```

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
