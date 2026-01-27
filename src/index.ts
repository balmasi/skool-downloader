import { Scraper, Module, Lesson } from './scraper.js';
import { Downloader } from './downloader.js';
import { login } from './auth.js';
import { regenerateIndex } from './regenerate-index.js';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';

// Parallelism Configuration
// CONCURRENCY: How many lessons to process in parallel. 
// Skool lessons often have a 5s+ initial load time during scraping. 
// Parallelism helps bypass this bottleneck. Recommended: 2-5
const CONCURRENCY = 8;

// indexLimit: A serial queue (concurrency = 1) for file system operations 
// that shouldn't happen in parallel, specifically writing the master index.html.
const indexLimit = pLimit(1);
let activeOutputDir: string | null = null;
let shutdownHandlersRegistered = false;

function registerShutdownHandlers() {
    if (shutdownHandlersRegistered) return;
    shutdownHandlersRegistered = true;

    const handleShutdown = async (signal: string) => {
        if (!activeOutputDir) {
            process.exit(0);
            return;
        }
        console.log(`\n🛑 Caught ${signal}. Regenerating index before exit...`);
        try {
            await regenerateIndex(activeOutputDir);
        } catch (err) {
            console.error('⚠️ Failed to regenerate index during shutdown:', err);
        } finally {
            process.exit(0);
        }
    };

    process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
    process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
}

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

async function writeAtomicJson(filePath: string, data: unknown) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeJson(tempPath, data, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
}

function getUrlExtension(url: string) {
    try {
        const ext = path.extname(new URL(url).pathname);
        if (ext && ext.length <= 5) return ext;
    } catch (err) {
        // Ignore parsing errors, fallback below.
    }
    return '.jpg';
}

