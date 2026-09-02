import YTDlpWrapPkg from 'yt-dlp-wrap';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';
import axios from 'axios';
import https from 'https';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { IncomingMessage } from 'http';
import { createConsoleLogger, type Logger } from './logger.js';
import { COOKIES_TXT_PATH } from './auth.js';

const YTDlpWrap = (YTDlpWrapPkg as any).default || YTDlpWrapPkg;

/**
 * Resolves the folder that holds the downloaded yt-dlp binary.
 *
 * This is deliberately not the current directory and not the package folder.
 * The current directory gives every folder the user runs the tool from its own
 * 36 MB copy (issue #13). The package folder is read-only for a global install
 * under a system prefix, and is a throwaway cache under npx.
 *
 * Downloads, .auth and cookies.txt stay relative to the current directory.
 * Those belong to the user and should follow them.
 */
export function resolveCacheDir(): string {
    const override = process.env.SKOOL_DOWNLOADER_CACHE_DIR;
    if (override) return override;

    const xdgCache = process.env.XDG_CACHE_HOME;
    if (xdgCache) return path.join(xdgCache, 'skool-downloader');

    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Caches', 'skool-downloader');
    }

    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(localAppData, 'skool-downloader');
    }

    return path.join(os.homedir(), '.cache', 'skool-downloader');
}

const BIN_DIR = path.join(resolveCacheDir(), 'bin');
const YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

const PREVIOUS_YTDLP_PATH = `${YTDLP_PATH}.prev`;
const DOWNLOAD_TMP_PATH = `${YTDLP_PATH}.tmp`;
const VERSION_STAMP_PATH = path.join(BIN_DIR, '.yt-dlp-check.json');

// yt-dlp is only as good as its extractors, and those break whenever a video
// host changes how it serves media. A build older than this is treated as
// suspect and checked against the latest release (issue #14).
const STALE_AFTER_DAYS = 30;

// An upper bound on how often the GitHub release list is queried, so a course
// with 200 lessons does not mean 200 checks. init() already memoises per run;
// this stamp file extends that across runs.
const CHECK_EVERY_HOURS = 24;

type VersionStamp = { lastCheckedAt?: string };

/**
 * Reads the version yt-dlp reports for itself.
 *
 * Doubles as a health check. An interrupted download leaves a file that
 * exists and is the right size on a quick glance, but is not a working
 * program. Running it is the only reliable way to tell the two apart, so
 * every install and rollback is verified this way before it is trusted.
 */
async function readBinaryVersion(binaryPath: string): Promise<string> {
    const version = await new YTDlpWrap(binaryPath).getVersion();
    const trimmed = String(version).trim();
    if (trimmed.length === 0) {
        throw new Error('yt-dlp reported an empty version');
    }
    return trimmed;
}

/**
 * yt-dlp versions are release dates: "2025.12.08", or "2025.12.08.232919" for
 * nightly builds. That makes age readable straight from the binary, with no
 * network call and no reliance on file timestamps, which a copy or a restore
 * from backup would reset.
 */
function parseVersionDate(version: string): Date | null {
    const match = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version);
    if (!match) return null;

    const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysSince(date: Date): number {
    return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

async function writeVersionStamp(): Promise<void> {
    try {
        const stamp: VersionStamp = { lastCheckedAt: new Date().toISOString() };
        await fs.writeJson(VERSION_STAMP_PATH, stamp);
    } catch {
        // A stamp that cannot be written only costs one extra check next run.
    }
}

async function checkedRecently(): Promise<boolean> {
    let stamp: VersionStamp;
    try {
        stamp = (await fs.readJson(VERSION_STAMP_PATH)) as VersionStamp;
    } catch {
        return false;
    }

    if (!stamp?.lastCheckedAt) return false;

    const lastChecked = new Date(stamp.lastCheckedAt);
    if (Number.isNaN(lastChecked.getTime())) return false;

    const hours = (Date.now() - lastChecked.getTime()) / (1000 * 60 * 60);
    return hours >= 0 && hours < CHECK_EVERY_HOURS;
}

async function fetchLatestVersion(): Promise<string> {
    let releases: any;
    try {
        releases = await YTDlpWrap.getGithubReleases(1, 1);
    } catch (error: any) {
        // getGithubReleases rejects with the raw response object, which would
        // reach the user as "[object Object]". Rate limiting (HTTP 403 after
        // 60 unauthenticated calls in an hour) is the likely cause, so say so.
        const status = error?.statusCode;
        if (status) {
            throw new Error(`GitHub answered HTTP ${status} when asked for the latest yt-dlp release`);
        }
        throw error;
    }

    const tag = releases?.[0]?.tag_name;
    if (typeof tag !== 'string' || tag.length === 0) {
        throw new Error('GitHub returned no yt-dlp release tag');
    }
    return tag;
}

const ASSET_NAME = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
const MAX_REDIRECTS = 5;

/**
 * Downloads a URL to a file.
 *
 * Written by hand rather than using YTDlpWrap.downloadFromGithub, which is not
 * safe to rely on here. That helper pipes the response body into the
 * destination before it looks at the status code, so a 404 page lands on disk
 * as the "binary". It also attaches no error handler to the write stream, so a
 * read-only folder or a full disk becomes an uncaught exception that no caller
 * can catch, which would take down a download run.
 *
 * This version checks the status before writing a byte, and lets
 * stream/promises pipeline report either side's failure as a normal rejection.
 */
async function downloadFile(fileUrl: string, filePath: string): Promise<void> {
    let currentUrl = fileUrl;

    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
            const request = https.get(currentUrl, { headers: { 'User-Agent': 'skool-downloader' } }, resolve);
            request.on('error', reject);
        });

        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
            response.resume();
            currentUrl = new URL(location, currentUrl).toString();
            continue;
        }

        if (status !== 200) {
            response.resume();
            throw new Error(`Download of ${currentUrl} failed with HTTP ${status}`);
        }

        await pipeline(response, fs.createWriteStream(filePath));
        return;
    }

    throw new Error(`Too many redirects while downloading ${fileUrl}`);
}

