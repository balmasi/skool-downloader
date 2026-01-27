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
export class Downloader {
    private ytDlp: any = null;
    private initPromise: Promise<void> | null = null;
    private logger: Logger;

    constructor(logger: Logger = createConsoleLogger()) {
        this.logger = logger;
    }

    async init() {
        if (this.initPromise) return this.initPromise;
        
        this.initPromise = (async () => {
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
