import {
    computeContentHash,
    classifyVideoSource,
    extractMuxPlaybackId,
    videoFingerprintsEqual,
    type VideoFingerprint
} from '../src/fingerprint.js';

let failed = 0;
function check(name: string, cond: boolean) {
    if (cond) {
        console.log(`  ✅ ${name}`);
    } else {
        console.error(`  ❌ ${name}`);
        failed += 1;
    }
}

console.log('computeContentHash');
const base = {
    title: 'Day 1',
    contentHtml: '<p>hello</p>',
    resources: [
        { title: 'Slides', file_id: 'abc' },
        { title: 'Worksheet', file_id: 'def' }
    ]
};
const h1 = computeContentHash(base);
const h2 = computeContentHash({ ...base });
check('deterministic for identical input', h1 === h2);

const h3 = computeContentHash({ ...base, title: 'Day 2' });
check('title change produces different hash', h1 !== h3);

const h4 = computeContentHash({ ...base, contentHtml: '<p>Hello</p>' });
check('content change produces different hash', h1 !== h4);

const h5 = computeContentHash({
    ...base,
    resources: [
        { title: 'Worksheet', file_id: 'def' },
        { title: 'Slides', file_id: 'abc' }
    ]
});
check('resource order does not affect hash', h1 === h5);

const h6 = computeContentHash({
    ...base,
    resources: [
        { title: 'Slides', file_id: 'abc' },
        { title: 'Worksheet', file_id: 'xyz' }
    ]
});
check('resource file_id change produces different hash', h1 !== h6);

console.log('\nclassifyVideoSource');
check('youtube', classifyVideoSource('https://youtube.com/watch?v=x') === 'youtube');
check('youtu.be', classifyVideoSource('https://youtu.be/abc') === 'youtube');
check('loom', classifyVideoSource('https://www.loom.com/share/x') === 'loom');
check('skool mux', classifyVideoSource('https://stream.video.skool.com/abc.m3u8?token=t') === 'mux');
check('other', classifyVideoSource('https://example.com/video.mp4') === 'other');
check('undefined is other', classifyVideoSource(undefined) === 'other');

console.log('\nextractMuxPlaybackId');
check('skool URL', extractMuxPlaybackId('https://stream.video.skool.com/abc123.m3u8?token=xyz') === 'abc123');
check('non-mux URL returns undefined', extractMuxPlaybackId('https://youtube.com/watch?v=x') === undefined);
check('malformed URL returns undefined', extractMuxPlaybackId('not a url') === undefined);

console.log('\nvideoFingerprintsEqual');
const mux1: VideoFingerprint = { source: 'mux', playbackId: 'pid-1', ytDlpId: 'yt-1', durationSec: 100 };
const mux1Dup: VideoFingerprint = { source: 'mux', playbackId: 'pid-1', ytDlpId: 'yt-changed', durationSec: 105 };
check('Mux: playbackId match is definitive', videoFingerprintsEqual(mux1, mux1Dup));

const mux2: VideoFingerprint = { source: 'mux', playbackId: 'pid-2', ytDlpId: 'yt-1', durationSec: 100 };
check('Mux: different playbackId not equal', !videoFingerprintsEqual(mux1, mux2));

const yt1: VideoFingerprint = { source: 'youtube', ytDlpId: 'abc', durationSec: 300 };
const yt1Dup: VideoFingerprint = { source: 'youtube', ytDlpId: 'abc', durationSec: 300 };
check('YouTube: same id+duration equal', videoFingerprintsEqual(yt1, yt1Dup));

const yt2: VideoFingerprint = { source: 'youtube', ytDlpId: 'abc', durationSec: 600 };
check('YouTube: different duration not equal', !videoFingerprintsEqual(yt1, yt2));

const yt3: VideoFingerprint = { source: 'youtube', ytDlpId: 'abc', durationSec: 301 };
check('YouTube: 1-second tolerance treated as equal', videoFingerprintsEqual(yt1, yt3));

check('null vs value not equal', !videoFingerprintsEqual(undefined, yt1));
check('missing ytDlpId on non-mux not equal', !videoFingerprintsEqual({ source: 'youtube', durationSec: 300 }, yt1));

console.log('\n' + (failed === 0 ? '✨ All fingerprint checks passed.' : `❌ ${failed} check(s) failed.`));
process.exit(failed === 0 ? 0 : 1);
