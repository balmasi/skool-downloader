import fs from 'fs-extra';
import path from 'path';

/**
 * Regenerates the master index.html by scanning the downloads directory
 * for existing lesson files. Useful for recovering from interrupted downloads.
 */
async function regenerateIndex(downloadsDir: string = path.join(process.cwd(), 'downloads')) {
    if (!fs.existsSync(downloadsDir)) {
        console.log('❌ Downloads directory not found:', downloadsDir);
        return;
    }

    console.log('🔍 Scanning downloads directory:', downloadsDir);

    // Read all module directories
    const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
    const moduleDirs = entries
        .filter(entry => entry.isDirectory())
        .sort((a, b) => {
            // Extract module number from directory name (e.g., "1-Module Name")
            const numA = parseInt(a.name.split('-')[0]) || 999;
            const numB = parseInt(b.name.split('-')[0]) || 999;
            return numA - numB;
        });

    const courseInfo: any[] = [];

    for (const moduleDir of moduleDirs) {
        const modulePath = path.join(downloadsDir, moduleDir.name);

        // Extract module title (remove the number prefix)
        const moduleTitle = moduleDir.name.replace(/^\d+-/, '');

        // Read lesson directories
        const lessonEntries = await fs.readdir(modulePath, { withFileTypes: true });
        const lessonDirs = lessonEntries
            .filter(entry => entry.isDirectory())
            .sort((a, b) => {
                // Extract lesson number from directory name
                const numA = parseInt(a.name.split('-')[0]) || 999;
                const numB = parseInt(b.name.split('-')[0]) || 999;
                return numA - numB;
            });

        const lessons: any[] = [];

        for (const lessonDir of lessonDirs) {
            const lessonPath = path.join(modulePath, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');

            // Check if lesson has an index.html
            if (fs.existsSync(indexPath)) {
                // Extract lesson title (remove the number prefix)
                const lessonTitle = lessonDir.name.replace(/^\d+-/, '');
                const relativePath = `${moduleDir.name}/${lessonDir.name}/index.html`;

                lessons.push({
                    title: lessonTitle,
                    path: relativePath
                });
            }
        }

        if (lessons.length > 0) {
            courseInfo.push({
                title: moduleTitle,
                lessons: lessons
            });
        }
    }

    // Generate the index HTML
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
                    .stats { margin-bottom: 20px; padding: 15px; background: #f0f7ff; border-radius: 8px; font-size: 0.95em; color: #555; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h1>Course Archive</h1>
                    <div class="stats">
                        📊 <strong>${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)} lessons</strong> across <strong>${courseInfo.length} modules</strong>
                    </div>
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

    // Write the index file
    await fs.writeFile(path.join(downloadsDir, 'index.html'), indexHtml);

    console.log('\n✅ Index regenerated successfully!');
    console.log(`📊 Found ${courseInfo.length} modules with ${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)} lessons total`);
    console.log(`📁 Saved to: ${path.join(downloadsDir, 'index.html')}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const downloadsDir = process.argv[2] || path.join(process.cwd(), 'downloads');
    regenerateIndex(downloadsDir).catch(console.error);
}

export { regenerateIndex };
