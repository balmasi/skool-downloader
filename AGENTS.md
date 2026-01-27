# Skool Downloader - Developer Onboarding

## Project Goal & Context
The goal of this project is to provide a robust, platform-independent tool for creating local, offline backups of Skool.com courses. This includes downloading video content, localizing images, and generating a navigable HTML structure that mirrors the online classroom.

## Technical Architecture

### Core Tech Stack
- **TypeScript / Node.js**: Modern ESM environment.
- **Playwright**: Used for scraping and the initial manual authentication flow.
- **yt-dlp**: Handled via `yt-dlp-wrap`. It's managed locally (downloaded to `bin/`) to avoid system-wide installations.
- **Axios**: For direct asset (image) downloads.

### Key Technical Strategies
1. **Source of Truth (`__NEXT_DATA__`)**:
   Instead of fragile DOM scraping, the tool extracts the `__NEXT_DATA__` JSON block from Skool's page source. This contains the structured course hierarchy, lesson metadata, and direct video links.
2. **Manual Authentication**:
   A script (`npm run login`) opens a browser for manual login, then captures the `storage_state.json`. 
3. **Cookie Conversion**:
   The tool automatically converts Playwright's JSON cookies into the **Netscape format** (`cookies.txt`) required by `yt-dlp` to access private course videos.
4. **Rich Text Parsing**:
   Skool uses TipTap/ProseMirror for lesson content. The scraper includes a parser (`parseTipTap`) to convert the stringified JSON content back into clean, localizable HTML.
5. **Asset Localization**:
   The `Downloader` class identifies `<img>` tags, downloads the images into a local `assets/` folder, and rewrites the HTML sources before saving.
6. **Native Video Extraction**:
   Skool's native Mux player requires a "play" click to generate authenticated HLS manifest URLs. The scraper simulates this interaction and monitors performance entries to extract the signed `.m3u8` link.
7. **Resource/Attachment Downloads**:
   Course attachments (PDFs, DOCX, etc.) are downloaded using direct API calls to `https://api2.skool.com/files/{file_id}/download-url?expire=28800`. This is more reliable than DOM interaction and returns signed CloudFront URLs for downloading.
8. **High-Performance Downloads**:
   The downloader is optimized with `-N 16` for parallel fragment fetching and `ffmpeg` post-processing (`+faststart`) for instant in-browser playback.

## Project Structure
- `src/auth.ts`: Handles the manual login flow and cookie conversion.
- `src/scraper.ts`: Navigates the course tree and parses lesson metadata from Next.js state.
- `src/downloader.ts`: Wrapper for `yt-dlp` and logic for image localization and resource downloads.
- `src/cli.ts`: Interactive CLI entry point (login, download course, download single lesson, regenerate index). Uses Listr2 to run lesson downloads concurrently with per-lesson status output.
- `src/index.ts`: Core download orchestrator. Handles course parsing, output path resolution, lesson processing, and manifest/index generation. Exposes callbacks + task runner hooks for the CLI.
- **Single Lesson Extraction**: The tool detects `?md=` or `?lesson=` in the input URL to download only a specific lesson instead of the entire course, and reports the exact destination path.
- **Native Video Handling**: Automates interaction with the Mux player to capture signed tokens.
- **Resource Downloads**: Uses direct API calls to fetch signed download URLs for attachments, stored in `resources/` folder within each lesson.
- `bin/`: Stores the platform-specific `yt-dlp` binary.


- **ffmpeg Requirement**: `yt-dlp` requires `ffmpeg` to merge high-quality video and audio streams (especially for YouTube 1080p+). To keep the project platform-independent, consider adding a local `ffmpeg` binary or a managed package like `@ffmpeg-installer/ffmpeg`.
- **Rate Limiting & Detection**: Skool may implement rate limiting. The current implementation uses a fixed delay between navigations, but for very large courses, further randomization or human-like interaction patterns should be implemented in `scraper.ts`.
- **Local Chromium**: Playwright currently uses the system cache for browser binaries. For a 100% self-contained folder, configure `PLAYWRIGHT_BROWSERS_PATH=0` in `.env` to force local installation.
- **Internal Link Mapping**: Lesson content often contains links to other lessons or attachments. These are currently absolute URLs. A post-processing step could map these to the local file structure for a fully isolated backup.

## Key Resources
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp): Essential for understanding header requirements and cookie imports.
- [Skool Scraping Insights](https://blog.devinschumacher.com/how-to-download-skoolcom-videos-wget): Background on the `md` parameter and `__NEXT_DATA__` structure.
