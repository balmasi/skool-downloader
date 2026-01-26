import YTDlpWrapPkg from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs-extra';
import axios from 'axios';
import { Readable } from 'stream';

const YTDlpWrap = (YTDlpWrapPkg as any).default || YTDlpWrapPkg;

const BIN_DIR = path.join(process.cwd(), 'bin');
const YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const COOKIES_TXT_PATH = path.join(process.cwd(), 'cookies.txt');

export class Downloader {
    private ytDlp: any = null;

    async init() {
        if (!fs.existsSync(BIN_DIR)) {
            await fs.ensureDir(BIN_DIR);
        }

        if (!fs.existsSync(YTDLP_PATH)) {
            console.log('Downloading yt-dlp binary locally...');
            await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
            if (process.platform !== 'win32') {
                await fs.chmod(YTDLP_PATH, 0o755);
            }
        }
        this.ytDlp = new YTDlpWrap(YTDLP_PATH);
    }

    async downloadVideo(url: string, outputDir: string, filename: string) {
        if (!this.ytDlp) await this.init();

        await fs.ensureDir(outputDir);
        const outputPath = path.join(outputDir, `${filename}.%(ext)s`);

        console.log(`Downloading video from ${url}...`);

        const args = [
            url,
            '-o', outputPath,
            '--no-check-certificates',
            '--prefer-free-formats',
            '--add-header', 'Referer:https://www.skool.com/',
            '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ];

        if (fs.existsSync(COOKIES_TXT_PATH)) {
            args.push('--cookies', COOKIES_TXT_PATH);
        }

        try {
            await this.ytDlp!.execPromise(args);
            console.log(`Video downloaded successfully to ${outputDir}`);
        } catch (error) {
            console.error(`Error downloading video: ${error}`);
            throw error;
        }
    }

    async downloadAsset(url: string, outputPath: string) {
        await fs.ensureDir(path.dirname(outputPath));
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

        while ((match = imgRegex.exec(html)) !== null) {
            const url = match[1];
            if (!url) continue;

            try {
                // Ignore relative paths if any
                if (!url.startsWith('http')) continue;

                const filename = `img_${Buffer.from(url).toString('base64').substring(0, 10)}_${path.basename(new URL(url).pathname)}`;
                const outputPath = path.join(assetsDir, filename);

                if (!fs.existsSync(outputPath)) {
                    await this.downloadAsset(url, outputPath);
                }

                processedHtml = processedHtml.replace(url, `assets/${filename}`);
            } catch (err) {
                console.warn(`      ⚠️ Failed to localize image: ${url}`);
            }
        }

        return processedHtml;
    }
}
