import { intro, outro, select, text, confirm, spinner, isCancel, cancel, log, multiselect } from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import fs from 'fs-extra';
import { Listr, PRESET_TIMER } from 'listr2';
import { downloadCourse, type DownloadMode } from './index.js';
import { login, getAuthStatus } from './auth.js';
import { regenerateIndex } from './regenerate-index.js';
import { regenerateGroupIndex } from './regenerate-group-index.js';
import { Scraper, type CourseLibraryResult, type CourseListItem } from './scraper.js';
import type { Logger } from './logger.js';

type CliArgs = {
    command?: 'login' | 'download' | 'regenerate-index' | 'help';
    url?: string;
    outputDir?: string;
    concurrency?: number;
    mode?: DownloadMode;
    lessonId?: string | null;
    regenerateDir?: string;
};

function showHelp() {
    console.log(`\nSkool Downloader\n\nUsage:\n  skool                          Interactive mode\n  skool login                    Log in to Skool\n  skool <classroom-url>          Download a course\n  skool <group-classroom-url>    Download all courses in a community\n  skool <lesson-url>             Download a single lesson (URL with ?md=)\n  skool regenerate-index         Regenerate all course indexes\n\nOptions:\n  -o, --output <dir>             Output directory (course root)\n  -c, --concurrency <number>     Lesson concurrency (default: 8)\n  --course                       Force course mode (ignore ?md=)\n  --lesson                       Force lesson mode\n  --lesson-id <id>               Explicit lesson id\n  -h, --help                     Show help\n`);
}

function parseArgs(args: string[]): CliArgs {
    const parsed: CliArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === 'login') {
            parsed.command = 'login';
            continue;
        }
        if (arg === 'regenerate-index') {
            parsed.command = 'regenerate-index';
            parsed.regenerateDir = args[i + 1];
            continue;
        }
        if (arg === '-h' || arg === '--help') {
            parsed.command = 'help';
            continue;
        }
        if (arg === '--course') {
            parsed.mode = 'course';
            continue;
        }
        if (arg === '--lesson') {
            parsed.mode = 'lesson';
            continue;
        }
        if (arg === '--lesson-id') {
            parsed.lessonId = args[i + 1];
            i++;
            continue;
        }
        if (arg === '-o' || arg === '--output') {
            parsed.outputDir = args[i + 1];
            i++;
            continue;
        }
        if (arg === '-c' || arg === '--concurrency') {
            const next = args[i + 1];
            parsed.concurrency = next ? Number.parseInt(next, 10) : undefined;
            i++;
            continue;
        }
        if (!parsed.url && arg.startsWith('http')) {
            parsed.url = arg;
            parsed.command = 'download';
            continue;
        }
    }

    return parsed;
}

function handleCancel(value: unknown) {
    if (isCancel(value)) {
        cancel('Operation cancelled.');
        process.exit(0);
    }
}

function buildInteractiveLogger(): Logger {
    return {
        info: () => {},
        debug: () => {},
        warn: (message) => log.warn(message),
        error: (message, error) => {
            if (error) {
                log.error(`${message} ${String(error)}`);
            } else {
                log.error(message);
            }
        }
    };
}

function formatExpiry(expiresAt?: Date) {
    if (!expiresAt) return 'unknown time';
    return expiresAt.toLocaleString();
}

