import crypto from 'crypto';
import type { Lesson, Resource } from './scraper.js';

export type VideoSource = 'youtube' | 'loom' | 'mux' | 'other';

export type VideoFingerprint = {
    source: VideoSource;
    ytDlpId?: string;
    durationSec?: number;
    playbackId?: string;
};

export function classifyVideoSource(url: string | undefined): VideoSource {
    if (!url) return 'other';
    if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
    if (/loom\.com/.test(url)) return 'loom';
    if (/stream\.video\.skool\.com|mux\.com/.test(url)) return 'mux';
    return 'other';
}

export function extractMuxPlaybackId(url: string | undefined): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        if (!/skool\.com|mux\.com/.test(parsed.hostname)) return undefined;
        const match = parsed.pathname.match(/\/([^\/]+?)\.m3u8$/);
        return match ? match[1] : undefined;
    } catch {
        return undefined;
    }
}

type ResourceFingerprint = {
    title: string;
    file_id?: string;
    external?: string;
};

function canonicalResources(resources: Resource[] | undefined): ResourceFingerprint[] {
    if (!resources) return [];
    return resources
        .map(r => ({
            title: r.title ?? '',
            file_id: r.file_id,
            external: r.isExternal ? r.downloadUrl : undefined
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
}

export function computeContentHash(lesson: Pick<Lesson, 'title' | 'contentHtml' | 'resources'>): string {
    const payload = JSON.stringify({
        title: lesson.title ?? '',
        contentHtml: lesson.contentHtml ?? '',
        resources: canonicalResources(lesson.resources)
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
}

export function videoFingerprintsEqual(a?: VideoFingerprint, b?: VideoFingerprint): boolean {
    if (!a || !b) return false;
    if (a.source !== b.source) return false;

    if (a.source === 'mux' && a.playbackId && b.playbackId) {
        return a.playbackId === b.playbackId;
    }

    if (!a.ytDlpId || !b.ytDlpId) return false;
    if (a.ytDlpId !== b.ytDlpId) return false;

    if (a.durationSec !== undefined && b.durationSec !== undefined) {
        if (Math.abs(a.durationSec - b.durationSec) > 1) return false;
    }

    return true;
}
