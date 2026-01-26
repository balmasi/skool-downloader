import { chromium, type BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const STORAGE_STATE_PATH = path.join(process.cwd(), 'storage_state.json');
const COOKIES_TXT_PATH = path.join(process.cwd(), 'cookies.txt');

export async function login() {
    console.log('Opening browser for manual login...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto('https://www.skool.com/login');

    console.log('Please log in manually in the browser window.');
    console.log('The script will wait until you are logged in and navigate to a classroom or dashboard.');

    // Wait for the URL to change to something indicating a successful login
    // Or wait for the user to close the browser after they are done
    await page.waitForURL((url) => {
        return url.hostname === 'www.skool.com' && !url.pathname.includes('login') && !url.pathname.includes('signup');
    }, { timeout: 0 });

    console.log('Login detected. Saving session state...');
    await context.storageState({ path: STORAGE_STATE_PATH });

    await saveCookiesAsNetscape(context);

    console.log(`Session state saved to ${STORAGE_STATE_PATH}`);
    console.log(`Cookies saved to ${COOKIES_TXT_PATH} (Netscape format)`);

    await browser.close();
}

async function saveCookiesAsNetscape(context: BrowserContext) {
    const cookies = await context.cookies();
    let netscapeContent = '# Netscape HTTP Cookie File\n';
    netscapeContent += '# http://curl.haxx.se/rfc/cookie_spec.html\n';
    netscapeContent += '# This is a generated file!  Do not edit.\n\n';

    for (const cookie of cookies) {
        const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
        const flag = 'TRUE';
        const path = cookie.path;
        const secure = cookie.secure ? 'TRUE' : 'FALSE';
        const expiration = cookie.expires ? Math.floor(cookie.expires) : 0;
        const name = cookie.name;
        const value = cookie.value;

        netscapeContent += `${domain}\t${flag}\t${path}\t${secure}\t${expiration}\t${name}\t${value}\n`;
    }

    await fs.writeFile(COOKIES_TXT_PATH, netscapeContent);
}


if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    login().catch(console.error);
}
