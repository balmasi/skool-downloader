import { Scraper, Module } from './scraper.js';
import { Downloader } from './downloader.js';
import { regenerateIndex } from './regenerate-index.js';
import { createConsoleLogger, type Logger } from './logger.js';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;

const indexLimit = pLimit(1);
let activeOutputDir: string | null = null;
let shutdownHandlersRegistered = false;

function registerShutdownHandlers(logger: Logger) {
    if (shutdownHandlersRegistered) return;
    shutdownHandlersRegistered = true;

    const handleShutdown = async (signal: string) => {
        if (!activeOutputDir) {
            process.exit(0);
            return;
        }
        logger.warn(`\n🛑 Caught ${signal}. Regenerating index before exit...`);
        try {
            await regenerateIndex(activeOutputDir);
        } catch (err) {
            logger.error('⚠️ Failed to regenerate index during shutdown.', err);
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

export type DownloadMode = 'auto' | 'course' | 'lesson';

export type DownloadCallbacks = {
    onCourseStart?: (info: {
        courseName: string;
        groupName: string;
        modulesCount: number;
        lessonsCount: number;
        outputDir: string;
        targetLessonId: string | null;
        lessonDestination?: {
            moduleIndex: number;
            moduleTitle: string;
            moduleDirName: string;
            lessonIndex: number;
            lessonTitle: string;
            lessonDirName: string;
            lessonOutputDir: string;
            lessonRelativePath: string;
        } | null;
    }) => void;
    onLessonStart?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
    }) => void;
    onLessonComplete?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
        hasVideo: boolean;
        resourcesCount: number;
    }) => void;
    onLessonError?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
        error: unknown;
    }) => void;
    onCourseComplete?: (summary: DownloadSummary) => void;
};

export type DownloadOptions = {
    url: string;
    outputDir?: string;
    concurrency?: number;
    mode?: DownloadMode;
    lessonId?: string | null;
    logger?: Logger;
    callbacks?: DownloadCallbacks;
    suppressIndexLogs?: boolean;
    runTasks?: (tasks: LessonTask[], concurrency: number) => Promise<void>;
};

export type DownloadSummary = {
    courseName: string;
    groupName: string;
    outputDir: string;
    modulesCount: number;
    lessonsCount: number;
    completedLessons: number;
    failedLessons: number;
    targetLessonId: string | null;
};

export type LessonTask = {
    title: string;
    run: (onStatus?: (message: string) => void) => Promise<void>;
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

function sanitizeName(value: string) {
    return value.replace(/[/\\?%*:|"<>]/g, '-');
}

function resolveTargetLessonId(
    url: string,
    mode: DownloadMode,
    explicitLessonId?: string | null
) {
    if (mode === 'course') return null;

    let targetLessonId = explicitLessonId ?? null;
    try {
        const urlObj = new URL(url);
        if (!targetLessonId) {
            targetLessonId = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');
        }
    } catch (err) {
        // Ignore parsing errors, caller will validate.
    }

    if (mode === 'lesson' && !targetLessonId) {
        throw new Error('Lesson mode requires a lesson id in the URL or explicit lessonId option.');
    }

    return targetLessonId;
}

function normalizeConcurrency(value: number | undefined) {
    if (!Number.isFinite(value) || value === undefined) return DEFAULT_CONCURRENCY;
    const floored = Math.floor(value);
    if (floored <= 0) return DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, floored);
}

async function runConcurrent(tasks: Array<() => Promise<void>>, concurrency: number) {
    if (tasks.length === 0) return;
    if (concurrency <= 1 || tasks.length === 1) {
        for (const task of tasks) {
            await task();
        }
        return;
    }

    let index = 0;
    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= tasks.length) return;
            await tasks[current]();
        }
    });

    await Promise.all(workers);
}

