import { Scraper } from './scraper.js';
import { Downloader } from './downloader.js';
import { login } from './auth.js';
import fs from 'fs-extra';
import path from 'path';

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
    const baseOutputDir = args[1] || path.join(process.cwd(), 'downloads');

    const scraper = new Scraper();
    const downloader = new Downloader();

    try {
        console.log('\x1b[33m%s\x1b[0m', '🚀 Fetching course structure...');
        let modules = await scraper.parseClassroom(classroomUrl);

        if (modules.length === 0) {
            console.log('\x1b[31m%s\x1b[0m', '❌ No modules found. Are you sure this is a classroom URL and you are logged in?');
            return;
        }

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

        const courseInfo: any[] = [];

        for (const module of modules) {
            const mIndex = module.index;
            console.log(`\n📂 Processing Module ${mIndex}: ${module.title}`);
            const moduleDirName = `${mIndex}-${module.title.replace(/[/\\?%*:|"<>]/g, '-')}`;
            const moduleDir = path.join(baseOutputDir, moduleDirName);
            await fs.ensureDir(moduleDir);

            const processedLessons = [];

            for (const lesson of module.lessons) {
                const lIndex = lesson.index;
                console.log(`  📄 Lesson ${lIndex}: ${lesson.title}`);

                try {
                    const lessonData = await scraper.extractLessonData(lesson.url);
                    const lessonDirName = `${lIndex}-${lesson.title.replace(/[/\\?%*:|"<>]/g, '-')}`;
                    const lessonDir = path.join(moduleDir, lessonDirName);
                    await fs.ensureDir(lessonDir);

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

                    // Download resources
                    const resourcesHtml: string[] = [];
                    if (lessonData.resources && lessonData.resources.length > 0) {
                        const resourcesDir = path.join(lessonDir, 'resources');
                        await fs.ensureDir(resourcesDir);

                        for (const res of lessonData.resources) {
                            if (res.downloadUrl) {
                                console.log(`    ⬇️ Downloading resource: ${res.title}`);
                                try {
                                    const safeFileName = res.file_name.replace(/[/\\?%*:|"<>]/g, '-');
                                    const resPath = path.join(resourcesDir, safeFileName);
                                    await downloader.downloadAsset(res.downloadUrl, resPath);
                                    resourcesHtml.push(`<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`);
                                } catch (err) {
                                    console.error(`    ⚠️ Failed to download resource ${res.title}:`, err);
                                }
                            }
                        }
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
                    processedLessons.push({ title: lesson.title, path: `${moduleDirName}/${lessonDirName}/index.html` });
                } catch (err) {
                    console.error(`    ⚠️ Error processing lesson ${lesson.title}:`, err);
                }
            }
            courseInfo.push({ title: module.title, lessons: processedLessons });
        }

        // Generate Master Index
        const indexHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Course Backup</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 800px; margin: 60px auto; padding: 20px; line-height: 1.6; color: #333; background: #f4f7f9; }
                    .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); }
                    h1 { color: #111; margin-bottom: 30px; border-bottom: 3px solid #5a1cb5; display: inline-block; }
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
                    <h1>Course Archive</h1>
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
