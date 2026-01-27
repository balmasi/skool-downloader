import fs from 'fs-extra';
import path from 'path';

type CourseManifest = {
    courseName: string;
    groupName: string;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
    }>;
    updatedAt: string;
};

type GroupIndexCourse = {
    dirName: string;
    courseName: string;
    groupName?: string;
    courseImagePath?: string;
    modulesCount: number;
    lessonsCount: number;
    updatedAt?: string;
};

type RegenerateOptions = {
    silent?: boolean;
};

async function writeAtomicHtml(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.move(tempPath, filePath, { overwrite: true });
}

async function countLessons(coursePath: string) {
    let modulesCount = 0;
    let lessonsCount = 0;

    const moduleEntries = await fs.readdir(coursePath, { withFileTypes: true });
    const moduleDirs = moduleEntries.filter(
        entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'assets'
    );

    modulesCount = moduleDirs.length;

    for (const moduleDir of moduleDirs) {
        const modulePath = path.join(coursePath, moduleDir.name);
        const lessonEntries = await fs.readdir(modulePath, { withFileTypes: true });
        const lessonDirs = lessonEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

        for (const lessonDir of lessonDirs) {
            const lessonPath = path.join(modulePath, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');
            const manifestPath = path.join(lessonPath, 'lesson.json');

            if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
                lessonsCount += 1;
            }
        }
    }

    return { modulesCount, lessonsCount };
}

async function loadCourseInfo(coursePath: string, dirName: string): Promise<GroupIndexCourse | null> {
    const manifestPath = path.join(coursePath, '.course.json');
    let manifest: CourseManifest | null = null;
    if (await fs.pathExists(manifestPath)) {
        try {
            manifest = await fs.readJson(manifestPath);
        } catch {
            manifest = null;
        }
    }

    const courseName = manifest?.courseName || dirName;
    const groupName = manifest?.groupName;
    const courseImagePath = manifest?.courseImagePath;
    const counts = await countLessons(coursePath);

    return {
        dirName,
        courseName,
        groupName,
        courseImagePath,
        modulesCount: counts.modulesCount,
        lessonsCount: counts.lessonsCount,
        updatedAt: manifest?.updatedAt
    };
}

