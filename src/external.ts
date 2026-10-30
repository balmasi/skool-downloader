import path from 'path';
import fs from 'fs-extra';
import axios from 'axios';
import type { BrowserContext } from 'playwright';
import type { Logger } from './logger.js';

/**
 * Lessons point at a lot of material that lives outside Skool: Google Docs,
 * Sheets and Slides, Drive files and folders, Miro boards, and referral links.
 * Linking to them is not a backup, because the owner can revoke access at any
 * time. This module saves a local copy of everything that can be exported
 * without signing in, and records the exact URL of everything else.
 */

export type LinkKind =
    | 'google-doc'
    | 'google-sheet'
    | 'google-slides'
    | 'google-drive-file'
    | 'google-drive-folder'
    | 'google-form'
    | 'miro'
    | 'skool'
    | 'video'
    | 'web';

export type LinkSource = 'resource' | 'content' | 'nested';

export interface LinkInput {
    url: string;
    title: string;
    source: LinkSource;
}

export interface LinkRecord extends LinkInput {
    kind: LinkKind;
    status: 'archived' | 'linked' | 'failed';
    /** Paths relative to the lesson folder. */
    files: string[];
    error?: string;
    /** Links found inside an archived Google Doc. */
    nested?: LinkRecord[];
}

const USER_AGENT =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Hosts whose pages are a single video that yt-dlp can save. Wistia is matched
// on its media paths only, because try.wistia.com is a referral page.
const VIDEO_HOSTS = [
    'youtube.com', 'youtu.be', 'loom.com', 'vimeo.com',
    'supercut.ai', 'fathom.video', 'tella.tv', 'vidyard.com'
];
const WISTIA_MEDIA = /wistia\.(com|net)$/;

