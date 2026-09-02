import YTDlpWrapPkg from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs-extra';
import axios from 'axios';
import { Readable } from 'stream';
import { createConsoleLogger, type Logger } from './logger.js';
import { COOKIES_TXT_PATH } from './auth.js';

const YTDlpWrap = (YTDlpWrapPkg as any).default || YTDlpWrapPkg;

const BIN_DIR = path.join(process.cwd(), 'bin');
const YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

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

            if (!fs.existsSync(BIN_DIR)) {
                await fs.ensureDir(BIN_DIR);
            }

            if (!fs.existsSync(YTDLP_PATH)) {
                this.logger.info('Downloading yt-dlp binary locally...');
                await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
                if (process.platform !== 'win32') {
                    await fs.chmod(YTDLP_PATH, 0o755);
                }
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
