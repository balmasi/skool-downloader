import { chromium, type Browser, type BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

const STORAGE_STATE_PATH = path.join(process.cwd(), 'storage_state.json');

export interface Lesson {
    id: string;
    title: string;
    url: string;
    index?: number;
    contentHtml?: string;
    videoLink?: string;
}

export interface Module {
    title: string;
    index: number;
    lessons: Lesson[];
}

export class Scraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;

    async init() {
        this.browser = await chromium.launch({ headless: true });
        if (fs.existsSync(STORAGE_STATE_PATH)) {
            this.context = await this.browser.newContext({ storageState: STORAGE_STATE_PATH });
        } else {
            this.context = await this.browser.newContext();
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }

    async parseClassroom(url: string): Promise<Module[]> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        // Ensure we are using a clean classroom URL without query params for structure extraction
        const cleanUrl = url.split('?')[0]!;
        console.log(`Navigating to ${cleanUrl}...`);
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        await page.close();

        if (!nextData) throw new Error('Could not find __NEXT_DATA__ on classroom page');

        const pageProps = nextData.props?.pageProps || {};
        const courseData = pageProps.course;

        if (!courseData || !courseData.children) {
            console.log('DEBUG: course metadata:', courseData?.course?.metadata);
            throw new Error('Course structure not found in __NEXT_DATA__');
        }

        // Skool Hierarchy:
        // Set (Module Group) -> Children (Modules/Lessons)

        const modules: Module[] = courseData.children.map((set: any, mIdx: number) => {
            const setInfo = set.course || {};
            const setTitle = setInfo.metadata?.title || setInfo.name || 'Untitled Section';

            // In Skool, a "set" contains "children" which are the actual modules/lessons
            const lessons: Lesson[] = (set.children || []).map((mod: any, lIdx: number) => {
                const modInfo = mod.course || {};
                return {
                    id: modInfo.id,
                    title: modInfo.metadata?.title || modInfo.name || 'Untitled Lesson',
                    url: `${cleanUrl}?md=${modInfo.id}`,
                    index: lIdx + 1
                };
            }).filter((l: Lesson) => l.id);

            return { title: setTitle, index: mIdx + 1, lessons };
        });

        return modules.filter(m => m.lessons.length > 0);
    }

    async extractLessonData(url: string): Promise<Lesson> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        await page.close();

        if (!nextData) throw new Error(`Could not find __NEXT_DATA__ for lesson at ${url}`);

        const pageProps = nextData.props?.pageProps || {};
        const urlObj = new URL(url);
        const md = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');

        let foundLesson: any = null;

        const findInTree = (node: any) => {
            if (node.course?.id === md) {
                foundLesson = node.course;
                return;
            }
            if (node.children) {
                for (const child of node.children) {
                    findInTree(child);
                    if (foundLesson) return;
                }
            }
        };

        if (pageProps.course) {
            findInTree(pageProps.course);
        }

        if (!foundLesson) {
            foundLesson = pageProps.lesson || pageProps.course?.course;
        }

        const metadata = foundLesson?.metadata || {};

        // Handle native videoId vs videoLink
        let vLink = metadata.videoLink || foundLesson?.video?.url || '';

        if (!vLink && metadata.videoId) {
            console.log(`    ℹ️ Native videoId found: ${metadata.videoId}.`);
            // The signed URL might be in another part of pageProps or require a fetch
            // Check pageProps.video for native player data
            if (pageProps.video && pageProps.video.id === metadata.videoId) {
                vLink = pageProps.video.url;
            }
        }

        // Skool stores rich text as a stringified JSON array or primitive HTML
        let body = metadata.desc || foundLesson?.body || '';

        // If it looks like [v2][{"type"...}], it's TipTap/JSON format
        if (typeof body === 'string' && body.startsWith('[v2]')) {
            try {
                const jsonPart = body.substring(4);
                const nodes = JSON.parse(jsonPart);
                body = this.parseTipTap(nodes);
            } catch (e) {
                console.error('Failed to parse TipTap content', e);
            }
        }

        return {
            id: md || foundLesson?.id || '',
            title: metadata.title || foundLesson?.name || '',
            url: url,
            contentHtml: body,
            videoLink: vLink
        };
    }

    private parseTipTap(nodes: any[]): string {
        return nodes.map(node => {
            if (node.type === 'paragraph') {
                return `<p>${this.parseTipTapContent(node.content)}</p>`;
            }
            if (node.type === 'hardBreak') {
                return '<br/>';
            }
            return '';
        }).join('');
    }

    private parseTipTapContent(content: any[]): string {
        if (!content) return '';
        return content.map(item => {
            if (item.type === 'text') {
                let text = item.text;
                if (item.marks) {
                    item.marks.forEach((mark: any) => {
                        if (mark.type === 'bold') text = `<b>${text}</b>`;
                        if (mark.type === 'link') text = `<a href="${mark.attrs.href}">${text}</a>`;
                    });
                }
                return text;
            }
            if (item.type === 'hardBreak') return '<br/>';
            return '';
        }).join('');
    }
}
