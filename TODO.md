# Skool Downloader TODO

## 🛠️ Critical Fixes & Improvements
- [x] **Fix Native Skool Video Downloads (HLS/m3u8)**
    - [x] Investigate if native videos require a "play" click to trigger signed token generation.
    - [x] Update Scraper to detect and extract native m3u8 playlist URLs by interacting with the player.
    - [x] Ensure signed tokens are passed correctly to `yt-dlp`.
- [x] **Preserve Module Order**
    - [x] Number the module folders (e.g., `1-Module Name`, `2-Module Name`) for lexicographical sorting.
- [x] **Download Course Attachments**
    - [x] Parse `course.metadata.resources` from `__NEXT_DATA__`.
    - [x] Download PDFs, DOCX, and other files into a `resources/` folder within each lesson.
    - [x] Add links to these resources in the generated `index.html`.
    - [x] Use direct API calls to `https://api2.skool.com/files/{file_id}/download-url` instead of DOM interaction for skool uploaded (native) content.
    - [x] Scrape DOM for **external** links and additional resources missing from metadata.**
- [x] **Single Lesson Extraction**
    - [x] Accept lesson URLs (with `?md=`) to download only that specific lesson.
- [x] **Skip Already Downloaded Content**
    - [x] Check if videos, resources, and images already exist before downloading.
    - [x] Display file size and skip message for existing content.

## 🎨 Performance
- [x] **Parallel Content Downloading (Configurable)**
    - [x] Ensure that images from the lesson content are also downloaded
    - [x] Parallelize lessons with concurrency control
    - [x] Parallelize assets (images/resources) within lessons

## 🎨 Polishing & User Experience
- [x] **Better downloading of content**
    - [x] Ensure that images from the lesson content are also downloaded
- [x] **Interactive CLI**
    - [x] Well-designed commands to help user choose which content they want to download
- [x] **Download entire courses library from the community**
    - [x] Allow optional selection of specific courses
    - [x] Integrate into interactive CLI
    - [x] Save course with image, and navigable HTML for each course (with image), as well as all courses for the community. (make sure update hooks are solid)
