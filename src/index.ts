import { Scraper, Module, Lesson } from './scraper.js';
import { Downloader } from './downloader.js';
import { login } from './auth.js';
import { regenerateIndex } from './regenerate-index.js';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';

// Parallelism Configuration
// CONCURRENCY: How many lessons to process in parallel. 
// Skool lessons often have a 5s+ initial load time during scraping. 
// Parallelism helps bypass this bottleneck. Recommended: 2-5
const CONCURRENCY = 8;

// indexLimit: A serial queue (concurrency = 1) for file system operations 
// that shouldn't happen in parallel, specifically writing the master index.html.
const indexLimit = pLimit(1);

async function main() {
    const args = process.argv.slice(2);
    let command = args[0];

    if (command === 'login') {
        await login();
        return;
    }

    // Support: npm run skool -- <url> or just npm run skool <url>
    if (!command || !command.startsWith('http')) {
        console.log('\x1b[36m%s\x1b[0m', 'Skool Course Downloader');
        console.log('-----------------------');
        console.log('Usage:');
        console.log('  npm run login                     - Log in to Skool');
        console.log('  npm run skool <classroom-url>     - Download course');
        console.log('  npm run skool <lesson-url>        - Download single lesson only');
        console.log('\nExample:');
        console.log('  Course:  npm run skool https://www.skool.com/ailaunch/classroom/addeb1da');
        console.log('  Lesson:  npm run skool "https://www.skool.com/ailaunch/classroom/addeb1da?md=123"');
        return;
    }

    const inputUrl = command.replace(/\\/g, '');
    let targetLessonId: string | null = null;
    try {
        const urlObj = new URL(inputUrl);
        targetLessonId = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');
    } catch (e) {
        // Not a valid URL or other error, fallback to treating as classroom URL
    }

    const classroomUrl = inputUrl.split('?')[0];

    const scraper = new Scraper();
    const downloader = new Downloader();

    try {
        console.log('\x1b[33m%s\x1b[0m', '🚀 Fetching course structure...');
        let { modules, courseName, groupName } = await scraper.parseClassroom(classroomUrl);

        if (modules.length === 0) {
            console.log('\x1b[31m%s\x1b[0m', '❌ No modules found. Are you sure this is a classroom URL and you are logged in?');
            return;
        }

        const sanitizedGroupName = groupName.replace(/[/\\?%*:|"<>]/g, '-');
        const sanitizedCourseName = courseName.replace(/[/\\?%*:|"<>]/g, '-');
        const baseOutputDir = args[1] || path.join(process.cwd(), 'downloads', `${sanitizedGroupName} - ${sanitizedCourseName}`);
        await fs.ensureDir(baseOutputDir);

        // Handle single lesson mode
        if (targetLessonId) {
            console.log('\x1b[33m%s\x1b[0m', `📍 Single lesson mode: Finding lesson ${targetLessonId}...`);
            let found = false;
            for (const module of modules) {
                const lesson = module.lessons.find(l => l.id === targetLessonId);
                if (lesson) {
                    module.lessons = [lesson];
                    modules = [module];
                    found = true;
                    break;
                }
            }

            if (!found) {
                console.log('\x1b[31m%s\x1b[0m', `❌ Could not find lesson with ID ${targetLessonId} in this classroom.`);
                return;
            }
            console.log('\x1b[32m%s\x1b[0m', `✅ Found lesson: ${modules[0].lessons[0].title}`);
        } else {
            console.log('\x1b[32m%s\x1b[0m', `✅ Found ${modules.length} modules.`);
        }

        const courseInfo: any[] = modules.map(m => ({ 
            title: m.title, 
            lessons: [] as any[], 
            totalLessons: m.lessons.length,
            mIndex: m.index,
            moduleDirName: `${m.index}-${m.title.replace(/[/\\?%*:|"<>]/g, '-')}`
        }));

        const limit = pLimit(CONCURRENCY);
        const tasks: any[] = [];

        // We queue up all lesson download tasks. pLimit will ensure only CONCURRENCY 
        // number of lessons are actually running their async blocks at any given time.
        for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            const mInfo = courseInfo[i];
            const moduleDir = path.join(baseOutputDir, mInfo.moduleDirName);
            await fs.ensureDir(moduleDir);

            for (const lesson of module.lessons) {
                tasks.push(limit(async () => {
                    const lIndex = lesson.index;
                    const lessonDirName = `${lIndex}-${lesson.title.replace(/[/\\?%*:|"<>]/g, '-')}`;
                    const lessonDir = path.join(moduleDir, lessonDirName);
                    
                    console.log(`\n  📄 Processing [${mInfo.mIndex}.${lIndex}] ${lesson.title}`);
                    
                    try {
                        await fs.ensureDir(lessonDir);
                        const lessonData = await scraper.extractLessonData(lesson.url);
                        
                        // Localize images in content
                        const localizedHtml = await downloader.localizeImages(lessonData.contentHtml || '', lessonDir);

                        // Download video if available
                        let hasVideo = false;
                        if (lessonData.videoLink) {
                            try {
                                await downloader.downloadVideo(lessonData.videoLink, lessonDir, 'video');
                                hasVideo = true;
                            } catch (err) {
                                console.error(`    ⚠️ Failed to download video for ${lesson.title}`);
                            }
                        }

                        // Download resources in parallel
                        const resourcesHtml: string[] = [];
                        if (lessonData.resources && lessonData.resources.length > 0) {
                            const resourcesDir = path.join(lessonDir, 'resources');
                            await fs.ensureDir(resourcesDir);

                            const resTasks = lessonData.resources.map(async (res) => {
                                if (!res.downloadUrl) return;
                                
                                // Handle External Links
                                if (res.isExternal) {
                                    console.log(`    🔗 External resource linked: ${res.title}`);
                                    return `<li><a href="${res.downloadUrl}" target="_blank">${res.title} (External)</a></li>`;
                                }

                                try {
                                    const safeFileName = (res.file_name || res.title).replace(/[/\\?%*:|"<>]/g, '-');
                                    const resPath = path.join(resourcesDir, safeFileName);

                                    // Check if resource already exists
                                    if (fs.existsSync(resPath)) {
                                        const stats = fs.statSync(resPath);
                                        if (stats.size > 0) {
                                            console.log(`    ⏭️  Resource already exists, skipping: ${res.title}`);
                                            return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                        }
                                    }

                                    console.log(`    ⬇️  Downloading resource: ${res.title}`);
                                    await downloader.downloadAsset(res.downloadUrl, resPath);
                                    return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                } catch (err) {
                                    console.error(`    ⚠️  Failed to download resource ${res.title}:`, err);
                                    return null;
                                }
                            });

                            const results = await Promise.all(resTasks);
                            results.forEach(r => { if (r) resourcesHtml.push(r); });
                        }

                        // Save content
                        const htmlContent = `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <meta charset="UTF-8">
                                <title>${lessonData.title}</title>
                                <style>
                                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #333; background: #f9f9f9; }
                                    .container { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.05); }
                                    h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; color: #111; }
                                    video { max-width: 100%; border-radius: 8px; margin-bottom: 30px; display: block; box-shadow: 0 8px 16px rgba(0,0,0,0.1); background: #000; }
                                    img { max-width: 100%; border-radius: 4px; height: auto; margin: 10px 0; }
                                    .content { font-size: 18px; margin-bottom: 30px; }
                                    .content p { margin-bottom: 1.5em; }
                                    .resources { background: #f0f7ff; padding: 20px; border-radius: 8px; border: 1px solid #d0e7ff; margin-top: 30px; }
                                    .resources h3 { margin-top: 0; color: #0056b3; }
                                    .resources ul { list-style: none; padding: 0; margin: 0; }
                                    .resources li { margin-bottom: 10px; }
                                    .resources li:last-child { margin-bottom: 0; }
                                    .resources a { color: #0056b3; font-weight: 500; display: flex; align-items: center; }
                                    .resources a::before { content: "📁"; margin-right: 8px; }
                                    a { color: #5a1cb5; text-decoration: none; word-break: break-all; }
                                    a:hover { text-decoration: underline; }
                                    .breadcrumb { font-size: 14px; color: #888; margin-bottom: 20px; }
                                    .nav { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; }
                                </style>
                            </head>
                            <body>
                                <div class="breadcrumb"><a href="../../index.html">Course</a> / ${module.title} / ${lessonData.title}</div>
                                <div class="container">
                                    <h1>${lessonData.title}</h1>
                                    ${hasVideo ? '<video controls src="video.mp4"></video>' : ''}
                                    <div class="content">
                                        ${localizedHtml}
                                    </div>
                                    ${resourcesHtml.length > 0 ? `
                                    <div class="resources">
                                        <h3>Resources / Attachments</h3>
                                        <ul>
                                            ${resourcesHtml.join('')}
                                        </ul>
                                    </div>
                                    ` : ''}
                                    <div class="nav">
                                        <a href="../../index.html">← Back to Course Index</a>
                                    </div>
                                </div>
                            </body>
                            </html>
                        `;

                        await fs.writeFile(path.join(lessonDir, 'index.html'), htmlContent);
                        
                        // Thread-safe update of courseInfo
                        mInfo.lessons.push({ 
                            index: lIndex,
                            title: lesson.title, 
                            path: `${mInfo.moduleDirName}/${lessonDirName}/index.html` 
                        });
                        
                        // Sort lessons by index to maintain order in the final index
                        mInfo.lessons.sort((a: any, b: any) => a.index - b.index);

                        // Use a serial queue for index regeneration to prevent race 
                        // conditions where multiple lessons try to write to index.html at once.
                        indexLimit(() => regenerateIndex(baseOutputDir));
                        
                    } catch (err) {
                        console.error(`    ⚠️ Error processing lesson ${lesson.title}:`, err);
                    }
                }));
            }
        }

        await Promise.all(tasks);

        // Generate Master Index (final version)
        const indexHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>${courseName} (${groupName}) - Backup</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 60px auto; padding: 20px; line-height: 1.6; color: #333; background: #f4f7f9; }
                    .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
                    h1 { color: #111; margin: 0; display: inline-block; }
                    .group-name { color: #666; font-size: 1.2em; margin-bottom: 30px; border-bottom: 3px solid #5a1cb5; padding-bottom: 10px; }
                    h2 { margin-top: 30px; font-size: 1.4em; color: #444; border-left: 4px solid #5a1cb5; padding-left: 15px; }
                    ul { list-style: none; padding: 0; }
                    li { margin-bottom: 10px; padding-left: 20px; position: relative; }
                    li::before { content: "•"; color: #5a1cb5; position: absolute; left: 0; font-weight: bold; }
                    a { color: #5a1cb5; text-decoration: none; font-size: 1.1em; }
                    a:hover { color: #3d137b; text-decoration: underline; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>${courseName}</h1>
                    <div class="group-name">${groupName}</div>
                    ${courseInfo.map(m => `
                        <h2>${m.title}</h2>
                        <ul>
                            ${m.lessons.map((l: any) => `<li><a href="${l.path}">${l.title}</a></li>`).join('')}
                        </ul>
                    `).join('')}
                </div>
            </body>
            </html>
        `;
        await fs.writeFile(path.join(baseOutputDir, 'index.html'), indexHtml);

        console.log('\n\x1b[32m%s\x1b[0m', '✨ All downloads complete!');
        console.log(`Check your files in: ${baseOutputDir}`);
    } catch (error) {
        console.error('❌ An error occurred:', error);
    } finally {
        await scraper.close();
    }
}

main();
