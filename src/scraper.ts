import { chromium, type Browser, type BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';

const STORAGE_STATE_PATH = path.join(process.cwd(), 'storage_state.json');

export interface Resource {
    title: string;
    file_id: string;
    file_name: string;
    file_content_type: string;
    downloadUrl?: string;
}

export interface Lesson {
    id: string;
    title: string;
    url: string;
    index?: number;
    contentHtml?: string;
    videoLink?: string;
    resources?: Resource[];
}

export interface Module {
    title: string;
    index: number;
    lessons: Lesson[];
}

export interface ClassroomResult {
    groupName: string;
    courseName: string;
    modules: Module[];
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

    async parseClassroom(url: string): Promise<ClassroomResult> {
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

        // Extract Group (Community) Name
        const groupData = pageProps.currentGroup || {};
        const groupName = groupData.metadata?.name || groupData.name || 'Unknown Group';

        // Extract Course Name
        let courseName = 'Unknown Course';
        if (courseData.metadata?.title) {
            courseName = courseData.metadata.title;
        } else if (courseData.course?.metadata?.title) {
            courseName = courseData.course.metadata.title;
        } else {
            // Fallback: match current URL segment with allCourses/renderData.allCourses
            const urlParts = cleanUrl.split('/');
            const urlCourseHandle = urlParts[urlParts.length - 1]; // e.g. "767876d4"
            const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];
            const foundCourse = allCourses.find((c: any) => c.name === urlCourseHandle);
            if (foundCourse?.metadata?.title) {
                courseName = foundCourse.metadata.title;
            }
        }

        console.log(`\x1b[32m%s\x1b[0m`, `🎓 Course detected: ${courseName}`);

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

        return {
            groupName,
            courseName,
            modules: modules.filter(m => m.lessons.length > 0)
        };
    }

    async extractLessonData(url: string): Promise<Lesson> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

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

        // Native Skool Player Handling (Mux)
        if (!vLink && metadata.videoId) {
            console.log(`    ℹ️ Native videoId found: ${metadata.videoId}.`);

            try {
                // Try to find and click the play button/thumbnail to trigger stream signed URL generation
                const playButtonSelector = 'div[class*="MuxThumbnailWrapper"]';
                const hasPlayButton = await page.evaluate((sel) => !!document.querySelector(sel), playButtonSelector);

                if (hasPlayButton) {
                    console.log('    🖱️ Clicking play button to initialize stream...');
                    await page.click(playButtonSelector);

                    // Poll for the stream manifest to appear in network entries or player src
                    let attempts = 0;
                    while (attempts < 10) {
                        vLink = await page.evaluate(() => {
                            // 1. Check performance entries for m3u8
                            const entries = performance.getEntriesByType('resource')
                                .filter(e => e.name.includes('m3u8') && e.name.includes('token='));
                            if (entries.length > 0) return (entries[entries.length - 1] as PerformanceResourceTiming).name;

                            // 2. Search all shadow roots for a video element (BFS)
                            const stack: any[] = [document];
                            while (stack.length > 0) {
                                const root = stack.pop();
                                const video = root.querySelector('video');
                                if (video && video.src && video.src.includes('m3u8')) return video.src;

                                const elements = root.querySelectorAll('*');
                                for (let i = 0; i < elements.length; i++) {
                                    if (elements[i].shadowRoot) {
                                        stack.push(elements[i].shadowRoot);
                                    }
                                }
                            }
                            return null;
                        });

                        if (vLink) break;
                        await page.waitForTimeout(1000);
                        attempts++;
                    }
                }

                // Fallback: Reconstruct from pageProps if interaction failed but we have IDs
                if (!vLink) {
                    const videoData = pageProps.video || pageProps.course?.video;
                    if (videoData && videoData.id === metadata.videoId && videoData.playbackId && videoData.playbackToken) {
                        console.log('    ℹ️ Using reconstructed HLS URL from page props fallback.');
                        vLink = `https://stream.video.skool.com/${videoData.playbackId}.m3u8?token=${videoData.playbackToken}`;
                    }
                }
            } catch (err) {
                console.warn('    ⚠️ Interaction-based extraction failed:', err);
            }
        }

        // Resource extraction
        let resources: Resource[] = [];
        try {
            const rawResources = metadata.resources || foundLesson?.resources || '[]';
            if (typeof rawResources === 'string') {
                resources = JSON.parse(rawResources);
            } else if (Array.isArray(rawResources)) {
                resources = rawResources;
            }
        } catch (e) {
            console.warn('    ⚠️ Failed to parse resources', e);
        }

        // Fetch download URLs for each resource using direct API calls
        if (resources.length > 0) {
            console.log(`    📥 Found ${resources.length} resources. Fetching download URLs...`);

            for (const res of resources) {
                try {
                    console.log(`      🔗 Requesting download URL for "${res.title}"...`);

                    // Use Playwright's page context to make authenticated API request
                    const response = await page.evaluate(async (fileId: string) => {
                        const apiUrl = `https://api2.skool.com/files/${fileId}/download-url?expire=28800`;
                        try {
                            const resp = await fetch(apiUrl, {
                                method: 'POST',
                                credentials: 'include' // Include cookies for auth
                            });

                            if (!resp.ok) {
                                return { success: false, error: `HTTP ${resp.status}` };
                            }

                            const text = await resp.text();
                            // Response is just the plain URL as text
                            return { success: true, url: text.trim() };
                        } catch (e) {
                            return { success: false, error: String(e) };
                        }
                    }, res.file_id);

                    if (response.success && response.url) {
                        res.downloadUrl = response.url;
                        console.log(`      ✅ Got download URL for "${res.title}"`);
                    } else {
                        console.warn(`      ⚠️ Failed to get download URL for "${res.title}": ${response.error}`);
                    }
                } catch (err) {
                    console.warn(`      ⚠️ Error fetching download URL for "${res.title}":`, err);
                }
            }
        }

        await page.close();

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
            videoLink: vLink,
            resources: resources
        };
    }

    // Helper removed as logic is now in extractLessonData for shared state


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
