# Skool Downloader TODO

## 🛠️ Critical Fixes & Improvements
- [ ] **Fix Native Skool Video Downloads (HLS/m3u8)**
    - [ ] Investigate if native videos require a "play" click to trigger signed token generation.
    - [ ] Update Scraper to detect and extract native m3u8 playlist URLs.
    - [ ] Ensure signed tokens are passed correctly to `yt-dlp`.
- [x] **Preserve Module Order**
    - [x] Number the module folders (e.g., `1-Module Name`, `2-Module Name`) for lexicographical sorting.
- [ ] **Download Course Attachments**
    - [ ] Parse `course.metadata.resources` from `__NEXT_DATA__`.
    - [ ] Download PDFs, DOCX, and other files into a `resources/` folder within each lesson.
    - [ ] Add links to these resources in the generated `index.html`.
- [x] **Single Lesson Extraction**
    - [x] Accept lesson URLs (with `?md=`) to download only that specific lesson.

## 🎨 Polishing & User Experience
- [ ] **Internal Link Mapping**
    - [ ] Map absolute Skool links between lessons to relative local file paths.
- [ ] **Improved Visual Design**
    - [ ] Enhance the CSS of local pages to feel more premium (vibrant colors, better cards, glassmorphism).
- [ ] **ffmpeg Management**
    - [ ] Add a setup script to download a local `ffmpeg` binary for zero-config high-quality downloads.
- [ ] **Rate Limiting & Anti-Detection**
    - [ ] Implement randomized delays and human-like interaction loops.

## 📦 Distribution
- [ ] **Local Readme for Users**
    - [ ] Create a `README.md` for end-users explaining how to view the downloaded content (e.g., "Open index.html").
- [ ] **Electron Version (Optional)**
    - [ ] Package this as a simple GUI app for users who aren't comfortable with the CLI.
