import { intro, outro, select, text, confirm, spinner, isCancel, cancel, log } from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import fs from 'fs-extra';
import { Listr, PRESET_TIMER } from 'listr2';
import { downloadCourse, type DownloadMode } from './index.js';
import { login, getAuthStatus } from './auth.js';
import { regenerateIndex } from './regenerate-index.js';
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
    console.log(`\nSkool Downloader\n\nUsage:\n  skool                          Interactive mode\n  skool login                    Log in to Skool\n  skool <classroom-url>          Download a course\n  skool <lesson-url>             Download a single lesson (URL with ?md=)\n\nOptions:\n  -o, --output <dir>             Output directory (course root)\n  -c, --concurrency <number>     Lesson concurrency (default: 8)\n  --course                       Force course mode (ignore ?md=)\n  --lesson                       Force lesson mode\n  --lesson-id <id>               Explicit lesson id\n  -h, --help                     Show help\n`);
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

async function runInteractive() {
    intro(pc.cyan('Skool Downloader'));

    const action = await select({
        message: 'What would you like to do?',
        options: [
            { value: 'download-course', label: 'Download a full course' },
            { value: 'download-lesson', label: 'Download a single lesson' },
            { value: 'login', label: 'Log in to Skool' },
            { value: 'regenerate-index', label: 'Regenerate a course index' },
            { value: 'exit', label: 'Exit' }
        ]
    });
    handleCancel(action);
    const actionValue = action as 'download-course' | 'download-lesson' | 'login' | 'regenerate-index' | 'exit';

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
        const selectedDir = await selectCourseDirectory();
        if (!selectedDir) {
            outro('No courses found to regenerate.');
            return;
        }

        await regenerateIndex(selectedDir);
        outro('Index regenerated.');
        return;
    }

    const loggedIn = await ensureLogin();
    if (!loggedIn) {
        outro('Login required. Exiting.');
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

    const lessonId: string | null = null;

    let concurrency = 8;
    if (actionValue === 'download-course') {
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

    const outputDir = await text({
        message: 'Custom output directory (leave empty for default)',
        placeholder: path.join(process.cwd(), 'downloads')
    });
    handleCancel(outputDir);

    const interactiveLogger = buildInteractiveLogger();

    const runTasks = async (tasks: { title: string; run: (onStatus?: (message: string) => void) => Promise<void> }[], concurrency: number) => {
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
    };

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

    outro(`All set! Files are ready at ${summary.outputDir}`);
}

type CourseOption = {
    label: string;
    value: string;
    community: string;
    updatedAt: number;
};

async function selectCourseDirectory(): Promise<string | null> {
    const downloadsRoot = path.join(process.cwd(), 'downloads');
    const rootExists = await fs.pathExists(downloadsRoot);
    if (!rootExists) return null;

    const groupEntries = await fs.readdir(downloadsRoot, { withFileTypes: true });
    const groupDirs = groupEntries.filter(entry => entry.isDirectory());

    const courses: CourseOption[] = [];

    for (const groupDir of groupDirs) {
        const groupPath = path.join(downloadsRoot, groupDir.name);
        const courseEntries = await fs.readdir(groupPath, { withFileTypes: true });
        const courseDirs = courseEntries.filter(entry => entry.isDirectory());

        for (const courseDir of courseDirs) {
            const coursePath = path.join(groupPath, courseDir.name);
            const manifestPath = path.join(coursePath, '.course.json');
            const hasManifest = await fs.pathExists(manifestPath);
            if (!hasManifest) continue;

            let community = groupDir.name;
            let courseName = courseDir.name;
            try {
                const manifest = await fs.readJson(manifestPath);
                community = manifest.groupName || community;
                courseName = manifest.courseName || courseName;
            } catch {
                // Ignore manifest read errors and fall back to folder names.
            }

            const stats = await fs.stat(coursePath);
            courses.push({
                label: `${courseName}`,
                value: coursePath,
                community,
                updatedAt: stats.mtimeMs
            });
        }
    }

    if (courses.length === 0) return null;

    const communities = Array.from(new Set(courses.map(course => course.community))).sort((a, b) => {
        const aLatest = Math.max(...courses.filter(c => c.community === a).map(c => c.updatedAt));
        const bLatest = Math.max(...courses.filter(c => c.community === b).map(c => c.updatedAt));
        return bLatest - aLatest;
    });

    const communityChoice = await select({
        message: 'Choose a community',
        options: communities.map(name => ({ value: name, label: name }))
    });
    handleCancel(communityChoice);

    const selectedCommunity = communityChoice as string;
    const communityCourses = courses
        .filter(course => course.community === selectedCommunity)
        .sort((a, b) => b.updatedAt - a.updatedAt);

    const courseChoice = await select({
        message: `Choose a course from ${selectedCommunity}`,
        options: communityCourses.map(course => ({
            value: course.value,
            label: course.label
        }))
    });
    handleCancel(courseChoice);

    return courseChoice as string;
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
            const selectedDir = await selectCourseDirectory();
            if (!selectedDir) {
                console.log('No courses found to regenerate.');
                return;
            }
            await regenerateIndex(selectedDir);
            return;
        }

        await regenerateIndex(args.regenerateDir);
        return;
    }

    if (args.command === 'download' && args.url) {
        const loggedIn = await ensureLogin();
        if (!loggedIn) {
            console.log('Login required. Exiting.');
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