async function main() {
    const args = process.argv.slice(2);
    let command = args[0];

    if (command === 'login') {
        await login();
        return;
    }

    // Support: npm run skool -- <url> or just npm run skool <url>
    if (!command || !command.startsWith('http')) {
        console.log('\x1b[36m%s\x1b[0m', 'Skool Course Downloader');
        console.log('-----------------------');
        console.log('Usage:');
        console.log('  npm run login                     - Log in to Skool');
        console.log('  npm run skool <classroom-url>     - Download course');
        console.log('  npm run skool <lesson-url>        - Download single lesson only');
        console.log('\nExample:');
        console.log('  Course:  npm run skool https://www.skool.com/ailaunch/classroom/addeb1da');
        console.log('  Lesson:  npm run skool "https://www.skool.com/ailaunch/classroom/addeb1da?md=123"');
        return;
    }

    const inputUrl = command.replace(/\\/g, '');
    let targetLessonId: string | null = null;
    try {
        const urlObj = new URL(inputUrl);
        targetLessonId = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');
    } catch (e) {
        // Not a valid URL or other error, fallback to treating as classroom URL
    }

    const classroomUrl = inputUrl.split('?')[0];

    const scraper = new Scraper();
    const downloader = new Downloader();

    try {
        console.log('\x1b[33m%s\x1b[0m', '🚀 Fetching course structure...');
        let { modules, courseName, groupName, courseImageUrl } = await scraper.parseClassroom(classroomUrl);

        if (modules.length === 0) {
            console.log('\x1b[31m%s\x1b[0m', '❌ No modules found. Are you sure this is a classroom URL and you are logged in?');
            return;
        }

        const sanitizedGroupName = groupName.replace(/[/\\?%*:|"<>]/g, '-');
        const sanitizedCourseName = courseName.replace(/[/\\?%*:|"<>]/g, '-');
        // Structure: downloads/Group - Course/Course/Module/Lesson
        const baseOutputDir = args[1] || path.join(process.cwd(), 'downloads', `${sanitizedGroupName} - ${sanitizedCourseName}`, sanitizedCourseName);
        await fs.ensureDir(baseOutputDir);
        activeOutputDir = baseOutputDir;
        registerShutdownHandlers();

        // Handle single lesson mode
        if (targetLessonId) {
            console.log('\x1b[33m%s\x1b[0m', `📍 Single lesson mode: Finding lesson ${targetLessonId}...`);
            let found = false;
            for (const module of modules) {
                const lesson = module.lessons.find(l => l.id === targetLessonId);
                if (lesson) {
                    module.lessons = [lesson];
                    modules = [module];
                    found = true;
                    break;
                }
            }

            if (!found) {
                console.log('\x1b[31m%s\x1b[0m', `❌ Could not find lesson with ID ${targetLessonId} in this classroom.`);
                return;
            }
            console.log('\x1b[32m%s\x1b[0m', `✅ Found lesson: ${modules[0].lessons[0].title}`);
        } else {
            console.log('\x1b[32m%s\x1b[0m', `✅ Found ${modules.length} modules.`);
        }

        const courseInfo: any[] = modules.map(m => ({
            title: m.title,
            lessons: [] as any[],
            totalLessons: m.lessons.length,
            mIndex: m.index,
            moduleDirName: `${m.index}-${m.title.replace(/[/\\?%*:|"<>]/g, '-')}`
        }));

        let courseImagePath: string | undefined;
        if (courseImageUrl) {
            try {
                const assetsDir = path.join(baseOutputDir, 'assets');
                await fs.ensureDir(assetsDir);
                const ext = getUrlExtension(courseImageUrl);
                const localName = `course-cover${ext}`;
                const localPath = path.join(assetsDir, localName);
                await downloader.downloadAsset(courseImageUrl, localPath);
                courseImagePath = `assets/${localName}`;
            } catch (err) {
                console.warn('⚠️ Failed to download course image, continuing without it.');
            }
        }

        const courseManifest: CourseManifest = {
            courseName,
            groupName,
            courseImageUrl,
            courseImagePath,
            modules: courseInfo.map(m => ({
                index: m.mIndex,
                title: m.title,
                moduleDirName: m.moduleDirName
            })),
            updatedAt: new Date().toISOString()
        };

        await writeAtomicJson(path.join(baseOutputDir, '.course.json'), courseManifest);

        const limit = pLimit(CONCURRENCY);
        const tasks: any[] = [];

        // We queue up all lesson download tasks. pLimit will ensure only CONCURRENCY 
        // number of lessons are actually running their async blocks at any given time.
        for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            const mInfo = courseInfo[i];
            const moduleDir = path.join(baseOutputDir, mInfo.moduleDirName);
            await fs.ensureDir(moduleDir);

            for (const lesson of module.lessons) {
                tasks.push(limit(async () => {
                    const lIndex = lesson.index;
                    const lessonDirName = `${lIndex}-${lesson.title.replace(/[/\\?%*:|"<>]/g, '-')}`;
                    const lessonDir = path.join(moduleDir, lessonDirName);
                    
                    console.log(`\n  📄 Processing [${mInfo.mIndex}.${lIndex}] ${lesson.title}`);
                    
                    try {
                        await fs.ensureDir(lessonDir);
                        const lessonData = await scraper.extractLessonData(lesson.url);
                        
                        // Localize images in content
                        const localizedHtml = await downloader.localizeImages(lessonData.contentHtml || '', lessonDir);

                        // Download video if available
                        let hasVideo = false;
                        if (lessonData.videoLink) {
                            try {
                                await downloader.downloadVideo(lessonData.videoLink, lessonDir, 'video');
                                hasVideo = true;
                            } catch (err) {
                                console.error(`    ⚠️ Failed to download video for ${lesson.title}`);
                            }
                        }

                        // Download resources in parallel
                        const resourcesHtml: string[] = [];
                        if (lessonData.resources && lessonData.resources.length > 0) {
                            const resourcesDir = path.join(lessonDir, 'resources');
                            await fs.ensureDir(resourcesDir);

                            const resTasks = lessonData.resources.map(async (res) => {
                                if (!res.downloadUrl) return;
                                
                                // Handle External Links
                                if (res.isExternal) {
                                    console.log(`    🔗 External resource linked: ${res.title}`);
                                    return `<li><a href="${res.downloadUrl}" target="_blank">${res.title} (External)</a></li>`;
                                }

                                try {
                                    const safeFileName = (res.file_name || res.title).replace(/[/\\?%*:|"<>]/g, '-');
                                    const resPath = path.join(resourcesDir, safeFileName);

                                    // Check if resource already exists
                                    if (fs.existsSync(resPath)) {
                                        const stats = fs.statSync(resPath);
                                        if (stats.size > 0) {
                                            console.log(`    ⏭️  Resource already exists, skipping: ${res.title}`);
                                            return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                        }
                                    }

                                    console.log(`    ⬇️  Downloading resource: ${res.title}`);
                                    await downloader.downloadAsset(res.downloadUrl, resPath);
                                    return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                } catch (err) {
                                    console.error(`    ⚠️  Failed to download resource ${res.title}:`, err);
                                    return null;
                                }
                            });

                            const results = await Promise.all(resTasks);
                            results.forEach(r => { if (r) resourcesHtml.push(r); });
                        }

                        // Save content
                        const htmlContent = `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <meta charset="UTF-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1">
                                <title>${lessonData.title}</title>
                                <style>
                                    :root {
                                        --bg: #f6f3ee;
                                        --panel: #ffffff;
                                        --panel-2: #f6f7fb;
                                        --text: #14161d;
                                        --muted: #5b6271;
                                        --accent: #f28c28;
                                        --ring: rgba(20,22,29,0.08);
                                        --shadow: 0 16px 32px rgba(15, 23, 42, 0.12);
                                    }
                                    * { box-sizing: border-box; }
                                    body {
                                        margin: 0;
                                        font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                                        background:
                                            radial-gradient(900px 500px at 0% -10%, rgba(242,140,40,0.18), transparent),
                                            radial-gradient(900px 600px at 100% 0%, rgba(37,99,235,0.12), transparent),
                                            var(--bg);
                                        color: var(--text);
                                        line-height: 1.7;
                                    }
                                    .page { max-width: 980px; margin: 48px auto 80px; padding: 0 22px; }
                                    .breadcrumb {
                                        font-size: 0.95rem;
                                        color: var(--muted);
                                        margin-bottom: 16px;
                                        display: flex;
                                        flex-wrap: wrap;
                                        gap: 8px;
                                        align-items: center;
                                    }
                                    .breadcrumb a { color: var(--accent); text-decoration: none; font-weight: 600; }
                                    .breadcrumb span { color: var(--muted); }
                                    .container {
                                        background: var(--panel);
                                        padding: 32px;
                                        border-radius: 18px;
                                        border: 1px solid var(--ring);
                                        box-shadow: var(--shadow);
                                    }
                                    h1 { margin: 0 0 16px 0; font-size: clamp(1.8rem, 3vw, 2.6rem); }
                                    video {
                                        width: 100%;
                                        border-radius: 14px;
                                        margin: 10px 0 26px;
                                        display: block;
                                        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.2);
                                        background: #000;
                                    }
                                    img { max-width: 100%; border-radius: 10px; height: auto; margin: 14px 0; }
                                    .content { font-size: 1.05rem; }
                                    .content p { margin-bottom: 1.2em; }
                                    .resources {
                                        background: var(--panel-2);
                                        padding: 18px;
                                        border-radius: 14px;
                                        border: 1px solid var(--ring);
                                        margin-top: 28px;
                                    }
                                    .resources h3 { margin: 0 0 10px 0; color: #1f3d7a; }
                                    .resources ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
                                    .resources a {
                                        color: #1f3d7a;
                                        font-weight: 600;
                                        display: inline-flex;
                                        align-items: center;
                                        gap: 8px;
                                        text-decoration: none;
                                    }
                                    .resources a::before { content: "📁"; }
                                    a { color: #1f3d7a; text-decoration: none; word-break: break-word; }
                                    a:hover { text-decoration: underline; }
                                    .nav { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--ring); }
                                </style>
                            </head>
                            <body>
                                <div class="page">
                                    <div class="breadcrumb">
                                        <a href="../../index.html">${groupName}</a>
                                        <span>/</span>
                                        <a href="../../index.html">${courseName}</a>
                                        <span>/</span>
                                        <span>${module.title}</span>
                                        <span>/</span>
                                        <span>${lessonData.title}</span>
                                    </div>
                                    <div class="container">
                                        <h1>${lessonData.title}</h1>
                                        ${hasVideo ? '<video controls src="video.mp4"></video>' : ''}
                                        <div class="content">
                                            ${localizedHtml}
                                        </div>
                                        ${resourcesHtml.length > 0 ? `
                                        <div class="resources">
                                            <h3>Resources / Attachments</h3>
                                            <ul>
                                                ${resourcesHtml.join('')}
                                            </ul>
                                        </div>
                                        ` : ''}
                                        <div class="nav">
                                            <a href="../../index.html">Back to Course Index</a>
                                        </div>
                                    </div>
                                </div>
                            </body>
                            </html>
                        `;

                        await fs.writeFile(path.join(lessonDir, 'index.html'), htmlContent);

                        const lessonManifest: LessonManifest = {
                            lessonId: lesson.id,
                            title: lesson.title,
                            moduleIndex: mInfo.mIndex,
                            moduleTitle: mInfo.title,
                            lessonIndex: lIndex,
                            moduleDirName: mInfo.moduleDirName,
                            lessonDirName,
                            relativePath: `${mInfo.moduleDirName}/${lessonDirName}/index.html`,
                            hasVideo,
                            resourcesCount: resourcesHtml.length,
                            updatedAt: new Date().toISOString()
                        };

                        await writeAtomicJson(path.join(lessonDir, 'lesson.json'), lessonManifest);
                        
                        // Use a serial queue for index regeneration to prevent race 
                        // conditions where multiple lessons try to write to index.html at once.
                        indexLimit(() => regenerateIndex(baseOutputDir));
                        
                    } catch (err) {
                        console.error(`    ⚠️ Error processing lesson ${lesson.title}:`, err);
                    }
                }));
            }
        }

        await Promise.all(tasks);

        await indexLimit(() => regenerateIndex(baseOutputDir));

        console.log('\n\x1b[32m%s\x1b[0m', '✨ All downloads complete!');
        console.log(`Check your files in: ${baseOutputDir}`);
    } catch (error) {
        console.error('❌ An error occurred:', error);
    } finally {
        await scraper.close();
    }
}

main();