export function classifyLink(rawUrl: string): { kind: LinkKind; id?: string } {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return { kind: 'web' };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const p = url.pathname;

    if (host === 'docs.google.com') {
        const id = p.match(/\/d\/(?:e\/)?([a-zA-Z0-9_-]{10,})/)?.[1];
        if (p.startsWith('/document/')) return { kind: 'google-doc', id };
        if (p.startsWith('/spreadsheets/')) return { kind: 'google-sheet', id };
        if (p.startsWith('/presentation/')) return { kind: 'google-slides', id };
        if (p.startsWith('/forms/')) return { kind: 'google-form', id };
        if (id) return { kind: 'google-drive-file', id };
    }
    if (host === 'drive.google.com' || host === 'drive.usercontent.google.com') {
        const folderId = p.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
        if (folderId) return { kind: 'google-drive-folder', id: folderId };
        const fileId = p.match(/\/d\/([a-zA-Z0-9_-]+)/)?.[1] || url.searchParams.get('id') || undefined;
        if (fileId) return { kind: 'google-drive-file', id: fileId };
    }
    if (host === 'miro.com' && p.includes('/board/')) {
        return { kind: 'miro', id: p.match(/\/board\/([^/]+)/)?.[1] };
    }
    if (host === 'skool.com') return { kind: 'skool' };
    if (VIDEO_HOSTS.some(h => host === h || host.endsWith(`.${h}`)) || (WISTIA_MEDIA.test(host) && /\/(medias|embed)\//.test(p))) {
        const id = videoId(host, url);
        // Channel pages, Loom folders and home pages are not single videos.
        return id ? { kind: 'video', id } : { kind: 'web' };
    }
    return { kind: 'web' };
}

/**
 * The same video is often linked several times with different timestamps or
 * tracking parameters (`?t=72`, `?sid=...`). The ID lets the archiver save it
 * once. Returns undefined for pages that are not one video.
 */
function videoId(host: string, url: URL): string | undefined {
    const p = url.pathname;
    if (host === 'youtu.be') return p.slice(1) || undefined;
    if (host.endsWith('youtube.com')) return url.searchParams.get('v') || p.match(/\/(?:shorts|embed|live)\/([\w-]+)/)?.[1];
    if (host.endsWith('loom.com')) return p.match(/\/(?:share|embed)\/([0-9a-f]{20,})/)?.[1];
    if (host.endsWith('vimeo.com')) return p.match(/\/(?:video\/)?(\d{6,})/)?.[1];
    if (host.includes('wistia')) return p.match(/\/(?:medias|embed\/iframe|embed\/medias)\/([a-z0-9]{10})/i)?.[1];
    if (host.endsWith('fathom.video')) return p.match(/\/share\/([\w-]+)/)?.[1];
    if (host.endsWith('supercut.ai')) return p.match(/\/share\/[^/]+\/([\w-]+)/)?.[1];
    return p.length > 1 ? p : undefined;
}

function isYouTube(url: string) {
    try {
        const host = new URL(url).hostname;
        return host.endsWith('youtube.com') || host === 'youtu.be';
    } catch {
        return false;
    }
}

export function sanitizeFileName(value: string) {
    const cleaned = value.replace(/[/\\?%*:|"<>\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
    return (cleaned || 'untitled').slice(0, 120);
}

/** Google wraps every link in an exported doc as google.com/url?q=<real url>. */
function unwrapGoogleRedirect(href: string) {
    try {
        const u = new URL(href);
        if (u.hostname.endsWith('google.com') && u.pathname === '/url') {
            return u.searchParams.get('q') || href;
        }
    } catch {
        // Not a URL; return as-is.
    }
    return href;
}

function decodeHtmlEntities(value: string) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

/** Pulls `<a href>` targets and their text out of an HTML string. */
export function extractAnchors(html: string): Array<{ url: string; text: string }> {
    const anchors: Array<{ url: string; text: string }> = [];
    const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const url = unwrapGoogleRedirect(decodeHtmlEntities(m[1]!));
        if (!/^https?:/i.test(url)) continue;
        const text = decodeHtmlEntities(m[2]!.replace(/<[^>]+>/g, '')).trim();
        anchors.push({ url, text });
    }
    return anchors;
}

type FetchedFile = { data: Buffer; contentType: string; fileName?: string };

/** Retries connection failures and 429/5xx; a 4xx is final. */
async function fetchBinary(url: string, attempts = 3): Promise<FetchedFile> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fetchBinaryOnce(url);
        } catch (err) {
            const message = String(err);
            const retryable = !/HTTP 4(?!29)\d\d/.test(message);
            if (!retryable || attempt >= attempts) throw err;
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

async function fetchBinaryOnce(url: string): Promise<FetchedFile> {
    const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        headers: { 'User-Agent': USER_AGENT },
        validateStatus: () => true
    });
    if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}`);
    }
    const contentType = String(response.headers['content-type'] || '');
    const disposition = String(response.headers['content-disposition'] || '');
    const fileName =
        disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1] ??
        disposition.match(/filename="([^"]+)"/i)?.[1];
    return {
        data: Buffer.from(response.data),
        contentType,
        fileName: fileName ? decodeURIComponent(fileName) : undefined
    };
}

/**
 * Google answers a request for a private file with a 200 and its sign-in page,
 * so the status alone does not prove that the export worked.
 */
function assertNotHtml(file: FetchedFile, what: string) {
    if (file.contentType.includes('text/html')) {
        throw new Error(`${what} is not public (Google returned a sign-in page)`);
    }
    if (file.data.length === 0) {
        throw new Error(`${what} export was empty`);
    }
}

async function writeFileAtomic(filePath: string, data: Buffer) {
    await fs.ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.part`;
    await fs.writeFile(tmp, data);
    await fs.move(tmp, filePath, { overwrite: true });
}

async function existsNonEmpty(filePath: string) {
    try {
        return (await fs.stat(filePath)).size > 0;
    } catch {
        return false;
    }
}

type ExportFormat = { ext: string; url: (id: string) => string };

const GOOGLE_EXPORTS: Partial<Record<LinkKind, ExportFormat[]>> = {
    'google-doc': [
        { ext: 'docx', url: id => `https://docs.google.com/document/d/${id}/export?format=docx` },
        { ext: 'pdf', url: id => `https://docs.google.com/document/d/${id}/export?format=pdf` }
    ],
    'google-sheet': [
        { ext: 'xlsx', url: id => `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx` }
    ],
    'google-slides': [
        { ext: 'pptx', url: id => `https://docs.google.com/presentation/d/${id}/export/pptx` },
        { ext: 'pdf', url: id => `https://docs.google.com/presentation/d/${id}/export/pdf` }
    ]
};

