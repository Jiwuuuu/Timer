/**
 * Timer — a drift-free countdown with Pomodoro cycles.
 *
 * Timing note: the countdown never accumulates from a tick counter. While
 * running, `deadline` (an absolute epoch ms) is the single source of truth and
 * every frame recomputes the remainder from it, so a throttled or backgrounded
 * tab self-corrects the moment it wakes up.
 */
(() => {
    'use strict';

    /* ---------------------------------------------------------------- config */

    const STORE_KEY = 'timer.settings.v2';
    const MAX_SECONDS = 99 * 3600 + 59 * 60 + 59;
    const TICK_MS = 100;

    const POMODORO = {
        focus: { seconds: 25 * 60, label: 'Focus', next: 'break' },
        short: { seconds: 5 * 60, label: 'Short break', next: 'focus' },
        long: { seconds: 15 * 60, label: 'Long break', next: 'focus' }
    };
    const LONG_BREAK_EVERY = 4;

    const DEFAULTS = {
        theme: 'system',
        sound: true,
        mode: 'timer',
        duration: 25 * 60,
        sessionDate: '',
        sessionCount: 0
    };

    /* ------------------------------------------------------------------- dom */

    const $ = (id) => document.getElementById(id);

    const el = {
        body: document.body,
        root: document.documentElement,
        modeTimer: $('mode-timer'),
        modePomodoro: $('mode-pomodoro'),
        soundBtn: $('sound-btn'),
        themeBtn: $('theme-btn'),
        themeGlyph: $('theme-glyph'),
        phaseLabel: $('phase-label'),
        ringBar: $('ring-bar'),
        timeDisplay: $('time-display'),
        timeInput: $('time-input'),
        dialHint: $('dial-hint'),
        presets: $('presets'),
        phases: $('phases'),
        startBtn: $('start-btn'),
        resetBtn: $('reset-btn'),
        upBtn: $('up-btn'),
        downBtn: $('down-btn'),
        sessions: $('sessions'),
        toast: $('toast'),
        srStatus: $('sr-status')
    };

    /* ----------------------------------------------------------------- state */

    let settings = load();

    let totalMs = 0;      // the full duration of the current run (drives the ring)
    let remainingMs = 0;  // authoritative while paused
    let deadline = 0;     // authoritative while running
    let running = false;
    let finished = false;
    let ticker = null;
    let phase = 'focus';
    let focusStreak = 0;  // focus sessions since the last long break
    let toastTimer = null;
    let lastTitle = '';
    let lastRendered = -1;
    let wakeLock = null;

    /* --------------------------------------------------------------- storage */

    function load() {
        let stored = {};
        try {
            stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
        } catch (err) {
            stored = {};
        }
        const merged = Object.assign({}, DEFAULTS, stored);
        if (merged.sessionDate !== today()) {
            merged.sessionDate = today();
            merged.sessionCount = 0;
        }
        merged.duration = clamp(Number(merged.duration) || DEFAULTS.duration, 0, MAX_SECONDS);
        return merged;
    }

    function save() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(settings));
        } catch (err) {
            /* private mode / file:// with storage disabled — settings just won't persist */
        }
    }

    function today() {
        const d = new Date();
        return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    }

    /* ---------------------------------------------------------------- format */

    function clamp(n, min, max) {
        return Math.min(Math.max(n, min), max);
    }

    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const mm = String(m).padStart(2, '0');
        const ss = String(s).padStart(2, '0');
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    }

    function speakTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const parts = [];
        if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
        if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
        if (s || !parts.length) parts.push(`${s} second${s === 1 ? '' : 's'}`);
        return parts.join(' ');
    }

    /**
     * Accepts "25" (bare number = minutes), "5:30" / "1:05:30" (clock form),
     * and "1h 30m" / "90s" (unit form). Returns seconds, or null if unusable.
     */
    function parseDuration(raw) {
        const text = String(raw == null ? '' : raw).trim().toLowerCase();
        if (!text) return null;

        if (text.includes(':')) {
            const parts = text.split(':');
            if (parts.length > 3) return null;
            if (parts.some((p) => !/^\d{1,2}$/.test(p.trim()))) return null;
            const nums = parts.map((p) => Number(p.trim()));
            while (nums.length < 3) nums.unshift(0);
            return nums[0] * 3600 + nums[1] * 60 + nums[2];
        }

        const unitPattern = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
        let match;
        let total = 0;
        let matched = false;
        while ((match = unitPattern.exec(text)) !== null) {
            matched = true;
            const value = parseFloat(match[1]);
            const unit = match[2][0];
            total += unit === 'h' ? value * 3600 : unit === 'm' ? value * 60 : value;
        }
        if (matched) return Math.round(total);

        if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text) * 60);
        return null;
    }

    /* ---------------------------------------------------------------- render */

    function render() {
        const seconds = Math.ceil(remainingMs / 1000);

        if (seconds !== lastRendered) {
            el.timeDisplay.textContent = formatTime(seconds);
            lastRendered = seconds;
        }

        // A drained ring at 00:00 reads as inert; refill it so the pulse alarms.
        const progress = finished ? 1 : (totalMs > 0 ? clamp(remainingMs / totalMs, 0, 1) : 0);
        el.ringBar.style.strokeDashoffset = String(100 - progress * 100);

        el.startBtn.textContent = running ? 'Pause' : (remainingMs > 0 && remainingMs < totalMs ? 'Resume' : 'Start');
        el.startBtn.disabled = !running && remainingMs <= 0;
        el.resetBtn.disabled = running === false && remainingMs === totalMs;
        el.downBtn.disabled = remainingMs <= 0 && !running;

        el.body.classList.toggle('is-finished', finished);
        el.body.dataset.phase = settings.mode === 'pomodoro' ? phase : 'timer';

        renderChips();
        renderSessions();
        renderTitle(seconds);
    }

    function renderChips() {
        const isPomodoro = settings.mode === 'pomodoro';
        el.presets.hidden = isPomodoro;
        el.phases.hidden = !isPomodoro;
        el.phaseLabel.hidden = !isPomodoro;

        if (isPomodoro) {
            el.phaseLabel.textContent = POMODORO[phase].label;
            // A hand-edited duration no longer represents the phase preset.
            const stock = totalMs === POMODORO[phase].seconds * 1000;
            for (const chip of el.phases.children) {
                chip.classList.toggle('is-active', stock && chip.dataset.phase === phase);
            }
        } else {
            const minutes = totalMs / 60000;
            for (const chip of el.presets.children) {
                chip.classList.toggle('is-active', Number(chip.dataset.minutes) === minutes);
            }
        }
    }

    function renderSessions() {
        const n = settings.sessionCount;
        el.sessions.textContent = n === 0
            ? 'No sessions completed today'
            : `${n} session${n === 1 ? '' : 's'} completed today`;
    }

    function renderTitle(seconds) {
        let title = 'Timer';
        if (finished) title = "Time's up! — Timer";
        else if (running) title = `${formatTime(seconds)} — Timer`;
        if (title !== lastTitle) {
            document.title = title;
            lastTitle = title;
        }
    }

    function announce(message) {
        el.srStatus.textContent = message;
    }

    function toast(message) {
        el.toast.hidden = false;
        el.toast.textContent = message;
        // Force a reflow so the transition replays on back-to-back toasts.
        void el.toast.offsetWidth;
        el.toast.classList.add('is-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), 2600);
    }

    /* ---------------------------------------------------------------- engine */

    function start() {
        if (running || remainingMs <= 0) return;
        running = true;
        finished = false;
        deadline = Date.now() + remainingMs;
        clearInterval(ticker);
        ticker = setInterval(tick, TICK_MS);
        requestWakeLock();
        requestNotifyPermission();
        render();
        announce(`Started. ${speakTime(Math.ceil(remainingMs / 1000))} remaining.`);
    }

    function pause() {
        if (!running) return;
        remainingMs = Math.max(0, deadline - Date.now());
        running = false;
        clearInterval(ticker);
        ticker = null;
        releaseWakeLock();
        render();
        announce(`Paused at ${speakTime(Math.ceil(remainingMs / 1000))}.`);
    }

    function tick() {
        remainingMs = Math.max(0, deadline - Date.now());
        if (remainingMs === 0) {
            complete();
            return;
        }
        render();
    }

    function complete() {
        clearInterval(ticker);
        ticker = null;
        running = false;
        finished = true;
        remainingMs = 0;
        releaseWakeLock();

        const finishedPhase = phase;
        const wasWork = settings.mode !== 'pomodoro' || finishedPhase === 'focus';
        if (wasWork) {
            settings.sessionCount += 1;
            settings.sessionDate = today();
            save();
        }

        if (settings.mode === 'pomodoro') advancePhase();

        render();
        chime();

        const message = settings.mode === 'pomodoro'
            ? `${POMODORO[finishedPhase].label} done — ${POMODORO[phase].label.toLowerCase()} next`
            : "Time's up!";
        toast(message);
        announce(message);
        notify("Time's up!", message);
    }

    function setDuration(seconds, { persist = true } = {}) {
        pause();
        const value = clamp(Math.round(seconds), 0, MAX_SECONDS);
        totalMs = value * 1000;
        remainingMs = totalMs;
        finished = false;
        if (persist && settings.mode === 'timer') {
            settings.duration = value;
            save();
        }
        render();
    }

    function reset() {
        pause();
        remainingMs = totalMs;
        finished = false;
        render();
        announce(`Reset to ${speakTime(Math.ceil(remainingMs / 1000))}.`);
    }

    /** Adjust by minutes; while running this shifts the deadline instead of the count. */
    function adjust(minutes) {
        const delta = minutes * 60 * 1000;

        if (running) {
            const now = Date.now();
            const next = clamp(deadline + delta, now, now + MAX_SECONDS * 1000);
            totalMs = Math.max(totalMs + (next - deadline), next - now);
            deadline = next;
            tick();
        } else {
            const next = clamp(remainingMs + delta, 0, MAX_SECONDS * 1000);
            remainingMs = next;
            totalMs = next;
            finished = false;
            if (settings.mode === 'timer') {
                settings.duration = Math.round(next / 1000);
                save();
            }
            render();
        }
    }

    /* -------------------------------------------------------------- pomodoro */

    function advancePhase() {
        if (phase === 'focus') {
            focusStreak += 1;
            phase = focusStreak % LONG_BREAK_EVERY === 0 ? 'long' : 'short';
        } else {
            phase = 'focus';
        }
        setPhase(phase);
    }

    function setPhase(next) {
        phase = next;
        setDuration(POMODORO[next].seconds, { persist: false });
    }

    function setMode(mode) {
        settings.mode = mode;
        save();
        el.modeTimer.classList.toggle('is-active', mode === 'timer');
        el.modePomodoro.classList.toggle('is-active', mode === 'pomodoro');
        el.modeTimer.setAttribute('aria-pressed', String(mode === 'timer'));
        el.modePomodoro.setAttribute('aria-pressed', String(mode === 'pomodoro'));

        if (mode === 'pomodoro') {
            focusStreak = 0;
            setPhase('focus');
        } else {
            setDuration(settings.duration, { persist: false });
        }
    }

    /* ----------------------------------------------------------------- audio */

    let audioCtx = null;

    function chime() {
        if (!settings.sound) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!audioCtx) audioCtx = new Ctx();
            if (audioCtx.state === 'suspended') audioCtx.resume();

            const now = audioCtx.currentTime;
            [880, 1174.66, 880].forEach((freq, i) => {
                const at = now + i * 0.26;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.28, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(at);
                osc.stop(at + 0.26);
            });
        } catch (err) {
            /* audio unavailable — the toast and title still report the finish */
        }
    }

    /* --------------------------------------------------- notifications / wake */

    function requestNotifyPermission() {
        try {
            if (!('Notification' in window)) return;
            if (Notification.permission === 'default') Notification.requestPermission();
        } catch (err) {
            /* blocked on insecure origins such as file:// */
        }
    }

    function notify(title, body) {
        try {
            if (!('Notification' in window) || Notification.permission !== 'granted') return;
            if (!document.hidden) return;
            new Notification(title, { body, tag: 'timer-finished', renotify: true });
        } catch (err) {
            /* ignore */
        }
    }

    async function requestWakeLock() {
        try {
            if (!('wakeLock' in navigator) || wakeLock) return;
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch (err) {
            wakeLock = null;
        }
    }

    function releaseWakeLock() {
        try {
            if (wakeLock) wakeLock.release();
        } catch (err) {
            /* ignore */
        }
        wakeLock = null;
    }

    /* ------------------------------------------------------------------ edit */

    function openEditor() {
        if (!el.timeInput.hidden) return;
        pause();
        const seconds = Math.ceil(remainingMs / 1000);
        el.timeInput.value = seconds > 0 ? formatTime(seconds) : '';
        el.timeInput.placeholder = 'mm  or  h:mm:ss';
        el.timeDisplay.hidden = true;
        el.timeInput.hidden = false;
        el.dialHint.dataset.persistent = 'true';
        el.dialHint.textContent = 'enter to confirm · esc to cancel';
        el.timeInput.focus();
        el.timeInput.select();
    }

    function closeEditor(commit) {
        if (el.timeInput.hidden) return;
        const raw = el.timeInput.value;
        el.timeInput.hidden = true;
        el.timeDisplay.hidden = false;
        delete el.dialHint.dataset.persistent;
        el.dialHint.textContent = 'click to edit';

        if (!commit) return;

        const seconds = parseDuration(raw);
        if (seconds === null) {
            if (raw.trim()) toast('Try 25, 5:30 or 1h 30m');
            return;
        }
        if (seconds > MAX_SECONDS) {
            toast('Max is 99:59:59');
        }
        setDuration(seconds);
        announce(`Set to ${speakTime(Math.min(seconds, MAX_SECONDS))}.`);
    }

    /* ---------------------------------------------------------------- theme  */

    const THEME_ORDER = ['system', 'dark', 'light'];
    const THEME_GLYPH = { system: '◐', dark: '☽', light: '☀' };

    function applyTheme() {
        const theme = settings.theme;
        if (theme === 'system') el.root.removeAttribute('data-theme');
        else el.root.setAttribute('data-theme', theme);
        el.themeGlyph.textContent = THEME_GLYPH[theme];
        el.themeBtn.title = `Theme: ${theme} (T)`;
    }

    function cycleTheme() {
        const i = THEME_ORDER.indexOf(settings.theme);
        settings.theme = THEME_ORDER[(i + 1) % THEME_ORDER.length];
        save();
        applyTheme();
        toast(`Theme: ${settings.theme}`);
    }

    function applySound() {
        el.soundBtn.setAttribute('aria-pressed', String(settings.sound));
        el.soundBtn.title = settings.sound ? 'Sound on (M)' : 'Sound off (M)';
    }

    /* ---------------------------------------------------------------- events */

    el.startBtn.addEventListener('click', () => (running ? pause() : start()));
    el.resetBtn.addEventListener('click', reset);
    el.upBtn.addEventListener('click', () => adjust(5));
    el.downBtn.addEventListener('click', () => adjust(-5));

    el.timeDisplay.addEventListener('click', openEditor);
    el.timeInput.addEventListener('blur', () => closeEditor(true));
    el.timeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            closeEditor(true);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeEditor(false);
        }
    });

    el.presets.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        setDuration(Number(chip.dataset.minutes) * 60);
        announce(`Set to ${speakTime(Number(chip.dataset.minutes) * 60)}.`);
    });

    el.phases.addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        setPhase(chip.dataset.phase);
    });

    el.modeTimer.addEventListener('click', () => setMode('timer'));
    el.modePomodoro.addEventListener('click', () => setMode('pomodoro'));
    el.themeBtn.addEventListener('click', cycleTheme);
    el.soundBtn.addEventListener('click', () => {
        settings.sound = !settings.sound;
        save();
        applySound();
        if (settings.sound) chime();
    });

    // A hidden tab gets its timers throttled; resync the moment it comes back.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && running) tick();
    });

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        const target = e.target;
        const typing = target instanceof HTMLElement &&
            (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
        if (typing) return;

        // Space and Enter belong to whichever control has focus; hijacking them
        // globally would break keyboard activation of the buttons.
        const onControl = target instanceof HTMLElement && target.closest('button, a, [role="button"]');

        switch (e.key) {
            case ' ':
            case 'Spacebar':
                if (onControl) return;
                e.preventDefault();
                running ? pause() : start();
                break;
            case 'r':
            case 'R':
                e.preventDefault();
                reset();
                break;
            case 'e':
            case 'E':
                e.preventDefault();
                openEditor();
                break;
            case 'ArrowUp':
                e.preventDefault();
                adjust(e.shiftKey ? 5 : 1);
                break;
            case 'ArrowDown':
                e.preventDefault();
                adjust(e.shiftKey ? -5 : -1);
                break;
            case 'p':
            case 'P':
                e.preventDefault();
                setMode(settings.mode === 'pomodoro' ? 'timer' : 'pomodoro');
                break;
            case 'm':
            case 'M':
                e.preventDefault();
                el.soundBtn.click();
                break;
            case 't':
            case 'T':
                e.preventDefault();
                cycleTheme();
                break;
            default:
                break;
        }
    });

    /* ------------------------------------------------------------------ init */

    applyTheme();
    applySound();
    setMode(settings.mode);
})();
