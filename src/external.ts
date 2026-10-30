import path from 'path';
import fs from 'fs-extra';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Browser, BrowserContext } from 'playwright';
import type { Logger } from './logger.js';
import { resolveFfmpegPath } from './downloader.js';

const execFileAsync = promisify(execFile);

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

type MiroRect = { x: number; y: number; w: number; h: number };
type MiroItem = MiroRect & { id: string; type: string; text: string };

/** CSS viewport of the capture page. Also the size of one detail tile. */
const MIRO_VIEW = { width: 2560, height: 1440 };
/** Screen pixels per board unit to try, sharpest first. Text stays legible down to ~0.5. */
const MIRO_SCALES = [1, 0.75, 0.5, 0.35];
const MIRO_MAX_TILES = 30;
/** Detail tiles stop being started after this long; the overview and text are always saved. */
const MIRO_TIME_BUDGET_MS = 150_000;
/** ffmpeg refuses frames above ~268 MP; stay well below and keep tiles instead. */
const MIRO_MAX_STITCH_PIXELS = 150_000_000;

/** Text of a Miro item from the Web SDK shape, HTML stripped. */
function miroItemText(i: any): string {
    const parts = [i.title, i.content, i.description, i.url && i.type !== 'image' ? i.url : undefined]
        .filter((s) => typeof s === 'string' && s.trim());
    return parts
        .join(' — ')
        .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
}

/**
 * Converts Web SDK items to absolute board rectangles. Top-level items are
 * centred on (x, y) relative to the canvas centre; children of frames are
 * relative to the parent's top-left corner. Connectors and groups have no
 * geometry of their own and are dropped.
 */
function miroItemRects(raw: any[]): MiroItem[] {
    const byId = new Map<string, any>(raw.map((i) => [i.id, i]));
    const abs = new Map<string, MiroRect | null>();
    const resolve = (i: any, depth = 0): MiroRect | null => {
        if (abs.has(i.id)) return abs.get(i.id)!;
        let r: MiroRect | null = null;
        if (typeof i.x === 'number' && typeof i.y === 'number' && i.width > 0 && i.height > 0) {
            // width/height are before rotation; use the rotated bounding box.
            const rad = ((Number(i.rotation) || 0) * Math.PI) / 180;
            const cos = Math.abs(Math.cos(rad));
            const sin = Math.abs(Math.sin(rad));
            const w = i.width * cos + i.height * sin;
            const h = i.width * sin + i.height * cos;
            r = { x: i.x - w / 2, y: i.y - h / 2, w, h };
            const parent = i.parentId && i.relativeTo === 'parent_top_left' ? byId.get(i.parentId) : undefined;
            if (parent) {
                const p = depth < 10 ? resolve(parent, depth + 1) : null;
                r = p ? { ...r, x: r.x + p.x, y: r.y + p.y } : null;
            }
        }
        abs.set(i.id, r);
        return r;
    };
    // A frame is mostly empty space around its children; its children define the content area.
    const parents = new Set(raw.map((i) => i.parentId).filter(Boolean));
    const items: MiroItem[] = [];
    for (const i of raw) {
        if (i.type === 'frame' && parents.has(i.id)) continue;
        const r = resolve(i);
        if (r && Number.isFinite(r.x + r.y + r.w + r.h)) items.push({ ...r, id: i.id, type: i.type, text: miroItemText(i) });
    }
    return items;
}

