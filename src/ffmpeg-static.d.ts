/**
 * ffmpeg-static is an optional dependency, so it is absent whenever its install
 * step fails or is skipped. Without this declaration `tsc` reports the dynamic
 * import in downloader.ts as an unresolved module on exactly those machines,
 * which would make the typecheck pass or fail based on install state rather
 * than on the code. Declaring the shape here keeps the answer the same either
 * way. It matches what the package exports: the path to the bundled binary, or
 * null when there is no build for the current platform.
 */
declare module 'ffmpeg-static' {
    const ffmpegPath: string | null;
    export default ffmpegPath;
}