export type VideoSaver = (url: string, outputDir: string, fileName: string, options?: { maxHeight?: number }) => Promise<void>;

/** State shared by all links of one lesson. */
type ArchiveRun = {
    lessonDir: string;
    /** Keyed by `kind:id` for Google files, by URL otherwise. */
    done: Map<string, LinkRecord>;
    usedNames: Set<string>;
};

export interface ArchiverOptions {
    logger: Logger;
    /** Needed for Miro boards, which only render in a browser. */
    getBrowserContext?: () => Promise<BrowserContext>;
    /** Saves a video page (Loom, YouTube, ...) with yt-dlp. */
    saveVideo?: VideoSaver;
    /** How deep to follow Google Doc links found inside archived Google Docs. */
    nestedDepth?: number;
    /**
     * Height cap for videos found inside Google Docs (default 720). They are
     * supporting material and can number in the dozens per course.
     */
    nestedVideoMaxHeight?: number;
}

export class LinkArchiver {
    private logger: Logger;
    private options: ArchiverOptions;

    constructor(options: ArchiverOptions) {
        this.logger = options.logger;
        this.options = options;
    }

    /**
     * Archives every link into `<lessonDir>/resources`. A document linked more
     * than once, directly or from inside another doc, is saved once and the
     * records share its files.
     */
    async archiveAll(links: LinkInput[], lessonDir: string): Promise<LinkRecord[]> {
        const run: ArchiveRun = { lessonDir, done: new Map(), usedNames: new Set() };
        const records: LinkRecord[] = [];
        for (const link of links) {
            records.push(await this.archiveLink(link, path.join(lessonDir, 'resources'), run, this.options.nestedDepth ?? 1));
        }
        return records;
    }

    private async archiveLink(link: LinkInput, targetDir: string, run: ArchiveRun, depth: number): Promise<LinkRecord> {
        const { kind, id } = classifyLink(link.url);
        const key = id ? `${kind}:${id}` : link.url;
        const previous = run.done.get(key);
        if (previous) {
            return { ...link, kind, status: previous.status, files: previous.files, error: previous.error };
        }

        let baseName = sanitizeFileName(link.title || id || 'link');
        const nameKey = path.join(targetDir, baseName).toLowerCase();
        if (run.usedNames.has(nameKey)) baseName = `${baseName} (${(id ?? String(run.usedNames.size)).slice(0, 8)})`;
        run.usedNames.add(path.join(targetDir, baseName).toLowerCase());

        const record = await this.archiveOne(link, kind, id, targetDir, baseName, run, depth);
        run.done.set(key, record);
        return record;
    }

    private async archiveOne(
        link: LinkInput,
        kind: LinkKind,
        id: string | undefined,
        targetDir: string,
        baseName: string,
        run: ArchiveRun,
        depth: number
    ): Promise<LinkRecord> {
        const record: LinkRecord = { ...link, kind, status: 'linked', files: [] };
        const rel = (abs: string) => path.relative(run.lessonDir, abs);

        try {
            const formats = GOOGLE_EXPORTS[kind];
            if (formats && id) {
                for (const format of formats) {
                    const abs = path.join(targetDir, `${baseName}.${format.ext}`);
                    if (!(await existsNonEmpty(abs))) {
                        const file = await fetchBinary(format.url(id));
                        assertNotHtml(file, `${kind} "${link.title}"`);
                        await writeFileAtomic(abs, file.data);
                    }
                    record.files.push(rel(abs));
                }
                record.status = 'archived';
                this.logger.info(`    📄 Saved ${kind} "${link.title}" (${record.files.map(f => path.extname(f)).join(', ')})`);
                // Registered before recursing so a doc that links back to
                // itself or its parent is not fetched again.
                run.done.set(`${kind}:${id}`, record);
                if (kind === 'google-doc' && depth > 0) {
                    record.nested = await this.archiveNested(id, path.join(run.lessonDir, 'resources', 'linked-from', baseName), run, depth - 1);
                }
                return record;
            }

            if (kind === 'google-drive-file' && id) {
                record.files.push(rel(await this.saveDriveFile(id, targetDir, baseName)));
                record.status = 'archived';
                return record;
            }

            if (kind === 'google-drive-folder' && id) {
                const files = await this.saveDriveFolder(id, path.join(targetDir, baseName), 2);
                record.files.push(...files.map(rel));
                record.status = files.length > 0 ? 'archived' : 'failed';
                if (files.length === 0) record.error = 'Drive folder is empty or not public';
                return record;
            }

            if (kind === 'miro' && this.options.getBrowserContext) {
                record.files.push(rel(await this.saveMiroBoard(link.url, targetDir, baseName)));
                record.status = 'archived';
                return record;
            }

            if (kind === 'video' && this.options.saveVideo) {
                const target = path.join(targetDir, `${baseName}.mp4`);
                const maxHeight = link.source === 'nested' ? (this.options.nestedVideoMaxHeight ?? 720) : undefined;
                await this.options.saveVideo(link.url, targetDir, baseName, { maxHeight });
                if (await existsNonEmpty(target)) {
                    record.files.push(rel(target));
                    record.status = 'archived';
                } else {
                    record.status = 'failed';
                    record.error = 'yt-dlp produced no file';
                }
                return record;
            }
        } catch (err) {
            record.status = 'failed';
            record.error = (err instanceof Error ? err.message : String(err)).trim().split('\n')[0]!.slice(0, 300);
            this.logger.warn(`    ⚠️ Could not archive ${kind} "${link.title}": ${record.error}`);
        }

        return record;
    }

