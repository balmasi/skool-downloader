import { chromium, type BrowserContext } from 'playwright';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

export const AUTH_DIR = path.join(process.cwd(), '.auth');
export const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'storage_state.json');
export const COOKIES_TXT_PATH = path.join(AUTH_DIR, 'cookies.txt');

export async function ensureAuthDir() {
    await fs.ensureDir(AUTH_DIR);
}

export type AuthStatus = {
    status: 'valid' | 'expired' | 'missing' | 'invalid' | 'no-expiry';
    expiresAt?: Date;
};

export async function getAuthStatus(): Promise<AuthStatus> {
    const hasState = await fs.pathExists(STORAGE_STATE_PATH);
    if (!hasState) return { status: 'missing' };

    try {
        const state = await fs.readJson(STORAGE_STATE_PATH);
        const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
        const skoolCookies = cookies.filter((cookie: any) => {
            return typeof cookie?.domain === 'string' && cookie.domain.includes('skool.com');
        });

        if (skoolCookies.length === 0) return { status: 'invalid' };

        const expiries = skoolCookies
            .map((cookie: any) => Number(cookie?.expires))
            .filter((value) => Number.isFinite(value) && value > 0);

        if (expiries.length === 0) return { status: 'no-expiry' };

        const latestExpiry = Math.max(...expiries);
        const expiresAt = new Date(latestExpiry * 1000);
        if (latestExpiry > Date.now() / 1000) {
            return { status: 'valid', expiresAt };
        }

        return { status: 'expired', expiresAt };
    } catch {
        return { status: 'invalid' };
    }
}

export async function login() {
    await ensureAuthDir();
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