export async function downloadCourse(options: DownloadOptions): Promise<DownloadSummary> {
    const logger = options.logger ?? createConsoleLogger();
    const concurrency = normalizeConcurrency(options.concurrency);
    const mode = options.mode ?? 'auto';
    const inputUrl = options.url.replace(/\\/g, '');

    let classroomUrl = inputUrl;
    try {
        classroomUrl = new URL(inputUrl).toString();
    } catch (err) {
        throw new Error(`Invalid URL: ${inputUrl}`);
    }

    const targetLessonId = resolveTargetLessonId(classroomUrl, mode, options.lessonId);
    classroomUrl = classroomUrl.split('?')[0];

    const scraper = new Scraper(logger);
    const downloader = new Downloader(logger);

    let completedLessons = 0;
    let failedLessons = 0;

    try {
        logger.info('🚀 Fetching course structure...');
        let { modules, courseName, groupName, courseImageUrl } = await scraper.parseClassroom(classroomUrl);

        if (modules.length === 0) {
            throw new Error('No modules found. Are you sure this is a classroom URL and you are logged in?');
        }

        if (targetLessonId) {
            logger.info(`📍 Single lesson mode: Finding lesson ${targetLessonId}...`);
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
                throw new Error(`Could not find lesson with ID ${targetLessonId} in this classroom.`);
            }

            logger.info(`✅ Found lesson: ${modules[0].lessons[0].title}`);
        } else {
            logger.info(`✅ Found ${modules.length} modules.`);
        }

        const sanitizedGroupName = sanitizeName(groupName);
        const sanitizedCourseName = sanitizeName(courseName);

        const defaultOutputDir = path.join(
            process.cwd(),
            'downloads',
            sanitizedGroupName,
            sanitizedCourseName
        );

        const outputOverride =
            options.outputDir && options.outputDir !== 'undefined'
                ? options.outputDir
                : undefined;
        const baseOutputDir = outputOverride || defaultOutputDir;
        if (!baseOutputDir) {
            throw new Error('Output directory resolution failed.');
        }

        await fs.ensureDir(baseOutputDir);
        activeOutputDir = baseOutputDir;
        registerShutdownHandlers(logger);

        const courseInfo: Array<{
            title: string;
            lessons: any[];
            totalLessons: number;
            mIndex: number;
            moduleDirName: string;
        }> = modules.map(m => ({
            title: m.title,
            lessons: [] as any[],
            totalLessons: m.lessons.length,
            mIndex: m.index,
            moduleDirName: `${m.index}-${sanitizeName(m.title)}`
        }));

        let lessonDestination: {
            moduleIndex: number;
            moduleTitle: string;
            moduleDirName: string;
            lessonIndex: number;
            lessonTitle: string;
            lessonDirName: string;
            lessonOutputDir: string;
            lessonRelativePath: string;
        } | null = null;

        if (targetLessonId && modules[0]?.lessons?.length) {
            const module = modules[0];
            const lesson = module.lessons[0];
            const moduleInfo = courseInfo[0];
            const lessonIndex = lesson.index ?? 1;
            const lessonDirName = `${lessonIndex}-${sanitizeName(lesson.title)}`;
            const lessonOutputDir = path.join(baseOutputDir, moduleInfo.moduleDirName, lessonDirName);
            lessonDestination = {
                moduleIndex: moduleInfo.mIndex,
                moduleTitle: moduleInfo.title,
                moduleDirName: moduleInfo.moduleDirName,
                lessonIndex,
                lessonTitle: lesson.title,
                lessonDirName,
                lessonOutputDir,
                lessonRelativePath: `${moduleInfo.moduleDirName}/${lessonDirName}/index.html`
            };
        }

        const totalLessons = modules.reduce((sum, module) => sum + module.lessons.length, 0);
        options.callbacks?.onCourseStart?.({
            courseName,
            groupName,
            modulesCount: modules.length,
            lessonsCount: totalLessons,
            outputDir: baseOutputDir,
            targetLessonId,
            lessonDestination
        });

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
                logger.warn('⚠️ Failed to download course image, continuing without it.');
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

        const tasks: LessonTask[] = [];

        for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            const mInfo = courseInfo[i];
            const moduleDir = path.join(baseOutputDir, mInfo.moduleDirName);
            await fs.ensureDir(moduleDir);

            for (const lesson of module.lessons) {
                const lIndex = lesson.index ?? 1;
                const taskTitle = `[${mInfo.mIndex}.${lIndex}] ${lesson.title}`;
                tasks.push({
                    title: taskTitle,
                    run: async (onStatus) => {
                        const updateStatus = (message?: string) => {
                            if (!onStatus || !message) return;
                            onStatus(message);
                        };
                        const lessonDirName = `${lIndex}-${sanitizeName(lesson.title)}`;
                        const lessonDir = path.join(moduleDir, lessonDirName);

                        options.callbacks?.onLessonStart?.({
                            moduleIndex: mInfo.mIndex,
                            lessonIndex: lIndex,
                            lessonTitle: lesson.title
                        });

                        logger.info(`\n  📄 Processing [${mInfo.mIndex}.${lIndex}] ${lesson.title}`);

                        try {
                            updateStatus('Loading lesson data...');
                            await fs.ensureDir(lessonDir);
                            const lessonData = await scraper.extractLessonData(lesson.url);

                            updateStatus('Localizing images...');
                            const localizedHtml = await downloader.localizeImages(lessonData.contentHtml || '', lessonDir);

                            let hasVideo = false;
                            if (lessonData.videoLink) {
                                try {
                                    updateStatus('Downloading video...');
                                    await downloader.downloadVideo(lessonData.videoLink, lessonDir, 'video');
                                    hasVideo = true;
                                } catch (err) {
                                    logger.warn(`    ⚠️ Failed to download video for ${lesson.title}`);
                                }
                            }

                            const resourcesHtml: string[] = [];
                            if (lessonData.resources && lessonData.resources.length > 0) {
                                const resourcesDir = path.join(lessonDir, 'resources');
                                await fs.ensureDir(resourcesDir);

                                const resTasks = lessonData.resources.map(async (res) => {
                                    if (!res.downloadUrl) return null;

                                    if (res.isExternal) {
                                        logger.info(`    🔗 External resource linked: ${res.title}`);
                                        return `<li><a href="${res.downloadUrl}" target="_blank">${res.title} (External)</a></li>`;
                                    }

                                    try {
                                        updateStatus('Downloading resources...');
                                        const safeFileName = sanitizeName(res.file_name || res.title);
                                        const resPath = path.join(resourcesDir, safeFileName);

                                        if (fs.existsSync(resPath)) {
                                            const stats = fs.statSync(resPath);
                                            if (stats.size > 0) {
                                                logger.info(`    ⏭️  Resource already exists, skipping: ${res.title}`);
                                                return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                            }
                                        }

                                        logger.info(`    ⬇️  Downloading resource: ${res.title}`);
                                        await downloader.downloadAsset(res.downloadUrl, resPath);
                                        return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                    } catch (err) {
                                        logger.warn(`    ⚠️  Failed to download resource ${res.title}: ${String(err)}`);
                                        return null;
                                    }
                                });

                                const results = await Promise.all(resTasks);
                                results.forEach(r => { if (r) resourcesHtml.push(r); });
                            }

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

                            updateStatus('Saving metadata...');
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

                            completedLessons += 1;
                            options.callbacks?.onLessonComplete?.({
                                moduleIndex: mInfo.mIndex,
                                lessonIndex: lIndex,
                                lessonTitle: lesson.title,
                                hasVideo,
                                resourcesCount: resourcesHtml.length
                            });

                            updateStatus('Updating course index...');
                            indexLimit(() => regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs }));
                        } catch (err) {
                            failedLessons += 1;
                            options.callbacks?.onLessonError?.({
                                moduleIndex: mInfo.mIndex,
                                lessonIndex: lIndex,
                                lessonTitle: lesson.title,
                                error: err
                            });
                            logger.error(`    ⚠️ Error processing lesson ${lesson.title}: ${String(err)}`);
                        }
                    }
                });
            }
        }

        if (options.runTasks) {
            await options.runTasks(tasks, concurrency);
        } else {
            await runConcurrent(tasks.map(task => () => task.run()), concurrency);
        }
        await indexLimit(() => regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs }));

        const summary: DownloadSummary = {
            courseName,
            groupName,
            outputDir: baseOutputDir,
            modulesCount: modules.length,
            lessonsCount: totalLessons,
            completedLessons,
            failedLessons,
            targetLessonId
        };

        options.callbacks?.onCourseComplete?.(summary);

        logger.info('\n✨ All downloads complete!');
        logger.info(`Check your files in: ${baseOutputDir}`);

        return summary;
    } finally {
        await scraper.close();
    }
}
