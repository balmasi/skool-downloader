import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Offline progress tracking for the generated HTML.
 *
 * The browser side lives in progress-runtime.js and is copied as `progress.js`
 * into each course folder and each community folder. Each course folder also gets
 * a `progress-data.js` listing its lessons in order, which lesson pages, the course
 * index and the community index all load, so they agree on what the course contains.
 */

const RUNTIME_SOURCE = fileURLToPath(new URL('./progress-runtime.js', import.meta.url));
export const PROGRESS_SCRIPT = 'progress.js';
export const PROGRESS_DATA = 'progress-data.js';

const BLOCK_START = '<!-- skool-progress:start -->';
const BLOCK_END = '<!-- skool-progress:end -->';
const BLOCK_PATTERN = /\n?<!-- skool-progress:start -->[\s\S]*?<!-- skool-progress:end -->\n?/g;

export type ProgressLesson = {
    id: string;
    title: string;
    /** Path of the lesson's index.html, relative to the course folder. */
    rel: string;
};

type ProgressConfig =
    | { page: 'lesson'; group: string; lesson: { id: string; title: string }; root: string }
    | { page: 'course'; group: string }
    | { page: 'group'; group: string };

/** JSON that is safe to place inside an inline <script>. */
function inlineJson(value: unknown) {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function writeAtomic(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.move(tempPath, filePath, { overwrite: true });
}

/** The markup a page needs: its config plus the scripts to load, in order. */
export function progressBlock(config: ProgressConfig, scripts: string[]) {
    return [
        BLOCK_START,
        `<script>window.SKOOL_PROGRESS = ${inlineJson(config)};</script>`,
        ...scripts.map(src => `<script src="${src}"></script>`),
        BLOCK_END
    ].join('\n');
}

/**
 * Block for a lesson page. `courseRoot` is the relative path from the lesson
 * folder up to the course folder ('../../' inside a module, '../' otherwise).
 */
export function lessonProgressBlock(options: { group: string; lessonId: string; title: string; courseRoot: string }) {
    const { group, lessonId, title, courseRoot } = options;
    return progressBlock(
        { page: 'lesson', group, lesson: { id: lessonId, title }, root: courseRoot },
        [`${courseRoot}${PROGRESS_DATA}`, `${courseRoot}${PROGRESS_SCRIPT}`]
    );
}

/** Puts `block` just before </body>, replacing any block added earlier. */
export function withProgressBlock(html: string, block: string) {
    const stripped = html.replace(BLOCK_PATTERN, '\n');
    const at = stripped.lastIndexOf('</body>');
    if (at === -1) return stripped;
    return `${stripped.slice(0, at)}${block}\n${stripped.slice(at)}`;
}

/** Adds (or refreshes) the block in an existing page. Only writes when something changed. */
export async function addProgressBlockToFile(htmlPath: string, block: string) {
    const html = await fs.readFile(htmlPath, 'utf8');
    const updated = withProgressBlock(html, block);
    if (updated !== html) await writeAtomic(htmlPath, updated);
}

/** Copies the browser runtime into `dir` as progress.js. */
export async function writeProgressRuntime(dir: string) {
    await writeAtomic(path.join(dir, PROGRESS_SCRIPT), await fs.readFile(RUNTIME_SOURCE, 'utf8'));
}

/** Writes the course's ordered lesson list as progress-data.js. */
export async function writeCourseProgressData(courseDir: string, title: string, lessons: ProgressLesson[]) {
    // `src` lets the community index work out where this course lives relative to itself.
    const content = '(window.SKOOL_COURSES = window.SKOOL_COURSES || []).push(Object.assign(' +
        `{ src: document.currentScript && document.currentScript.getAttribute('src') }, ` +
        `${inlineJson({ title, lessons })}));\n`;
    await writeAtomic(path.join(courseDir, PROGRESS_DATA), content);
}