    /**
     * Records every link inside a Google Doc and saves the Google files among
     * them. Docs often hold the real material (an SOP linking to its sheet).
     */
    private async archiveNested(docId: string, targetDir: string, run: ArchiveRun, depth: number): Promise<LinkRecord[]> {
        let html: string;
        try {
            const file = await fetchBinary(`https://docs.google.com/document/d/${docId}/export?format=html`);
            html = file.data.toString('utf8');
        } catch {
            return [];
        }
        const seen = new Set<string>();
        const nested: LinkRecord[] = [];
        for (const anchor of extractAnchors(html)) {
            if (seen.has(anchor.url)) continue;
            seen.add(anchor.url);
            const { kind, id } = classifyLink(anchor.url);
            if (id === docId) continue;
            const input: LinkInput = { url: anchor.url, title: anchor.text || anchor.url, source: 'nested' };
            const isGoogleFile = kind.startsWith('google-') && kind !== 'google-form';
            // Walkthrough videos (Loom, Wistia, Fathom, ...) and Miro boards in
            // SOP docs are course material. Public YouTube videos linked from
            // docs are mostly third-party, so they are recorded, not saved.
            const isSaveable = isGoogleFile || kind === 'miro' || (kind === 'video' && !isYouTube(anchor.url));
            if (!isSaveable || !id) {
                const previous = run.done.get(id ? `${kind}:${id}` : anchor.url);
                nested.push(previous
                    ? { ...input, kind, status: previous.status, files: previous.files, error: previous.error }
                    : { ...input, kind, status: 'linked', files: [] });
                continue;
            }
            nested.push(await this.archiveLink(input, targetDir, run, depth));
        }
        return nested;
    }