/**
 * Downloads the given yt-dlp release and puts it in place, but only once it
 * has proven that it runs.
 *
 * The download goes to a temporary path, is executed there, and is renamed
 * over the real path only on success. That protects the first install as much
 * as an update: before this, a failed download left a corrupt file that every
 * later run treated as a working binary. The copy being replaced is kept as
 * .prev, so a yt-dlp release that regresses can be undone with
 * `skool update --rollback`.
 */
async function installYtDlp(version: string): Promise<string> {
    await fs.ensureDir(BIN_DIR);
    await fs.remove(DOWNLOAD_TMP_PATH);

    try {
        const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${ASSET_NAME}`;
        await downloadFile(url, DOWNLOAD_TMP_PATH);
        if (process.platform !== 'win32') {
            await fs.chmod(DOWNLOAD_TMP_PATH, 0o755);
        }

        const installedVersion = await readBinaryVersion(DOWNLOAD_TMP_PATH);

        // The old binary moves out of the way first. On Windows a rename onto
        // an existing executable fails if anything still holds a handle to it.
        if (await fs.pathExists(YTDLP_PATH)) {
            await fs.move(YTDLP_PATH, PREVIOUS_YTDLP_PATH, { overwrite: true });
        }
        await fs.move(DOWNLOAD_TMP_PATH, YTDLP_PATH, { overwrite: true });

        return installedVersion;
    } finally {
        // Never leave a half-written file behind that a later run could
        // mistake for a real download.
        await fs.remove(DOWNLOAD_TMP_PATH).catch(() => {});
    }
}

/**
 * Replaces a stale yt-dlp before any lesson is downloaded.
 *
 * Deliberately blocking rather than a background refresh. The point of the
 * update is that the current run stops failing, and a background download
 * would leave this run on the binary that is already broken. It runs at most
 * once a day, and only downloads when the installed build is genuinely old.
 */
async function updateYtDlpIfStale(logger: Logger): Promise<void> {
    if (process.env.SKOOL_NO_YTDLP_UPDATE) return;
    if (await checkedRecently()) return;

    let localVersion: string;
    try {
        localVersion = await readBinaryVersion(YTDLP_PATH);
    } catch {
        // The file exists but cannot report a version, so an earlier download
        // was cut short. There is no working copy to fall back to, so a
        // failure here is allowed to stop the run.
        logger.warn('⚠️  The yt-dlp binary looks damaged. Downloading it again...');
        const repaired = await installYtDlp(await fetchLatestVersion());
        await writeVersionStamp();
        logger.info(`✅ yt-dlp ${repaired} installed.`);
        return;
    }

    try {
        const releaseDate = parseVersionDate(localVersion);
        if (releaseDate && daysSince(releaseDate) < STALE_AFTER_DAYS) return;

        const latest = await fetchLatestVersion();
        if (latest === localVersion) return;

        const age = releaseDate ? `${daysSince(releaseDate)} days old` : 'of unknown age';
        logger.info(`⬆️  yt-dlp ${localVersion} is ${age}. Updating to ${latest} ...`);
        await installYtDlp(latest);
        logger.info(`✅ yt-dlp updated to ${latest}.`);
    } catch (error) {
        // GitHub being unreachable, rate-limited or slow must never stop a
        // download. The installed binary still works, it is just old.
        logger.warn(`⚠️  Could not update yt-dlp: ${String(error)}`);
        logger.warn(`⚠️  Continuing with the installed version (${localVersion}).`);
    } finally {
        await writeVersionStamp();
    }
}

export type YtDlpUpdateResult = {
    from: string | null;
    to: string;
    changed: boolean;
};

/**
 * Forces a version check and download, ignoring both the age threshold and the
 * once-a-day stamp. This is what `skool update` runs.
 */
export async function updateYtDlp(logger: Logger = createConsoleLogger()): Promise<YtDlpUpdateResult> {
    await fs.ensureDir(BIN_DIR);

    let from: string | null = null;
    if (await fs.pathExists(YTDLP_PATH)) {
        try {
            from = await readBinaryVersion(YTDLP_PATH);
        } catch {
            logger.warn('⚠️  The installed yt-dlp binary is damaged and will be replaced.');
        }
    }

    const latest = await fetchLatestVersion();
    if (from !== null && from === latest) {
        await writeVersionStamp();
        return { from, to: latest, changed: false };
    }

    const installed = await installYtDlp(latest);
    await writeVersionStamp();
    return { from, to: installed, changed: true };
}

/**
 * Puts back the copy that the last update replaced, for when a new yt-dlp
 * release breaks something that used to work.
 */
export async function rollbackYtDlp(): Promise<{ from: string | null; to: string }> {
    if (!(await fs.pathExists(PREVIOUS_YTDLP_PATH))) {
        throw new Error(`No previous yt-dlp binary to restore. Expected it at ${PREVIOUS_YTDLP_PATH}`);
    }

    // Verified before the swap, so a rollback cannot leave the tool worse off
    // than it started.
    const to = await readBinaryVersion(PREVIOUS_YTDLP_PATH);

    let from: string | null = null;
    if (await fs.pathExists(YTDLP_PATH)) {
        try {
            from = await readBinaryVersion(YTDLP_PATH);
        } catch {
            from = null;
        }
        await fs.remove(YTDLP_PATH);
    }

    await fs.move(PREVIOUS_YTDLP_PATH, YTDLP_PATH, { overwrite: true });
    await writeVersionStamp();

    return { from, to };
}

export function getYtDlpPaths() {
    return { binDir: BIN_DIR, binaryPath: YTDLP_PATH, previousPath: PREVIOUS_YTDLP_PATH };
}

const FFMPEG_INSTALL_HINT = [
    'ffmpeg is required to merge video and audio into a single file, but none was found.',
    'The bundled copy could not be installed, so please install ffmpeg manually:',
    '  macOS:   brew install ffmpeg',
    '  Windows: winget install Gyan.FFmpeg',
    '  Linux:   sudo apt install ffmpeg'
].join('\n');

/**
 * Looks for an ffmpeg executable on the system PATH.
 * Done by hand rather than by shelling out to which/where so it behaves the
 * same on every platform.
 */
function findFfmpegOnPath(): string | null {
    const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const candidate = path.join(dir, exeName);
        if (fs.existsSync(candidate)) return candidate;
    }

    return null;
}

/**
 * Resolves the ffmpeg binary that yt-dlp uses to merge streams.
 *
 * Most sources above 720p deliver video and audio separately. Without ffmpeg
 * yt-dlp downloads both and leaves them side by side, unmerged (issue #9).
 *
 * ffmpeg-static is an optional dependency because its install step downloads a
 * binary from GitHub, which can fail behind a proxy, offline, or on a platform
 * it has no build for. A failure there must not break the whole install, so
 * fall back to a system ffmpeg before giving up.
 */
async function resolveFfmpegPath(): Promise<string> {
    try {
        // Imported dynamically. A static import of a missing optional
        // dependency throws while the module loads and takes down the whole CLI.
        const mod: any = await import('ffmpeg-static');
        const bundled = mod.default || mod;
        if (typeof bundled === 'string' && fs.existsSync(bundled)) {
            return bundled;
        }
    } catch {
        // Not installed. The system PATH is the next place to look.
    }

    const systemFfmpeg = findFfmpegOnPath();
    if (systemFfmpeg) return systemFfmpeg;

    throw new Error(FFMPEG_INSTALL_HINT);
}

const STALE_EXTRACTOR_HINT = [
    'This failure usually means the yt-dlp build is too old for the video host.',
    'Run `skool update` to fetch the newest yt-dlp, then try again.',
    'If a fresh yt-dlp made things worse, `skool update --rollback` restores the previous one.'
].join('\n');

/**
 * Recognises the failures that a newer yt-dlp normally fixes. Hosts answer an
 * outdated extractor with a plain 403 or by offering no usable format, neither
 * of which points at the real cause on its own.
 */
function looksLikeStaleExtractor(error: unknown): boolean {
    const message = String(error);
    return (
        message.includes('HTTP Error 403') ||
        message.includes('Requested format is not available') ||
        message.includes('unable to download video data') ||
        message.includes('Unable to extract') ||
        message.includes('SABR streaming')
    );
}

export class Downloader {
    private ytDlp: any = null;
    private ffmpegPath: string | null = null;
    private initPromise: Promise<void> | null = null;
    private logger: Logger;

    constructor(logger: Logger = createConsoleLogger()) {
        this.logger = logger;
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        
        this.initPromise = (async () => {
            // Resolved before yt-dlp is set up, for two reasons. A missing
            // ffmpeg fails while this.ytDlp is still null, so every later call
            // re-awaits this rejected promise instead of finding ytDlp set,
            // skipping init, and quietly downloading unmerged streams. It also
            // reports the problem before the 36 MB yt-dlp download, not after.
            this.ffmpegPath = await resolveFfmpegPath();

            await fs.ensureDir(BIN_DIR);

            if (!fs.existsSync(YTDLP_PATH)) {
                this.logger.info(`Downloading yt-dlp binary to ${YTDLP_PATH} ...`);
                const version = await installYtDlp(await fetchLatestVersion());
                await writeVersionStamp();
                this.logger.info(`\u2705 yt-dlp ${version} installed.`);
            } else {
                // Runs before the first lesson, not per lesson: init() is
                // memoised for the run and the stamp file caps it at once a
                // day across runs.
                await updateYtDlpIfStale(this.logger);
            }

            this.ytDlp = new YTDlpWrap(YTDLP_PATH);
        })();

        return this.initPromise;
    }

    async downloadVideo(url: string, outputDir: string, filename: string) {
        if (!this.ytDlp) await this.init();

        await fs.ensureDir(outputDir);
        const outputPath = path.join(outputDir, `${filename}.mp4`);

        // Skip if video already exists
        if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            if (stats.size > 0) {
                this.logger.info(`    ⏭️  Video already exists, skipping download (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                return;
            }
        }

        const displayUrl = url.length > 100 ? url.substring(0, 97) + '...' : url;
        this.logger.info(`    ⬇️  Downloading video from ${displayUrl}`);

        const args = [
            url,
            '-o', outputPath,
            '--no-check-certificates',
            '--prefer-free-formats',
            '--add-header', 'Referer:https://www.skool.com/',
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            '--merge-output-format', 'mp4',
            '-N', '16',
            '--postprocessor-args', 'ffmpeg:-movflags +faststart'
        ];

        // Without this yt-dlp cannot merge the separate video and audio streams
        // and leaves both files behind instead of one playable mp4.
        if (this.ffmpegPath) {
            args.push('--ffmpeg-location', this.ffmpegPath);
        }

        if (fs.existsSync(COOKIES_TXT_PATH)) {
            args.push('--cookies', COOKIES_TXT_PATH);
        }

        try {
            await this.ytDlp!.execPromise(args);
            this.logger.info(`Video downloaded successfully to ${outputDir}`);
        } catch (error) {
            this.logger.error(`Error downloading video: ${String(error)}`);
            if (looksLikeStaleExtractor(error)) {
                this.logger.error(STALE_EXTRACTOR_HINT);
            }
            throw error;
        }
    }

    async downloadAsset(url: string, outputPath: string) {
        await fs.ensureDir(path.dirname(outputPath));

        // Skip if asset already exists
        if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            if (stats.size > 0) {
                return; // Silently skip, caller will handle messaging
            }
        }

        const writer = fs.createWriteStream(outputPath);

        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'Referer': 'https://www.skool.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });

        (response.data as Readable).pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    async localizeImages(html: string, outputDir: string): Promise<string> {
        const assetsDir = path.join(outputDir, 'assets');
        const imgRegex = /<img[^>]+src="([^">]+)"/g;
        let match;
        let processedHtml = html;
        const tasks: { url: string; outputPath: string }[] = [];

        while ((match = imgRegex.exec(html)) !== null) {
            const url = match[1];
            if (!url) continue;
            if (!url.startsWith('http')) continue;

            const filename = `img_${Buffer.from(url).toString('base64').substring(0, 10)}_${path.basename(new URL(url).pathname)}`;
            const outputPath = path.join(assetsDir, filename);
            tasks.push({ url, outputPath });
            
            processedHtml = processedHtml.replace(url, `assets/${filename}`);
        }

        if (tasks.length > 0) {
            this.logger.info(`      🖼️  Localizing ${tasks.length} images...`);
            await Promise.all(tasks.map(task => 
                this.downloadAsset(task.url, task.outputPath).catch(err => 
                    this.logger.warn(`      ⚠️ Failed to localize image: ${task.url}`)
                )
            ));
        }

        return processedHtml;
    }
}