function sanitizeName(value: string) {
    return value.replace(/[/\\?%*:|"<>]/g, '-');
}

function isClassroomRootUrl(value: string) {
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        const classroomIndex = parts.indexOf('classroom');
        return classroomIndex !== -1 && classroomIndex === parts.length - 1;
    } catch {
        return false;
    }
}

async function ensureLogin(): Promise<boolean> {
    const status = await getAuthStatus();
    if (status.status === 'valid') {
        if (status.expiresAt) {
            log.info(`Using saved login (expires ${formatExpiry(status.expiresAt)}).`);
        } else {
            log.info('Using saved login.');
        }
        return true;
    }

    let promptMessage = 'No saved login session found. Open a browser to log in now?';
    if (status.status === 'expired') {
        promptMessage = `Saved login expired on ${formatExpiry(status.expiresAt)}. Log in again now?`;
    } else if (status.status === 'no-expiry') {
        promptMessage = 'Saved login has no expiry info. Log in again now?';
    } else if (status.status === 'invalid') {
        promptMessage = 'Saved login could not be validated. Log in again now?';
    }

    const shouldLogin = await confirm({ message: promptMessage, initialValue: true });
    handleCancel(shouldLogin);

    if (shouldLogin) {
        await login();
        return true;
    }

    log.warn('Login required to continue.');
    return false;
}

function createTaskRunner() {
    return async (tasks: { title: string; run: (onStatus?: (message: string) => void) => Promise<void> }[], concurrency: number) => {
        const list = new Listr(
            tasks.map((entry) => ({
                title: entry.title,
                task: async (_ctx, task) => {
                    task.output = 'Starting...';
                    await entry.run((message) => {
                        if (message) task.output = message;
                    });
                }
            })),
            {
                concurrent: concurrency,
                exitOnError: false,
                rendererOptions: {
                    timer: PRESET_TIMER,
                    collapseErrors: false,
                    collapseSubtasks: false
                }
            }
        );

        await list.run();
        if (typeof list.renderer?.end === 'function') {
            list.renderer.end();
        }
        process.stdout.write('\n');
        await new Promise(resolve => setTimeout(resolve, 0));
    };
}

async function fetchCourseLibrary(url: string, logger: Logger): Promise<CourseLibraryResult> {
    const scraper = new Scraper(logger);
    try {
        return await scraper.parseCourseLibrary(url);
    } finally {
        await scraper.close();
    }
}

function buildCourseHint(course: CourseListItem) {
    const parts: string[] = [];
    if (course.numModules) {
        parts.push(`${course.numModules} modules`);
    }
    if (course.hasAccess === false) {
        parts.push('locked');
    }
    if (course.privacy === 1) {
        parts.push('private');
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

function filterAccessibleCourses(courses: CourseListItem[]) {
    const isLocked = (course: CourseListItem) => course.hasAccess === false || (course.privacy ?? 0) > 0;
    const accessible = courses.filter(course => !isLocked(course));
    const locked = courses.filter(course => isLocked(course));
    return { accessible, locked };
}

function resolveCourseOutputDir(outputRoot: string, groupName: string, courseName: string) {
    return path.join(outputRoot, sanitizeName(groupName), sanitizeName(courseName));
}

async function runInteractive() {
    intro(pc.cyan('Skool Downloader'));

    const action = await select({
        message: 'What would you like to do?',
        options: [
            { value: 'download-course', label: 'Download a full course' },
            { value: 'download-multi', label: 'Download multiple courses' },
            { value: 'download-lesson', label: 'Download a single lesson' },
            { value: 'login', label: 'Log in to Skool' },
            { value: 'regenerate-index', label: 'Regenerate all course indexes' },
            { value: 'exit', label: 'Exit' }
        ]
    });
    handleCancel(action);
    const actionValue = action as 'download-course' | 'download-multi' | 'download-lesson' | 'login' | 'regenerate-index' | 'exit';

    if (actionValue === 'exit') {
        outro('See you next time.');
        return;
    }

    if (actionValue === 'login') {
        const loginSpinner = spinner();
        loginSpinner.start('Opening login browser...');
        await login();
        loginSpinner.stop('Login saved.');
        outro('Session ready for downloads.');
        return;
    }

    if (actionValue === 'regenerate-index') {
        await regenerateAllIndexes();
        outro('Indexes regenerated.');
        return;
    }

    const loggedIn = await ensureLogin();
    if (!loggedIn) {
        outro('Login required. Exiting.');
        return;
    }

    let concurrency = 8;
    if (actionValue === 'download-course' || actionValue === 'download-multi') {
        const concurrencyChoice = await select({
            message: 'Lesson concurrency',
            options: [
                { value: 2, label: '2 (gentle)' },
                { value: 4, label: '4 (steady)' },
                { value: 8, label: '8 (fast)' },
                { value: 12, label: '12 (very fast)' }
            ],
            initialValue: 8
        });
        handleCancel(concurrencyChoice);
        concurrency = Number(concurrencyChoice);
    }

    const interactiveLogger = buildInteractiveLogger();
    const runTasks = createTaskRunner();

    if (actionValue === 'download-multi') {
        const urlInput = await text({
            message: 'Community classroom URL',
            placeholder: 'https://www.skool.com/community/classroom',
            validate(value) {
                if (!value || !value.startsWith('http')) return 'Please enter a valid URL.';
                return undefined;
            }
        });
        handleCancel(urlInput);
        const url = String(urlInput);

        const outputDir = await text({
            message: 'Custom output directory (leave empty for default downloads/)',
            placeholder: path.join(process.cwd(), 'downloads')
        });
        handleCancel(outputDir);
        const outputDirValue = typeof outputDir === 'string' ? outputDir.trim() : '';
        const outputRoot = outputDirValue.length > 0 ? outputDirValue : undefined;

        const librarySpinner = spinner();
        librarySpinner.start('Fetching courses...');
        let library: CourseLibraryResult;
        try {
            library = await fetchCourseLibrary(url, interactiveLogger);
            librarySpinner.stop(`Found ${library.courses.length} courses.`);
        } catch (err) {
            librarySpinner.stop('Failed to fetch courses.');
            log.error(`Unable to load course list: ${String(err)}`);
            outro('Could not fetch courses.');
            return;
        }

        const { accessible, locked } = filterAccessibleCourses(library.courses);
        if (accessible.length === 0) {
            log.warn('No accessible courses found to download.');
            outro('Nothing to download.');
            return;
        }

        if (locked.length > 0) {
            log.warn(`Locked courses (no access):`);
            for (const course of locked) {
                log.warn(`  🔒 ${course.title}`);
            }
        }

        const courseOptions = accessible.map(course => ({
            value: course.key,
            label: course.title,
            hint: buildCourseHint(course)
        }));

        const accessibleKeys = new Set(accessible.map(course => course.key));

        const selection = await multiselect({
            message: 'Select courses to download',
            options: courseOptions,
            initialValues: courseOptions.map(option => option.value).filter(key => accessibleKeys.has(key))
        });
        handleCancel(selection);

        const selectedKeys = new Set(selection as string[]);
        const selectedCourses = accessible.filter(course => selectedKeys.has(course.key));

        if (selectedCourses.length === 0) {
            log.warn('No courses selected.');
            outro('Nothing to download.');
            return;
        }

        let failedCourses = 0;

        for (const course of selectedCourses) {
            log.info(`\n${pc.bold(course.title)} ${pc.dim(`· ${library.groupName}`)}`);
            try {
                const summary = await downloadCourse({
                    url: course.url,
                    outputDir: outputRoot ? resolveCourseOutputDir(outputRoot, library.groupName, course.title) : undefined,
                    concurrency,
                    mode: 'course',
                    logger: interactiveLogger,
                    suppressIndexLogs: true,
                    runTasks,
                    callbacks: {
                        onCourseStart: ({ modulesCount, lessonsCount, outputDir: resolvedDir }) => {
                            log.info(`${modulesCount} modules · ${lessonsCount} lessons`);
                            log.info(`Course will save to: ${resolvedDir}`);
                        }
                    }
                });

                if (summary.failedLessons > 0) {
                    log.warn(`${summary.failedLessons} lessons had errors. You can rerun the download to fill gaps.`);
                }
            } catch (err) {
                failedCourses += 1;
                log.error(`Failed to download course ${course.title}: ${String(err)}`);
            }
        }

        if (failedCourses > 0) {
            log.warn(`${failedCourses} courses failed. You can rerun to fill gaps.`);
        }

        outro('All selected courses processed.');
        return;
    }

    const urlInput = await text({
        message: actionValue === 'download-course' ? 'Course classroom URL' : 'Lesson URL (with ?md=...)',
        placeholder: 'https://www.skool.com/community/classroom/abcdef',
        validate(value) {
            if (!value || !value.startsWith('http')) return 'Please enter a valid URL.';
            return undefined;
        }
    });
    handleCancel(urlInput);
    const url = String(urlInput);

    const outputDir = await text({
        message: 'Custom output directory (leave empty for default)',
        placeholder: path.join(process.cwd(), 'downloads')
    });
    handleCancel(outputDir);

    const lessonId: string | null = null;
    const outputDirValue = typeof outputDir === 'string' ? outputDir.trim() : '';

    const summary = await downloadCourse({
        url: url.trim(),
        outputDir: outputDirValue.length > 0 ? outputDirValue : undefined,
        concurrency: actionValue === 'download-lesson' ? 1 : concurrency,
        mode: actionValue === 'download-lesson' ? 'lesson' : 'course',
        lessonId,
        logger: interactiveLogger,
        suppressIndexLogs: true,
        runTasks,
        callbacks: {
            onCourseStart: ({ courseName, groupName, modulesCount, lessonsCount, outputDir: resolvedDir, targetLessonId, lessonDestination }) => {
                log.info(`${pc.bold(courseName)} ${groupName ? pc.dim(`· ${groupName}`) : ''}`);
                log.info(`${modulesCount} modules · ${lessonsCount} lessons`);
                if (targetLessonId) {
                    log.info(`Single lesson id: ${targetLessonId}`);
                }
                log.info(`Course will save to: ${resolvedDir}`);
                if (lessonDestination) {
                    log.info(`Lesson folder: ${lessonDestination.lessonOutputDir}`);
                    log.info(`Lesson page: ${path.join(lessonDestination.lessonOutputDir, 'index.html')}`);
                    log.info('Lesson assets: video.mp4 (if present) and resources/ folder');
                }
            }
        }
    });

    if (summary.failedLessons > 0) {
        log.warn(`${summary.failedLessons} lessons had errors. You can rerun the download to fill gaps.`);
    }

    outro('All set!');
    console.log(`Files are ready at:\n${summary.outputDir}`);
}

async function regenerateAllIndexes() {
    const downloadsRoot = path.join(process.cwd(), 'downloads');
    const rootExists = await fs.pathExists(downloadsRoot);
    if (!rootExists) {
        console.log(`Downloads folder not found: ${downloadsRoot}`);
        return;
    }

    const groupEntries = await fs.readdir(downloadsRoot, { withFileTypes: true });
    const groupDirs = groupEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

    if (groupDirs.length === 0) {
        console.log('No group folders found to regenerate.');
        return;
    }

    let regeneratedCourses = 0;
    let regeneratedGroups = 0;

    for (const groupDir of groupDirs) {
        const groupPath = path.join(downloadsRoot, groupDir.name);
        const courseEntries = await fs.readdir(groupPath, { withFileTypes: true });
        const courseDirs = courseEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

        if (courseDirs.length === 0) continue;

        for (const courseDir of courseDirs) {
            const coursePath = path.join(groupPath, courseDir.name);
            await regenerateIndex(coursePath, { silent: true });
            regeneratedCourses += 1;
        }

        await regenerateGroupIndex(groupPath, { silent: true });
        regeneratedGroups += 1;
    }

    console.log(`Regenerated ${regeneratedCourses} course indexes across ${regeneratedGroups} groups.`);
}

async function runWithArgs(args: CliArgs) {
    if (args.command === 'help') {
        showHelp();
        return;
    }

    if (args.command === 'login') {
        await login();
        return;
    }

    if (args.command === 'regenerate-index') {
        if (!args.regenerateDir) {
            await regenerateAllIndexes();
            return;
        }

        await regenerateIndex(args.regenerateDir);
        await regenerateGroupIndex(path.dirname(args.regenerateDir));
        return;
    }

    if (args.command === 'download' && args.url) {
        const loggedIn = await ensureLogin();
        if (!loggedIn) {
            console.log('Login required. Exiting.');
            return;
        }
        if (isClassroomRootUrl(args.url)) {
            const logger = buildInteractiveLogger();
            const library = await fetchCourseLibrary(args.url, logger);
            const outputRoot = args.outputDir && args.outputDir !== 'undefined' ? args.outputDir : undefined;
            let failedCourses = 0;
            const { accessible, locked } = filterAccessibleCourses(library.courses);

            if (locked.length > 0) {
                console.warn(`Skipping ${locked.length} locked course${locked.length === 1 ? '' : 's'} (no access).`);
            }

            if (accessible.length === 0) {
                console.warn('No accessible courses found to download.');
                return;
            }

            for (const course of accessible) {
                try {
                    await downloadCourse({
                        url: course.url,
                        outputDir: outputRoot ? resolveCourseOutputDir(outputRoot, library.groupName, course.title) : undefined,
                        concurrency: args.concurrency,
                        mode: 'course'
                    });
                } catch (err) {
                    failedCourses += 1;
                    console.error(`Failed to download course ${course.title}: ${String(err)}`);
                }
            }

            if (failedCourses > 0) {
                console.warn(`${failedCourses} courses failed.`);
            }
            return;
        }

        await downloadCourse({
            url: args.url,
            outputDir: args.outputDir,
            concurrency: args.concurrency,
            mode: args.mode,
            lessonId: args.lessonId
        });
        return;
    }

    await runInteractive();
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await runWithArgs(args);
}

main().catch((error) => {
    console.error('❌ An error occurred:', error);
    process.exit(1);
});