    private async saveDriveFile(id: string, dir: string, baseName: string): Promise<string> {
        const existing = (await fs.pathExists(dir))
            ? (await fs.readdir(dir)).find(f => f.startsWith(`${baseName}.`) && !f.endsWith('.part'))
            : undefined;
        if (existing) return path.join(dir, existing);

        const file = await fetchBinary(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`);
        if (file.contentType.includes('text/html')) {
            // Google-native files have no binary; try the Docs exports instead.
            for (const kind of ['google-doc', 'google-sheet', 'google-slides'] as const) {
                const format = GOOGLE_EXPORTS[kind]![0]!;
                try {
                    const exported = await fetchBinary(format.url(id));
                    if (!exported.contentType.includes('text/html') && exported.data.length > 0) {
                        const target = path.join(dir, `${baseName}.${format.ext}`);
                        await writeFileAtomic(target, exported.data);
                        return target;
                    }
                } catch {
                    // Try the next kind.
                }
            }
            throw new Error('Drive file is not public');
        }
        const ext = path.extname(file.fileName || '') || '.bin';
        const target = path.join(dir, `${baseName}${ext}`);
        await writeFileAtomic(target, file.data);
        return target;
    }

    /**
     * Public Drive folders can be listed without the Drive API through the
     * embeddable folder view, which is plain HTML.
     */
    private async saveDriveFolder(id: string, dir: string, depth: number): Promise<string[]> {
        const listing = await fetchBinary(`https://drive.google.com/embeddedfolderview?id=${id}#list`);
        const html = listing.data.toString('utf8');
        const entries: Array<{ url: string; title: string }> = [];
        const re = /<div class="flip-entry"[\s\S]*?<a href="([^"]+)"[\s\S]*?<div class="flip-entry-title">([^<]*)<\/div>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
            entries.push({ url: decodeHtmlEntities(m[1]!), title: decodeHtmlEntities(m[2]!).trim() });
        }

        const saved: string[] = [];
        for (const entry of entries) {
            const { kind, id: childId } = classifyLink(entry.url);
            if (!childId) continue;
            const name = sanitizeFileName(entry.title.replace(/\.[a-z0-9]{2,5}$/i, ''));
            try {
                if (kind === 'google-drive-folder') {
                    if (depth > 0) saved.push(...(await this.saveDriveFolder(childId, path.join(dir, name), depth - 1)));
                    continue;
                }
                const formats = GOOGLE_EXPORTS[kind];
                if (formats) {
                    for (const format of formats) {
                        const target = path.join(dir, `${name}.${format.ext}`);
                        if (!(await existsNonEmpty(target))) {
                            const file = await fetchBinary(format.url(childId));
                            assertNotHtml(file, entry.title);
                            await writeFileAtomic(target, file.data);
                        }
                        saved.push(target);
                    }
                    continue;
                }
                saved.push(await this.saveDriveFile(childId, dir, name));
            } catch (err) {
                this.logger.warn(`    ⚠️ Could not save Drive item "${entry.title}": ${String(err)}`);
            }
        }
        return saved;
    }

    /**
     * Miro has no anonymous export, and its screen-reader outline is empty for
     * anonymous viewers. The board opens zoomed to fit, so one screenshot at
     * 3x pixel density keeps the sticky-note text readable.
     */
    private async saveMiroBoard(url: string, dir: string, baseName: string): Promise<string> {
        const pngPath = path.join(dir, `${baseName}.miro.png`);
        if (await existsNonEmpty(pngPath)) return pngPath;

        const browser = (await this.options.getBrowserContext!()).browser();
        if (!browser) throw new Error('No browser available for the Miro capture');
        // A separate context: pixel density is fixed per context, and the board
        // needs no Skool cookies.
        const context = await browser.newContext({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 3 });
        try {
            const page = await context.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(15000);
            await fs.ensureDir(dir);
            await page.screenshot({ path: `${pngPath}.part.png` });
            await fs.move(`${pngPath}.part.png`, pngPath, { overwrite: true });
            return pngPath;
        } finally {
            await context.close();
        }
    }
}

const KIND_LABELS: Record<LinkKind, string> = {
    'google-doc': 'Google Doc',
    'google-sheet': 'Google Sheet',
    'google-slides': 'Google Slides',
    'google-drive-file': 'Drive file',
    'google-drive-folder': 'Drive folder',
    'google-form': 'Google Form',
    miro: 'Miro board',
    skool: 'Skool link',
    video: 'Video',
    web: 'Web link'
};

function escapeHtml(value: string) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One `<li>` per link: the original URL plus every local copy. */
export function renderLinkItems(records: LinkRecord[]): string {
    return records.map(r => {
        const local = r.files
            .map(f => `<a class="local" href="${f.split(path.sep).map(encodeURIComponent).join('/')}">${escapeHtml(path.basename(f))}</a>`)
            .join(' ');
        const status = r.status === 'failed' ? ` <em>(not saved: ${escapeHtml(r.error ?? 'unknown error')})</em>` : '';
        const nested = r.nested && r.nested.length > 0
            ? `<ul class="nested">${renderLinkItems(r.nested)}</ul>`
            : '';
        return `<li><span class="kind">${KIND_LABELS[r.kind]}</span> <a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.title)}</a> <code>${escapeHtml(r.url)}</code> ${local}${status}${nested}</li>`;
    }).join('');
}