/** Groups items whose rectangles lie within `gap` board units of each other. */
function clusterMiroItems(items: MiroItem[], gap: number): { rect: MiroRect; items: MiroItem[] }[] {
    const parent = items.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const order = items.map((_, i) => i).sort((a, b) => items[a].x - items[b].x);
    for (let a = 0; a < order.length; a++) {
        const A = items[order[a]];
        for (let b = a + 1; b < order.length; b++) {
            const B = items[order[b]];
            if (B.x > A.x + A.w + gap) break;
            if (B.y <= A.y + A.h + gap && A.y <= B.y + B.h + gap) parent[find(order[a])] = find(order[b]);
        }
    }
    const groups = new Map<number, MiroItem[]>();
    items.forEach((it, i) => {
        const root = find(i);
        groups.set(root, [...(groups.get(root) || []), it]);
    });
    return [...groups.values()]
        .map((members) => {
            const x0 = Math.min(...members.map((m) => m.x));
            const y0 = Math.min(...members.map((m) => m.y));
            const x1 = Math.max(...members.map((m) => m.x + m.w));
            const y1 = Math.max(...members.map((m) => m.y + m.h));
            return { rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, items: members };
        })
        .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/** Tile grid for one cluster at `scale` screen px per board unit, centred on the cluster. */
function miroTileGrid(rect: MiroRect, scale: number) {
    const tw = MIRO_VIEW.width / scale;
    const th = MIRO_VIEW.height / scale;
    const pad = 40 / scale;
    const cols = Math.max(1, Math.ceil((rect.w + 2 * pad) / tw));
    const rows = Math.max(1, Math.ceil((rect.h + 2 * pad) / th));
    const x0 = rect.x + rect.w / 2 - (cols * tw) / 2;
    const y0 = rect.y + rect.h / 2 - (rows * th) / 2;
    return { cols, rows, tw, th, x0, y0 };
}

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
                record.files.push(...(await this.saveMiroBoard(link.url, targetDir, baseName)).map(rel));
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
    private async saveMiroBoard(url: string, dir: string, baseName: string): Promise<string[]> {
        // The text export is written last, so its presence marks a finished capture.
        const md = path.join(dir, `${baseName}.miro.md`);
        const overview = path.join(dir, `${baseName}.miro.png`);
        if (await existsNonEmpty(md)) {
            const prefix = `${baseName}.miro`;
            const files = (await fs.readdir(dir)).filter((f) => f.startsWith(prefix) && !f.endsWith('.part.png'));
            return files.sort().map((f) => path.join(dir, f));
        }
        const browser = (await this.options.getBrowserContext!()).browser();
        if (!browser) throw new Error('No browser available for the Miro capture');
        const ffmpegPath = await resolveFfmpegPath().catch(() => null);
        const saved = await this.captureMiroBoard(browser, url, dir, baseName, ffmpegPath);
        if (!saved.includes(overview)) saved.unshift(overview);
        return saved;
    }

    /**
     * Saves a public Miro board for offline reading:
     *  - `<baseName>.miro.png`: overview of all content, UI hidden;
     *  - `<baseName>.miro-N.png`: one stitched image per content area at 0.35–1
     *    px per board unit, so text is legible (falls back to
     *    `<baseName>.miro-tiles/N-tile-RR-CC.png` without ffmpeg or when too big);
     *  - `<baseName>.miro.md`: every text item, per area, in reading order.
     *
     * Miro's own Web SDK (`window.miro.board`) is loaded in the board page even for
     * anonymous viewers. `board.get()` returns every item with its bounds and
     * text, and `viewport.set()` moves the camera to an exact board rectangle.
     * That gives the content bounding boxes (so a stray item far away does not
     * shrink everything else) and pixel-exact tiles. When the SDK is missing,
     * only the old fit-to-screen overview is saved.
     */
    private async captureMiroBoard(
        browser: Browser,
        url: string,
        outDir: string,
        baseName: string,
        ffmpegPath: string | null
    ): Promise<string[]> {
        const overviewPath = path.join(outDir, `${baseName}.miro.png`);
        const saved: string[] = [];
        const deadline = Date.now() + MIRO_TIME_BUDGET_MS;
        await fs.ensureDir(outDir);

        // Pixel density is fixed per context, and the board needs no Skool cookies.
        const context = await browser.newContext({ viewport: MIRO_VIEW, deviceScaleFactor: 1 });
        try {
            const page = await context.newPage();
            let inFlight = 0;
            page.on('request', () => inFlight++);
            page.on('requestfinished', () => inFlight--);
            page.on('requestfailed', () => inFlight--);
            /** Waits for image/text tiles of the new camera position to arrive. */
            const settle = async (minMs: number, maxMs: number) => {
                await page.waitForTimeout(minMs);
                const end = Date.now() + maxMs - minMs;
                let quietSince = Date.now();
                while (Date.now() < end) {
                    if (inFlight > 0) quietSince = Date.now();
                    else if (Date.now() - quietSince >= 500) break;
                    await page.waitForTimeout(150);
                }
                // Two frames so the canvas paints what just arrived.
                await page.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
            };
            const shoot = async (file: string) => {
                await page.screenshot({ path: `${file}.part.png`, timeout: 60000, animations: 'disabled', caret: 'hide' });
                await fs.move(`${file}.part.png`, file, { overwrite: true });
            };
            const moveTo = (r: MiroRect) =>
                page.evaluate(
                    `window.miro.board.viewport.set({ viewport: ${JSON.stringify({ x: r.x, y: r.y, width: r.w, height: r.h })} })`
                );

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            let raw: any[] | null = null;
            try {
                await page.waitForFunction('!!(window.miro && window.miro.board && window.miro.board.get)', null, {
                    timeout: 45000
                });
                await page.waitForFunction('window.boardLoading !== true', null, { timeout: 30000 }).catch(() => {});
                raw = (await page.evaluate('window.miro.board.get()')) as any[];
            } catch (err) {
                this.logger.warn(`    ⚠️ Miro board API unavailable, saving the overview only: ${String(err)}`);
            }
            const items = raw ? miroItemRects(raw) : [];
            if (!items.length) {
                await settle(12000, 20000);
                // A private board shows a sign-up dialog instead of the board.
                const body = await page.innerText('body').catch(() => '');
                if (/this is a private board|sign up for free in order to access/i.test(body)) {
                    throw new Error('Miro board is private (owner has not shared it publicly)');
                }
                await shoot(overviewPath);
                return [overviewPath];
            }

            // Hide Miro's chrome (menus, sign-up banner, zoom bar) and keep only the board.
            await page.addStyleTag({
                content:
                    'body * { visibility: hidden !important; } ' +
                    '#main-canvas, #embeds-root, #embeds-root * { visibility: visible !important; }'
            });

            // Pick the sharpest scale whose tiles fit the budget.
            let scale = MIRO_SCALES[MIRO_SCALES.length - 1];
            let clusters = clusterMiroItems(items, MIRO_VIEW.height / scale / 3);
            for (const s of MIRO_SCALES) {
                const c = clusterMiroItems(items, MIRO_VIEW.height / s / 3);
                const n = c.reduce((sum, k) => sum + miroTileGrid(k.rect, s).cols * miroTileGrid(k.rect, s).rows, 0);
                if (n <= MIRO_MAX_TILES) {
                    scale = s;
                    clusters = c;
                    break;
                }
            }

            // Overview: everything, fitted to the screen, chrome hidden.
            const all = clusters.reduce(
                (u, k) => ({
                    x0: Math.min(u.x0, k.rect.x),
                    y0: Math.min(u.y0, k.rect.y),
                    x1: Math.max(u.x1, k.rect.x + k.rect.w),
                    y1: Math.max(u.y1, k.rect.y + k.rect.h)
                }),
                { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
            );
            const fit = Math.max((all.x1 - all.x0) / MIRO_VIEW.width, (all.y1 - all.y0) / MIRO_VIEW.height) * 1.04;
            const ow = MIRO_VIEW.width * fit;
            const oh = MIRO_VIEW.height * fit;
            await moveTo({ x: (all.x0 + all.x1) / 2 - ow / 2, y: (all.y0 + all.y1) / 2 - oh / 2, w: ow, h: oh });
            await settle(3000, 10000);
            await shoot(overviewPath);
            saved.push(overviewPath);

            // Detail tiles, then one stitched image per area.
            let budget = MIRO_MAX_TILES;
            let skipped = 0;
            const tileDir = path.join(outDir, `${baseName}.miro-tiles`);
            // When the budget is tight, the areas with the most items get their tiles first.
            const chosen = new Set<number>();
            for (const i of clusters.map((_, i) => i).sort((a, b) => clusters[b].items.length - clusters[a].items.length)) {
                const g = miroTileGrid(clusters[i].rect, scale);
                if (g.cols * g.rows <= budget) {
                    chosen.add(i);
                    budget -= g.cols * g.rows;
                }
            }
            for (const [index, cluster] of clusters.entries()) {
                const n = index + 1;
                const g = miroTileGrid(cluster.rect, scale);
                // ~3 s per tile; never let one board hold up the lesson for more than a few minutes.
                if (!chosen.has(index) || Date.now() + g.cols * g.rows * 3000 > deadline) {
                    skipped++;
                    continue;
                }
                await fs.ensureDir(tileDir);
                const tiles: string[] = [];
                for (let r = 0; r < g.rows; r++) {
                    for (let c = 0; c < g.cols; c++) {
                        const tile = path.join(
                            tileDir,
                            `${n}-tile-${String(r + 1).padStart(2, '0')}-${String(c + 1).padStart(2, '0')}.png`
                        );
                        await moveTo({ x: g.x0 + c * g.tw, y: g.y0 + r * g.th, w: g.tw, h: g.th });
                        await settle(800, 6000);
                        await shoot(tile);
                        tiles.push(tile);
                    }
                }

                const stitched = path.join(outDir, `${baseName}.miro-${n}.png`);
                const pixels = g.cols * g.rows * MIRO_VIEW.width * MIRO_VIEW.height;
                if (tiles.length === 1) {
                    await fs.move(tiles[0], stitched, { overwrite: true });
                    saved.push(stitched);
                } else if (ffmpegPath && pixels <= MIRO_MAX_STITCH_PIXELS) {
                    try {
                        const list = path.join(tileDir, `${n}-list.txt`);
                        // concat demuxer feeds the tiles in row-major order to the tile filter.
                        await fs.writeFile(list, tiles.map((t) => `file '${path.resolve(t).replace(/'/g, "'\\''")}'`).join('\n'));
                        await execFileAsync(
                            ffmpegPath,
                            ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
                             '-vf', `tile=${g.cols}x${g.rows}`, '-frames:v', '1', '-update', '1', `${stitched}.part.png`],
                            { timeout: 120000 }
                        );
                        await fs.move(`${stitched}.part.png`, stitched, { overwrite: true });
                        await Promise.all([...tiles, list].map((t) => fs.remove(t)));
                        saved.push(stitched);
                    } catch (err) {
                        this.logger.warn(`    ⚠️ Could not stitch Miro tiles, keeping them separate: ${String(err)}`);
                        await fs.remove(`${stitched}.part.png`).catch(() => {});
                        saved.push(...tiles);
                    }
                } else {
                    saved.push(...tiles);
                }
            }
            if (skipped) this.logger.warn(`    ⚠️ Miro board: ${skipped} small area(s) left out of the detail images (time or tile budget)`);
            if ((await fs.pathExists(tileDir)) && !(await fs.readdir(tileDir)).length) await fs.remove(tileDir);

            // Text export: the board's own text, area by area, top-to-bottom then left-to-right.
            const lines: string[] = [];
            for (const [index, cluster] of clusters.entries()) {
                const texts = cluster.items
                    .filter((i) => i.text)
                    .sort((a, b) => Math.round(a.y / 200) - Math.round(b.y / 200) || a.x - b.x);
                if (!texts.length) continue;
                lines.push(`## Area ${index + 1}`, '');
                for (const t of texts) lines.push(`- ${t.type.replace(/_/g, ' ')}: ${t.text.replace(/\n/g, '\n  ')}`);
                lines.push('');
            }
            if (lines.length) {
                const md = path.join(outDir, `${baseName}.miro.md`);
                const title = await page.title().catch(() => '');
                await fs.writeFile(md, [`# ${title.replace(/ - Miro$/, '') || 'Miro board'}`, '', `Source: ${url}`, '', ...lines].join('\n'));
                saved.push(md);
            }
            return saved;
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
