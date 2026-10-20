/*
 * Offline progress tracking for downloaded courses. This file is copied as
 * `progress.js` next to each course index and the community index (see
 * src/progress.ts); it runs in the browser, not in Node.
 *
 * Every page sets window.SKOOL_PROGRESS = { page: 'lesson' | 'course' | 'group', group, ... }.
 * Each course's `progress-data.js` appends { src, title, lessons: [{ id, title, rel }] }
 * to window.SKOOL_COURSES, where `rel` is relative to the course folder.
 *
 * Progress is kept in localStorage, keyed by Skool lesson ID, under one key per community,
 * so it survives re-downloading a course or regenerating its index.
 */
(function () {
    var cfg = window.SKOOL_PROGRESS;
    if (!cfg) return;

    var KEY = 'skool-progress:' + cfg.group;
    var COMPLETE_AT = 0.9;      // fraction of the video watched that counts as complete
    var MIN_RESUME = 5;         // seconds; don't bother resuming earlier than this
    var courses = window.SKOOL_COURSES || [];

    // ---------- storage ----------

    function emptyState() { return { v: 1, lessons: {}, last: null }; }

    function load() {
        try {
            var raw = localStorage.getItem(KEY);
            var s = raw ? JSON.parse(raw) : null;
            if (s && s.lessons) return s;
        } catch (e) { /* unavailable or corrupt */ }
        return emptyState();
    }

    var storageOk = true;
    function save(state) {
        try { localStorage.setItem(KEY, JSON.stringify(state)); }
        catch (e) { storageOk = false; }
    }

    function lessonState(state, id) {
        return state.lessons[id] || (state.lessons[id] = { done: false, pos: 0, dur: 0 });
    }

    function isDone(state, id) { return !!(state.lessons[id] && state.lessons[id].done); }
    function isStarted(state, id) {
        var l = state.lessons[id];
        return !!(l && !l.done && (l.pos > 0 || l.opened));
    }

    // Lesson to continue with in an ordered list: the last opened one if it is
    // unfinished, otherwise the first unfinished one after it (then from the top).
    function nextUp(state, lessons, lastId) {
        var start = 0;
        for (var i = 0; i < lessons.length; i++) {
            if (lessons[i].id === lastId) {
                if (!isDone(state, lastId)) return lessons[i];
                start = i + 1;
                break;
            }
        }
        for (var j = 0; j < lessons.length; j++) {
            var l = lessons[(start + j) % lessons.length];
            if (!isDone(state, l.id)) return l;
        }
        return null;
    }

    function countDone(state, lessons) {
        var n = 0;
        for (var i = 0; i < lessons.length; i++) if (isDone(state, lessons[i].id)) n++;
        return n;
    }

    function hasLesson(lessons, id) {
        for (var i = 0; i < lessons.length; i++) if (lessons[i].id === id) return true;
        return false;
    }

    // ---------- small DOM helpers ----------

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function bar(done, total, cls) {
        var wrap = el('div', cls || 'sp-bar');
        var fill = el('div', 'sp-bar-fill');
        fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
        wrap.appendChild(fill);
        return wrap;
    }

    function fmtTime(s) {
        s = Math.floor(s);
        var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
        var mm = (h ? String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
        return h ? h + ':' + mm : mm;
    }

    function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

    function continueLink(lesson, href, label) {
        var a = el('a', 'sp-continue', label + lesson.title);
        a.href = href;
        return a;
    }

    function warnIfNoStorage(target) {
        if (storageOk || !target || document.querySelector('.sp-warn')) return;
        target.insertBefore(el('div', 'sp-warn',
            'Progress can\'t be saved in this browser for local files. Try Chrome or Edge.'), target.firstChild);
    }

    // ---------- lesson page ----------

    function initLesson() {
        var id = cfg.lesson.id;
        var course = courses[0];
        var state = load();
        lessonState(state, id).opened = true;
        state.last = { id: id };
        save(state);

        var container = document.querySelector('.container');
        var h1 = container && container.querySelector('h1');
        var video = document.querySelector('video');

        // Status row under the title: completion toggle + resume note.
        var row = el('div', 'sp-status');
        var btn = el('button', 'sp-toggle');
        btn.type = 'button';
        var note = el('span', 'sp-note');
        row.appendChild(btn);
        row.appendChild(note);
        if (h1) h1.parentNode.insertBefore(row, h1.nextSibling);

        function render() {
            var s = load().lessons[id] || {};
            btn.classList.toggle('is-done', !!s.done);
            btn.textContent = s.done ? '✓ Completed' : 'Mark as complete';
            btn.title = s.done ? 'Click to mark as not complete' : '';
        }

        function setDone(done) {
            var st = load();
            var l = lessonState(st, id);
            l.done = done;
            if (done) l.doneAt = Date.now();
            save(st);
            render();
        }

        btn.addEventListener('click', function () { setDone(!(load().lessons[id] || {}).done); });

        if (video) {
            var lastSaved = 0;

            function savePos(force) {
                if (!video.duration || isNaN(video.duration)) return;
                var now = Date.now();
                if (!force && now - lastSaved < 3000) return;
                lastSaved = now;
                var st = load();
                var l = lessonState(st, id);
                l.pos = video.currentTime;
                l.dur = video.duration;
                var reached = video.currentTime / video.duration >= COMPLETE_AT;
                if (reached && !l.done) { l.done = true; l.doneAt = now; }
                save(st);
                if (reached) render();
            }

            video.addEventListener('loadedmetadata', function () {
                var l = load().lessons[id];
                if (l && l.pos > MIN_RESUME && l.pos < video.duration - 5) {
                    video.currentTime = l.pos;
                    note.textContent = 'Resumed at ' + fmtTime(l.pos) + ' · ';
                    var restart = el('a', 'sp-link', 'start over');
                    restart.href = '#';
                    restart.addEventListener('click', function (e) {
                        e.preventDefault();
                        video.currentTime = 0;
                        note.textContent = '';
                    });
                    note.appendChild(restart);
                }
            });
            video.addEventListener('timeupdate', function () { savePos(false); });
            video.addEventListener('pause', function () { savePos(true); });
            video.addEventListener('ended', function () {
                var st = load();
                var l = lessonState(st, id);
                l.pos = 0;            // rewatching starts from the beginning
                l.done = true;
                l.doneAt = l.doneAt || Date.now();
                save(st);
                render();
            });
            window.addEventListener('pagehide', function () { savePos(true); });
            // Playback speed is remembered across lessons too.
            try {
                var rate = parseFloat(localStorage.getItem(KEY + ':rate'));
                if (rate > 0) video.playbackRate = rate;
                video.addEventListener('ratechange', function () {
                    try { localStorage.setItem(KEY + ':rate', String(video.playbackRate)); } catch (e) {}
                });
            } catch (e) {}
        }

        // Previous / next lesson links in the bottom nav.
        var nav = document.querySelector('.nav');
        var lessons = course ? course.lessons : [];
        var at = -1;
        for (var i = 0; i < lessons.length; i++) if (lessons[i].id === id) at = i;
        if (nav && at !== -1) {
            nav.classList.add('sp-nav');
            var prev = lessons[at - 1], next = lessons[at + 1];
            if (prev) {
                var p = el('a', 'sp-prev', '← ' + prev.title);
                p.href = cfg.root + prev.rel;
                nav.insertBefore(p, nav.firstChild);
            }
            if (next) {
                var n = el('a', 'sp-next', next.title + ' →');
                n.href = cfg.root + next.rel;
                n.addEventListener('click', function () {
                    // Moving on from a lesson without video counts as finishing it.
                    if (!video && !(load().lessons[id] || {}).done) setDone(true);
                });
                nav.appendChild(n);
            }
        }

        render();
        warnIfNoStorage(container);
    }

    // ---------- course index ----------

    function initCourse() {
        var lessons = courses[0] ? courses[0].lessons : [];
        var anchors = {};
        var links = document.querySelectorAll('.lesson a');
        for (var i = 0; i < links.length; i++) anchors[links[i].getAttribute('href')] = links[i];

        var heroCopy = document.querySelector('.hero-copy');
        var panel = el('div', 'sp-panel');
        if (heroCopy) heroCopy.appendChild(panel);

        function render() {
            var state = load();

            for (var i = 0; i < lessons.length; i++) {
                var l = lessons[i], a = anchors[l.rel];
                if (!a) continue;
                var s = state.lessons[l.id] || {};
                a.classList.toggle('sp-done', !!s.done);
                a.classList.toggle('sp-started', isStarted(state, l.id));
                var old = a.querySelector('.sp-mini');
                if (old) old.remove();
                if (!s.done && s.dur && s.pos > 0) a.appendChild(bar(s.pos, s.dur, 'sp-mini'));
            }

            // Per-module counts.
            var modules = document.querySelectorAll('.module');
            for (var m = 0; m < modules.length; m++) {
                var mLinks = modules[m].querySelectorAll('.lesson a');
                var done = 0;
                for (var k = 0; k < mLinks.length; k++) if (mLinks[k].classList.contains('sp-done')) done++;
                var title = modules[m].querySelector('.module-title');
                if (!title) continue;
                var badge = title.querySelector('.sp-count') || title.appendChild(el('em', 'sp-count'));
                badge.textContent = done + '/' + mLinks.length;
                badge.classList.toggle('sp-all', done === mLinks.length);
            }

            // Course summary + continue button.
            clear(panel);
            var total = lessons.length, doneCount = countDone(state, lessons);
            var label = el('div', 'sp-label');
            label.appendChild(el('strong', null, doneCount + '/' + total));
            label.appendChild(document.createTextNode(' lessons completed · ' +
                (total ? Math.round(doneCount / total * 100) : 0) + '%'));
            panel.appendChild(label);
            panel.appendChild(bar(doneCount, total));

            var lastId = state.last && hasLesson(lessons, state.last.id) ? state.last.id : null;
            var up = nextUp(state, lessons, lastId);
            if (up) panel.appendChild(continueLink(up, up.rel, doneCount || lastId ? 'Continue: ' : 'Start: '));
            else if (total) panel.appendChild(el('div', 'sp-finished', 'Course complete 🎉'));
            warnIfNoStorage(document.querySelector('.page'));
        }

        render();
        window.addEventListener('pageshow', render);   // the back button can restore a stale page
        window.addEventListener('storage', function (e) { if (e.key === KEY) render(); });
    }

    // ---------- community (group) index ----------

    function initGroup() {
        // `src` is the path this page loaded the course's progress-data.js from,
        // so it also gives the course folder relative to this page.
        var list = courses.map(function (c) {
            var base = (c.src || '').replace(/progress-data\.js$/, '');
            return {
                title: c.title,
                href: base + 'index.html',
                lessons: c.lessons.map(function (l) { return { id: l.id, title: l.title, rel: base + l.rel }; })
            };
        });
        var cards = {};
        var links = document.querySelectorAll('.course-card');
        for (var i = 0; i < links.length; i++) cards[links[i].getAttribute('href')] = links[i];

        var hero = document.querySelector('.hero');
        var panel = el('div', 'sp-panel');
        if (hero) hero.appendChild(panel);

        function render() {
            var state = load();
            var all = [];

            for (var i = 0; i < list.length; i++) {
                var c = list[i];
                all = all.concat(c.lessons);
                var card = cards[c.href];
                var body = card && card.querySelector('.course-body');
                if (!body) continue;
                var old = body.querySelector('.sp-course');
                if (old) old.remove();
                var done = countDone(state, c.lessons), total = c.lessons.length;
                var complete = total > 0 && done === total;
                var box = el('div', 'sp-course' + (complete ? ' sp-all' : ''));
                box.appendChild(el('div', 'sp-label', complete ? '✓ Completed' : done + '/' + total + ' completed'));
                box.appendChild(bar(done, total));
                body.appendChild(box);
            }

            clear(panel);
            var doneAll = countDone(state, all);
            var label = el('div', 'sp-label');
            label.appendChild(el('strong', null, doneAll + '/' + all.length));
            label.appendChild(document.createTextNode(' lessons completed across all courses'));
            panel.appendChild(label);
            panel.appendChild(bar(doneAll, all.length));

            if (state.last) {
                for (var j = 0; j < list.length; j++) {
                    if (!hasLesson(list[j].lessons, state.last.id)) continue;
                    var up = nextUp(state, list[j].lessons, state.last.id);
                    if (up) panel.appendChild(continueLink(up, up.rel, 'Continue: '));
                    break;
                }
            }

            var tools = el('div', 'sp-tools');
            tools.appendChild(button('Export progress', exportProgress));
            tools.appendChild(button('Import progress', importProgress));
            tools.appendChild(button('Reset progress', function () {
                if (confirm('Clear all saved progress for ' + cfg.group + '?')) { save(emptyState()); render(); }
            }, 'sp-danger'));
            panel.appendChild(tools);
            warnIfNoStorage(document.querySelector('.page'));
        }

        function button(text, onClick, cls) {
            var b = el('button', cls || null, text);
            b.type = 'button';
            b.addEventListener('click', onClick);
            return b;
        }

        function exportProgress() {
            var blob = new Blob([JSON.stringify(load(), null, 2)], { type: 'application/json' });
            var a = el('a');
            a.href = URL.createObjectURL(blob);
            a.download = cfg.group + '-progress-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
        }

        function importProgress() {
            var input = el('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.addEventListener('change', function () {
                var file = input.files && input.files[0];
                if (!file) return;
                var reader = new FileReader();
                reader.onload = function () {
                    try {
                        var incoming = JSON.parse(reader.result);
                        if (!incoming || typeof incoming.lessons !== 'object') throw new Error('bad file');
                        // Merge: a lesson is done if either side says so; keep the furthest position.
                        var state = load();
                        Object.keys(incoming.lessons).forEach(function (id) {
                            var a = state.lessons[id] || {}, b = incoming.lessons[id] || {};
                            state.lessons[id] = {
                                done: !!(a.done || b.done),
                                doneAt: a.doneAt || b.doneAt,
                                pos: Math.max(a.pos || 0, b.pos || 0),
                                dur: a.dur || b.dur || 0,
                                opened: !!(a.opened || b.opened)
                            };
                        });
                        if (!state.last && incoming.last) state.last = incoming.last;
                        save(state);
                        render();
                    } catch (e) {
                        alert('That file is not a progress export.');
                    }
                };
                reader.readAsText(file);
            });
            input.click();
        }

        render();
        window.addEventListener('pageshow', render);
        window.addEventListener('storage', function (e) { if (e.key === KEY) render(); });
    }

    // ---------- styles ----------

    var css = [
        '.sp-bar,.sp-mini{border-radius:999px;background:rgba(20,22,29,0.08);overflow:hidden}',
        '.sp-bar{height:8px}',
        '.sp-mini{height:4px;margin-top:8px}',
        '.sp-bar-fill{height:100%;border-radius:999px;background:#22c55e;transition:width .3s ease}',
        '.sp-mini .sp-bar-fill{background:#3b82f6}',
        '.sp-panel{margin-top:20px;display:grid;gap:10px;max-width:520px}',
        '.sp-label{font-size:.95rem;color:#5c6575}',
        '.sp-label strong{color:#16a34a}',
        '.sp-continue{justify-self:start;margin-top:4px;padding:10px 16px;border-radius:12px;background:#3b82f6;color:#fff !important;font-weight:600;text-decoration:none !important}',
        '.sp-continue:hover{background:#2563eb}',
        '.sp-finished{font-weight:600;color:#16a34a}',
        '.sp-tools{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}',
        '.sp-tools button,.sp-toggle{font:inherit;font-size:.9rem;padding:7px 12px;border-radius:10px;border:1px solid rgba(20,22,29,0.15);background:#fff;color:#14161d;cursor:pointer}',
        '.sp-tools button:hover,.sp-toggle:hover{border-color:#3b82f6}',
        '.sp-tools .sp-danger:hover{border-color:#ef4444;color:#b91c1c}',
        '.sp-status{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:-4px 0 14px}',
        '.sp-toggle.is-done{background:#dcfce7;border-color:#86efac;color:#166534;font-weight:600}',
        '.sp-note{font-size:.9rem;color:#5b6271}',
        '.sp-nav{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}',
        '.sp-prev,.sp-next{font-weight:600}',
        '.sp-next{margin-left:auto}',
        '.lesson a.sp-done{background:#ecfdf3;border-color:#bbf7d0;position:relative;padding-right:38px}',
        '.lesson a.sp-done::after{content:"✓";position:absolute;right:14px;top:12px;color:#16a34a;font-weight:700}',
        '.lesson a.sp-started{border-color:rgba(59,130,246,0.45)}',
        '.sp-count{margin-left:auto;font-style:normal;font-size:.85rem;font-weight:600;color:#5c6575}',
        '.sp-count.sp-all{color:#16a34a}',
        '.sp-course{display:grid;gap:6px;margin-top:4px}',
        '.sp-course .sp-label{font-size:.88rem}',
        '.sp-course.sp-all .sp-label{color:#16a34a;font-weight:600}',
        '.sp-warn{margin-bottom:14px;padding:10px 14px;border-radius:12px;background:#fef3c7;color:#92400e;font-size:.92rem}'
    ].join('\n');
    var style = el('style');
    style.textContent = css;
    document.head.appendChild(style);

    if (cfg.page === 'lesson') initLesson();
    else if (cfg.page === 'course') initCourse();
    else if (cfg.page === 'group') initGroup();
})();