async function regenerateGroupIndex(
    groupDir: string,
    options: RegenerateOptions = {}
) {
    const log = options.silent ? () => {} : console.log;
    const warn = options.silent ? () => {} : console.warn;

    if (!fs.existsSync(groupDir)) {
        log(`Group directory not found: ${groupDir}`);
        return;
    }

    const entries = await fs.readdir(groupDir, { withFileTypes: true });
    const courseDirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

    const courses: GroupIndexCourse[] = [];
    let resolvedGroupName: string | null = null;

    for (const courseDir of courseDirs) {
        const coursePath = path.join(groupDir, courseDir.name);
        const courseInfo = await loadCourseInfo(coursePath, courseDir.name);
        if (!courseInfo) continue;

        courses.push(courseInfo);
        if (!resolvedGroupName && courseInfo.groupName) {
            resolvedGroupName = courseInfo.groupName;
        }
    }

    if (courses.length === 0) {
        warn('No courses found to build group index.');
        return;
    }

    const groupName = resolvedGroupName || path.basename(groupDir);

    courses.sort((a, b) => {
        if (a.updatedAt && b.updatedAt) {
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        }
        return a.courseName.localeCompare(b.courseName);
    });

    const totalLessons = courses.reduce((acc, course) => acc + course.lessonsCount, 0);

    const courseCards = await Promise.all(
        courses.map(async (course) => {
            const coursePath = path.join(groupDir, course.dirName);
            const courseIndexPath = `${course.dirName}/index.html`;
            let imageMarkup = '<div class="course-fallback">No course image</div>';

            if (course.courseImagePath) {
                const resolvedImagePath = path.join(coursePath, course.courseImagePath);
                if (await fs.pathExists(resolvedImagePath)) {
                    const imageSrc = `${course.dirName}/${course.courseImagePath}`;
                    imageMarkup = `<img src="${imageSrc}" alt="${course.courseName} cover">`;
                }
            }

            const updatedLabel = course.updatedAt
                ? new Date(course.updatedAt).toLocaleDateString()
                : 'Unknown';

            return `
                <a class="course-card" href="${courseIndexPath}">
                    <div class="course-image">${imageMarkup}</div>
                    <div class="course-body">
                        <h2>${course.courseName}</h2>
                        <p class="course-meta">Updated ${updatedLabel}</p>
                        <div class="course-stats">
                            <span><strong>${course.modulesCount}</strong> modules</span>
                            <span><strong>${course.lessonsCount}</strong> lessons</span>
                        </div>
                    </div>
                </a>
            `;
        })
    );

    const indexHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>${groupName} - Courses</title>
            <style>
                :root {
                    --bg: #f8f6f1;
                    --panel: #ffffff;
                    --panel-2: #f5f7fb;
                    --text: #16181f;
                    --muted: #5c6575;
                    --accent: #3b82f6;
                    --accent-2: #0f172a;
                    --ring: rgba(20,22,29,0.08);
                    --shadow: 0 18px 36px rgba(15, 23, 42, 0.12);
                }
                * { box-sizing: border-box; }
                body {
                    margin: 0;
                    font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                    background: #f6f6f8;
                    color: var(--text);
                    line-height: 1.6;
                }
                .page {
                    max-width: 1100px;
                    margin: 48px auto 80px;
                    padding: 0 24px;
                }
                .hero {
                    background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.92) 100%);
                    border-radius: 26px;
                    padding: 32px;
                    box-shadow:
                        0 25px 45px rgba(15, 23, 42, 0.18),
                        0 10px 20px rgba(15, 23, 42, 0.08);
                }
                .hero-title {
                    font-size: clamp(2.3rem, 4vw, 3.2rem);
                    margin: 0 0 8px 0;
                    letter-spacing: -0.02em;
                }
                .hero-subtitle {
                    color: var(--muted);
                    margin: 0 0 18px 0;
                    font-size: 1.05rem;
                }
                .hero-meta {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                }
                .chip {
                    padding: 10px 14px;
                    border-radius: 999px;
                    background: var(--panel-2);
                    border: 1px solid var(--ring);
                    color: var(--text);
                    font-size: 0.95rem;
                }
                .chip strong { color: var(--accent); font-weight: 700; }
                .courses {
                    margin-top: 32px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 18px;
                }
                .course-card {
                    background: var(--panel);
                    border: 1px solid rgba(15, 23, 42, 0.05);
                    border-radius: 18px;
                    overflow: hidden;
                    text-decoration: none;
                    color: inherit;
                    display: flex;
                    flex-direction: column;
                    min-height: 100%;
                    transition: transform 0.25s ease, box-shadow 0.25s ease;
                    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
                }
                .course-card:hover {
                    transform: translateY(-6px);
                    box-shadow:
                        0 30px 60px rgba(15, 23, 42, 0.25),
                        0 14px 30px rgba(15, 23, 42, 0.15);
                }
                .course-image {
                    aspect-ratio: 16 / 9;
                    min-height: 0;
                    background: #f0f2f7;
                    border-bottom: 1px solid var(--ring);
                    overflow: hidden;
                }
                .course-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .course-fallback {
                    height: 100%;
                    display: grid;
                    place-items: center;
                    color: var(--muted);
                    font-size: 0.95rem;
                }
                .course-body {
                    padding: 18px 18px 20px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .course-body h2 {
                    margin: 0;
                    font-size: 1.2rem;
                }
                .course-meta {
                    margin: 0;
                    color: var(--muted);
                    font-size: 0.95rem;
                }
                .course-stats {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    font-size: 0.95rem;
                }
                .course-stats strong { color: var(--accent-2); }
            </style>
        </head>
        <body>
            <div class="page">
                <section class="hero">
                    <h1 class="hero-title">${groupName}</h1>
                    <p class="hero-subtitle">All downloaded courses for this community.</p>
                    <div class="hero-meta">
                        <div class="chip"><strong>${courses.length}</strong> courses</div>
                        <div class="chip"><strong>${totalLessons}</strong> lessons</div>
                        <div class="chip">Updated: <strong>${new Date().toLocaleDateString()}</strong></div>
                    </div>
                </section>
                <section class="courses">
                    ${courseCards.join('')}
                </section>
            </div>
        </body>
        </html>
    `;

    await writeAtomicHtml(path.join(groupDir, 'index.html'), indexHtml);

    log('\nGroup index regenerated successfully.');
    log(`Saved to: ${path.join(groupDir, 'index.html')}`);
}

export { regenerateGroupIndex };
