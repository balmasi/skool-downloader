import fs from 'fs-extra';
import path from 'path';

type CourseManifest = {
    courseName: string;
    groupName: string;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
    }>;
    updatedAt: string;
};

type LessonManifest = {
    lessonId: string;
    title: string;
    moduleIndex: number;
    moduleTitle: string;
    lessonIndex: number;
    moduleDirName: string;
    lessonDirName: string;
    relativePath: string;
    hasVideo: boolean;
    resourcesCount: number;
    updatedAt: string;
};

async function writeAtomicHtml(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.move(tempPath, filePath, { overwrite: true });
}

/**
 * Regenerates the master index.html by scanning the downloads directory
 * for existing lesson files. Useful for recovering from interrupted downloads.
 */
type RegenerateOptions = {
    silent?: boolean;
};

async function regenerateIndex(
    downloadsDir: string = path.join(process.cwd(), 'downloads'),
    options: RegenerateOptions = {}
) {
    const log = options.silent ? () => {} : console.log;
    const warn = options.silent ? () => {} : console.warn;

    if (!fs.existsSync(downloadsDir)) {
        log(`❌ Downloads directory not found: ${downloadsDir}`);
        return;
    }

    log(`🔍 Scanning downloads directory: ${downloadsDir}`);

    let courseManifest: CourseManifest | null = null;
    const courseManifestPath = path.join(downloadsDir, '.course.json');
    if (await fs.pathExists(courseManifestPath)) {
        try {
            courseManifest = await fs.readJson(courseManifestPath);
        } catch (err) {
            warn('⚠️ Failed to read course manifest, falling back to directory names.');
        }
    }

    // Read all module directories
    const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
    const moduleDirs = entries
        .filter(entry => entry.isDirectory())
        .sort((a, b) => {
            // Extract module number from directory name (e.g., "1-Module Name")
            const numA = parseInt(a.name.split('-')[0]) || 999;
            const numB = parseInt(b.name.split('-')[0]) || 999;
            return numA - numB;
        });

    const courseInfo: any[] = [];

    for (const moduleDir of moduleDirs) {
        const modulePath = path.join(downloadsDir, moduleDir.name);

        // Extract module title (remove the number prefix)
        const moduleTitle = moduleDir.name.replace(/^\d+-/, '');
        const moduleIndex = parseInt(moduleDir.name.split('-')[0]) || 999;

        // Read lesson directories
        const lessonEntries = await fs.readdir(modulePath, { withFileTypes: true });
        const lessonDirs = lessonEntries
            .filter(entry => entry.isDirectory())
            .sort((a, b) => {
                // Extract lesson number from directory name
                const numA = parseInt(a.name.split('-')[0]) || 999;
                const numB = parseInt(b.name.split('-')[0]) || 999;
                return numA - numB;
            });

        const lessons: any[] = [];

        for (const lessonDir of lessonDirs) {
            const lessonPath = path.join(modulePath, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');
            const manifestPath = path.join(lessonPath, 'lesson.json');

            // Check if lesson has an index.html
            if (fs.existsSync(indexPath)) {
                let lessonTitle = lessonDir.name.replace(/^\d+-/, '');
                let relativePath = `${moduleDir.name}/${lessonDir.name}/index.html`;
                let lessonIndex = parseInt(lessonDir.name.split('-')[0]) || 999;
                let moduleTitleOverride: string | null = null;
                let moduleIndexOverride: number | null = null;

                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest: LessonManifest = await fs.readJson(manifestPath);
                        lessonTitle = manifest.title || lessonTitle;
                        relativePath = manifest.relativePath || relativePath;
                        lessonIndex = manifest.lessonIndex ?? lessonIndex;
                        moduleTitleOverride = manifest.moduleTitle || null;
                        moduleIndexOverride = manifest.moduleIndex ?? null;
                    } catch (err) {
                        warn(`⚠️ Failed to read manifest for ${lessonDir.name}, using directory data.`);
                    }
                }

                lessons.push({
                    title: lessonTitle,
                    path: relativePath,
                    index: lessonIndex,
                    moduleTitleOverride,
                    moduleIndexOverride
                });
            }
        }

        if (lessons.length > 0) {
            lessons.sort((a, b) => a.index - b.index);
            const resolvedModuleTitle = lessons.find(l => l.moduleTitleOverride)?.moduleTitleOverride || moduleTitle;
            const resolvedModuleIndex = lessons.find(l => l.moduleIndexOverride)?.moduleIndexOverride ?? moduleIndex;
            courseInfo.push({
                title: resolvedModuleTitle,
                lessons: lessons,
                index: resolvedModuleIndex
            });
        }
    }

    if (courseManifest?.modules?.length) {
        const order = new Map(courseManifest.modules.map((m, i) => [m.moduleDirName, i]));
        courseInfo.sort((a, b) => {
            const orderA = order.get(a.moduleDirName) ?? 9999;
            const orderB = order.get(b.moduleDirName) ?? 9999;
            if (orderA !== orderB) return orderA - orderB;
            return a.index - b.index;
        });
    } else {
        courseInfo.sort((a, b) => a.index - b.index);
    }

    const courseName = courseManifest?.courseName || 'Course Archive';
    const groupName = courseManifest?.groupName || '';
    const courseImagePath = courseManifest?.courseImagePath;
    const resolvedCourseImagePath = courseImagePath
        ? path.join(downloadsDir, courseImagePath)
        : null;
    const hasCourseImage = resolvedCourseImagePath ? await fs.pathExists(resolvedCourseImagePath) : false;

    // Generate the index HTML
    const indexHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>${courseName}${groupName ? ` (${groupName})` : ''} - Backup</title>
                <style>
                    :root {
                        --bg: #f6f3ee;
                        --panel: #ffffff;
                        --panel-2: #f6f7fb;
                        --text: #14161d;
                        --muted: #596070;
                        --accent: #3b82f6;
                        --accent-2: #0f172a;
                        --ring: rgba(20,22,29,0.08);
                        --shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
                    }
                    * { box-sizing: border-box; }
                    body {
                        margin: 0;
                        font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                        background: linear-gradient(145deg, #fefefe 0%, #f3f6fb 100%);
                        color: var(--text);
                        line-height: 1.6;
                    }
                    .page {
                        max-width: 1100px;
                        margin: 48px auto 80px;
                        padding: 0 24px;
                    }
                    .hero {
                        display: grid;
                        grid-template-columns: 1fr;
                        gap: 28px;
                        align-items: stretch;
                        background: var(--panel);
                        border-radius: 28px;
                        padding: 32px;
                        box-shadow:
                            0 20px 45px rgba(15, 23, 42, 0.18),
                            0 10px 20px rgba(15, 23, 42, 0.08);
                    }
                    .breadcrumb {
                        font-size: 0.95rem;
                        color: var(--muted);
                        margin-bottom: 18px;
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                        align-items: center;
                    }
                    .breadcrumb a { color: var(--accent); text-decoration: none; font-weight: 600; }
                    .breadcrumb span { color: var(--muted); }
                    .hero-copy {
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        gap: 6px;
                    }
                    .hero-title {
                        font-size: clamp(2.2rem, 4vw, 3.2rem);
                        margin: 0 0 10px 0;
                        letter-spacing: -0.02em;
                    }
                    .hero-subtitle {
                        color: var(--muted);
                        margin: 0 0 22px 0;
                        font-size: 1.05rem;
                    }
                    .hero-meta {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 12px;
                    }
                    .chip {
                        padding: 10px 14px;
                        border-radius: 999px;
                        background: var(--panel-2);
                        border: 1px solid var(--ring);
                        color: var(--text);
                        font-size: 0.95rem;
                    }
                    .chip strong { color: var(--accent); font-weight: 700; }
                    .hero-image {
                        position: relative;
                        border-radius: 18px;
                        overflow: hidden;
                        background: #f0f2f7;
                        height: 100%;
                        border: 1px solid var(--ring);
                        box-shadow: 0 16px 28px rgba(15, 23, 42, 0.14);
                    }
                    .hero-image img {
                        width: 100%;
                        height: 100%;
                        object-fit: cover;
                        background: #f0f2f7;
                        display: block;
                    }
                    .hero-image .fallback {
                        height: 100%;
                        display: grid;
                        place-items: center;
                        color: var(--muted);
                        font-size: 0.95rem;
                    }
                    .content {
                        margin-top: 36px;
                        display: grid;
                        gap: 18px;
                    }
                    .module {
                        background: var(--panel);
                        border-radius: 20px;
                        padding: 22px;
                        transition: transform 0.25s ease, box-shadow 0.25s ease;
                        box-shadow: 0 20px 40px rgba(15, 23, 42, 0.1);
                    }
                    .module:hover {
                        transform: translateY(-4px);
                        box-shadow:
                            0 30px 60px rgba(15, 23, 42, 0.18),
                            0 12px 24px rgba(15, 23, 42, 0.1);
                    }
                    .module-title {
                        margin: 0 0 12px 0;
                        font-size: 1.25rem;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    .module-title span {
                        color: var(--accent-2);
                        font-weight: 700;
                        font-size: 0.95rem;
                        padding: 4px 10px;
                        border-radius: 999px;
                        background: rgba(37,99,235,0.12);
                        border: 1px solid rgba(37,99,235,0.25);
                    }
                    .lesson-list {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
                        gap: 12px 16px;
                        align-items: stretch;
                        grid-auto-flow: row dense;
                        padding: 0;
                        margin: 0;
                        list-style: none;
                    }
                    .lesson a {
                        display: block;
                        padding: 12px 14px;
                        border-radius: 14px;
                        background: var(--panel-2);
                        border: 1px solid rgba(255,255,255,0.2);
                        color: var(--text);
                        text-decoration: none;
                        font-size: 0.98rem;
                        min-height: 46px;
                        height: 100%;
                        transition: border-color 0.25s ease, transform 0.25s ease;
                        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15);
                    }
                    .lesson a:hover {
                        border-color: rgba(59,130,246,0.6);
                        transform: translateY(-2px);
                    }
                    @media (min-width: 900px) {
                        .hero { grid-template-columns: 1.15fr 0.85fr; }
                    }
                    @media (max-width: 640px) {
                        .hero-image { min-height: 200px; }
                    }
                </style>
            </head>
            <body>
                <div class="page">
                    ${groupName ? `
                        <div class="breadcrumb">
                            <a href="../index.html">${groupName}</a>
                            <span>/</span>
                            <span>${courseName}</span>
                        </div>
                    ` : ''}
                    <section class="hero">
                        <div class="hero-copy">
                            <h1 class="hero-title">${courseName}</h1>
                            <p class="hero-subtitle">${groupName ? `Community: ${groupName}` : 'Course Archive'}</p>
                            <div class="hero-meta">
                                <div class="chip"><strong>${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)}</strong> lessons</div>
                                <div class="chip"><strong>${courseInfo.length}</strong> modules</div>
                                <div class="chip">Updated: <strong>${new Date().toLocaleDateString()}</strong></div>
                            </div>
                        </div>
                        <div class="hero-image">
                            ${hasCourseImage && courseImagePath
        ? `<img src="${courseImagePath}" alt="${courseName} cover">`
        : `<div class="fallback">No course image available</div>`}
                        </div>
                    </section>

                    <section class="content">
                        ${courseInfo.map(m => `
                            <div class="module">
                                <h2 class="module-title"><span>Module ${m.index}</span>${m.title}</h2>
                                <ul class="lesson-list">
                                    ${m.lessons.map((l: any) => `<li class="lesson"><a href="${l.path}">${l.title}</a></li>`).join('')}
                                </ul>
                            </div>
                        `).join('')}
                    </section>
                </div>
            </body>
            </html>
        `;

    // Write the index file
    await writeAtomicHtml(path.join(downloadsDir, 'index.html'), indexHtml);

    log('\n✅ Index regenerated successfully!');
    log(`📊 Found ${courseInfo.length} modules with ${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)} lessons total`);
    log(`📁 Saved to: ${path.join(downloadsDir, 'index.html')}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const downloadsDir = process.argv[2] || path.join(process.cwd(), 'downloads');
    regenerateIndex(downloadsDir).catch(console.error);
}

export { regenerateIndex };
