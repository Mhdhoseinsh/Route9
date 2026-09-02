        (function() {
            // Wraps every localStorage call in the file. Some browsers/extensions
            // throw on ANY localStorage access (not just quota errors) — e.g.
            // Safari private mode edge cases, storage-blocking privacy extensions,
            // some enterprise/managed-device policies, or third-party iframe
            // embeds. Before this helper existed, the very first executable line
            // of this script read localStorage directly with no try/catch, so on
            // an affected browser that one line threw and silently killed the
            // entire script — blank, non-functional page, no error shown to the
            // player. Every localStorage.* call below now goes through these so a
            // storage failure only costs that one feature (e.g. saved name/sound
            // preference), never the whole game.
            function safeStorageGet(key) {
                try { return localStorage.getItem(key) } catch (e) { return null }
            }
            function safeStorageSet(key, value) {
                try { localStorage.setItem(key, value); return !0 } catch (e) { return !1 }
            }
            function safeStorageRemove(key) {
                try { localStorage.removeItem(key) } catch (e) {}
            }

            // Registering this actually turns on the caching strategy already
            // written in sw.js (fonts/icons/webp served from disk on repeat
            // visits) — previously the file existed but nothing ever called
            // register(), so it never ran.
            if ('serviceWorker' in navigator) {
                window.addEventListener('load', () => {
                    navigator.serviceWorker.register('sw.js').catch(() => {})
                });
            }

            const canvas = document.getElementById('boardCanvas');
            const ctx = canvas.getContext('2d');
            const padding = 20;
            const cellSize = 48;
            const colLetters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
            const ITEMS_PER_PAGE = 8;
            let sfxCtx = null;
            let sfxEnabled = safeStorageGet('barricade-sfx') !== 'off';

            function getSfxCtx() {
                if (!sfxEnabled) return null;
                if (!sfxCtx) {
                    try {
                        sfxCtx = new(window.AudioContext || window.webkitAudioContext)()
                    } catch (e) {
                        sfxCtx = null
                    }
                }
                if (sfxCtx && sfxCtx.state === 'suspended') sfxCtx.resume();
                return sfxCtx
            }

            function sfxTone(ctx, t0, freq, endFreq, duration, type, peak) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = type;
                osc.frequency.setValueAtTime(freq, t0);
                if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration * 0.9);
                gain.gain.setValueAtTime(0, t0);
                gain.gain.linearRampToValueAtTime(peak, t0 + 0.012);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + duration + 0.03);
                return { osc, gain }
            }

            function sfxNoiseBurst(ctx, t0, duration, filterType, filterFreq, peak, q) {
                const bufSize = Math.max(1, Math.floor(ctx.sampleRate * duration));
                const buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
                const data = buffer.getChannelData(0);
                for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufSize, 1.4);
                const noise = ctx.createBufferSource();
                noise.buffer = buffer;
                const filter = ctx.createBiquadFilter();
                filter.type = filterType;
                filter.frequency.setValueAtTime(filterFreq, t0);
                if (q) filter.Q.setValueAtTime(q, t0);
                const gain = ctx.createGain();
                gain.gain.setValueAtTime(peak, t0);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
                noise.connect(filter);
                filter.connect(gain);
                gain.connect(ctx.destination);
                noise.start(t0);
                noise.stop(t0 + duration + 0.02)
            }

            function sfxKick(ctx, t0, peak) {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(160, t0);
                osc.frequency.exponentialRampToValueAtTime(42, t0 + 0.16);
                gain.gain.setValueAtTime(peak, t0);
                gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.24);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(t0);
                osc.stop(t0 + 0.26);
                sfxNoiseBurst(ctx, t0, 0.03, 'lowpass', 900, peak * 0.45)
            }

            function sfxBrassNote(ctx, t0, freq, duration, peak) {
                [0, -7].forEach(detune => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    const filter = ctx.createBiquadFilter();
                    filter.type = 'lowpass';
                    filter.frequency.setValueAtTime(freq * 3.2, t0);
                    filter.frequency.exponentialRampToValueAtTime(freq * 1.4, t0 + duration);
                    osc.type = 'sawtooth';
                    osc.frequency.setValueAtTime(freq, t0);
                    osc.detune.setValueAtTime(detune, t0);
                    gain.gain.setValueAtTime(0, t0);
                    gain.gain.linearRampToValueAtTime(peak, t0 + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
                    osc.connect(filter);
                    filter.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(t0);
                    osc.stop(t0 + duration + 0.03)
                })
            }

            function haptic(pattern) {
                try {
                    if (navigator.vibrate) navigator.vibrate(pattern)
                } catch (e) {}
            }

            function sfxMove() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                haptic(10);
                const t0 = ctx.currentTime;
                sfxTone(ctx, t0, 200, 130, 0.08, 'sine', 0.2);
                sfxNoiseBurst(ctx, t0, 0.02, 'highpass', 2400, 0.13)
            }

            function sfxWall() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                haptic(18);
                const t0 = ctx.currentTime;
                sfxKick(ctx, t0, 0.42);
                sfxNoiseBurst(ctx, t0 + 0.005, 0.09, 'lowpass', 550, 0.22);
                sfxTone(ctx, t0 + 0.02, 950, 680, 0.16, 'triangle', 0.07)
            }

            function sfxGameStart() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                const t0 = ctx.currentTime;
                sfxKick(ctx, t0, 0.46);
                sfxNoiseBurst(ctx, t0, 0.05, 'bandpass', 3200, 0.11, 6);
                sfxTone(ctx, t0, 110, 100, 0.55, 'sawtooth', 0.05);
                [220, 220, 330, 440].forEach((freq, i) => {
                    sfxBrassNote(ctx, t0 + [0.09, 0.21, 0.33, 0.45][i], freq, 0.15, 0.15)
                });
                sfxBrassNote(ctx, t0 + 0.6, 440, 0.35, 0.2)
            }

            function sfxWin() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                haptic([30, 50, 30, 50, 70]);
                const t0 = ctx.currentTime;
                sfxKick(ctx, t0, 0.48);
                [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
                    sfxBrassNote(ctx, t0 + i * 0.11, freq, 0.28, 0.17)
                });
                const chordTime = t0 + 0.46;
                [523.25, 659.25, 783.99, 1046.5].forEach(freq => {
                    sfxBrassNote(ctx, chordTime, freq, 0.55, 0.13)
                });
                sfxNoiseBurst(ctx, chordTime, 0.35, 'highpass', 4200, 0.05)
            }

            function sfxBite() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                haptic([40, 30, 40, 30, 50]);
                const t0 = ctx.currentTime;
                sfxNoiseBurst(ctx, t0, 0.06, 'lowpass', 650, 0.32);
                sfxTone(ctx, t0, 280, 80, 0.13, 'square', 0.2);
                sfxNoiseBurst(ctx, t0 + 0.16, 0.06, 'lowpass', 650, 0.3);
                sfxTone(ctx, t0 + 0.16, 280, 80, 0.13, 'square', 0.18);
                sfxNoiseBurst(ctx, t0 + 0.32, 0.08, 'lowpass', 500, 0.35);
                sfxTone(ctx, t0 + 0.32, 220, 60, 0.18, 'square', 0.22)
            }

            function sfxProximity() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                const t0 = ctx.currentTime;
                sfxTone(ctx, t0, 520, 420, 0.14, 'triangle', 0.16);
                sfxNoiseBurst(ctx, t0, 0.05, 'highpass', 3000, 0.09)
            }

            function sfxClick() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                haptic(7);
                const t0 = ctx.currentTime;
                sfxTone(ctx, t0, 760, 560, 0.055, 'sine', 0.11);
                sfxNoiseBurst(ctx, t0, 0.012, 'highpass', 4000, 0.05)
            }

            function sfxToggle() {
                const ctx = getSfxCtx();
                if (!ctx) return;
                haptic(9);
                const t0 = ctx.currentTime;
                sfxTone(ctx, t0, 500, 780, 0.07, 'sine', 0.12);
                sfxTone(ctx, t0 + 0.03, 780, 900, 0.06, 'sine', 0.08)
            }
            // Fixed English UI strings. (Persian/multi-language support has
            // been fully removed — this is a plain, single dictionary now,
            // not a per-language lookup table.)
            const translations = {
                pageTitle: 'Route 9 - Dark Mode',
                    modeTitle: 'Route 9',
                    aboutBtn: 'About',
                    soundOn: 'Sound',
                soundOff: 'Muted',
                shakeToShowHint: 'Tap the small dot to bring the icon back',
                aboutTitle: 'About Us',
                    aboutTagline: 'Strategy. Walls. Victory.',
                    aboutText: 'Route 9 is a strategy board game where players race to reach the opposite side while placing walls to slow each other down — play pass-and-play offline, or challenge a friend online.',
                    aboutFeature1: 'Offline & online play',
                    aboutFeature2: '2–4 players',
                    aboutFeature3: 'Wall strategy',
                    aboutCreatorLabel: 'Created by',
                    aboutCreatorName: 'Mohammad hossein shamsi',
                    aboutFollowLabel: 'Follow us',
                    aboutClose: 'Close',
                    startSubtitle: 'Choose how you want to play',
                    howToPlay: 'How to Play',
                    modeClassicTitle: 'Classic Game',
                    modeClassicShort: 'Classic',
                    modeClassicDesc: 'Block your rivals and race to the other side.',
                    modeClassicBadge: '2-4',
                    pc2Label: '2 Players',
                    pc4Label: '2 vs 2',
                    modeHunterTitle: 'Wolf VS Sheep',
                    modeHunterDesc: 'One escapes, one hunts — first to win takes it.',
                    onlinePick2pLabel: 'Classic 1 vs 1',
                    onlinePick4pLabel: '2 vs 2',
                    onlinePickHunterLabel: 'Wolf & Sheep',
                    onlineCreateTitle: 'Create Room',
                    onlineCreateDesc: 'Make a code and send it to your opponent',
                    onlineJoinTitle: 'Join with Code',
                    onlineJoinDesc: "Enter your opponent's code",
                    onlineBackLabel: 'Back',
                    onlineCodeHint: 'Send this code to your opponent',
                    onlineCancelLabel: 'Cancel',
                    onlineConnectLabel: 'Connect',
                    onlineCopyCodeAria: 'Copy code',
                    move: 'Move',
                    horizontal: 'Horizontal',
                    vertical: 'Vertical',
                    undo: 'Undo',
                    repeat: 'Repeat',
                    resign: 'Resign',
                    newGame: 'Back to Home',
                    moveHistory: 'MOVE HISTORY',
                    startGame: 'Start a game',
                    gameInfo: 'GAME INFO',
                    mode: 'Mode',
                    wallsLeft: 'Walls Left',
                    status: 'Status',
                    objective: 'OBJECTIVE',
                    walls: 'WALLS',
                    wallsText: '• Tap a spot to select a wall, then confirm.<br>• 10 walls per player.',
                    wallsText4p: '• Tap a spot to select a wall, then confirm.<br>• 6 walls per player, 2v2 teams.',
                    wallsTextHunter: '• Tap a spot to select a wall, then confirm.<br>• Survivor: 10 walls, Hunter: 8 walls.',
                    rules: 'RULES',
                    rulesText: '• A wall can never fully block a path.<br>• Walls can\'t overlap or cross like a "+".',
                    placeWall: 'Place Wall',
                    match: 'MATCH',
                    vs: 'VS',
                    gameOver: 'Game Over',
                    turnSuffix: "'s Turn",
                    mode2p: '2 Player',
                    mode4p: '4 Player',
                    modeHunter: 'Hunter & Survivor',
                    objective2p: 'Reach the opposite side before your opponent.',
                    objective4p: 'Get both teammates to their target edge before the other team.',
                    objectiveHunter: '• Survivor must reach the opposite side.\n• Hunter must catch the survivor by moving onto their square, or corner them 7 times.',
                    teamA: 'Team A',
                    teamB: 'Team B',
                    players: {
                        player1: 'Player 1 (Red)',
                        player2: 'Player 2 (Blue)',
                        red: 'Red',
                        blue: 'Blue',
                        green: 'Green',
                        yellow: 'Yellow',
                        hunterRole: 'Hunter (Red)',
                        escaperRole: 'Survivor (Blue)'
                    },
                    roleHunter: 'Hunter',
                    roleEscaper: 'Survivor',
                    teamNames: {
                        0: 'Red & Blue',
                        1: 'Green & Yellow'
                    },
                    alertPerpendicular: 'Cannot intersect perpendicular walls!',
                    alertBlocked: 'This wall would completely block a path — not allowed!',
                    alertWins: '{name} Wins!',
                    alertTeamWins: 'Team {team} Wins!',
                    confirmResign: '{name} resigns — end the game?',
                    resignWinner: '{name} Resigned! Winner: {winner}',
                    resignTeamWinner: '{name} Resigned! Team {team} Wins!',
                    confirmNewGame: 'Go back to home? Current progress will be lost.',
                    confirmRepeat: 'Repeat this game with the same players?',
                    nameEntryTitle: 'Enter Player Names',
                    startGameBtn: 'Start Game',
                    createRoomBtn: 'Create Room',
                    onlineCreateTitle: 'Set Up Your Room',
                    backBtn: 'Back',
                    toastNoWalls: 'You have no walls left to place!',
                    toastWallExists: 'There is already a wall in this spot.',
                    toastInvalidMove: "You can't move there.",
                    toastNothingToUndo: 'Nothing to undo yet.',
                    dangerWarning: 'The hunter is right next to you!',
                    huntProximityToast: 'Hunter closing in: {n}/7',
                    huntProximityWinToast: 'The hunter cornered the survivor 7 times!',
                    defaultPlayerNames: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
                    goWinnerLabel: 'WINNER',
                    goTagWinner: 'Winner',
                    goTagLoser: 'Loser',
                    goPlayAgain: 'Play Again',
                    goBackHome: 'Back to Home',
                    confirmYesLabel: 'Yes, Continue',
                    confirmNoLabel: 'Cancel',
                    confirmHomeYes: 'Yes, Go Home',
                    confirmHomeNo: 'Stay in Game',
                    confirmRepeatYes: 'Yes, Repeat',
                    confirmRepeatNo: 'Cancel',
                    confirmResignYes: 'Yes, Resign',
                    confirmResignNo: 'Keep Playing',
                    settingsBtn: 'Settings',
                    settingsTitle: 'Settings',
                    settingsSoundLabel: 'Sound Effects',
                    settingsSoundDesc: 'Enable or mute in-game sounds',
                    settingsWallOffsetLabel: 'Wall Preview Distance',
                    settingsWallOffsetDesc: 'How far your finger sits from the wall preview while dragging',
                    onlineLobbyTitle: 'Set Name & Avatar',
                    onlineLobbyDesc: 'You have up to {n} seconds to set your name and avatar color',
                    onlineLobbyHint: 'You can only change your own name and color',
                    hunterPickLabel: 'Pick your role',
                    hunterPickPending: 'Not chosen yet',
                    hunterRevealTitle: 'Role Lottery',
                    hunterRevealSub: "You both picked the same role — flipping a coin to decide!",
                    rematchAcceptLabel: "Accept Opponent's Rematch",
                    rematchWaitingLabel: 'Waiting for opponent...',
                    opponentLeftMsg: 'Opponent left the game',
                    disconnectOverlayLabel: 'Disconnected',
                    disconnectReconnectedToast: '{name} reconnected',
                    disconnectTimeoutToast: '{name} lost connection — forfeited the match',
                    matchPausedToast: 'Match paused — waiting for your opponent to reconnect',
                    toastRematchRequested: 'Opponent wants a rematch',
                    gtOfflineLabel: 'Offline',
                    gtOnlineLabel: 'Online',
                    gtLockHint4p: '4-player mode is offline only',
                    onlineNameLockTitle: 'Name & avatar are set inside the room',
                    onlineNameLockDesc: "After you create or join a room, you'll pick your name and avatar color in the lobby.",
                    timerSelectLabel: "Each Player's Total Time",
                    timerUnitSec: 'sec',
                    timerUnitMin: 'min',
                    timerNoneLabel: 'No timer',
                onlineCodeEntryLabel: 'Join with Code',
                timeUpToast: "{name}'s time ran out — turn forfeited"
            };
            // English-only build: language switching has been removed.

            function t(key) {
                return translations[key]
            }

            function localizeNum(n) {
                return String(n)
            }

            function fmt(str, params) {
                const localizedParams = {};
                for (const k in params) {
                    localizedParams[k] = typeof params[k] === 'number' ? localizeNum(params[k]) : params[k]
                }
                return str.replace(/\{(\w+)\}/g, (m, k) => (localizedParams[k] !== undefined ? localizedParams[k] : m))
            }

            function setTextContent(elId, text) {
                const el = document.getElementById(elId);
                if (el) el.textContent = text
            }

            function escapeHTML(str) {
                return String(str).replace(/[&<>"]/g, function(m) {
                    if (m === '&') return '&amp;';
                    if (m === '<') return '&lt;';
                    if (m === '>') return '&gt;';
                    if (m === '"') return '&quot;';
                    return m
                })
            }

            // ===== Toast notifications ==========================================
            // Compact card: icon, single-line title and a close button up
            // top, with a slim progress bar tracking the auto-dismiss
            // underneath — no secondary line of text, so it stays small on
            // screen. Only one toast is ever shown at once: a new call
            // instantly swaps out whatever is currently visible instead of
            // stacking a second one below it.
            const TOAST_ICONS = {
                success: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2"/><path d="M7.8 12.5l2.6 2.6 5.8-6.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
                warning: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 3.6 21.3 20H2.7Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 9.6v4.6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1" fill="currentColor"/></svg>',
                error: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2"/><path d="M12 7.2v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="16.2" r="1" fill="currentColor"/></svg>',
                info: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2"/><path d="M12 10.8v5.4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.4" r="1" fill="currentColor"/></svg>'
            };
            const TOAST_DURATION_MS = 4000;
            let activeToast = null; // { el, cleanup } — the single toast on screen, if any

            function showToast(message, type) {
                type = TOAST_ICONS[type] ? type : 'info';
                const container = document.getElementById('toast-container');
                if (!container) return;

                // Only one toast on screen at a time: cut the current one
                // off immediately (no exit animation) so the new one can
                // take its place without ever appearing stacked underneath.
                if (activeToast) {
                    activeToast.cleanup();
                    activeToast.el.remove();
                    activeToast = null
                }

                const el = document.createElement('div');
                el.className = 'toast toast-' + type;

                const row = document.createElement('div');
                row.className = 'toast-row';
                const icon = document.createElement('span');
                icon.className = 'toast-icon';
                icon.innerHTML = TOAST_ICONS[type];
                const body = document.createElement('div');
                body.className = 'toast-body';
                const title = document.createElement('div');
                title.className = 'toast-title';
                title.textContent = message;
                body.appendChild(title);
                const closeBtn = document.createElement('button');
                closeBtn.type = 'button';
                closeBtn.className = 'toast-close';
                closeBtn.setAttribute('aria-label', 'Close');
                closeBtn.innerHTML = '&times;';
                row.append(icon, body, closeBtn);

                const progress = document.createElement('div');
                progress.className = 'toast-progress';
                const progressBar = document.createElement('div');
                progressBar.className = 'toast-progress-bar';
                progress.appendChild(progressBar);

                el.append(row, progress);
                container.appendChild(el);

                // Toasts drop in from the top everywhere in the app, except
                // during an active game where they drop in from the bottom
                // (above the board controls) so they don't cover the board.
                container.classList.toggle('toast-pos-bottom', !!(appEl && appEl.classList.contains('visible')));

                let remainingMs = TOAST_DURATION_MS;
                let lastTick = Date.now();
                let rafId = null;
                let dismissed = false;

                function dismiss() {
                    if (dismissed) return;
                    dismissed = true;
                    if (rafId) cancelAnimationFrame(rafId);
                    el.classList.remove('show');
                    el.classList.add('leave');
                    setTimeout(() => el.remove(), 220);
                    if (activeToast && activeToast.el === el) activeToast = null
                }

                function tick() {
                    const now = Date.now();
                    remainingMs -= (now - lastTick);
                    lastTick = now;
                    if (remainingMs <= 0) { dismiss(); return }
                    progressBar.style.width = Math.max(0, (remainingMs / TOAST_DURATION_MS) * 100) + '%';
                    rafId = requestAnimationFrame(tick)
                }

                closeBtn.onclick = dismiss;

                activeToast = {
                    el,
                    cleanup() {
                        dismissed = true;
                        if (rafId) cancelAnimationFrame(rafId)
                    }
                };

                // Force a style flush before flipping to the "show" state so
                // the browser is guaranteed to have painted the initial
                // (off-screen/opacity:0) styles first. Firefox in particular
                // can otherwise coalesce the very next rAF with the append
                // and skip the transition entirely, so only the icon's own
                // keyframe animation appears to run.
                void el.offsetWidth;
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        el.classList.add('show');
                        lastTick = Date.now();
                        rafId = requestAnimationFrame(tick)
                    })
                })
            }
            const startOverlay = document.getElementById('start-overlay');
            const appEl = document.getElementById('app');
            const topbarEl = document.getElementById('topbar');
            const boardWrapper = document.getElementById('board-wrapper');
            const btnMove = document.getElementById('btn-move');
            const btnHWall = document.getElementById('btn-hwall');
            const btnVWall = document.getElementById('btn-vwall');
            const btnUndo = document.getElementById('btn-undo');
            const btnRepeat = document.getElementById('btn-repeat');
            const btnResign = document.getElementById('btn-resign');
            const btnHome = document.getElementById('btn-home');
            const historyList = document.getElementById('history-list');
            const statusText = document.getElementById('status-text');
            const infoMode = document.getElementById('info-mode');
            const infoWalls = document.getElementById('info-walls');
            const infoObjective = document.getElementById('info-objective');
            const wallConfirmPopup = document.getElementById('wall-confirm-popup');
            const wallConfirmYes = document.getElementById('wall-confirm-yes');
            const wallConfirmNo = document.getElementById('wall-confirm-no');
            const gameOverOverlay = document.getElementById('game-over-overlay');
            const confirmOverlay = document.getElementById('confirm-overlay');
            const confirmText = document.getElementById('confirm-text');
            const confirmBtnYes = document.getElementById('confirm-btn-yes');
            const confirmBtnNo = document.getElementById('confirm-btn-no');
            let confirmResolver = null;

            function showConfirmDialog(message, yesLabel, noLabel) {
                confirmText.textContent = message;
                setTextContent('lbl-confirm-yes', yesLabel || t('confirmYesLabel'));
                setTextContent('lbl-confirm-no', noLabel || t('confirmNoLabel'));
                confirmOverlay.classList.add('visible');
                return new Promise((resolve) => {
                    confirmResolver = resolve
                })
            }

            function closeConfirmDialog(result) {
                confirmOverlay.classList.remove('visible');
                if (confirmResolver) {
                    const resolve = confirmResolver;
                    confirmResolver = null;
                    resolve(result)
                }
            }
            confirmBtnYes.onclick = () => closeConfirmDialog(true);
            confirmBtnNo.onclick = () => closeConfirmDialog(false);
            confirmOverlay.addEventListener('click', (e) => {
                if (e.target.id === 'confirm-overlay') closeConfirmDialog(false)
            });
            const goWinnerName = document.getElementById('go-winner-name');
            const goNameWinner = document.getElementById('go-name-winner');
            const goNameLoser = document.getElementById('go-name-loser');
            const btnGoRepeat = document.getElementById('btn-go-repeat');
            const btnGoHome = document.getElementById('btn-go-home');

            // ================= ONLINE MULTIPLAYER (WebRTC via PeerJS, no game logic changed) =================
            const onlineModeSelectView = document.getElementById('online-mode-pick');
            const onlineChoiceView = document.getElementById('online-choice-view');
            const onlineCreateView = document.getElementById('online-create-view');
            const onlineJoinView = document.getElementById('online-join-view');
            const onlineSetupView = document.getElementById('online-setup-view');
            const onlineStatusText = document.getElementById('online-status-text');
            const onlineCodeBox = document.getElementById('online-code-box');
            const onlineJoinInput = document.getElementById('online-join-input');
            const onlineJoinStatus = document.getElementById('online-join-status');
            // Room-code field that now lives on the settings screen (next to
            // the timer picker) instead of its own separate "Join with code"
            // step — typing a code here and confirming connects directly.
            const onlineNameEntryCodeInput = document.getElementById('online-name-entry-code');
            if (onlineNameEntryCodeInput) {
                onlineNameEntryCodeInput.addEventListener('input', () => {
                    onlineNameEntryCodeInput.value = onlineNameEntryCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5)
                })
            }

            // ===== OTP-style room-code boxes: keep them in sync with the hidden #online-join-input =====
            const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));

            function otpSyncHiddenInput() {
                onlineJoinInput.value = otpBoxes.map(b => b.value).join('')
            }

            function otpClear() {
                otpBoxes.forEach(b => { b.value = ''; b.classList.remove('filled', 'otp-error') });
                otpSyncHiddenInput()
            }

            function otpShakeError() {
                otpBoxes.forEach(b => b.classList.add('otp-error'));
                setTimeout(() => otpBoxes.forEach(b => b.classList.remove('otp-error')), 340)
            }
            otpBoxes.forEach((box, idx) => {
                box.addEventListener('input', () => {
                    box.value = box.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(-1);
                    box.classList.toggle('filled', !!box.value);
                    otpSyncHiddenInput();
                    if (box.value && idx < otpBoxes.length - 1) otpBoxes[idx + 1].focus()
                });
                box.addEventListener('keydown', (e) => {
                    if (e.key === 'Backspace' && !box.value && idx > 0) {
                        otpBoxes[idx - 1].focus();
                        otpBoxes[idx - 1].value = '';
                        otpBoxes[idx - 1].classList.remove('filled');
                        otpSyncHiddenInput()
                    } else if (e.key === 'ArrowLeft' && idx > 0) {
                        otpBoxes[idx - 1].focus()
                    } else if (e.key === 'ArrowRight' && idx < otpBoxes.length - 1) {
                        otpBoxes[idx + 1].focus()
                    } else if (e.key === 'Enter') {
                        document.getElementById('btn-online-connect').click()
                    }
                });
                box.addEventListener('paste', (e) => {
                    e.preventDefault();
                    const text = (e.clipboardData || window.clipboardData).getData('text').toUpperCase().replace(/[^A-Z0-9]/g, '');
                    if (!text) return;
                    otpBoxes.forEach((b, i) => {
                        b.value = text[i] || '';
                        b.classList.toggle('filled', !!b.value)
                    });
                    otpSyncHiddenInput();
                    const nextEmpty = otpBoxes.find(b => !b.value);
                    (nextEmpty || otpBoxes[otpBoxes.length - 1]).focus()
                })
            });

            const onlineState = {
                active: !1,
                peer: null,
                conn: null,
                isHost: !1,
                localPlayerId: null,
                mode: '2p',
                applyingRemote: !1,
                peerLeft: !1,
                timerSeconds: 120,
                hunterRoleByPlayerId: null,
                // Per-sender message counter (see room.js/server.js) — for
                // each opponent slot, tracks the last `seq` we successfully
                // applied FROM THAT SLOT so a gap (a message from them we
                // never received) can be noticed and auto-corrected instead
                // of silently desyncing the two devices forever. Keyed by
                // sender slot rather than one shared room-wide counter,
                // because our own outgoing messages are never echoed back to
                // us — a single shared counter would "skip" every time we
                // sent something ourselves and falsely look like a missed
                // message from the opponent. Reset to {} whenever we
                // (re)connect, since a fresh connection restarts its own
                // baseline; the next inbound message from each slot
                // re-anchors that slot's baseline.
                lastSeqBySlot: {}
            };

            const onlineRematch = {
                requestedByMe: !1,
                requestedByOpponent: !1
            };

            // ===== Resume-after-reload (online) ================================
            // If the tab/browser is closed or refreshed mid-match, all JS state
            // is lost — but the *server* still holds this player's room slot
            // open (marked disconnected) for a while. We remember just enough
            // in localStorage to reconnect to that same room on the next visit,
            // then ask the opponent's still-live device for a full snapshot of
            // the board so we can drop the player back in exactly where the
            // match stands. If they decline, we notify the opponent right away
            // instead of making them sit through the 30s disconnect timer.
            const ONLINE_SESSION_KEY = 'barricade-active-online-session';
            const ONLINE_SESSION_MAX_AGE_MS = 90 * 60 * 1000; // 90 minutes

            function saveOnlineSession() {
                try {
                    const code = window.FBRoom && window.FBRoom._roomCode;
                    if (!code) return;
                    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify({
                        roomCode: code,
                        mode: onlineState.mode,
                        maxPlayers: onlineMaxPlayers(),
                        localPlayerId: onlineState.localPlayerId,
                        timerSeconds: onlineState.timerSeconds,
                        // Private per-slot reconnect token the server handed us
                        // when we first joined — resending it on resume is what
                        // guarantees we get back our OWN slot (see joinRoom in
                        // server.js), instead of just "whichever slot happens
                        // to be free", which could be the wrong one in 4-player
                        // mode, or even someone else's slot entirely.
                        token: (window.FBRoom && window.FBRoom._token) || null,
                        savedAt: Date.now()
                    }))
                } catch (e) {}
            }

            function clearOnlineSession() {
                try { localStorage.removeItem(ONLINE_SESSION_KEY) } catch (e) {}
            }

            function readOnlineSession() {
                try {
                    const raw = localStorage.getItem(ONLINE_SESSION_KEY);
                    if (!raw) return null;
                    const data = JSON.parse(raw);
                    if (!data || !data.roomCode) return null;
                    if (Date.now() - (data.savedAt || 0) > ONLINE_SESSION_MAX_AGE_MS) {
                        clearOnlineSession();
                        return null
                    }
                    return data
                } catch (e) { return null }
            }

            // Lobby (name/avatar — and, for Wolf & Sheep, role-pick) countdown
            // length. Wolf & Sheep gets longer since players also have to pick
            // a role in that window; other modes just set name/avatar.
            const ONLINE_LOBBY_SECONDS_DEFAULT = 18;
            const ONLINE_LOBBY_SECONDS_HUNTER = 27;

            function onlineLobbySecondsFor(mode) {
                return mode === 'hunter' ? ONLINE_LOBBY_SECONDS_HUNTER : ONLINE_LOBBY_SECONDS_DEFAULT
            }
            const onlineLobby = {
                me: { name: '', color: '#E74C3C' },
                othersById: {},
                mySlot: 'p1',
                timer: null,
                secondsLeft: ONLINE_LOBBY_SECONDS_DEFAULT,
                totalSeconds: ONLINE_LOBBY_SECONDS_DEFAULT,
                deadline: null
            };

            // Each player's chosen role during the Wolf & Sheep lobby window
            // ('escaper' | 'hunter' | null). `opp` arrives via the 'role-pick'
            // roomMessage from the other device.
            const onlineHunterPick = { me: null, opp: null };

            function resetOnlineHunterPick() {
                onlineHunterPick.me = null;
                onlineHunterPick.opp = null
            }

            // Deterministic 32-bit string hash (FNV-1a) used to derive a
            // shared "coin flip" for the role lottery: both devices hash the
            // exact same room code, so they land on the exact same result
            // independently, without needing an extra network round-trip.
            function hashStringToUnit(str) {
                let h = 2166136261;
                for (let i = 0; i < str.length; i++) {
                    h ^= str.charCodeAt(i);
                    h = Math.imul(h, 16777619)
                }
                h >>>= 0;
                return h / 4294967295
            }

            // Decides who plays Escaper and who plays Hunter for an online
            // Wolf & Sheep match, based on each player's lobby pick:
            // - If the two picks are different, each player gets the role
            //   they picked.
            // - If both picked the same role (or a pick is missing because a
            //   player didn't choose in time), it's a tie: both devices
            //   deterministically flip the same "coin" (see hashStringToUnit)
            //   and the result is revealed with the role-lottery animation.
            function resolveHunterRoles() {
                const myId = onlineState.localPlayerId;
                const oppId = myId === 0 ? 1 : 0;
                const mine = onlineHunterPick.me;
                const theirs = onlineHunterPick.opp;
                if (mine && theirs && mine !== theirs) {
                    const escaperId = mine === 'escaper' ? myId : oppId;
                    const hunterId = escaperId === myId ? oppId : myId;
                    return { escaperId, hunterId, needsLottery: !1 }
                }
                const seed = ((window.FBRoom && window.FBRoom._roomCode) || 'route9') + '-hunter-roles';
                const escaperId = hashStringToUnit(seed) < 0.5 ? 0 : 1;
                const hunterId = escaperId === 0 ? 1 : 0;
                return { escaperId, hunterId, needsLottery: !0 }
            }

            function genRoomCode() {
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
                let s = '';
                for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
                return s
            }

            function sendOnline(data) {
                if (window.FBRoom && window.FBRoom._roomCode) {
                    window.FBRoom.send(data)
                }
            }

            function resetOnlineSetupUI() {
                onlineModeSelectView.style.display = 'none';
                onlineChoiceView.style.display = 'flex';
                onlineCreateView.style.display = 'none';
                onlineJoinView.style.display = 'none';
                onlineJoinView.classList.remove('autoconnecting');
                otpClear();
                onlineJoinStatus.textContent = ''
            }

            // Back out of the create/join waiting screens to the settings
            // screen (timer + room-code field), so the player can fix the
            // code or change the timer and try again — this replaces the
            // old "back to the create/join picker" behavior, since that
            // in-between picker screen is no longer part of the flow.
            function backToOnlineSettings() {
                showStartScreen('name-entry-view')
            }

            function teardownOnline(notifyPeer) {
                clearOnlineSession();
                if (notifyPeer) sendOnline({ type: 'leave' });
                if (window.FBRoom) { try { window.FBRoom.leaveRoom() } catch (e) {} }
                onlineState.active = !1;
                onlineState.peer = null;
                onlineState.conn = null;
                onlineState.localPlayerId = null;
                onlineState.peerLeft = !1;
                onlineRematch.requestedByMe = !1;
                onlineRematch.requestedByOpponent = !1;
                onlineState.hunterRoleByPlayerId = null;
                resetOnlineHunterPick();
                clearAllDisconnectCountdowns();
                if (onlineLobby.timer) { clearInterval(onlineLobby.timer); onlineLobby.timer = null }
                stopTurnTimer();
                turnTimerPlayerId = null;
                onlineMsgQueue = [];
                onlineState.lastSeqBySlot = {};
                const lobbyView = document.getElementById('online-lobby-view');
                if (lobbyView) lobbyView.style.display = 'none';
                const revealOverlay = document.getElementById('hunter-role-reveal-overlay');
                if (revealOverlay) revealOverlay.classList.remove('visible');
                hideTurnBanner()
            }

            function isMyOnlineTurn() {
                if (!onlineState.active) return !0;
                const p = currentPlayer();
                return !!p && p.id === onlineState.localPlayerId
            }

            // ===== Online-only board perspective: always show *my* pawn starting
            // at the bottom of *my own* screen, regardless of which side I was
            // actually assigned. Purely visual (CSS rotate of the canvas +
            // inverted input mapping) — does not touch row/col game state, the
            // network protocol, or any rule/logic. Offline modes are untouched.
            function isBoardFlippedForMe() {
                if (!onlineState.active) return !1;
                const me = players.find(p => p.id === onlineState.localPlayerId);
                return !!me && me.target === 'row8'
            }

            function updateBoardOrientation() {
                canvas.classList.toggle('board-flipped', isBoardFlippedForMe())
            }

            // Every top-level screen inside #start-overlay. Whenever the UI
            // moves to a screen, route it through showStartScreen() so all
            // the others are force-hidden — this guarantees two screens can
            // never end up visible side-by-side (the flex layout in
            // #start-overlay lays out any visible siblings next to each
            // other), no matter which button/path got us here.
            const ALL_START_SCREENS = ['mode-select-view', 'offline-mode-pick-view', 'online-setup-view', 'name-entry-view', 'online-lobby-view'];
            function showStartScreen(id) {
                ALL_START_SCREENS.forEach(sid => {
                    const el = document.getElementById(sid);
                    if (el) el.style.display = (sid === id) ? 'block' : 'none'
                })
            }

            document.getElementById('btn-home-online').onclick = () => {
                onlineEntryFromNameEntry = false;
                nameEntryOrigin = 'online';
                showStartScreen('online-setup-view');
                resetOnlineSetupUI()
            };
            document.getElementById('btn-home-offline').onclick = () => {
                showStartScreen('offline-mode-pick-view')
            };
            document.getElementById('btn-offline-pick-back').onclick = () => {
                showStartScreen('mode-select-view')
            };
            // "Create Room" card -> one screen with mode buttons + timer,
            // all in the same view. Mode can be switched right here without
            // leaving the screen; the room is only actually created when
            // the Create Room button (btn-name-confirm) is pressed.
            function selectOnlineCreateMode(mode) {
                onlineState.mode = mode;
                selectedMode = mode;
                document.querySelectorAll('#online-create-mode-pick .online-mode-chip').forEach(b => b.classList.remove('active'));
                const btnId = mode === '4p' ? 'btn-online-pick-4p' : (mode === 'hunter' ? 'btn-online-pick-hunter' : 'btn-online-pick-2p');
                const btn = document.getElementById(btnId);
                if (btn) btn.classList.add('active')
            }
            function showOnlineCreateSetup() {
                onlineChoiceView.style.display = 'none';
                onlineSetupView.style.display = 'none';
                nameEntryOrigin = 'online';
                showNameEntry(onlineState.mode || '2p', !1);
                setGameType(!0);
                document.getElementById('online-create-mode-pick').style.display = 'grid';
                document.getElementById('online-code-entry-wrap').style.display = 'none';
                selectOnlineCreateMode(onlineState.mode || '2p');
                setTextContent('name-entry-title', t('onlineCreateTitle'));
                setTextContent('btn-name-confirm', t('createRoomBtn'))
            }
            document.getElementById('btn-online-pick-2p').onclick = () => selectOnlineCreateMode('2p');
            document.getElementById('btn-online-pick-4p').onclick = () => selectOnlineCreateMode('4p');
            document.getElementById('btn-online-pick-hunter').onclick = () => selectOnlineCreateMode('hunter');
            document.getElementById('btn-online-back1').onclick = () => {
                if (onlineEntryFromNameEntry) {
                    onlineEntryFromNameEntry = false;
                    showStartScreen('name-entry-view')
                } else {
                    showStartScreen('mode-select-view')
                }
                resetOnlineSetupUI()
            };

            const networkHintMsg = 'Could not connect. Please check your internet connection and try again.';

            function attachRoomMessageListener() {
                window.FBRoom.onMessage((data, from, seq) => {
                    if (!data) return;
                    // `from` is the server-verified true sender slot (never
                    // spoofable from the payload itself) — stash it so
                    // processOnlineMessage() can trust it over any
                    // self-declared id inside the payload (see there).
                    data.__from = from;
                    if (typeof seq === 'number' && typeof from === 'number') {
                        // Gap check is per SENDER SLOT — see the
                        // lastSeqBySlot comment on onlineState. Comparing
                        // against a single shared counter here (the old
                        // behavior) meant our own outgoing messages, which
                        // never loop back to us, made the very next message
                        // we received from the opponent falsely look like a
                        // gap almost every time.
                        const lastFromThem = onlineState.lastSeqBySlot[from];
                        if (lastFromThem != null && seq > lastFromThem + 1 && !awaitingStateSync) {
                            // We missed at least one message in between — don't
                            // apply this one on top of an unknown gap, ask for a
                            // fresh full snapshot instead of risking a silent,
                            // permanent desync between the two devices.
                            onlineState.lastSeqBySlot[from] = seq;
                            requestLiveResync();
                            return
                        }
                        onlineState.lastSeqBySlot[from] = seq
                    }
                    handleOnlineData(data)
                });
                // Server-side fallback answer to our own 'request-state' when
                // the opponent isn't actually online to answer it themselves
                // (e.g. both devices reloaded around the same time).
                window.FBRoom.onStateFallback((state) => {
                    if (!awaitingStateSync) return;
                    handleStateSyncMessage({ state })
                })
            }

            // Mid-match auto-resync: reuses the exact same request-state /
            // state-sync machinery the reconnect-after-reload flow already
            // has, but triggered live (without the resume overlay) whenever
            // we detect we might have drifted out of sync with the opponent —
            // either a missed message (see above) or a move/wall that arrived
            // but failed local validation, which previously was just silently
            // dropped forever with no way to recover except a manual reload.
            let liveResyncCooldownUntil = 0;
            function requestLiveResync() {
                if (!onlineState.active || awaitingStateSync) return;
                const now = Date.now();
                if (now < liveResyncCooldownUntil) return; // avoid resync storms from several near-simultaneous gaps
                liveResyncCooldownUntil = now + 6000;
                awaitingStateSync = !0;
                showToast("Reconnecting the board with your opponent…", 'warning');
                sendOnline({ type: 'request-state' });
                stateSyncTimeoutId = setTimeout(() => {
                    if (!awaitingStateSync) return;
                    awaitingStateSync = !1;
                    showToast("Couldn't resync automatically — reload if the board looks off.", 'error')
                }, 9000)
            }

            // Small, throttle-free helper: pushes our current full board state
            // to the server's per-room cache so a reconnecting opponent can be
            // served state even if we're the only device that was ever online
            // to report it. Safe to call often — the snapshot is small (two
            // 9x9 boolean grids + a handful of player fields).
            function sendOnlineCheckpoint() {
                if (!onlineState.active || !window.FBRoom) return;
                try { window.FBRoom.checkpoint(buildFullGameStateSnapshot()) } catch (e) {}
            }

            function attachRoomPresenceListener(maxPlayers) {
                window.FBRoom.onPresence(maxPlayers, (playersObj) => {
                    onOnlinePresenceChange(playersObj)
                })
            }

            function onlineMaxPlayers() {
                return onlineState.mode === '4p' ? 4 : 2
            }

            // Create-room flow, now reached directly from the settings screen
            // (name-entry-view) when the room-code field was left empty —
            // the separate "Create room" card/screen is no longer a required
            // step in between.
            async function startOnlineCreateFlow() {
                onlineChoiceView.style.display = 'none';
                onlineCreateView.style.display = 'flex';
                onlineCodeBox.textContent = '...';
                onlineStatusText.textContent = 'Setting up room...';
                onlineState.isHost = !0;
                onlineState._startSent = !1;
                const maxP = onlineMaxPlayers();
                try {
                    const code = await window.FBRoom.createRoom(maxP, onlineState.mode);
                    const slot = await window.FBRoom.joinRoom(code, maxP);
                    onlineState.localPlayerId = slot;
                    onlineCodeBox.textContent = code;
                    onlineStatusText.textContent = maxP === 2 ?
                        'Waiting for opponent to join...' :
                        'Waiting for players to join...';
                    attachRoomMessageListener();
                    attachRoomPresenceListener(maxP);
                    window.FBRoom.onPresence(maxP, (playersObj) => {
                        if (onlineState.active) return;
                        const others = [];
                        for (let i = 0; i < maxP; i++) if (i !== slot) others.push(i);
                        const allJoined = playersObj && others.every(i => playersObj[i] && playersObj[i].connected);
                        if (allJoined && !onlineState._startSent) {
                            onlineState._startSent = !0;
                            onlineStatusText.textContent = maxP === 2 ?
                                'Opponent connected!' :
                                'Everyone connected!';
                            sendOnline({ type: 'start', mode: onlineState.mode, timerSeconds: onlineState.timerSeconds });
                            beginOnlineGame(onlineState.mode)
                        }
                    })
                } catch (e) {
                    onlineStatusText.textContent = networkHintMsg + '\n[debug: ' + (e && (e.code || e.message) || e) + ']'
                }
            }
            document.getElementById('btn-online-create').onclick = showOnlineCreateSetup;
            document.getElementById('btn-online-copy-code').onclick = () => {
                const code = onlineCodeBox.textContent;
                if (code && navigator.clipboard) {
                    navigator.clipboard.writeText(code).then(() => {
                        showToast('Code copied', 'success');
                        const btn = document.getElementById('btn-online-copy-code');
                        btn.classList.add('copied');
                        setTimeout(() => btn.classList.remove('copied'), 1400)
                    }).catch(() => {})
                }
            };
            document.getElementById('btn-online-cancel-create').onclick = () => {
                teardownOnline(!1);
                onlineCreateView.style.display = 'none';
                backToOnlineSettings()
            };
            document.getElementById('btn-online-join').onclick = () => {
                onlineChoiceView.style.display = 'none';
                onlineJoinView.style.display = 'flex';
                onlineJoinView.classList.remove('autoconnecting');
                otpClear();
                setTimeout(() => otpBoxes[0] && otpBoxes[0].focus(), 60)
            };
            document.getElementById('btn-online-cancel-join').onclick = () => {
                teardownOnline(!1);
                onlineJoinView.style.display = 'none';
                onlineJoinView.classList.remove('autoconnecting');
                onlineChoiceView.style.display = 'flex'
            };
            // Join-room flow. `code` normally comes straight from the
            // room-code field on the settings screen; `fromOtp` is used by
            // the (now-fallback) manual OTP boxes so their own error-shake
            // still works if that path is ever reached.
            async function startOnlineJoinFlow(code, fromOtp) {
                onlineState.isHost = !1;
                onlineJoinStatus.textContent = 'Connecting...';
                const maxP = onlineMaxPlayers();
                try {
                    const exists = await window.FBRoom.roomExists(code);
                    if (!exists) {
                        onlineJoinStatus.textContent = 'No room found with this code';
                        if (fromOtp) otpShakeError();
                        return
                    }
                    const slot = await window.FBRoom.joinRoom(code, maxP);
                    if (slot === null) {
                        onlineJoinStatus.textContent = 'This room is full';
                        if (fromOtp) otpShakeError();
                        return
                    }
                    // BUGFIX (mode mismatch between host & joiner): the room's
                    // real mode (2p/4p/hunter) now comes straight from the
                    // server's join response — the same place maxPlayers has
                    // always come from — instead of relying only on the
                    // 'start' broadcast that arrives later. Previously the
                    // joiner kept onlineState.mode at its local default
                    // ('2p') until 'start' showed up, so if that message was
                    // delayed or arrived after this device had already begun
                    // rendering the lobby, the two sides could show two
                    // different modes (one Wolf & Sheep, one 2-player) for
                    // the exact same room. Setting it here, right away, from
                    // the server-authoritative value removes that race
                    // entirely; the later 'start' message just reconfirms it.
                    if (window.FBRoom._roomMode) {
                        onlineState.mode = window.FBRoom._roomMode
                    }
                    onlineState.localPlayerId = slot;
                    onlineJoinStatus.textContent = 'Connected! Waiting for the game to start...';
                    attachRoomMessageListener();
                    // Recompute from the now-corrected mode (matters for a
                    // 4-player room, where the initial guess above could
                    // otherwise still watch only 2 seats).
                    attachRoomPresenceListener(onlineMaxPlayers())
                } catch (e) {
                    onlineJoinStatus.textContent = networkHintMsg + '\n[debug: ' + (e && (e.code || e.message) || e) + ']'
                }
            }
            document.getElementById('btn-online-connect').onclick = () => {
                const raw = onlineJoinInput.value.trim().toUpperCase();
                if (raw.length < 5) { otpShakeError(); return }
                onlineChoiceView.style.display = 'none';
                onlineJoinView.style.display = 'flex';
                startOnlineJoinFlow(raw, !0)
            };

            // ===== Reconnect grace period ===================================
            // When a player's connection drops mid-game, they get a 30s
            // window to come back before being declared the loser. Keyed by
            // player id so it naturally supports both 1v1/Wolf&Sheep (one
            // possible disconnect at a time) and 4-player (up to three).
            // A fresh disconnect after a successful reconnect always starts
            // a brand new 30s countdown — nothing here persists remaining
            // time across a reconnect.
            const DISCONNECT_GRACE_SECONDS = 30;
            const onlineDisconnectTimers = {}; // playerId -> { remaining, intervalId }

            function formatGraceTime(secs) {
                const m = Math.floor(secs / 60);
                const s = secs % 60;
                return m > 0 ? (m + ':' + String(s).padStart(2, '0')) : String(s)
            }

            // Instead of one shared floating banner, each disconnected
            // player's own card grows its "Disconnected" overlay in place
            // (with a live grace-period countdown). A card can be rendered
            // more than once (e.g. the mobile team layout duplicates it),
            // so every matching .player-card gets updated, not just one.
            function updateDisconnectOverlays() {
                document.querySelectorAll('.player-card[data-player-id]').forEach(card => {
                    const overlay = card.querySelector('.disconnect-overlay');
                    if (!overlay) return;
                    const timer = onlineState.active ? onlineDisconnectTimers[card.dataset.playerId] : null;
                    if (!timer) {
                        overlay.classList.remove('show');
                        card.classList.remove('card-disconnected');
                        return
                    }
                    const timeEl = overlay.querySelector('.do-timer');
                    if (timeEl) timeEl.textContent = formatGraceTime(Math.max(0, timer.remaining));
                    overlay.classList.add('show');
                    // Force this specific card to full opacity even if it's
                    // not the currently-active player — the overlay needs
                    // to read clearly regardless of turn state.
                    card.classList.add('card-disconnected')
                })
            }

            function clearDisconnectCountdown(playerId) {
                const timer = onlineDisconnectTimers[playerId];
                if (!timer) return;
                clearInterval(timer.intervalId);
                delete onlineDisconnectTimers[playerId];
                updateDisconnectOverlays()
            }

            function clearAllDisconnectCountdowns() {
                Object.keys(onlineDisconnectTimers).forEach(id => clearInterval(onlineDisconnectTimers[id].intervalId));
                for (const id in onlineDisconnectTimers) delete onlineDisconnectTimers[id];
                updateDisconnectOverlays()
            }

            // True while at least one seat is mid-grace-period. Used to pause
            // the shared match clock and block new moves for EVERYONE — not
            // just the disconnected player — until every pending disconnect
            // has cleared (covers 4-player, where more than one seat can be
            // out at once).
            function anyDisconnectPending() {
                return Object.keys(onlineDisconnectTimers).length > 0
            }

            // Called once the 30s grace period actually runs out without the
            // player reconnecting — declares them the loser without touching
            // any other online-state handling (rematch, teardown, etc. all
            // continue to work exactly as they do for a normal resign).
            function handleDisconnectTimeout(player) {
                if (gameOver || player.finished) return;
                showToast(fmt(t('disconnectTimeoutToast'), { name: playerDisplayName(player) }), 'error');
                if (gameMode === '4p') {
                    performForfeit4p(player);
                    return
                }
                onlineState.peerLeft = !0;
                gameOver = !0;
                pendingWallPos = null;
                wallPreviewPos = null;
                hideWallConfirm();
                updateActivePlayerUI();
                draw();
                const winner = players.find(p => p.id !== player.id);
                setTimeout(() => showGameOverDialog(winner, player), 50)
            }

            function startDisconnectCountdown(player) {
                if (gameOver || player.forfeited || player.finished) return;
                if (onlineDisconnectTimers[player.id]) return; // already counting down
                // No toast here on purpose — the disconnected player's own
                // card overlay (with its live countdown) is the single,
                // sole notice for this; a toast would just repeat it.
                const timer = { remaining: DISCONNECT_GRACE_SECONDS, intervalId: null };
                onlineDisconnectTimers[player.id] = timer;
                updateDisconnectOverlays();
                // The instant ANYONE disconnects — regardless of whose turn
                // it currently is — we freeze the shared match clock (just
                // stop the interval; timeBank numbers are left untouched) so
                // no one's remaining time drains away while we wait to see
                // if they reconnect. turnTimerPlayerId is deliberately left
                // alone so the clock resumes from exactly the same point
                // once every pending disconnect clears, instead of resetting.
                if (timerIsEnabled()) stopTurnTimer();
                timer.intervalId = setInterval(() => {
                    timer.remaining -= 1;
                    if (timer.remaining <= 0) {
                        clearInterval(timer.intervalId);
                        delete onlineDisconnectTimers[player.id];
                        updateDisconnectOverlays();
                        handleDisconnectTimeout(player);
                        return
                    }
                    updateDisconnectOverlays()
                }, 1000)
            }

            // True only during the post-join, pre-game "set your name and
            // avatar" lobby countdown (see showOnlineLobby/tickOnlineLobbyCountdown).
            // onlineLobby.timer is set the instant that countdown starts and
            // cleared the instant it finishes (or the online session is torn
            // down) — so it doubles as a cheap "are we still in the lobby"
            // check without needing a separate flag.
            function inOnlineLobbyPhase() {
                return !!onlineLobby.timer
            }

            function onOnlinePresenceChange(playersObj) {
                if (!onlineState.active) return;
                const maxP = onlineMaxPlayers();
                // If someone bails while we're still sitting in the lobby
                // countdown (before the match itself has even started),
                // there's no "player" object yet for them and no in-game
                // grace period makes sense — waiting out the rest of the
                // countdown would just dump the remaining player(s) into a
                // game with a permanently empty seat. Cancel the room right
                // here instead.
                if (inOnlineLobbyPhase()) {
                    for (let i = 0; i < maxP; i++) {
                        if (i === onlineState.localPlayerId) continue;
                        const other = playersObj && playersObj[i];
                        const isConnected = !other || other.connected !== !1;
                        if (!isConnected) {
                            teardownOnline(!1);
                            showStartScreen('mode-select-view');
                            startOverlay.style.display = 'flex';
                            appEl.classList.remove('visible');
                            showToast('Opponent left — room cancelled', 'warning');
                            return
                        }
                    }
                    return
                }
                for (let i = 0; i < maxP; i++) {
                    if (i === onlineState.localPlayerId) continue;
                    const p = players.find(pl => pl.id === i);
                    const other = playersObj && playersObj[i];
                    if (!p) continue;
                    const isConnected = !other || other.connected !== !1;
                    if (isConnected) {
                        if (onlineDisconnectTimers[p.id]) {
                            // Came back before the countdown ran out — clear
                            // it and carry on as if nothing happened.
                            clearDisconnectCountdown(p.id);
                            showToast(fmt(t('disconnectReconnectedToast'), { name: playerDisplayName(p) }), 'success');
                            // Only resume the shared clock once EVERY pending
                            // disconnect has cleared (relevant in 4-player,
                            // where a second seat could still be out) —
                            // startTurnTimer() picks the still-frozen bank
                            // back up right where it left off.
                            if (!anyDisconnectPending() && timerIsEnabled() && !gameOver) {
                                startTurnTimer()
                            }
                        }
                        continue
                    }
                    // Disconnected.
                    if (gameOver) {
                        // Match already decided (e.g. still on the game-over
                        // screen) — no countdown needed, just reflect it in
                        // the dialog like before.
                        if (!onlineState.peerLeft) {
                            onlineState.peerLeft = !0;
                            showToast('Opponent left the game', 'warning');
                            refreshGameOverDialogOnlineState()
                        }
                        continue
                    }
                    if (p.forfeited || p.finished) continue;
                    startDisconnectCountdown(p)
                }
            }

            function fmt2(str, name) {
                return str.replace('{name}', name)
            }

            function beginOnlineGame(mode) {
                onlineState.active = !0;
                onlineState.mode = mode;
                onlineState.peerLeft = !1;
                onlineState.lastSeqBySlot = {};
                clearAllDisconnectCountdowns();
                currentTurnTimerSeconds = onlineState.timerSeconds || DEFAULT_TIMER_SECONDS;
                document.getElementById('name-entry-view').style.display = 'none';
                onlineSetupView.style.display = 'none';
                showOnlineLobby(mode)
            }

            // BUGFIX (turn/timer desync in online play): incoming network
            // messages used to be applied the instant they arrived, even if
            // *our own* move/capture animation was still playing (isAnimating
            // === true). Two different failures came from that:
            //  1) executeMove()/confirmWall() both bail out immediately when
            //     isAnimating is true — so a 'move' or 'wall' that arrived
            //     mid-animation was silently DROPPED forever, permanently
            //     desyncing the two devices' board/turn state (each side then
            //     shows a different, stuck "whose turn" highlight).
            //  2) 'timer-sync' was applied with no such guard at all. If it
            //     arrived before our own animation finished calling
            //     advanceTurn() locally, it overwrote turnTimerPlayerId to
            //     the *next* player while `turn` here still pointed at the
            //     *current* one — so the still-running interval kept ticking
            //     the wrong player's time bank down using the new deadline,
            //     and then, once our own advanceTurn() finally did fire, the
            //     turn-changed check in syncTurnTimer() found turnTimerPlayerId
            //     already "matching" (by coincidence) and skipped starting a
            //     fresh timer for the player actually now on turn — which is
            //     exactly the "active player's clock is frozen, the other
            //     player's clock is draining" symptom.
            // Fix: queue any message that arrives while isAnimating is true
            // and replay the queue, in arrival order, only once our local
            // animation/turn state has caught up.
            let onlineMsgQueue = [];
            // True on a reconnecting device between sending 'request-state' and
            // receiving 'state-sync' back — every other incoming message is
            // queued during that window since we have no board to apply it to
            // yet (see handleOnlineData / drainOnlineMsgQueue).
            let awaitingStateSync = !1;

            function handleOnlineData(data) {
                if (!data || !data.type) return;
                if (data.type === 'request-state') { respondWithStateSync(); return }
                if (data.type === 'state-sync') { handleStateSyncMessage(data); return }
                if (data.type === 'start') {
                    onlineState.timerSeconds = data.timerSeconds || DEFAULT_TIMER_SECONDS;
                    beginOnlineGame(data.mode);
                    return
                }
                if (isAnimating || awaitingStateSync) {
                    onlineMsgQueue.push(data);
                    return
                }
                processOnlineMessage(data)
            }

            // Builds a complete, self-contained snapshot of the live match so a
            // reconnecting opponent's device (which has zero local state after
            // a reload) can rebuild the exact same board, turn, timers and
            // history. Only ever sent by the device that's still actively in
            // the game (never by the one that's mid-reconnect itself).
            function buildFullGameStateSnapshot() {
                return {
                    gameMode: gameMode,
                    turnOrder: turnOrder.slice(),
                    turn: turn,
                    turnIndex: turnIndex,
                    gameOver: gameOver,
                    huntProximity: huntProximity,
                    hWalls: hWalls.map(row => row.slice()),
                    vWalls: vWalls.map(row => row.slice()),
                    players: players.map(p => ({ ...p })),
                    history: history.slice(),
                    currentTurnTimerSeconds: currentTurnTimerSeconds,
                    onlineMode: onlineState.mode,
                    onlineTimerSeconds: onlineState.timerSeconds,
                    hunterRoleByPlayerId: onlineState.hunterRoleByPlayerId
                }
            }

            function respondWithStateSync() {
                if (!onlineState.active) return; // nothing to share
                sendOnline({ type: 'state-sync', state: buildFullGameStateSnapshot() })
            }

            // Rebuilds every piece of client-side state a fresh page load lost,
            // then reveals the board exactly like completeOnlineLobbyStart()
            // does at the end of the normal online-lobby flow.
            function applyFullGameStateSnapshot(state) {
                gameMode = state.gameMode;
                turnOrder = state.turnOrder.slice();
                turn = state.turn;
                turnIndex = state.turnIndex;
                gameOver = !1;
                huntProximity = state.huntProximity || 0;
                hWalls = state.hWalls.map(row => row.slice());
                vWalls = state.vWalls.map(row => row.slice());
                players = state.players.map(p => ({ ...p }));
                history = state.history ? state.history.slice() : [];
                undoStack = [];
                currentPage = 0;
                uiMode = 'move';
                isAnimating = !1;
                animData = null;
                wallAnimation = null;
                captureAnim = null;
                pendingWallPos = null;
                wallPreviewPos = null;
                onlineMsgQueue = [];
                currentTurnTimerSeconds = state.currentTurnTimerSeconds;
                onlineState.mode = state.onlineMode;
                onlineState.timerSeconds = state.onlineTimerSeconds;
                onlineState.hunterRoleByPlayerId = state.hunterRoleByPlayerId;
                onlineState.active = !0;
                onlineState.peerLeft = !1;

                // Rebuild the lobby identity bookkeeping (names/colors) so the
                // topbar and player cards render correctly without having gone
                // through the actual online lobby on this device.
                onlineLobby.mySlot = slotNameForId(gameMode, onlineState.localPlayerId);
                const me = players.find(p => p.id === onlineState.localPlayerId);
                onlineLobby.me = {
                    name: (me && me.customName) || '',
                    color: (me && me.color) || customColor(onlineLobby.mySlot)
                };
                onlineLobby.othersById = {};
                players.forEach(p => {
                    if (p.id !== onlineState.localPlayerId) {
                        onlineLobby.othersById[p.id] = { name: p.customName || '', color: p.color }
                    }
                });

                hideWallConfirm();
                infoMode.textContent = gameMode === '2p' ? t('mode2p') : (gameMode === '4p' ? t('mode4p') : t('modeHunter'));
                infoObjective.innerHTML = (gameMode === '2p' ? t('objective2p') : (gameMode === '4p' ? t('objective4p') : t(
                    'objectiveHunter'))).replace(/\n/g, '<br>');
                const wallsTextEl = document.getElementById('info-walls-text');
                if (gameMode === 'hunter') wallsTextEl.innerHTML = t('wallsTextHunter');
                else if (gameMode === '4p') wallsTextEl.innerHTML = t('wallsText4p');
                else wallsTextEl.innerHTML = t('wallsText');
                renderTopbar();
                updateBtnState();
                updateScores();
                updateActivePlayerUI();
                updateHistory();
                updateBoardOrientation();
                updateProximityUI();
                draw();

                startOverlay.style.display = 'none';
                appEl.classList.add('visible');
                setThemeColor('#000000');
                btnHome.style.display = 'none';
                btnUndo.style.display = 'none';
                btnRepeat.style.display = 'none';
                const topCtrls = document.getElementById('top-controls');
                if (topCtrls) topCtrls.style.display = 'none';
                const soundBtnHeader = document.getElementById('btn-sound-board');
                if (soundBtnHeader) soundBtnHeader.classList.add('visible');

                clearAllDisconnectCountdowns();
                // Re-anchor the shared turn clock from our restored timeBank
                // values — syncTurnTimer() picks up from here exactly like it
                // does after any normal turn change.
                turnTimerPlayerId = null;
                syncTurnTimer();
                sfxGameStart();
                saveOnlineSession();
                // Fresh connection/resync — the next inbound message from
                // each sender re-anchors that sender's seq baseline instead
                // of being compared against a counter from before the gap.
                onlineState.lastSeqBySlot = {};
                // Re-report our just-restored state so the server's cache is
                // warm again in case we're the one who ends up needing to
                // answer a future 'request-state' fallback.
                sendOnlineCheckpoint()
            }

            function handleStateSyncMessage(data) {
                if (!awaitingStateSync) return; // stray/late reply, already handled
                awaitingStateSync = !1;
                if (stateSyncTimeoutId) { clearTimeout(stateSyncTimeoutId); stateSyncTimeoutId = null }
                const state = data && data.state;
                if (!state) {
                    showResumeStatus("Sync failed — please try again.");
                    setResumeButtonsEnabled(!0);
                    return
                }
                if (state.gameOver) {
                    // The match was already decided while we were away (the
                    // opponent's 30s grace timer ran out on their device).
                    // Nothing to resume — send this device home cleanly.
                    closeResumeOverlay();
                    clearOnlineSession();
                    pendingResumeSession = null;
                    teardownOnline(!1);
                    showStartScreen('mode-select-view');
                    startOverlay.style.display = 'flex';
                    appEl.classList.remove('visible');
                    showToast('That match already ended while you were away.', 'warning');
                    return
                }
                applyFullGameStateSnapshot(state);
                closeResumeOverlay();
                pendingResumeSession = null;
                showToast("You're back! Continue the match.", 'success');
                drainOnlineMsgQueue()
            }

            function processOnlineMessage(data) {
                onlineState.applyingRemote = !0;
                try {
                    // `data.__from` is the server-verified true sender slot
                    // (see attachRoomMessageListener) — for any message that
                    // claims to act "as" a particular player, this is trusted
                    // over any self-declared id/playerId field in the payload
                    // itself, since that field is just whatever the sender's
                    // client chose to put there. Without this, a modified
                    // client could e.g. send {type:'forfeit', playerId:<someone
                    // else's id>} and force a different player's forfeit in
                    // 4-player mode, or send a 'move' that gets misattributed
                    // to whichever player we locally think is on turn.
                    const trueFrom = (typeof data.__from === 'number') ? data.__from : undefined;
                    if (data.type === 'move') {
                        if (trueFrom !== undefined && (!currentPlayer() || trueFrom !== currentPlayer().id)) {
                            requestLiveResync()
                        } else if (!executeMove(data.row, data.col)) {
                            requestLiveResync()
                        }
                    } else if (data.type === 'wall') {
                        if (trueFrom !== undefined && (!currentPlayer() || trueFrom !== currentPlayer().id)) {
                            requestLiveResync()
                        } else {
                            pendingWallPos = { row: data.row, col: data.col, mode: data.mode };
                            if (!confirmWall()) requestLiveResync()
                        }
                    } else if (data.type === 'resign') {
                        const targetId = trueFrom !== undefined ? trueFrom : data.playerId;
                        const resignedPlayer = (targetId !== undefined) ? players.find(p => p.id === targetId) : null;
                        performResign(resignedPlayer || currentPlayer())
                    } else if (data.type === 'forfeit') {
                        const targetId = trueFrom !== undefined ? trueFrom : data.playerId;
                        const p = players.find(p => p.id === targetId);
                        if (p && !p.forfeited) performForfeit4p(p)
                    } else if (data.type === 'rematch-request') {
                        if (onlineRematch.requestedByMe) {
                            onlineRematch.requestedByMe = !1;
                            onlineRematch.requestedByOpponent = !1;
                            restartSameGame()
                        } else {
                            onlineRematch.requestedByOpponent = !0;
                            refreshGameOverDialogOnlineState();
                            showToast(t('toastRematchRequested'), 'info')
                        }
                    } else if (data.type === 'rematch-accept') {
                        onlineRematch.requestedByMe = !1;
                        onlineRematch.requestedByOpponent = !1;
                        restartSameGame()
                    } else if (data.type === 'profile') {
                        const pid = trueFrom !== undefined ? trueFrom : ((data.id !== undefined) ? data.id : (onlineState.localPlayerId === 0 ? 1 : 0));
                        onlineLobby.othersById[pid] = { name: (data.name || '').slice(0, 13), color: data.color || customColor(slotNameForId(onlineState.mode, pid)) };
                        updateOnlineOppUI()
                    } else if (data.type === 'role-pick') {
                        onlineHunterPick.opp = data.role;
                        updateHunterPickUI(onlineState.mode)
                    } else if (data.type === 'timer-sync') {
                        // Authoritative deadline from whichever device's player
                        // just started their turn — replaces our own
                        // provisional estimate so both devices count down from
                        // the exact same real-world instant, regardless of the
                        // network delay it took this message to arrive.
                        // Security: a 'timer-sync' is only ever legitimately
                        // sent about the sender's OWN turn (see startTurnTimer,
                        // which only sends it when isMyOnlineTurn()) — so a
                        // message whose declared playerId doesn't match the
                        // server-verified true sender is forged. Ignore it
                        // rather than let a modified client manipulate the
                        // other player's clock (make it appear to run out
                        // early, or grant itself extra thinking time).
                        // Guard: only apply it once our own `turn` has already
                        // moved on to that same player. If it hasn't yet (this
                        // message raced ahead of our local advanceTurn), queue
                        // it instead of stomping on the currently-running
                        // player's deadline.
                        if (trueFrom !== undefined && data.playerId !== trueFrom) {
                            // forged/inconsistent sender — drop it
                        } else if (!currentPlayer() || currentPlayer().id !== data.playerId) {
                            onlineMsgQueue.push(data)
                        } else {
                            turnTimerPlayerId = data.playerId;
                            turnTimerDeadline = data.deadline;
                            stopTurnTimer();
                            turnTimerInterval = setInterval(tickTurnTimer, 250);
                            renderAllPlayerClocks()
                        }
                    }
                } finally {
                    onlineState.applyingRemote = !1
                }
            }

            // Replays one queued message once we're free to process it again.
            // Only one per call — processing a queued 'move'/'wall' can itself
            // kick off a new animation, and its own completion will call this
            // again, so the queue drains naturally in the original arrival
            // order without deep recursion.
            function drainOnlineMsgQueue() {
                if (isAnimating || !onlineState.active || awaitingStateSync) return;
                if (!onlineMsgQueue.length) return;
                const next = onlineMsgQueue.shift();
                processOnlineMessage(next)
            }

            // ===== Resume-after-reload dialog wiring ============================
            let pendingResumeSession = null;
            let stateSyncTimeoutId = null;

            function showResumeStatus(msg) {
                const el = document.getElementById('resume-status');
                if (!el) return;
                el.textContent = msg || '';
                el.classList.toggle('visible', !!msg)
            }

            function setResumeButtonsEnabled(enabled) {
                const yes = document.getElementById('btn-resume-yes');
                const no = document.getElementById('btn-resume-no');
                if (yes) yes.disabled = !enabled;
                if (no) no.disabled = !enabled
            }

            function closeResumeOverlay() {
                const overlay = document.getElementById('resume-game-overlay');
                if (overlay) overlay.classList.remove('visible')
            }

            function checkForResumableOnlineSession() {
                const session = readOnlineSession();
                if (!session) return;
                pendingResumeSession = session;
                const codeEl = document.getElementById('resume-room-code');
                if (codeEl) codeEl.textContent = 'Room ' + session.roomCode;
                showResumeStatus('');
                setResumeButtonsEnabled(!0);
                const overlay = document.getElementById('resume-game-overlay');
                if (overlay) overlay.classList.add('visible')
            }

            const btnResumeYes = document.getElementById('btn-resume-yes');
            const btnResumeNo = document.getElementById('btn-resume-no');
            if (btnResumeYes) btnResumeYes.onclick = async () => {
                if (!pendingResumeSession) return;
                const session = pendingResumeSession;
                setResumeButtonsEnabled(!1);
                showResumeStatus('Reconnecting to your match…');
                try {
                    const exists = await window.FBRoom.roomExists(session.roomCode);
                    if (!exists) {
                        showResumeStatus('This match is no longer available.');
                        setTimeout(() => { closeResumeOverlay(); clearOnlineSession(); pendingResumeSession = null }, 1800);
                        return
                    }
                    const slot = await window.FBRoom.joinRoom(session.roomCode, session.maxPlayers, session.token);
                    if (slot === null || slot === undefined) {
                        showResumeStatus("Couldn't rejoin — the room is full.");
                        setTimeout(() => { closeResumeOverlay(); clearOnlineSession(); pendingResumeSession = null }, 1800);
                        return
                    }
                    onlineState.active = !0;
                    onlineState.mode = session.mode;
                    onlineState.localPlayerId = slot;
                    onlineState.timerSeconds = session.timerSeconds;
                    onlineState.peerLeft = !1;
                    onlineState.isHost = !1;
                    awaitingStateSync = !0;
                    attachRoomMessageListener();
                    attachRoomPresenceListener(session.maxPlayers);
                    showResumeStatus('Syncing the board…');
                    sendOnline({ type: 'request-state' });
                    stateSyncTimeoutId = setTimeout(() => {
                        if (!awaitingStateSync) return;
                        awaitingStateSync = !1;
                        showResumeStatus("Couldn't reach your opponent — they may be reconnecting too. Try again in a moment.");
                        setResumeButtonsEnabled(!0)
                    }, 9000)
                } catch (e) {
                    showResumeStatus('Connection error — check your internet and try again.');
                    setResumeButtonsEnabled(!0)
                }
            };
            if (btnResumeNo) btnResumeNo.onclick = async () => {
                if (!pendingResumeSession) return;
                const session = pendingResumeSession;
                setResumeButtonsEnabled(!1);
                showResumeStatus('Forfeiting the match…');
                try {
                    const exists = await window.FBRoom.roomExists(session.roomCode);
                    if (exists) {
                        const slot = await window.FBRoom.joinRoom(session.roomCode, session.maxPlayers, session.token);
                        if (slot !== null && slot !== undefined) {
                            const forfeitType = session.mode === '4p' ? 'forfeit' : 'resign';
                            sendOnline({ type: forfeitType, playerId: slot });
                            try { window.FBRoom.leaveRoom() } catch (e) {}
                        }
                    }
                } catch (e) {}
                clearOnlineSession();
                pendingResumeSession = null;
                closeResumeOverlay();
                showToast('You forfeited the match — your opponent wins.', 'error')
            };
            // ================= END ONLINE MULTIPLAYER =================

            let gameMode = '2p';
            let players = [];
            let turnOrder = [];
            let turnIndex = 0;
            let turn = 0;
            let hWalls = Array.from({ length: 9 }, () => Array(9).fill(!1));
            let vWalls = Array.from({ length: 9 }, () => Array(9).fill(!1));
            let uiMode = 'move';
            let gameOver = !1;
            let history = [];
            let undoStack = [];
            let currentPage = 0;
            let isAnimating = !1;
            let animData = null;
            let wallAnimation = null;
            let wallPreviewPos = null;
            let touchAnchorPos = null;
            let touchDidMove = false;
            let pendingWallPos = null;
            let selectedMode = '2p';
            let huntProximity = 0;
            const HUNT_PROXIMITY_MAX = 7;

            // ================= TURN TIMER (graphic/UX addition — reuses existing resign flow, no core game logic changed) =================
            // Each player gets a total time BANK for the whole game (like a chess clock),
            // not a per-turn reset. Only the current player's bank ticks down; it pauses
            // on their opponent's turn and resumes exactly where it left off.
            const DEFAULT_TIMER_SECONDS = 120;
            const VALID_TIMER_SECONDS = [0, 30, 60, 120, 300, 600];
            function loadSelectedTimerSeconds() {
                const raw = parseInt(safeStorageGet('barricade-timer-secs'), 10);
                if (isNaN(raw) || !VALID_TIMER_SECONDS.includes(raw)) return DEFAULT_TIMER_SECONDS;
                return raw
            }
            let selectedGameTypeOnline = false;
            let selectedTimerSeconds = loadSelectedTimerSeconds();
            let currentTurnTimerSeconds = selectedTimerSeconds;
            let turnTimerInterval = null;
            let turnTimerPlayerId = null;
            // Absolute real-world timestamp (Date.now()) at which the current
            // player's time bank hits zero. We always recompute the remaining
            // time from this fixed target instead of subtracting 1 on every
            // tick, so the displayed number can never drift out of sync with
            // real elapsed time — regardless of setInterval jitter, a
            // backgrounded/throttled tab, or a device that briefly slept.
            // This is what keeps the two players' clocks (and two devices)
            // agreeing with each other instead of slowly falling behind.
            let turnTimerDeadline = null;
            let onlineEntryFromNameEntry = false;
            // Tracks which "second page" led into the name-entry/settings
            // screen — 'offline' (Classic/Hunter picker) or 'online' (the
            // online mode picker) — purely so its own Back button returns
            // to the right place. Doesn't affect game logic.
            let nameEntryOrigin = 'offline';

            function timerIsEnabled() {
                return !!currentTurnTimerSeconds
            }

            function initPlayerTimeBanks() {
                if (!timerIsEnabled()) { players.forEach(p => { p.timeBank = null }); return }
                players.forEach(p => { p.timeBank = currentTurnTimerSeconds })
            }

            function formatTimerLabel(secs) {
                if (secs < 0) secs = 0;
                const m = Math.floor(secs / 60),
                    s = secs % 60;
                const str = m > 0 ? (m + ':' + String(s).padStart(2, '0')) : ('0:' + String(s).padStart(2, '0'));
                return str
            }

            function stopTurnTimer() {
                if (turnTimerInterval) { clearInterval(turnTimerInterval); turnTimerInterval = null }
            }

            function renderAllPlayerClocks() {
                document.querySelectorAll('.player-timer').forEach(el => {
                    el.classList.remove('visible', 'ticking', 'warning', 'critical');
                    if (!timerIsEnabled()) return;
                    const pid = parseInt(el.dataset.playerId, 10);
                    const p = players.find(pl => pl.id === pid);
                    if (!p) return;
                    const bank = (p.timeBank != null) ? p.timeBank : currentTurnTimerSeconds;
                    el.classList.add('visible');
                    const timeEl = el.querySelector('.pt-time');
                    if (timeEl) timeEl.textContent = formatTimerLabel(bank);
                    const fillEl = el.querySelector('.pt-fill');
                    if (fillEl) {
                        const pct = currentTurnTimerSeconds > 0 ? Math.max(0, Math.min(1, bank / currentTurnTimerSeconds)) : 1;
                        fillEl.style.width = (pct * 100).toFixed(1) + '%';
                    }
                    const isActiveTurn = !gameOver && p.id === turn;
                    el.classList.toggle('ticking', isActiveTurn);
                    if (bank <= 10) el.classList.add('critical');
                    else if (bank <= Math.max(11, Math.ceil(currentTurnTimerSeconds * 0.3))) el.classList.add('warning')
                })
            }

            function tickTurnTimer() {
                const p = currentPlayer();
                if (!p) { stopTurnTimer(); return }
                // Recompute remaining time from the fixed deadline every tick —
                // never from "previous value minus one" — so any delay in when
                // this tick actually fired (throttled background tab, slow
                // device, etc.) is automatically corrected instead of
                // accumulating into drift.
                const remainingMs = turnTimerDeadline - Date.now();
                const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));
                if (p.timeBank !== remainingSecs) {
                    p.timeBank = remainingSecs;
                    renderAllPlayerClocks()
                }
                if (remainingMs <= 0) {
                    stopTurnTimer();
                    handleTurnTimeout()
                }
            }

            function startTurnTimer() {
                stopTurnTimer();
                if (!timerIsEnabled() || gameOver) { renderAllPlayerClocks(); return }
                if (onlineState.active && anyDisconnectPending()) { renderAllPlayerClocks(); return }
                const p = currentPlayer();
                if (!p) { renderAllPlayerClocks(); return }
                const bank = (p.timeBank != null) ? p.timeBank : currentTurnTimerSeconds;
                // In online mode, only the device whose own player's turn is
                // starting is authoritative for the deadline — it computes it
                // once from its own clock and broadcasts it. The other device
                // must NOT compute its own deadline independently: doing so
                // means each side anchors "now" at a different real-world
                // moment (whenever the move message happens to arrive on
                // their end), which is exactly what caused the two players'
                // clocks to disagree. The non-owner sets a provisional value
                // here only so the UI isn't blank for the instant before the
                // 'timer-sync' message (sent right below) arrives; it gets
                // overwritten the moment that message is handled.
                turnTimerDeadline = Date.now() + bank * 1000;
                if (onlineState.active && isMyOnlineTurn()) {
                    sendOnline({ type: 'timer-sync', playerId: p.id, deadline: turnTimerDeadline })
                }
                renderAllPlayerClocks();
                // Ticking more often than once a second just means the on-screen
                // number and the progress bar update smoothly; the actual
                // countdown accuracy comes from the deadline check above, not
                // from this interval's timing.
                turnTimerInterval = setInterval(tickTurnTimer, 250)
            }

            function syncTurnTimer() {
                if (gameOver || !players.length) {
                    stopTurnTimer();
                    turnTimerPlayerId = null;
                    renderAllPlayerClocks();
                    return
                }
                if (!timerIsEnabled()) { stopTurnTimer(); renderAllPlayerClocks(); return }
                const p = currentPlayer();
                if (!p) return;
                if (p.id !== turnTimerPlayerId) {
                    turnTimerPlayerId = p.id;
                    startTurnTimer()
                } else {
                    renderAllPlayerClocks()
                }
            }

            // If the tab was backgrounded (screen off, switched app, etc.),
            // browsers throttle or fully pause timers. The moment the tab is
            // visible again, force an immediate recompute instead of waiting
            // for the next tick, so the number snaps to the correct value
            // right away rather than sitting stale for a second.
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    if (turnTimerInterval) tickTurnTimer();
                    if (onlineLobby.timer) tickOnlineLobbyCountdown()
                }
            });

            function handleTurnTimeout() {
                if (gameOver) return;
                const p = currentPlayer();
                if (!p) return;
                if (onlineState.active) {
                    if (!isMyOnlineTurn()) return;
                    showToast(fmt(t('timeUpToast'), { name: playerDisplayName(p) }), 'error');
                    performResign(p);
                    sendOnline({ type: 'resign', playerId: p.id })
                } else {
                    showToast(fmt(t('timeUpToast'), { name: playerDisplayName(p) }), 'error');
                    performResign(p)
                }
            }
            // ================= END TURN TIMER =================
            let captureAnim = null;

            function isAdjacent(r1, c1, r2, c2) {
                return (Math.abs(r1 - r2) + Math.abs(c1 - c2)) === 1
            }
            let currentNames = {
                p1: safeStorageGet('barricade-name-p1') || '',
                p2: safeStorageGet('barricade-name-p2') || '',
                red: safeStorageGet('barricade-name-red') || '',
                blue: safeStorageGet('barricade-name-blue') || '',
                green: safeStorageGet('barricade-name-green') || '',
                yellow: safeStorageGet('barricade-name-yellow') || '',
                hunter: safeStorageGet('barricade-name-hunter') || '',
                escaper: safeStorageGet('barricade-name-escaper') || ''
            };
            const CUSTOM_COLORS = ['#E74C3C', '#E91E63', '#FF5722', '#FF9800', '#F1C40F', '#CDDC39', '#8BC34A', '#2ECC71', '#1ABC9C', '#00BCD4', '#03A9F4', '#3498DB', '#2979FF', '#3F51B5', '#673AB7', '#9C27B0', '#E040FB', '#FF4081', '#795548', '#607D8B', '#FF6F00', '#76FF03', '#00E676', '#448AFF'];
            const DEFAULT_COLOR_FOR = {
                p1: '#E74C3C',
                p2: '#3498DB',
                red: '#E74C3C',
                blue: '#3498DB',
                green: '#2ECC71',
                yellow: '#F1C40F',
                hunter: '#E74C3C',
                escaper: '#3498DB'
            };

            function loadCustom(slot) {
                try {
                    return JSON.parse(safeStorageGet('barricade-custom-' + slot)) || {}
                } catch (e) {
                    return {}
                }
            }
            let currentCustom = {
                p1: loadCustom('p1'),
                p2: loadCustom('p2'),
                red: loadCustom('red'),
                blue: loadCustom('blue'),
                green: loadCustom('green'),
                yellow: loadCustom('yellow'),
                hunter: loadCustom('hunter'),
                escaper: loadCustom('escaper')
            };

            function customColor(slot) {
                return (currentCustom[slot] && currentCustom[slot].color) || DEFAULT_COLOR_FOR[slot]
            }

            function customBackground(slot) {
                return customColor(slot)
            }

            function refreshSwatchUI(slot) {
                const avatarEl = document.getElementById('avatar-preview-' + slot);
                if (avatarEl) {
                    avatarEl.style.background = customColor(slot)
                }
                const colorContainer = document.getElementById('swatches-' + slot);
                if (colorContainer)[...colorContainer.children].forEach(b => {
                    const sel = b.dataset.color === customColor(slot);
                    b.classList.toggle('selected', sel)
                })
                const teamDotEl = document.getElementById('team-dot-' + slot);
                if (teamDotEl) {
                    teamDotEl.style.background = customColor(slot);
                    teamDotEl.style.boxShadow = `0 0 6px ${customColor(slot)}`
                }
            }

            function buildSwatches(slot) {
                const colorContainer = document.getElementById('swatches-' + slot);
                if (!colorContainer) return;
                colorContainer.innerHTML = '';
                if (!currentCustom[slot]) currentCustom[slot] = {};
                CUSTOM_COLORS.forEach(c => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'swatch-btn';
                    b.style.background = c;
                    b.dataset.color = c;
                    b.onclick = () => {
                        currentCustom[slot].color = c;
                        safeStorageSet('barricade-custom-' + slot, JSON.stringify(currentCustom[slot]));
                        refreshSwatchUI(slot)
                    };
                    colorContainer.appendChild(b)
                });
                refreshSwatchUI(slot)
            }

            // ================= ONLINE LOBBY (live name/avatar setup, online-only) =================
            const SLOT_DPN_INDEX = { p1: 0, p2: 1, hunter: 0, escaper: 1 };
            const FOUR_P_SLOTS = ['red', 'blue', 'green', 'yellow'];

            function slotPlaceholder(slot) {
                const dpn = translations.defaultPlayerNames;
                return dpn[SLOT_DPN_INDEX[slot]] || dpn[0]
            }

            function slotNameForId(mode, id) {
                if (mode === '4p') return FOUR_P_SLOTS[id];
                if (mode === 'hunter') return id === 1 ? 'hunter' : 'escaper';
                return id === 0 ? 'p1' : 'p2'
            }

            function lobbyOtherIds(mode) {
                const maxP = mode === '4p' ? 4 : 2;
                const ids = [];
                for (let i = 0; i < maxP; i++) if (i !== onlineState.localPlayerId) ids.push(i);
                return ids
            }

            function lobbySlots(mode) {
                if (mode === 'hunter') {
                    return onlineState.localPlayerId === 0 ? { me: 'escaper', opp: 'hunter' } : { me: 'hunter', opp: 'escaper' }
                }
                return onlineState.localPlayerId === 0 ? { me: 'p1', opp: 'p2' } : { me: 'p2', opp: 'p1' }
            }

            function broadcastOnlineProfile() {
                if (onlineState.active) sendOnline({ type: 'profile', id: onlineState.localPlayerId, name: onlineLobby.me.name, color: onlineLobby.me.color })
            }

            function refreshOnlineLobbySwatchUI() {
                const avatarEl = document.getElementById('avatar-preview-online-me');
                if (avatarEl) avatarEl.style.background = onlineLobby.me.color;
                const container = document.getElementById('swatches-online-me');
                if (container)[...container.children].forEach(b => {
                    b.classList.toggle('selected', b.dataset.color === onlineLobby.me.color)
                })
            }

            function buildOnlineSwatches() {
                const el = document.getElementById('swatches-online-me');
                if (!el) return;
                el.innerHTML = '';
                CUSTOM_COLORS.forEach(c => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'swatch-btn';
                    b.style.background = c;
                    b.dataset.color = c;
                    b.onclick = () => {
                        onlineLobby.me.color = c;
                        safeStorageSet('barricade-online-color', c);
                        refreshOnlineLobbySwatchUI();
                        broadcastOnlineProfile()
                    };
                    el.appendChild(b)
                })
            }
            buildOnlineSwatches();
            const onlineLobbyNameInput = document.getElementById('input-name-online-me');
            if (onlineLobbyNameInput) {
                onlineLobbyNameInput.oninput = (e) => {
                    onlineLobby.me.name = e.target.value.slice(0, 13);
                    safeStorageSet('barricade-online-name', onlineLobby.me.name);
                    broadcastOnlineProfile()
                }
            }
            const btnPickRoleEscaper = document.getElementById('btn-pick-role-escaper');
            const btnPickRoleHunter = document.getElementById('btn-pick-role-hunter');
            if (btnPickRoleEscaper) btnPickRoleEscaper.onclick = () => pickHunterRole('escaper');
            if (btnPickRoleHunter) btnPickRoleHunter.onclick = () => pickHunterRole('hunter');

            const OPP_CARD_ELS = [
                { avatar: 'avatar-preview-online-opp', name: 'name-online-opp', card: 'online-lobby-opp1-card', badge: 'forfeit-badge-online-opp1' },
                { avatar: 'avatar-preview-online-opp2', name: 'name-online-opp2', card: 'online-lobby-opp2-card', badge: 'forfeit-badge-online-opp2' },
                { avatar: 'avatar-preview-online-opp3', name: 'name-online-opp3', card: 'online-lobby-opp3-card', badge: 'forfeit-badge-online-opp3' }
            ];

            function placeholderForId(mode, id) {
                const dpn = translations.defaultPlayerNames;
                if (mode === '4p') return dpn[id] || dpn[0];
                return slotPlaceholder(slotNameForId(mode, id))
            }

            function updateOnlineOppUI() {
                const otherIds = lobbyOtherIds(onlineState.mode);
                OPP_CARD_ELS.forEach((els, idx) => {
                    const cardEl = document.getElementById(els.card);
                    if (idx >= otherIds.length) { if (cardEl) cardEl.style.display = 'none'; return }
                    if (cardEl) cardEl.style.display = '';
                    const id = otherIds[idx];
                    const slot = slotNameForId(onlineState.mode, id);
                    const data = onlineLobby.othersById[id] || { name: '', color: customColor(slot) };
                    const avatarEl = document.getElementById(els.avatar);
                    if (avatarEl) avatarEl.style.background = data.color;
                    const nameEl = document.getElementById(els.name);
                    if (nameEl) nameEl.textContent = (data.name && data.name.trim()) ? data.name.trim() : placeholderForId(onlineState.mode, id)
                })
            }

            function updateOnlineCountdownUI() {
                const el = document.getElementById('online-lobby-countdown');
                const numEl = document.getElementById('online-lobby-countdown-num');
                const secs = Math.max(0, onlineLobby.secondsLeft);
                if (numEl) numEl.textContent = localizeNum(secs);
                if (el) el.style.setProperty('--pct', Math.max(0, Math.min(100, (secs / onlineLobby.totalSeconds) * 100)))
            }

            // Small icon set for the two Wolf & Sheep roles — used in the
            // role-pick buttons, the live pick badges, and the lottery
            // reveal. Inline SVGs (tinted via currentColor/CSS) instead of
            // the old sheep.webp/wolf.webp image files, so the icons always
            // render crisply and match the role's theme color everywhere.
            const ROLE_ICON_SVG = {
                escaper: '<svg viewBox="0 0 64 64" class="role-icon-svg" aria-hidden="true"><g fill="currentColor"><circle cx="15" cy="25" r="9"/><circle cx="27" cy="16" r="10.5"/><circle cx="40" cy="17" r="10"/><circle cx="51" cy="27" r="9"/><circle cx="47" cy="41" r="9.5"/><circle cx="30" cy="45" r="12"/><circle cx="15" cy="39" r="8.5"/><path d="M22 7c1-4 7-5 7-1s-4 5-6 4-2-2-1-3z"/></g><ellipse cx="30" cy="43" rx="11" ry="9" fill="#fff8ec"/><circle cx="25" cy="40" r="3.4" fill="#fff"/><circle cx="27" cy="41" r="1.6" fill="#2b2b2b"/><circle cx="36" cy="40" r="2.6" fill="#fff"/><circle cx="34.5" cy="40.6" r="1.3" fill="#2b2b2b"/><path d="M23 46q4.5 4.5 10 1.5" stroke="#7a3b28" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M29 47q2.5 5 1 8c-.6 1.3-2.3 1-2.3-.6z" fill="#e8827c"/></svg>',
                hunter: '<svg viewBox="0 0 64 64" class="role-icon-svg" aria-hidden="true"><g fill="currentColor"><path d="M13 8 27 24 19 27z"/><path d="M53 12c2 6-1 13-7 15-4 1.4-6-2.4-3-5.6 3-3.4 7-7 10-9.4z"/><path d="M32 15c12.7 0 21 9.8 21 21.5C53 48.5 45 55 32 55S11 48.5 11 36.5C11 24.8 19.3 15 32 15z"/></g><circle cx="23" cy="33.5" r="5" fill="#fff"/><circle cx="25" cy="35" r="2.1" fill="#1b1b1b"/><circle cx="41" cy="34" r="3.4" fill="#fff"/><circle cx="39.3" cy="34.8" r="1.5" fill="#1b1b1b"/><path d="M32 37 27 44h10z" fill="#1b1b1b"/><path d="M23 47q9 6.5 18 0q-1.5 7-9 7t-9-7z" fill="#7a1f1a"/><path d="M35 49q4.5 6 2.5 10c-.6 1.3-2.6 1-2.6-.7z" fill="#e8827c"/><path d="M25 47.5l3 3.5-3.6.6z" fill="#fff"/></svg>'
            };

            function roleBadgeHTML(role) {
                if (!role) return '<span class="role-live-badge-pending">' + t('hunterPickPending') + '</span>';
                return ROLE_ICON_SVG[role] + '<span>' + (role === 'escaper' ? t('roleEscaper') : t('roleHunter')) + '</span>'
            }

            function updateHunterPickUI(mode) {
                const section = document.getElementById('hunter-role-pick-section');
                const badgeMe = document.getElementById('role-live-badge-me');
                const badgeOpp = document.getElementById('role-live-badge-opp');
                if (mode !== 'hunter') {
                    if (section) section.style.display = 'none';
                    if (badgeMe) badgeMe.style.display = 'none';
                    if (badgeOpp) badgeOpp.style.display = 'none';
                    return
                }
                if (section) section.style.display = '';
                const btnEscaper = document.getElementById('btn-pick-role-escaper');
                const btnHunter = document.getElementById('btn-pick-role-hunter');
                if (btnEscaper) btnEscaper.classList.toggle('selected', onlineHunterPick.me === 'escaper');
                if (btnHunter) btnHunter.classList.toggle('selected', onlineHunterPick.me === 'hunter');
                // Live, just like the name field: shows the actual picked role
                // for both players in real time, updating instantly whenever
                // either side taps a different role.
                const applyBadge = (el, role) => {
                    if (!el) return;
                    el.style.display = '';
                    el.innerHTML = roleBadgeHTML(role);
                    el.classList.toggle('role-escaper', role === 'escaper');
                    el.classList.toggle('role-hunter', role === 'hunter')
                };
                applyBadge(badgeMe, onlineHunterPick.me);
                applyBadge(badgeOpp, onlineHunterPick.opp)
            }

            function pickHunterRole(role) {
                onlineHunterPick.me = role;
                sendOnline({ type: 'role-pick', role });
                updateHunterPickUI(onlineState.mode)
            }

            function showOnlineLobby(mode) {
                const meSlot = slotNameForId(mode, onlineState.localPlayerId);
                onlineLobby.mySlot = meSlot;
                const savedOnlineName = safeStorageGet('barricade-online-name');
                const savedOnlineColor = safeStorageGet('barricade-online-color');
                onlineLobby.me = {
                    name: (savedOnlineName !== null ? savedOnlineName : (currentNames[meSlot] || '')),
                    color: savedOnlineColor || customColor(meSlot)
                };
                onlineLobby.othersById = {};
                resetOnlineHunterPick();
                onlineState.hunterRoleByPlayerId = null;
                showStartScreen('online-lobby-view');
                const lobbyView = document.getElementById('online-lobby-view');
                startOverlay.style.display = 'flex';
                appEl.classList.remove('visible');
                setThemeColor('#000000');
                if (onlineLobbyNameInput) {
                    onlineLobbyNameInput.value = onlineLobby.me.name;
                    onlineLobbyNameInput.placeholder = placeholderForId(mode, onlineState.localPlayerId)
                }
                refreshOnlineLobbySwatchUI();
                updateOnlineOppUI();
                updateHunterPickUI(mode);
                broadcastOnlineProfile();
                onlineLobby.totalSeconds = onlineLobbySecondsFor(mode);
                onlineLobby.secondsLeft = onlineLobby.totalSeconds;
                setTextContent('online-lobby-desc', fmt(t('onlineLobbyDesc'), { n: onlineLobby.totalSeconds }));
                // Deadline-based, same reasoning as the in-game turn timer: each
                // player's browser starts this lobby countdown at a slightly
                // different real moment (network delay in receiving "start"),
                // and a plain "subtract 1 every 1000ms" timer drifts further
                // from there. Anchoring to a fixed real-world deadline keeps it
                // accurate and keeps both players landing in the game together.
                onlineLobby.deadline = Date.now() + onlineLobby.totalSeconds * 1000;
                updateOnlineCountdownUI();
                if (onlineLobby.timer) clearInterval(onlineLobby.timer);
                onlineLobby.timer = setInterval(tickOnlineLobbyCountdown, 250)
            }

            function tickOnlineLobbyCountdown() {
                const mode = onlineState.mode;
                const remainingMs = onlineLobby.deadline - Date.now();
                onlineLobby.secondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));
                updateOnlineCountdownUI();
                if (remainingMs <= 0) {
                    clearInterval(onlineLobby.timer);
                    onlineLobby.timer = null;
                    finalizeOnlineLobby(mode)
                }
            }

            // Re-applies each online player's chosen name/avatar color (set in
            // the online lobby) onto the freshly (re)built `players` array.
            // initGame()/setupHunter()/setup2P()/setup4P() always reset players
            // to their offline defaults, so this must be called again after
            // every initGame() in an online match — including rematches — or
            // the online-picked names/colors get lost and silently fall back
            // to the defaults.
            function applyOnlineIdentitiesToPlayers() {
                const meP = players.find(p => p.id === onlineState.localPlayerId);
                if (meP) {
                    meP.customName = onlineLobby.me.name;
                    meP.color = onlineLobby.me.color
                }
                for (const idStr in onlineLobby.othersById) {
                    const id = parseInt(idStr, 10);
                    const p = players.find(pl => pl.id === id);
                    const data = onlineLobby.othersById[id];
                    if (p && data) {
                        p.customName = data.name;
                        p.color = data.color
                    }
                }
            }

            // Plays the role-lottery reveal animation (used only when both
            // players picked the same role, or a pick was missing) and then
            // calls `callback` to actually start the game. Both devices run
            // this independently but always land on the same `roles` result
            // (see resolveHunterRoles), so the reveal matches on both ends.
            function showHunterRoleLottery(roles, callback) {
                const overlay = document.getElementById('hunter-role-reveal-overlay');
                if (!overlay) { callback(); return }
                const myId = onlineState.localPlayerId;
                const oppId = myId === 0 ? 1 : 0;
                const myRole = roles.escaperId === myId ? 'escaper' : 'hunter';
                const oppRole = myRole === 'escaper' ? 'hunter' : 'escaper';
                const oppData = onlineLobby.othersById[oppId] || {};
                const myName = (onlineLobby.me.name && onlineLobby.me.name.trim()) || placeholderForId('hunter', myId);
                const oppName = (oppData.name && oppData.name.trim()) || placeholderForId('hunter', oppId);
                setTextContent('hunter-reveal-name-me', myName);
                setTextContent('hunter-reveal-name-opp', oppName);
                const iconMe = document.getElementById('hunter-reveal-icon-me');
                const iconOpp = document.getElementById('hunter-reveal-icon-opp');
                const roleMe = document.getElementById('hunter-reveal-role-me');
                const roleOpp = document.getElementById('hunter-reveal-role-opp');
                if (roleMe) roleMe.textContent = '';
                if (roleOpp) roleOpp.textContent = '';
                if (iconMe) { iconMe.classList.remove('landed'); iconMe.classList.add('shuffling') }
                if (iconOpp) { iconOpp.classList.remove('landed'); iconOpp.classList.add('shuffling') }
                overlay.classList.add('visible');
                const setIconRole = (el, role) => {
                    if (!el) return;
                    el.innerHTML = ROLE_ICON_SVG[role];
                    el.classList.toggle('icon-escaper', role === 'escaper');
                    el.classList.toggle('icon-hunter', role === 'hunter')
                };
                let tick = 0;
                const shuffleInterval = setInterval(() => {
                    tick++;
                    setIconRole(iconMe, tick % 2 === 0 ? 'escaper' : 'hunter');
                    setIconRole(iconOpp, tick % 2 === 0 ? 'hunter' : 'escaper');
                    sfxClick()
                }, 90);
                setTimeout(() => {
                    clearInterval(shuffleInterval);
                    if (iconMe) {
                        iconMe.classList.remove('shuffling');
                        setIconRole(iconMe, myRole);
                        iconMe.classList.add('landed')
                    }
                    if (iconOpp) {
                        iconOpp.classList.remove('shuffling');
                        setIconRole(iconOpp, oppRole);
                        iconOpp.classList.add('landed')
                    }
                    if (roleMe) roleMe.textContent = myRole === 'escaper' ? t('roleEscaper') : t('roleHunter');
                    if (roleOpp) roleOpp.textContent = oppRole === 'escaper' ? t('roleEscaper') : t('roleHunter');
                    sfxWin();
                    setTimeout(() => {
                        overlay.classList.remove('visible');
                        if (iconMe) iconMe.classList.remove('landed');
                        if (iconOpp) iconOpp.classList.remove('landed');
                        callback()
                    }, 1500)
                }, 1600)
            }

            function finalizeOnlineLobby(mode) {
                const lobbyView = document.getElementById('online-lobby-view');
                if (lobbyView) lobbyView.style.display = 'none';
                if (mode === 'hunter') {
                    const roles = resolveHunterRoles();
                    onlineState.hunterRoleByPlayerId = { [roles.escaperId]: 'escaper', [roles.hunterId]: 'hunter' };
                    if (roles.needsLottery) {
                        showHunterRoleLottery(roles, () => completeOnlineLobbyStart(mode));
                        return
                    }
                }
                completeOnlineLobbyStart(mode)
            }

            function completeOnlineLobbyStart(mode) {
                initGame(mode);
                applyOnlineIdentitiesToPlayers();
                renderTopbar();
                updateScores();
                updateActivePlayerUI();
                draw();
                saveOnlineSession();
                // Warm the server's checkpoint cache right away, before any
                // move has happened — otherwise, if both players reloaded in
                // the first few seconds of the match, there'd be nothing yet
                // for the server to serve back (see 'request-state' handling
                // in server.js).
                sendOnlineCheckpoint()
            }
            // ================= END ONLINE LOBBY =================

            function applyStaticTranslations() {
                setTextContent('page-title', t('pageTitle'));
                setTextContent('about-btn-label', t('aboutBtn'));
                setTextContent('settings-btn-label', t('settingsBtn'));
                setTextContent('settings-title', t('settingsTitle'));
                setTextContent('settings-sound-label', t('settingsSoundLabel'));
                setTextContent('settings-sound-desc', t('settingsSoundDesc'));
                setTextContent('settings-wall-offset-label', t('settingsWallOffsetLabel'));
                setTextContent('settings-wall-offset-desc', t('settingsWallOffsetDesc'));
                setTextContent('about-title', t('aboutTitle'));
                setTextContent('about-tagline', t('aboutTagline'));
                setTextContent('about-text', t('aboutText'));
                setTextContent('about-feature1', t('aboutFeature1'));
                setTextContent('about-feature2', t('aboutFeature2'));
                setTextContent('about-feature3', t('aboutFeature3'));
                setTextContent('about-creator-label', t('aboutCreatorLabel'));
                setTextContent('about-creator-name', t('aboutCreatorName'));
                setTextContent('about-follow-label', t('aboutFollowLabel'));
                setTextContent('start-subtitle', t('startSubtitle'));
                setTextContent('lbl-help', t('howToPlay'));
                setTextContent('mode-classic-title', t('modeClassicTitle'));
                setTextContent('mode-classic-desc', t('modeClassicDesc'));
                setTextContent('pc-2-label', t('pc2Label'));
                setTextContent('pc-4-label', t('pc4Label'));
                setTextContent('team-group-1-label', t('teamA'));
                setTextContent('team-group-2-label', t('teamB'));
                setTextContent('team-vs-label', t('vs'));
                setTextContent('mode-hunter-title', t('modeHunterTitle'));
                setTextContent('mode-hunter-desc', t('modeHunterDesc'));
                setTextContent('online-pick-2p-label', t('onlinePick2pLabel'));
                setTextContent('online-pick-4p-label', t('onlinePick4pLabel'));
                setTextContent('online-pick-hunter-label', t('onlinePickHunterLabel'));
                setTextContent('online-create-title', t('onlineCreateTitle'));
                setTextContent('online-create-desc', t('onlineCreateDesc'));
                setTextContent('online-join-title', t('onlineJoinTitle'));
                setTextContent('online-join-desc', t('onlineJoinDesc'));
                setTextContent('online-back-label', t('onlineBackLabel'));
                setTextContent('online-code-hint', t('onlineCodeHint'));
                setTextContent('online-connect-label', t('onlineConnectLabel'));
                setTextContent('btn-online-cancel-create', t('onlineCancelLabel'));
                setTextContent('btn-online-cancel-join', t('onlineCancelLabel'));
                const copyCodeBtn = document.getElementById('btn-online-copy-code');
                if (copyCodeBtn) copyCodeBtn.setAttribute('aria-label', t('onlineCopyCodeAria'));
                setTextContent('gt-offline-label', t('gtOfflineLabel'));
                setTextContent('gt-online-label', t('gtOnlineLabel'));
                setTextContent('game-type-lock-hint', t('gtLockHint4p'));
                setTextContent('online-name-lock-title', t('onlineNameLockTitle'));
                setTextContent('online-name-lock-desc', t('onlineNameLockDesc'));
                setTextContent('timer-select-label-text', t('timerSelectLabel'));
                setTextContent('timer-chip-none-label', t('timerNoneLabel'));
                setTextContent('online-code-entry-label-text', t('onlineCodeEntryLabel'));
                if (onlineNameEntryCodeInput) onlineNameEntryCodeInput.placeholder = 'CYRU5';
                document.querySelectorAll('.tc-unit').forEach(el => {
                    el.textContent = el.dataset.unit === 'sec' ? t('timerUnitSec') : t('timerUnitMin')
                });
                document.querySelectorAll('#timer-chip-group .timer-chip:not(.no-timer-chip) .tc-num').forEach(el => {
                    const secs = parseInt(el.closest('.timer-chip').dataset.secs, 10);
                    const n = secs < 60 ? secs : Math.round(secs / 60);
                    el.textContent = localizeNum(n)
                });
                setTextContent('lbl-move', t('move'));
                setTextContent('lbl-hwall', t('horizontal'));
                setTextContent('lbl-vwall', t('vertical'));
                setTextContent('lbl-undo', t('undo'));
                setTextContent('lbl-repeat', t('repeat'));
                setTextContent('lbl-resign', t('resign'));
                setTextContent('lbl-home', t('newGame'));
                setTextContent('go-winner-label', t('goWinnerLabel'));
                setTextContent('go-tag-winner', t('goTagWinner'));
                setTextContent('go-tag-loser', t('goTagLoser'));
                setTextContent('lbl-go-repeat', t('goPlayAgain'));
                setTextContent('lbl-go-home', t('goBackHome'));
                setTextContent('lbl-confirm-yes', t('confirmYesLabel'));
                setTextContent('lbl-confirm-no', t('confirmNoLabel'));
                setTextContent('lbl-move-history', t('moveHistory'));
                setTextContent('lbl-game-info', t('gameInfo'));
                setTextContent('lbl-mode', t('mode'));
                setTextContent('lbl-walls-left', t('wallsLeft'));
                setTextContent('lbl-status', t('status'));
                setTextContent('lbl-online-turn', 'Turn');
                setTextContent('lbl-objective', t('objective'));
                setTextContent('lbl-walls', t('walls'));
                document.getElementById('info-walls-text').innerHTML = t('wallsText');
                setTextContent('lbl-rules', t('rules'));
                document.getElementById('info-rules-text').innerHTML = t('rulesText');
                setTextContent('lbl-place-wall', t('placeWall'));
                const startLbl = document.getElementById('lbl-start-game');
                if (startLbl) startLbl.textContent = t('startGame');
                setTextContent('name-entry-title', t('nameEntryTitle'));
                setTextContent('btn-name-confirm', t('startGameBtn'));
                setTextContent('btn-name-back', t('backBtn'));
                setTextContent('online-lobby-title', t('onlineLobbyTitle'));
                setTextContent('online-lobby-desc', fmt(t('onlineLobbyDesc'), { n: onlineLobby.totalSeconds || ONLINE_LOBBY_SECONDS_DEFAULT }));
                setTextContent('online-lobby-hint', t('onlineLobbyHint'));
                setTextContent('hunter-role-pick-label', t('hunterPickLabel'));
                setTextContent('hunter-role-btn-escaper-label', t('roleEscaper'));
                setTextContent('hunter-role-btn-hunter-label', t('roleHunter'));
                setTextContent('hunter-reveal-title', t('hunterRevealTitle'));
                setTextContent('hunter-reveal-sub', t('hunterRevealSub'));
                setTextContent('mode-title', t('modeTitle'));
                const dpn = translations.defaultPlayerNames;
                const ph = (id, idx) => {
                    const el = document.getElementById(id);
                    if (el) el.placeholder = dpn[idx]
                };
                ph('input-name-p1', 0);
                ph('input-name-p2', 1);
                ph('input-name-red', 0);
                ph('input-name-blue', 1);
                ph('input-name-green', 2);
                ph('input-name-yellow', 3);
                ph('input-name-hunter', 0);
                ph('input-name-escaper', 1);
                document.documentElement.lang = 'en';
                document.documentElement.dir = 'ltr'
            }
            document.getElementById('btn-about').onclick = () => document.getElementById('about-overlay').classList.add('visible');
            const btnAboutCloseX = document.getElementById('btn-about-close-x');
            if (btnAboutCloseX) btnAboutCloseX.onclick = () => document.getElementById('about-overlay').classList.remove('visible');
            document.getElementById('about-overlay').addEventListener('click', (e) => {
                if (e.target.id === 'about-overlay') e.target.classList.remove('visible')
            });

            const settingsOverlay = document.getElementById('settings-overlay');
            document.getElementById('btn-settings').onclick = () => settingsOverlay.classList.add('visible');
            document.getElementById('btn-settings-close-x').onclick = () => settingsOverlay.classList.remove('visible');
            settingsOverlay.addEventListener('click', (e) => {
                if (e.target.id === 'settings-overlay') settingsOverlay.classList.remove('visible')
            });

            // ===== منوی موبایل (سه‌نقطه) برای Help/About/Settings =====
            const btnTopMenu = document.getElementById('btn-top-menu');
            const topMenuPanel = document.getElementById('top-menu-panel');
            if (btnTopMenu && topMenuPanel) {
                const closeTopMenu = () => {
                    topMenuPanel.classList.remove('open');
                    btnTopMenu.classList.remove('active');
                    btnTopMenu.setAttribute('aria-expanded', 'false')
                };
                btnTopMenu.onclick = (e) => {
                    e.stopPropagation();
                    const isOpen = topMenuPanel.classList.toggle('open');
                    btnTopMenu.classList.toggle('active', isOpen);
                    btnTopMenu.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
                };
                topMenuPanel.querySelectorAll('.top-ctrl-btn').forEach(item => {
                    item.addEventListener('click', closeTopMenu)
                });
                document.addEventListener('click', (e) => {
                    if (topMenuPanel.classList.contains('open') && !topMenuPanel.contains(e.target) && e.target !==
                        btnTopMenu && !btnTopMenu.contains(e.target)) closeTopMenu()
                });
                window.addEventListener('resize', closeTopMenu)
            }

            // وقتی هرکدام از دیالوگ‌ها (تنظیمات، درباره ما، تأیید، برنده بازی) باز است،
            // بقیه دکمه‌های صفحه غیرفعال و اسکرول صفحه قفل می‌شود
            const lockableOverlays = [
                document.getElementById('about-overlay'),
                settingsOverlay,
                confirmOverlay,
                gameOverOverlay
            ];

            function refreshModalLock() {
                const anyOpen = lockableOverlays.some(el => el && el.classList.contains('visible'));
                document.body.classList.toggle('modal-locked', anyOpen)
            }
            lockableOverlays.forEach(el => {
                if (el) new MutationObserver(refreshModalLock).observe(el, { attributes: !0, attributeFilter: ['class'] })
            });
            refreshModalLock();

            function updateSoundUI() {
                const onIconBoard = document.getElementById('icon-sound-on-board');
                const offIconBoard = document.getElementById('icon-sound-off-board');
                if (onIconBoard) onIconBoard.style.display = sfxEnabled ? 'block' : 'none';
                if (offIconBoard) offIconBoard.style.display = sfxEnabled ? 'none' : 'block';
                const label = sfxEnabled ? t('soundOn') : t('soundOff');
                const boardBtn = document.getElementById('btn-sound-board');
                if (boardBtn) boardBtn.setAttribute('aria-label', label);
                const boardBtnLabel = document.getElementById('lbl-sound-board');
                if (boardBtnLabel) boardBtnLabel.textContent = label;
                const settingsToggle = document.getElementById('btn-sound-settings');
                if (settingsToggle) {
                    settingsToggle.classList.toggle('on', sfxEnabled);
                    settingsToggle.setAttribute('aria-checked', sfxEnabled ? 'true' : 'false');
                    settingsToggle.setAttribute('aria-label', label)
                }
            }

            function toggleSound() {
                sfxEnabled = !sfxEnabled;
                safeStorageSet('barricade-sfx', sfxEnabled ? 'on' : 'off');
                updateSoundUI();
                if (sfxEnabled) sfxToggle()
            }
            const btnSoundBoard = document.getElementById('btn-sound-board');
            if (btnSoundBoard) {
                btnSoundBoard.onclick = function () {
                    if (btnSoundBoard.dataset.dragMoved === '1') {
                        btnSoundBoard.dataset.dragMoved = '0';
                        return
                    }
                    toggleSound()
                };
                makeSoundBtnDraggable(btnSoundBoard, document.getElementById('board-wrapper'))
                setupSoundBtnHideOnLongPress(btnSoundBoard, document.getElementById('board-wrapper'))
            }
            const btnSoundSettings = document.getElementById('btn-sound-settings');
            if (btnSoundSettings) btnSoundSettings.onclick = toggleSound;
            updateSoundUI();

            function makeSoundBtnDraggable(btn, wrapper) {
                if (!btn || !wrapper) return;
                const DRAG_THRESHOLD = 12;
                let dragging = false, moved = false;
                let startX = 0, startY = 0, startLeft = 0, startTop = 0;
                let savedPos = null;

                function clampAndApply(leftPx, topPx) {
                    const wrapRect = wrapper.getBoundingClientRect();
                    const btnRect = btn.getBoundingClientRect();
                    const minLeft = -btnRect.width * 0.4;
                    const minTop = -btnRect.height * 1.5;
                    const maxLeft = wrapRect.width - btnRect.width * 0.6;
                    const maxTop = wrapRect.height - btnRect.height * 0.6;
                    leftPx = Math.max(minLeft, Math.min(leftPx, maxLeft));
                    topPx = Math.max(minTop, Math.min(topPx, maxTop));
                    btn.style.left = leftPx + 'px';
                    btn.style.top = topPx + 'px';
                    btn.style.right = 'auto';
                    return { leftPx, topPx, wrapRect, btnRect }
                }

                function savePosition(leftPx, topPx, wrapRect, btnRect) {
                    const maxLeft = wrapRect.width - btnRect.width * 0.6;
                    const maxTop = wrapRect.height - btnRect.height * 0.6;
                    const minLeft = -btnRect.width * 0.4;
                    const minTop = -btnRect.height * 1.5;
                    const spanLeft = maxLeft - minLeft;
                    const spanTop = maxTop - minTop;
                    const leftPct = spanLeft > 0 ? (leftPx - minLeft) / spanLeft : 0;
                    const topPct = spanTop > 0 ? (topPx - minTop) / spanTop : 0;
                    savedPos = { leftPct, topPct };
                }

                function restorePosition() {
                    const saved = savedPos;
                    if (!saved || typeof saved.leftPct !== 'number' || typeof saved.topPct !== 'number') return;
                    const wrapRect = wrapper.getBoundingClientRect();
                    const btnRect = btn.getBoundingClientRect();
                    const minLeft = -btnRect.width * 0.4;
                    const minTop = -btnRect.height * 1.5;
                    const maxLeft = wrapRect.width - btnRect.width * 0.6;
                    const maxTop = wrapRect.height - btnRect.height * 0.6;
                    const leftPx = minLeft + saved.leftPct * (maxLeft - minLeft);
                    const topPx = minTop + saved.topPct * (maxTop - minTop);
                    clampAndApply(leftPx, topPx)
                }

                btn.addEventListener('pointerdown', function (e) {
                    dragging = true;
                    moved = false;
                    const wrapRect = wrapper.getBoundingClientRect();
                    const btnRect = btn.getBoundingClientRect();
                    startX = e.clientX;
                    startY = e.clientY;
                    startLeft = btnRect.left - wrapRect.left;
                    startTop = btnRect.top - wrapRect.top;
                    try { btn.setPointerCapture(e.pointerId) } catch (err) {}
                });

                btn.addEventListener('pointermove', function (e) {
                    if (!dragging) return;
                    const dx = e.clientX - startX;
                    const dy = e.clientY - startY;
                    if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
                        moved = true;
                        btn.classList.add('dragging')
                    }
                    if (moved) {
                        e.preventDefault();
                        clampAndApply(startLeft + dx, startTop + dy)
                    }
                });

                function endDrag(e) {
                    if (!dragging) return;
                    dragging = false;
                    btn.classList.remove('dragging');
                    if (moved) {
                        btn.dataset.dragMoved = '1';
                        setTimeout(() => { if (btn.dataset.dragMoved === '1') btn.dataset.dragMoved = '0' }, 400);
                        const wrapRect = wrapper.getBoundingClientRect();
                        const btnRect = btn.getBoundingClientRect();
                        savePosition(btnRect.left - wrapRect.left, btnRect.top - wrapRect.top, wrapRect, btnRect)
                    }
                    moved = false
                }

                btn.addEventListener('pointerup', endDrag);
                btn.addEventListener('pointercancel', endDrag);
                window.addEventListener('resize', restorePosition);
                restorePosition()
            }

            function setupSoundBtnHideOnLongPress(btn, wrapper) {
                if (!btn || !wrapper) return;
                const LONG_PRESS_MS = 500;
                const HOLD_VISUAL_DELAY_MS = 130;
                const MOVE_CANCEL_PX = 12;

                let pressTimer = null;
                let holdVisualTimer = null;
                let pressStartX = 0, pressStartY = 0, pressMoved = false;
                let suppressNextClick = false;
                let isHidden = false;
                let ghostPos = null;

                const badge = document.createElement('div');
                badge.className = 'sound-close-badge no-click-sfx';
                badge.setAttribute('role', 'button');
                badge.setAttribute('aria-label', 'Close');
                badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>';
                wrapper.appendChild(badge);

                const ring = document.createElement('div');
                ring.className = 'sound-reappear-ring';
                wrapper.appendChild(ring);

                const ghost = document.createElement('div');
                ghost.className = 'sound-ghost-dot no-click-sfx';
                ghost.setAttribute('role', 'button');
                ghost.setAttribute('aria-label', 'Show sound button');
                ghost.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/></svg>';
                wrapper.appendChild(ghost);

                function positionBadge() {
                    const wrapRect = wrapper.getBoundingClientRect();
                    const btnRect = btn.getBoundingClientRect();
                    const left = (btnRect.left - wrapRect.left) - 6;
                    const top = (btnRect.top - wrapRect.top) - 6;
                    badge.style.left = left + 'px';
                    badge.style.top = top + 'px'
                }

                function showBadge() {
                    positionBadge();
                    badge.classList.add('visible');
                    document.addEventListener('pointerdown', dismissOnOutsideTap, true)
                }

                function hideBadge() {
                    badge.classList.remove('visible');
                    document.removeEventListener('pointerdown', dismissOnOutsideTap, true)
                }

                function dismissOnOutsideTap(e) {
                    if (e.target === badge || badge.contains(e.target) || e.target === btn) return;
                    hideBadge()
                }

                function positionRing() {
                    const wrapRect = wrapper.getBoundingClientRect();
                    const btnRect = btn.getBoundingClientRect();
                    const size = btnRect.width * 2.2;
                    ring.style.width = size + 'px';
                    ring.style.height = size + 'px';
                    ring.style.left = ((btnRect.left - wrapRect.left) - (size - btnRect.width) / 2) + 'px';
                    ring.style.top = ((btnRect.top - wrapRect.top) - (size - btnRect.height) / 2) + 'px'
                }

                function placeGhostAt(centerLeft, centerTop) {
                    ghost.style.left = (centerLeft - 9) + 'px';
                    ghost.style.top = (centerTop - 9) + 'px'
                }

                function showGhostAt(centerLeft, centerTop) {
                    placeGhostAt(centerLeft, centerTop);
                    ghostPos = { left: centerLeft, top: centerTop };
                    ghost.classList.add('visible')
                }

                function restoreGhostFromStorage() {
                    if (ghostPos && typeof ghostPos.left === 'number' && typeof ghostPos.top === 'number') {
                        placeGhostAt(ghostPos.left, ghostPos.top)
                    } else {
                        const wrapRect = wrapper.getBoundingClientRect();
                        const btnRect = btn.getBoundingClientRect();
                        placeGhostAt((btnRect.left - wrapRect.left) + btnRect.width / 2, (btnRect.top - wrapRect.top) + btnRect.height / 2)
                    }
                    ghost.classList.add('visible')
                }

                function hideGhost() {
                    ghost.classList.remove('visible')
                }

                function hideSoundBtn() {
                    hideBadge();
                    btn.classList.remove('btn-holding');
                    btn.classList.add('btn-hidden-anim');
                    const wrapRect = wrapper.getBoundingClientRect();
                    const btnRect = btn.getBoundingClientRect();
                    const centerLeft = (btnRect.left - wrapRect.left) + btnRect.width / 2;
                    const centerTop = (btnRect.top - wrapRect.top) + btnRect.height / 2;
                    setTimeout(() => {
                        btn.style.display = 'none';
                        btn.classList.remove('btn-hidden-anim');
                        showGhostAt(centerLeft, centerTop)
                    }, 380);
                    isHidden = true;
                    showToast(t('shakeToShowHint'), 'info')
                }

                function revealSoundBtn() {
                    if (btn.style.display !== 'none') return;
                    hideGhost();
                    btn.style.display = 'flex';
                    btn.classList.add('btn-reappear-anim');
                    positionRing();
                    ring.classList.remove('ping');
                    void ring.offsetWidth;
                    ring.classList.add('ping');
                    if (navigator.vibrate) { try { navigator.vibrate(35) } catch (e) {} }
                    setTimeout(() => btn.classList.remove('btn-reappear-anim'), 650);
                    isHidden = false;
                }

                badge.addEventListener('pointerdown', (e) => { e.stopPropagation() });
                badge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    hideSoundBtn()
                });

                ghost.addEventListener('pointerdown', (e) => { e.stopPropagation() });
                ghost.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    revealSoundBtn()
                });

                btn.addEventListener('pointerdown', function (e) {
                    pressMoved = false;
                    pressStartX = e.clientX;
                    pressStartY = e.clientY;
                    clearTimeout(pressTimer);
                    clearTimeout(holdVisualTimer);
                    holdVisualTimer = setTimeout(() => {
                        if (!pressMoved) btn.classList.add('btn-holding')
                    }, HOLD_VISUAL_DELAY_MS);
                    pressTimer = setTimeout(() => {
                        if (!pressMoved) {
                            btn.classList.remove('btn-holding');
                            suppressNextClick = true;
                            if (navigator.vibrate) { try { navigator.vibrate(18) } catch (err) {} }
                            showBadge()
                        }
                    }, LONG_PRESS_MS)
                });
                btn.addEventListener('pointermove', function (e) {
                    const dx = e.clientX - pressStartX, dy = e.clientY - pressStartY;
                    if (Math.hypot(dx, dy) > MOVE_CANCEL_PX) {
                        pressMoved = true;
                        btn.classList.remove('btn-holding');
                        clearTimeout(pressTimer);
                        clearTimeout(holdVisualTimer)
                    }
                });
                function clearHoldState() {
                    clearTimeout(pressTimer);
                    clearTimeout(holdVisualTimer);
                    btn.classList.remove('btn-holding')
                }
                btn.addEventListener('pointerup', clearHoldState);
                btn.addEventListener('pointercancel', clearHoldState);

                const originalOnClick = btn.onclick;
                btn.onclick = function (e) {
                    if (suppressNextClick) {
                        suppressNextClick = false;
                        return
                    }
                    if (typeof originalOnClick === 'function') originalOnClick.call(btn, e)
                };

                window.addEventListener('resize', () => {
                    if (badge.classList.contains('visible')) positionBadge();
                    if (btn.style.display === 'none' && ghost.classList.contains('visible')) restoreGhostFromStorage()
                });

                if (isHidden) {
                    btn.style.display = 'none';
                    restoreGhostFromStorage()
                }
            }

            document.addEventListener('click', (e) => {
                const target = e.target.closest('button, a.top-ctrl-btn');
                if (target && !target.classList.contains('no-click-sfx')) sfxClick()
            }, true);
            applyStaticTranslations();
            ['p1', 'p2', 'red', 'blue', 'green', 'yellow', 'hunter', 'escaper'].forEach(buildSwatches);

            function setup2P() {
                players = [{
                    id: 0,
                    name: 'Player 1 (Red)',
                    customName: currentNames.p1,
                    color: customColor('p1'),
                    colorClass: 'red',
                    row: 8,
                    col: 4,
                    walls: 10,
                    maxWalls: 10,
                    target: 'row0',
                    team: 0,
                    finished: !1
                }, {
                    id: 1,
                    name: 'Player 2 (Blue)',
                    customName: currentNames.p2,
                    color: customColor('p2'),
                    colorClass: 'blue',
                    row: 0,
                    col: 4,
                    walls: 10,
                    maxWalls: 10,
                    target: 'row8',
                    team: 1,
                    finished: !1
                }, ];
                turnOrder = [0, 1]
            }

            function setup4P() {
                players = [{
                    id: 0,
                    name: 'Red',
                    customName: currentNames.red,
                    color: customColor('red'),
                    colorClass: 'red',
                    row: 0,
                    col: 2,
                    walls: 6,
                    maxWalls: 6,
                    target: 'row8',
                    team: 0,
                    finished: !1,
                    forfeited: !1
                }, {
                    id: 1,
                    name: 'Blue',
                    customName: currentNames.blue,
                    color: customColor('blue'),
                    colorClass: 'blue',
                    row: 0,
                    col: 6,
                    walls: 6,
                    maxWalls: 6,
                    target: 'row8',
                    team: 0,
                    finished: !1,
                    forfeited: !1
                }, {
                    id: 2,
                    name: 'Green',
                    customName: currentNames.green,
                    color: customColor('green'),
                    colorClass: 'green',
                    row: 8,
                    col: 2,
                    walls: 6,
                    maxWalls: 6,
                    target: 'row0',
                    team: 1,
                    finished: !1,
                    forfeited: !1
                }, {
                    id: 3,
                    name: 'Yellow',
                    customName: currentNames.yellow,
                    color: customColor('yellow'),
                    colorClass: 'yellow',
                    row: 8,
                    col: 6,
                    walls: 6,
                    maxWalls: 6,
                    target: 'row0',
                    team: 1,
                    finished: !1,
                    forfeited: !1
                }, ];
                turnOrder = [0, 2, 1, 3]
            }

            function setupHunter() {
                // In an online Wolf & Sheep match, which player id plays which
                // role comes from the lobby pick/lottery (see resolveHunterRoles
                // and finalizeOnlineLobby); offline (or if that mapping is
                // somehow missing) keeps the original fixed assignment: id 0 is
                // always the Escaper, id 1 is always the Hunter.
                let escaperId = 0,
                    hunterId = 1;
                if (onlineState.active && onlineState.mode === 'hunter' && onlineState.hunterRoleByPlayerId) {
                    const map = onlineState.hunterRoleByPlayerId;
                    if (map[0] === 'hunter') { hunterId = 0; escaperId = 1 } else { escaperId = 0; hunterId = 1 }
                }
                players = [{
                    id: escaperId,
                    name: 'Escaper',
                    customName: currentNames.escaper,
                    color: customColor('escaper'),
                    colorClass: 'blue',
                    row: 0,
                    col: 4,
                    walls: 10,
                    maxWalls: 10,
                    target: 'row8',
                    team: 0,
                    finished: !1,
                    role: 'escaper'
                }, {
                    id: hunterId,
                    name: 'Hunter',
                    customName: currentNames.hunter,
                    color: customColor('hunter'),
                    colorClass: 'red',
                    row: 8,
                    col: 4,
                    walls: 8,
                    maxWalls: 8,
                    target: null,
                    team: 1,
                    finished: !1,
                    role: 'hunter'
                }, ];
                turnOrder = [escaperId, hunterId]
            }

            function getDefaultPlayerName(p) {
                const dpn = translations.defaultPlayerNames;
                if (gameMode === 'hunter') {
                    return p.role === 'hunter' ? dpn[0] : dpn[1]
                }
                return dpn[p.id] || dpn[0]
            }

            function playerDisplayName(p) {
                if (p.customName && p.customName.trim()) return p.customName.trim();
                return getDefaultPlayerName(p)
            }

            function teamName(team) {
                return translations.teamNames[team]
            }

            function teamPlayerNames(team) {
                return players.filter(p => p.team === team).map(playerDisplayName).join(' & ')
            }

            function currentPlayer() {
                return players.find(p => p.id === turn)
            }

            function setThemeColor(color) {
                const m = document.querySelector('meta[name="theme-color"]');
                if (m) m.setAttribute('content', color)
            }

            function initGame(mode) {
                gameMode = mode;
                stopTurnTimer();
                turnTimerPlayerId = null;
                onlineMsgQueue = [];
                if (mode === '2p') setup2P();
                else if (mode === '4p') setup4P();
                else setupHunter();
                initPlayerTimeBanks();
                hWalls = Array.from({ length: 9 }, () => Array(9).fill(!1));
                vWalls = Array.from({ length: 9 }, () => Array(9).fill(!1));
                turnIndex = 0;
                turn = turnOrder[0];
                gameOver = !1;
                history = [];
                undoStack = [];
                currentPage = 0;
                uiMode = 'move';
                wallPreviewPos = null;
                pendingWallPos = null;
                isAnimating = !1;
                animData = null;
                wallAnimation = null;
                captureAnim = null;
                huntProximity = 0;
                hideWallConfirm();
                infoMode.textContent = mode === '2p' ? t('mode2p') : (mode === '4p' ? t('mode4p') : t('modeHunter'));
                infoObjective.innerHTML = (mode === '2p' ? t('objective2p') : (mode === '4p' ? t('objective4p') : t(
                    'objectiveHunter'))).replace(/\n/g, '<br>');
                // به‌روزرسانی متن دیوارها بر اساس حالت بازی
                const wallsTextEl = document.getElementById('info-walls-text');
                if (mode === 'hunter') {
                    wallsTextEl.innerHTML = t('wallsTextHunter');
                } else if (mode === '4p') {
                    wallsTextEl.innerHTML = t('wallsText4p');
                } else {
                    wallsTextEl.innerHTML = t('wallsText');
                }
                renderTopbar();
                updateBtnState();
                updateScores();
                updateActivePlayerUI();
                updateHistory();
                updateBoardOrientation();
                draw();
                startOverlay.style.display = 'none';
                appEl.classList.add('visible');
                setThemeColor('#000000');
                btnHome.style.display = onlineState.active ? 'none' : '';
                btnUndo.style.display = onlineState.active ? 'none' : '';
                btnRepeat.style.display = onlineState.active ? 'none' : '';
                const topCtrls = document.getElementById('top-controls');
                if (topCtrls) topCtrls.style.display = 'none';
                const soundBtnHeader = document.getElementById('btn-sound-board');
                if (soundBtnHeader) soundBtnHeader.classList.add('visible');
                sfxGameStart()
            }
            function loadClassicSubMode() {
                const raw = safeStorageGet('barricade-classic-submode');
                return raw === '4p' ? '4p' : '2p'
            }
            let classicSubMode = loadClassicSubMode();
            document.getElementById('btn-start-classic').onclick = () => { nameEntryOrigin = 'offline'; showNameEntry(classicSubMode, !0) };
            document.getElementById('btn-start-hunter').onclick = () => { nameEntryOrigin = 'offline'; showNameEntry('hunter') };
            document.getElementById('btn-pc-2').onclick = () => switchClassicSubMode('2p');
            document.getElementById('btn-pc-4').onclick = () => switchClassicSubMode('4p');

            function playCardAnimation() {
                const card = document.getElementById('name-entry-view');
                if (!card) return;
                card.classList.remove('card-anim');
                void card.offsetWidth;
                card.classList.add('card-anim')
            }

            function setGameType(isOnline) {
                const onlineBtn = document.getElementById('btn-gt-online');
                if (isOnline && onlineBtn.disabled) return;
                selectedGameTypeOnline = isOnline;
                document.getElementById('game-type-toggle').dataset.active = isOnline ? 'online' : 'offline';
                document.getElementById('btn-gt-offline').classList.toggle('active', !isOnline);
                onlineBtn.classList.toggle('active', isOnline);
                document.getElementById('name-entry-view').classList.toggle('gt-online', isOnline);
                updateTimerAvailabilityForGameType()
            }
            document.getElementById('btn-gt-offline').onclick = () => setGameType(!1);
            document.getElementById('btn-gt-online').onclick = () => setGameType(!0);

            function updateGameTypeAvailability(mode) {
                const onlineBtn = document.getElementById('btn-gt-online');
                const lockHint = document.getElementById('game-type-lock-hint');
                const locked = !1;
                onlineBtn.disabled = locked;
                onlineBtn.classList.toggle('locked', locked);
                lockHint.style.display = locked ? 'block' : 'none';
                if (locked && selectedGameTypeOnline) setGameType(!1)
            }

            function updateTimerAvailabilityForGameType() {
                const noTimerChip = document.querySelector('#timer-chip-group .no-timer-chip');
                if (!noTimerChip) return;
                // Online games always run on a timer — the "No timer" chip is
                // removed from the picker entirely (not just disabled) when
                // playing online. Offline keeps it as a normal option.
                noTimerChip.style.display = selectedGameTypeOnline ? 'none' : '';
                noTimerChip.classList.remove('locked');
                if (selectedGameTypeOnline && selectedTimerSeconds === 0) setSelectedTimer(DEFAULT_TIMER_SECONDS)
            }

            function setSelectedTimer(secs) {
                if (secs === 0 && selectedGameTypeOnline) return;
                selectedTimerSeconds = secs;
                safeStorageSet('barricade-timer-secs', String(secs));
                document.querySelectorAll('#timer-chip-group .timer-chip').forEach(chip => {
                    chip.classList.toggle('active', parseInt(chip.dataset.secs, 10) === secs)
                })
            }
            document.querySelectorAll('#timer-chip-group .timer-chip').forEach(chip => {
                chip.onclick = () => setSelectedTimer(parseInt(chip.dataset.secs, 10))
            });

            function switchClassicSubMode(mode) {
                classicSubMode = mode;
                safeStorageSet('barricade-classic-submode', mode);
                selectedMode = mode;
                const fields2p = document.getElementById('name-fields-2p');
                const fields4p = document.getElementById('name-fields-4p');
                fields2p.style.display = mode === '2p' ? 'block' : 'none';
                fields4p.style.display = mode === '4p' ? 'block' : 'none';
                document.getElementById('btn-pc-2').classList.toggle('active', mode === '2p');
                document.getElementById('btn-pc-4').classList.toggle('active', mode === '4p');
                document.getElementById('player-count-toggle').dataset.active = (mode === '4p' ? '4' : '2');
                updateGameTypeAvailability(mode)
            }

            function showNameEntry(mode, isClassic) {
                selectedMode = mode;
                showStartScreen('name-entry-view');
                document.getElementById('online-create-mode-pick').style.display = 'none';
                document.getElementById('online-code-entry-wrap').style.display = 'none';
                setGameType(!1);
                setSelectedTimer(selectedTimerSeconds);
                const pcToggle = document.getElementById('player-count-toggle');
                if (isClassic) {
                    pcToggle.style.display = 'flex';
                    switchClassicSubMode(mode)
                } else {
                    pcToggle.style.display = 'none';
                    document.getElementById('name-fields-2p').style.display = mode === '2p' ? 'block' : 'none';
                    document.getElementById('name-fields-4p').style.display = mode === '4p' ? 'block' : 'none';
                    updateGameTypeAvailability(mode)
                }
                document.getElementById('name-fields-hunter').style.display = mode === 'hunter' ? 'block' : 'none';
                document.getElementById('input-name-p1').value = currentNames.p1;
                document.getElementById('input-name-p2').value = currentNames.p2;
                document.getElementById('input-name-red').value = currentNames.red;
                document.getElementById('input-name-blue').value = currentNames.blue;
                document.getElementById('input-name-green').value = currentNames.green;
                document.getElementById('input-name-yellow').value = currentNames.yellow;
                document.getElementById('input-name-hunter').value = currentNames.hunter;
                document.getElementById('input-name-escaper').value = currentNames.escaper;
                ['p1', 'p2', 'red', 'blue', 'green', 'yellow', 'hunter', 'escaper'].forEach(refreshSwatchUI);
                applyStaticTranslations();
                setTextContent('name-entry-title', t(mode === 'hunter' ? 'modeHunterTitle' : 'modeClassicShort'))
            }
            document.getElementById('btn-name-back').onclick = () => {
                if (nameEntryOrigin === 'online') {
                    showStartScreen('online-setup-view');
                    resetOnlineSetupUI()
                } else {
                    showStartScreen('offline-mode-pick-view')
                }
            };
            document.getElementById('btn-name-confirm').onclick = () => {
                if (selectedGameTypeOnline) {
                    onlineState.mode = selectedMode;
                    onlineState.timerSeconds = selectedTimerSeconds;
                    onlineEntryFromNameEntry = !0;
                    const codeVal = onlineNameEntryCodeInput ? onlineNameEntryCodeInput.value.trim().toUpperCase() : '';
                    showStartScreen('online-setup-view');
                    onlineModeSelectView.style.display = 'none';
                    onlineChoiceView.style.display = 'none';
                    onlineCreateView.style.display = 'none';
                    onlineJoinStatus.textContent = '';
                    if (codeVal.length >= 5) {
                        // A code was typed right here on the settings screen —
                        // connect directly instead of asking for it again on
                        // a separate "join" screen.
                        onlineJoinView.style.display = 'flex';
                        onlineJoinView.classList.add('autoconnecting');
                        startOnlineJoinFlow(codeVal, !1)
                    } else {
                        startOnlineCreateFlow()
                    }
                    return
                }
                if (selectedMode === '2p') {
                    currentNames.p1 = document.getElementById('input-name-p1').value.trim();
                    currentNames.p2 = document.getElementById('input-name-p2').value.trim();
                    safeStorageSet('barricade-name-p1', currentNames.p1);
                    safeStorageSet('barricade-name-p2', currentNames.p2)
                } else if (selectedMode === '4p') {
                    currentNames.red = document.getElementById('input-name-red').value.trim();
                    currentNames.blue = document.getElementById('input-name-blue').value.trim();
                    currentNames.green = document.getElementById('input-name-green').value.trim();
                    currentNames.yellow = document.getElementById('input-name-yellow').value.trim();
                    safeStorageSet('barricade-name-red', currentNames.red);
                    safeStorageSet('barricade-name-blue', currentNames.blue);
                    safeStorageSet('barricade-name-green', currentNames.green);
                    safeStorageSet('barricade-name-yellow', currentNames.yellow)
                } else {
                    currentNames.hunter = document.getElementById('input-name-hunter').value.trim();
                    currentNames.escaper = document.getElementById('input-name-escaper').value.trim();
                    safeStorageSet('barricade-name-hunter', currentNames.hunter);
                    safeStorageSet('barricade-name-escaper', currentNames.escaper)
                }
                currentTurnTimerSeconds = selectedTimerSeconds;
                initGame(selectedMode)
            };
            async function confirmGoHome() {
                if (!(await showConfirmDialog(t('confirmNewGame'), t('confirmHomeYes'), t('confirmHomeNo')))) return;
                goHome()
            }
            btnHome.onclick = confirmGoHome;
            btnRepeat.onclick = async () => {
                if (isAnimating) return;
                if (!(await showConfirmDialog(t('confirmRepeat'), t('confirmRepeatYes'), t('confirmRepeatNo')))) return;
                restartSameGame()
            };
            function performResign(player) {
                gameOver = !0;
                pendingWallPos = null;
                wallPreviewPos = null;
                hideWallConfirm();
                updateActivePlayerUI();
                draw();
                sendOnlineCheckpoint();
                if (gameMode === '2p' || gameMode === 'hunter') {
                    const winner = players.find(p => p.id !== player.id);
                    setTimeout(() => showGameOverDialog(winner, player), 50)
                } else {
                    const winTeam = player.team === 0 ? 1 : 0;
                    setTimeout(() => showGameOverDialog(null, null, winTeam), 50)
                }
            }
            function performForfeit4p(player) {
                player.forfeited = !0;
                const mate = players.find(p => p.team === player.team && p.id !== player.id);
                const bothOut = !mate || mate.forfeited;
                if (bothOut) {
                    gameOver = !0;
                    updateActivePlayerUI();
                    renderTopbar();
                    draw();
                    sendOnlineCheckpoint();
                    setTimeout(() => showGameOverDialog(null, null, player.team === 0 ? 1 : 0), 50);
                    return
                }
                if (currentPlayer() && currentPlayer().id === player.id) {
                    advanceTurn()
                }
                updateActivePlayerUI();
                renderTopbar();
                draw();
                sendOnlineCheckpoint()
            }

            btnResign.onclick = async () => {
                if (gameOver || isAnimating) return;
                const player = onlineState.active ? (players.find(p => p.id === onlineState.localPlayerId) || currentPlayer()) : currentPlayer();
                if (!(await showConfirmDialog(fmt(t('confirmResign'), { name: playerDisplayName(player) }), t('confirmResignYes'), t('confirmResignNo')))) return;
                if (onlineState.active && gameMode === '4p') {
                    performForfeit4p(player);
                    sendOnline({ type: 'forfeit', playerId: player.id })
                } else {
                    performResign(player);
                    if (onlineState.active) sendOnline({ type: 'resign', playerId: player.id })
                }
            };

            function renderTopbar() {
                topbarEl.innerHTML = '';
                if (gameMode === '2p' || gameMode === 'hunter') {
                    topbarEl.className = 'topbar mode-2p';
                    const p0 = players[0],
                        p1 = players[1];
                    const card0 = createPlayerCard(p0);
                    const card1 = createPlayerCard(p1);
                    const vsBox = document.createElement('div');
                    vsBox.className = 'bet-box';
                    vsBox.innerHTML = `<span class="vs-x">VS</span>`;
                    topbarEl.append(card0, vsBox, card1);
                    const mobileTopbar = document.getElementById('topbar-4p-mobile');
                    if (mobileTopbar) mobileTopbar.remove()
                } else {
                    topbarEl.className = 'topbar mode-4p desktop-4p';
                    for (const p of players) {
                        topbarEl.appendChild(createPlayerCard(p))
                    }
                    renderMobileTeamTopbar()
                }
            }

            function renderMobileTeamTopbar() {
                let mobileTopbar = document.getElementById('topbar-4p-mobile');
                if (mobileTopbar) mobileTopbar.remove();
                mobileTopbar = document.createElement('div');
                mobileTopbar.className = 'topbar-4p-mobile';
                mobileTopbar.id = 'topbar-4p-mobile';
                const teamAPlayers = players.filter(p => p.team === 0);
                const teamBPlayers = players.filter(p => p.team === 1);
                const colA = document.createElement('div');
                colA.className = 'team-col';
                teamAPlayers.forEach(p => colA.appendChild(createPlayerCard(p, !0)));
                const vsBox = document.createElement('div');
                vsBox.className = 'bet-box';
                vsBox.innerHTML = `<span class="vs-x">VS</span>`;
                const colB = document.createElement('div');
                colB.className = 'team-col';
                teamBPlayers.forEach(p => colB.appendChild(createPlayerCard(p, !0)));
                mobileTopbar.append(colA, vsBox, colB);
                topbarEl.insertAdjacentElement('afterend', mobileTopbar)
            }

            function createWallGauge(p, alignRight, mobileTeamRight) {
                const wrap = document.createElement('div');
                wrap.className = 'wall-gauge' + (alignRight ? ' align-right' : '');
                wrap.dataset.playerId = p.id;
                const pipRow = document.createElement('div');
                pipRow.className = 'wall-gauge-pips';
                const maxWalls = p.maxWalls || 10;
                for (let i = 0; i < maxWalls; i++) {
                    const pip = document.createElement('span');
                    pip.className = 'wall-pip';
                    if (i < p.walls) {
                        pip.classList.add('filled');
                        pip.style.background = p.color;
                        pip.style.color = p.color
                    }
                    pipRow.appendChild(pip)
                }
                const label = document.createElement('div');
                label.className = 'wall-gauge-label';
                const numSpan = document.createElement('span');
                numSpan.className = 'wall-gauge-num';
                numSpan.dataset.playerId = p.id;
                numSpan.textContent = localizeNum(p.walls);
                const iconSpan = document.createElement('span');
                iconSpan.className = 'wall-gauge-icon';
                iconSpan.innerHTML = '<svg class="icon-svg sm" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="4" y1="12" x2="20" y2="12"/></svg>';
                if (mobileTeamRight) {
                    wrap.style.direction = 'ltr';
                    wrap.style.flexDirection = 'row';
                    wrap.style.justifyContent = 'flex-end';
                    label.append(numSpan, iconSpan);
                    wrap.append(pipRow, label);
                } else {
                    label.append(iconSpan, numSpan);
                    wrap.append(label, pipRow);
                }
                return wrap
            }

            function createPlayerTimer(p, mobileTeamRight) {
                const wrap = document.createElement('div');
                wrap.className = 'player-timer';
                wrap.dataset.playerId = p.id;
                const iconSpan = document.createElement('span');
                iconSpan.className = 'pt-icon';
                iconSpan.innerHTML = '<svg class="icon-svg sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg>';
                const track = document.createElement('div');
                track.className = 'pt-track';
                const fill = document.createElement('div');
                fill.className = 'pt-fill';
                const timeSpan = document.createElement('span');
                timeSpan.className = 'pt-time';
                timeSpan.textContent = '--:--';
                track.append(fill, timeSpan);
                if (mobileTeamRight) {
                    wrap.style.direction = 'ltr';
                    wrap.style.flexDirection = 'row';
                    wrap.style.justifyContent = 'flex-end';
                }
                wrap.append(iconSpan, track);
                return wrap
            }

            function createPlayerCard(p, forMobileTeamLayout) {
                const card = document.createElement('div');
                card.className = `player-card ${p.colorClass}`;
                card.dataset.playerId = p.id;
                const isTeamBIn4p = gameMode === '4p' && p.team === 1;
                if (isTeamBIn4p) card.classList.add('team-b-align');
                // NOTE: for 'hunter' mode we must NOT key this off p.id.
                // setupHunter() always builds the players array as
                // [escaperObj, hunterObj] (escaper first/left, hunter
                // second/right) regardless of which numeric id ends up on
                // which role — in online matches the role lottery can hand
                // id 0 to the hunter and id 1 to the escaper. Using p.id===1
                // here would then flip the *internal* alignment of a card
                // whose *position* never actually moved, breaking the
                // layout only in that (random) case. p.role stays correctly
                // tied to array position, so use that instead for hunter mode.
                const isRightSide = (!forMobileTeamLayout && ((gameMode === '2p' && p.id === 1) || (gameMode === 'hunter' && p.role === 'hunter'))) || (forMobileTeamLayout && p.team === 1) || isTeamBIn4p;
                const avatar = document.createElement('div');
                avatar.className = 'avatar';
                avatar.style.background = p.color;
                const info = document.createElement('div');
                info.className = 'player-info';
                
                if (isRightSide) {
                    info.style.direction = 'rtl';
                    info.style.textAlign = 'right';
                } else {
                    info.style.direction = 'ltr';
                    info.style.textAlign = 'left';
                }

                const nameDiv = document.createElement('div');
                nameDiv.className = 'name';
                nameDiv.textContent = playerDisplayName(p);
                if (p.forfeited) {
                    card.classList.add('forfeited');
                    const badge = document.createElement('span');
                    badge.className = 'forfeit-badge';
                    badge.textContent = 'Forfeited';
                    nameDiv.appendChild(badge)
                }
                info.appendChild(nameDiv);
                if (gameMode === '4p') {
                    const teamDiv = document.createElement('div');
                    teamDiv.className = 'team-label';
                    teamDiv.textContent = p.team === 0 ? t('teamA') : t('teamB');
                    info.appendChild(teamDiv)
                } else if (gameMode === 'hunter') {
                    const roleDiv = document.createElement('div');
                    roleDiv.className = 'team-label';
                    roleDiv.textContent = p.role === 'hunter' ? t('roleHunter') : t('roleEscaper');
                    info.appendChild(roleDiv);
                    if (p.role === 'escaper') {
                        const proxDiv = document.createElement('div');
                        proxDiv.className = 'hunt-proximity';
                        proxDiv.dataset.huntProximity = '1';
                        for (let i = 0; i < HUNT_PROXIMITY_MAX; i++) {
                            const dot = document.createElement('span');
                            dot.className = 'hunt-dot';
                            proxDiv.appendChild(dot)
                        }
                        info.appendChild(proxDiv)
                    }
                }
                const reverseInternal = isTeamBIn4p || (forMobileTeamLayout && isRightSide);
                info.appendChild(createWallGauge(p, isRightSide, reverseInternal));
                info.appendChild(createPlayerTimer(p, reverseInternal));
                card.append(avatar, info, createDisconnectOverlay(p));
                return card
            }

            // Covers just this player's own card while their connection is
            // down — created hidden, toggled by updateDisconnectOverlays().
            // Shows the player's own name front and center (not just left
            // to show through underneath) so it stays readable at a glance.
            function createDisconnectOverlay(p) {
                const overlay = document.createElement('div');
                overlay.className = 'disconnect-overlay';
                overlay.dataset.playerId = p.id;
                const icon = document.createElement('span');
                icon.className = 'do-icon';
                icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M3 3l18 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M8.5 8.8a10.6 10.6 0 0 1 11 .3M5 12.2a15 15 0 0 1 3-2M12 18.2h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 14.6a5.3 5.3 0 0 1 3.3 1.1" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity=".55"/></svg>';
                const text = document.createElement('span');
                text.className = 'do-text';
                const nameEl = document.createElement('span');
                nameEl.className = 'do-name';
                nameEl.textContent = playerDisplayName(p);
                const statusRow = document.createElement('span');
                statusRow.className = 'do-status';
                const label = document.createElement('span');
                label.className = 'do-label';
                label.textContent = t('disconnectOverlayLabel');
                const timeEl = document.createElement('span');
                timeEl.className = 'do-timer';
                timeEl.textContent = '--';
                statusRow.append(label, timeEl);
                text.append(nameEl, statusRow);
                overlay.append(icon, text);
                return overlay
            }

            function getCoordStr(row, col) {
                return colLetters[col] + (9 - row)
            }

            function inBounds(r, c) {
                return r >= 0 && r < 9 && c >= 0 && c < 9
            }

            function canPassBetween(r, c, dr, dc) {
                if (dr === -1) {
                    if (r <= 0) return !1;
                    return !hWalls[r - 1][c]
                }
                if (dr === 1) {
                    if (r >= 8) return !1;
                    return !hWalls[r][c]
                }
                if (dc === -1) {
                    if (c <= 0) return !1;
                    return !vWalls[r][c - 1]
                }
                if (dc === 1) {
                    if (c >= 8) return !1;
                    return !vWalls[r][c]
                }
                return !1
            }

            function isTargetCell(player, r, c) {
                switch (player.target) {
                    case 'row0':
                        return r === 0;
                    case 'row8':
                        return r === 8;
                    default:
                        return !1
                }
            }

            function playerAt(r, c, excludeId) {
                return players.find(p => p.id !== excludeId && p.row === r && p.col === c) || null
            }

            function getValidMoves(player) {
                let moves = [];
                const r = player.row,
                    c = player.col;
                const dirs = [
                    [-1, 0],
                    [1, 0],
                    [0, -1],
                    [0, 1]
                ];
                if (gameMode === 'hunter') {
                    const opponent = players.find(p => p.id !== player.id);
                    for (const [dr, dc] of dirs) {
                        if (!canPassBetween(r, c, dr, dc)) continue;
                        const nr = r + dr,
                            nc = c + dc;
                        if (player.role === 'escaper' && opponent && nr === opponent.row && nc === opponent.col) continue;
                        moves.push([nr, nc])
                    }
                    return moves
                }
                for (const [dr, dc] of dirs) {
                    if (!canPassBetween(r, c, dr, dc)) continue;
                    const nr = r + dr,
                        nc = c + dc;
                    const occ = playerAt(nr, nc, player.id);
                    if (!occ) {
                        moves.push([nr, nc]);
                        continue
                    }
                    if (canPassBetween(nr, nc, dr, dc)) {
                        const jr = nr + dr,
                            jc = nc + dc;
                        if (!playerAt(jr, jc, player.id)) moves.push([jr, jc]);
                    }
                    const perp = dr === 0 ? [
                        [-1, 0],
                        [1, 0]
                    ] : [
                        [0, -1],
                        [0, 1]
                    ];
                    for (const [pdr, pdc] of perp) {
                        if (canPassBetween(nr, nc, pdr, pdc)) {
                            const jr = nr + pdr,
                                jc = nc + pdc;
                            if (!playerAt(jr, jc, player.id)) moves.push([jr, jc]);
                        }
                    }
                }
                return moves
            }

            function canReachTarget(player) {
                const visited = new Set();
                const startKey = player.row + ',' + player.col;
                visited.add(startKey);
                const queue = [
                    [player.row, player.col]
                ];
                while (queue.length > 0) {
                    const [r, c] = queue.shift();
                    if (isTargetCell(player, r, c)) return !0;
                    const dirs = [
                        [-1, 0],
                        [1, 0],
                        [0, -1],
                        [0, 1]
                    ];
                    for (const [dr, dc] of dirs) {
                        if (!canPassBetween(r, c, dr, dc)) continue;
                        const nr = r + dr,
                            nc = c + dc;
                        const key = nr + ',' + nc;
                        if (visited.has(key)) continue;
                        visited.add(key);
                        queue.push([nr, nc])
                    }
                }
                return !1
            }

            function canReachCell(player, targetRow, targetCol) {
                const visited = new Set();
                const startKey = player.row + ',' + player.col;
                visited.add(startKey);
                const queue = [
                    [player.row, player.col]
                ];
                while (queue.length > 0) {
                    const [r, c] = queue.shift();
                    if (r === targetRow && c === targetCol) return !0;
                    const dirs = [
                        [-1, 0],
                        [1, 0],
                        [0, -1],
                        [0, 1]
                    ];
                    for (const [dr, dc] of dirs) {
                        if (!canPassBetween(r, c, dr, dc)) continue;
                        const nr = r + dr,
                            nc = c + dc;
                        const key = nr + ',' + nc;
                        if (visited.has(key)) continue;
                        visited.add(key);
                        queue.push([nr, nc])
                    }
                }
                return !1
            }

            function startAnimation(oldRow, oldCol, newRow, newCol, player, callback) {
                if (isAnimating) return;
                isAnimating = !0;
                const startX = padding + oldCol * cellSize + cellSize / 2;
                const startY = padding + oldRow * cellSize + cellSize / 2;
                const endX = padding + newCol * cellSize + cellSize / 2;
                const endY = padding + newRow * cellSize + cellSize / 2;
                animData = {
                    x1: startX,
                    y1: startY,
                    x2: endX,
                    y2: endY,
                    color: player.color,
                    playerId: player.id,
                    progress: 0,
                    callback
                };
                loopAnimation()
            }

            function animateWall(wallKey, callback) {
                wallAnimation = {
                    row: wallKey.row,
                    col: wallKey.col,
                    isH: wallKey.isH,
                    progress: 0,
                    callback
                };
                loopAnimation()
            }

            function loopAnimation() {
                const step = 1 / 12;
                let updated = !1;
                if (animData) {
                    animData.progress += step;
                    if (animData.progress >= 1) {
                        animData.progress = 1;
                        draw();
                        const cb = animData.callback;
                        animData = null;
                        isAnimating = !1;
                        if (cb) cb();
                        // Now that our own move/turn state is fully settled,
                        // apply anything the opponent sent us while we were
                        // still mid-animation (see handleOnlineData).
                        drainOnlineMsgQueue();
                        updated = !0
                    } else {
                        draw();
                        updated = !0
                    }
                }
                if (wallAnimation) {
                    wallAnimation.progress += step;
                    if (wallAnimation.progress >= 1) {
                        wallAnimation.progress = 1;
                        draw();
                        const cb = wallAnimation.callback;
                        wallAnimation = null;
                        if (cb) cb();
                        updated = !0
                    } else {
                        draw();
                        updated = !0
                    }
                }
                if (updated && (animData || wallAnimation)) requestAnimationFrame(loopAnimation)
            }

            function draw() {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.strokeStyle = '#282f3a';
                ctx.lineWidth = 1.2;
                for (let i = 0; i <= 9; i++) {
                    ctx.beginPath();
                    ctx.moveTo(padding, padding + i * cellSize);
                    ctx.lineTo(padding + 9 * cellSize, padding + i * cellSize);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.moveTo(padding + i * cellSize, padding);
                    ctx.lineTo(padding + i * cellSize, padding + 9 * cellSize);
                    ctx.stroke()
                }
                for (const p of players) {
                    ctx.fillStyle = hexToRgba(p.color, 0.09);
                    if (p.target === 'row0') ctx.fillRect(padding, padding, 9 * cellSize, cellSize);
                    else if (p.target === 'row8') ctx.fillRect(padding, padding + 8 * cellSize, 9 * cellSize, cellSize);
                }
                if (!gameOver && uiMode === 'move' && !isAnimating && !captureAnim && players.length && (!onlineState.active || isMyOnlineTurn())) {
                    const player = currentPlayer();
                    const moves = getValidMoves(player);
                    const pulse = Math.sin(Date.now() / 300) * 0.3 + 0.7;
                    let capturePos = null;
                    if (gameMode === 'hunter' && player.role === 'hunter') {
                        const escaperP = players.find(p => p.role === 'escaper');
                        capturePos = { row: escaperP.row, col: escaperP.col }
                    }
                    ctx.lineWidth = 2.5;
                    ctx.shadowBlur = 8;
                    for (let [r, c] of moves) {
                        const isCapture = capturePos && r === capturePos.row && c === capturePos.col;
                        if (isCapture) {
                            ctx.strokeStyle = `rgba(255,59,48,${Math.min(1,pulse+0.15)})`;
                            ctx.shadowColor = 'rgba(255,59,48,0.65)'
                        } else {
                            ctx.strokeStyle = `rgba(255,255,255,${pulse*0.6})`;
                            ctx.shadowColor = 'rgba(255,255,255,0.4)'
                        }
                        ctx.strokeRect(padding + c * cellSize + 3, padding + r * cellSize + 3, cellSize - 6, cellSize - 6)
                    }
                    ctx.shadowBlur = 0
                }
                if (!gameOver && (uiMode === 'hwall' || uiMode === 'vwall') && wallPreviewPos && !pendingWallPos && !
                    isAnimating && (!onlineState.active || isMyOnlineTurn())) {
                    let pos = wallPreviewPos;
                    ctx.fillStyle = 'rgba(255,255,255,0.35)';
                    ctx.shadowBlur = 12;
                    ctx.shadowColor = 'rgba(255,255,255,0.25)';
                    ctx.beginPath();
                    if (uiMode === 'hwall') ctx.roundRect(padding + pos.col * cellSize, padding + (pos.row + 1) * cellSize -
                        4, cellSize * 2, 8, 4);
                    else ctx.roundRect(padding + (pos.col + 1) * cellSize - 4, padding + pos.row * cellSize, 8, cellSize * 2,
                        4);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                    if (touchAnchorPos) {
                        const barCx = padding + (pos.col + 1) * cellSize;
                        const barCy = padding + (pos.row + 1) * cellSize;
                        const anchorX = padding + touchAnchorPos.x;
                        const anchorY = padding + touchAnchorPos.y;
                        ctx.save();
                        ctx.setLineDash([3, 4]);
                        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.moveTo(barCx, barCy);
                        ctx.lineTo(anchorX, anchorY);
                        ctx.stroke();
                        ctx.restore();
                        ctx.beginPath();
                        ctx.fillStyle = 'rgba(255,255,255,0.18)';
                        ctx.arc(anchorX, anchorY, 13, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.beginPath();
                        ctx.fillStyle = 'rgba(255,255,255,0.55)';
                        ctx.arc(anchorX, anchorY, 3.5, 0, Math.PI * 2);
                        ctx.fill()
                    }
                }
                if (!gameOver && pendingWallPos && !isAnimating) {
                    let pos = pendingWallPos;
                    const pulse = Math.sin(Date.now() / 220) * 0.25 + 0.75;
                    const col = currentPlayer() ? currentPlayer().color : '#ffffff';
                    ctx.fillStyle = hexToRgba(col, 0.55 * pulse);
                    ctx.shadowBlur = 16;
                    ctx.shadowColor = hexToRgba(col, 0.7);
                    ctx.beginPath();
                    if (pos.mode === 'hwall') ctx.roundRect(padding + pos.col * cellSize, padding + (pos.row + 1) * cellSize -
                        4, cellSize * 2, 8, 4);
                    else ctx.roundRect(padding + (pos.col + 1) * cellSize - 4, padding + pos.row * cellSize, 8, cellSize * 2,
                        4);
                    ctx.fill();
                    ctx.shadowBlur = 0
                }
                ctx.fillStyle = '#acb8c8';
                ctx.shadowColor = 'rgba(255,255,255,0.1)';
                ctx.shadowBlur = 6;
                // Draw each wall as a single continuous piece — a placed
                // wall always spans 2 cells (hWalls[row][col] and
                // hWalls[row][col+1] both get set together in confirmWall),
                // but drawing them as two independent rounded rects left a
                // visible seam right where the two halves met. Grouping
                // consecutive true cells (that share the same fade-in
                // opacity) into one rect removes that seam and also means
                // a wall placed mid-animation fades in as one solid piece
                // instead of only its first half animating.
                for (let r = 0; r < 9; r++) {
                    let c = 0;
                    while (c < 9) {
                        if (!hWalls[r][c]) { c++; continue }
                        const alphaOf = cc => (wallAnimation && wallAnimation.isH && wallAnimation.row === r &&
                            (cc === wallAnimation.col || cc === wallAnimation.col + 1)) ? wallAnimation.progress : 1;
                        const startC = c;
                        const a0 = alphaOf(c);
                        let endC = c;
                        while (endC + 1 < 9 && hWalls[r][endC + 1] && alphaOf(endC + 1) === a0) endC++;
                        ctx.globalAlpha = a0;
                        ctx.beginPath();
                        ctx.roundRect(padding + startC * cellSize, padding + (r + 1) * cellSize - 3, (endC - startC + 1) * cellSize, 6, 3);
                        ctx.fill();
                        c = endC + 1
                    }
                }
                for (let c = 0; c < 9; c++) {
                    let r = 0;
                    while (r < 9) {
                        if (!vWalls[r][c]) { r++; continue }
                        const alphaOf = rr => (wallAnimation && !wallAnimation.isH && wallAnimation.col === c &&
                            (rr === wallAnimation.row || rr === wallAnimation.row + 1)) ? wallAnimation.progress : 1;
                        const startR = r;
                        const a0 = alphaOf(r);
                        let endR = r;
                        while (endR + 1 < 9 && vWalls[endR + 1][c] && alphaOf(endR + 1) === a0) endR++;
                        ctx.globalAlpha = a0;
                        ctx.beginPath();
                        ctx.roundRect(padding + (c + 1) * cellSize - 3, padding + startR * cellSize, 8, (endR - startR + 1) * cellSize, 3);
                        ctx.fill();
                        r = endR + 1
                    }
                }
                ctx.globalAlpha = 1;
                ctx.shadowBlur = 0;
                for (const p of players) {
                    if (captureAnim && (p.role === 'hunter' || p.role === 'escaper')) continue;
                    drawPiece(p, animData && animData.playerId === p.id)
                }
                if (captureAnim) drawCaptureAnimation()
            }

            function drawCaptureAnimation() {
                const hunterP = players.find(p => p.role === 'hunter');
                const escaperP = players.find(p => p.role === 'escaper');
                const x = padding + escaperP.col * cellSize + cellSize / 2;
                const y = padding + escaperP.row * cellSize + cellSize / 2;
                const p = captureAnim.progress;
                ctx.save();
                if (p < 0.55) {
                    const shockP = p / 0.55;
                    const shockR = cellSize * 0.15 + shockP * cellSize * 0.9;
                    ctx.globalAlpha = Math.max(0, 0.5 * (1 - shockP));
                    ctx.beginPath();
                    ctx.arc(x, y, shockR, 0, Math.PI * 2);
                    ctx.strokeStyle = hunterP.color;
                    ctx.lineWidth = 3 * (1 - shockP) + 0.5;
                    ctx.stroke()
                }
                ctx.restore();
                const escRadius = cellSize * 0.34 * Math.max(0, 1 - Math.pow(p * 1.15, 1.4));
                if (escRadius > 0.6) {
                    ctx.save();
                    const wobble = Math.sin(p * 40) * 2 * (1 - p);
                    ctx.translate(wobble, 0);
                    ctx.globalAlpha = Math.max(0, 1 - p * 1.25);
                    ctx.beginPath();
                    ctx.arc(x, y, escRadius, 0, Math.PI * 2);
                    ctx.fillStyle = escaperP.color;
                    ctx.fill();
                    ctx.restore();
                    if (p < 0.5) {
                        const sparkCount = 6;
                        for (let i = 0; i < sparkCount; i++) {
                            const ang = (i / sparkCount) * Math.PI * 2 + p * 3;
                            const dist = escRadius * 0.6 + p * cellSize * 0.5;
                            const sx = x + Math.cos(ang) * dist,
                                sy = y + Math.sin(ang) * dist;
                            ctx.save();
                            ctx.globalAlpha = Math.max(0, (0.5 - p) * 1.6);
                            ctx.beginPath();
                            ctx.arc(sx, sy, 2.2 * (1 - p * 1.5), 0, Math.PI * 2);
                            ctx.fillStyle = escaperP.color;
                            ctx.fill();
                            ctx.restore()
                        }
                    }
                }
                const mouthAngle = Math.abs(Math.sin(p * Math.PI * 3.2)) * 0.42 + 0.03;
                const squash = 1 + Math.sin(Math.min(1, p * 2.2) * Math.PI) * 0.14;
                const radius = cellSize * 0.38 * squash;
                ctx.save();
                ctx.translate(x, y);
                ctx.scale(1, 1 / squash);
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.arc(0, 0, radius, mouthAngle, Math.PI * 2 - mouthAngle);
                ctx.closePath();
                const grad = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius);
                grad.addColorStop(0, hexToRgba(hunterP.color, 1));
                grad.addColorStop(1, hexToRgba(hunterP.color, 0.85));
                ctx.fillStyle = grad;
                ctx.shadowColor = hexToRgba(hunterP.color, 0.75);
                ctx.shadowBlur = 14;
                ctx.fill();
                ctx.restore();
                if (p > 0.55) {
                    const ringP = (p - 0.55) / 0.45;
                    ctx.save();
                    ctx.globalAlpha = Math.max(0, 0.55 * (1 - ringP));
                    ctx.beginPath();
                    ctx.arc(x, y, radius * (1 + ringP * 0.7), 0, Math.PI * 2);
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 2 * (1 - ringP);
                    ctx.stroke();
                    ctx.restore()
                }
            }

            function hexToRgba(hex, alpha) {
                const r = parseInt(hex.slice(1, 3), 16),
                    g = parseInt(hex.slice(3, 5), 16),
                    b = parseInt(hex.slice(5, 7), 16);
                return `rgba(${r},${g},${b},${alpha})`
            }

            function drawPiece(player, isAnimatingPiece) {
                let x = padding + player.col * cellSize + cellSize / 2;
                let y = padding + player.row * cellSize + cellSize / 2;
                if (isAnimatingPiece && animData) {
                    const p = Math.min(1, animData.progress);
                    const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
                    x = animData.x1 + (animData.x2 - animData.x1) * ease;
                    y = animData.y1 + (animData.y2 - animData.y1) * ease;
                }
                const radius = cellSize * 0.34;
                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fillStyle = player.color;
                ctx.fill();
            }
            if (!CanvasRenderingContext2D.prototype.roundRect) {
                CanvasRenderingContext2D.prototype.roundRect = function(x, y, w, h, r) {
                    if (r > w / 2) r = w / 2;
                    if (r > h / 2) r = h / 2;
                    this.moveTo(x + r, y);
                    this.arcTo(x + w, y, x + w, y + h, r);
                    this.arcTo(x + w, y + h, x, y + h, r);
                    this.arcTo(x, y + h, x, y, r);
                    this.arcTo(x, y, x + w, y, r);
                    return this
                }
            }

            function makeSnapshot() {
                return {
                    players: players.map(p => ({ ...p })),
                    hWalls: hWalls.map(a => [...a]),
                    vWalls: vWalls.map(a => [...a]),
                    turnIndex: turnIndex,
                    turn: turn,
                    historyLen: history.length,
                    gameOver: gameOver,
                    huntProximity: huntProximity
                }
            }
            btnUndo.onclick = () => {
                if (isAnimating) return;
                if (onlineState.active) { showToast('Undo is not available in online games', 'warning'); return }
                if (undoStack.length === 0) {
                    showToast(t('toastNothingToUndo'), 'warning');
                    return
                }
                const snap = undoStack.pop();
                players = snap.players.map(p => ({ ...p }));
                hWalls = snap.hWalls.map(a => [...a]);
                vWalls = snap.vWalls.map(a => [...a]);
                turnIndex = snap.turnIndex;
                turn = snap.turn;
                gameOver = snap.gameOver;
                huntProximity = snap.huntProximity || 0;
                history.splice(snap.historyLen);
                animData = null;
                wallAnimation = null;
                captureAnim = null;
                isAnimating = !1;
                pendingWallPos = null;
                wallPreviewPos = null;
                hideWallConfirm();
                const totalPages = Math.max(1, Math.ceil(history.length / ITEMS_PER_PAGE));
                if (currentPage >= totalPages) currentPage = totalPages - 1;
                if (currentPage < 0) currentPage = 0;
                updateHistory();
                updateScores();
                updateActivePlayerUI();
                updateProximityUI();
                draw()
            };

            // Returns true if the move was accepted and applied, false if it
            // was rejected. The caller (processOnlineMessage) uses this to
            // tell a rejected remote move apart from a silently-dropped one —
            // previously there was no way to tell the difference, so a
            // rejected opponent move just vanished with no recovery, leaving
            // the two devices permanently out of sync.
            function executeMove(row, col) {
                if (gameOver || isAnimating) return !1;
                if (onlineState.active && !onlineState.applyingRemote && !isMyOnlineTurn()) return !1;
                if (onlineState.active && !onlineState.applyingRemote && anyDisconnectPending()) {
                    showToast(t('matchPausedToast'), 'warning');
                    return !1
                }
                const player = currentPlayer();
                const moves = getValidMoves(player);
                const valid = moves.some(m => m[0] === row && m[1] === col);
                if (!valid) {
                    showToast(t('toastInvalidMove'), 'warning');
                    return !1
                }
                if (onlineState.active && !onlineState.applyingRemote) sendOnline({ type: 'move', row, col });
                let captureTarget = null;
                if (gameMode === 'hunter' && player.role === 'hunter') {
                    const escaperP = players.find(p => p.role === 'escaper');
                    if (escaperP.row === row && escaperP.col === col) captureTarget = escaperP
                }
                sfxMove();
                undoStack.push(makeSnapshot());
                const oldRow = player.row,
                    oldCol = player.col;
                player.row = row;
                player.col = col;
                history.push({
                    type: 'MOVE',
                    player: player.name,
                    colorClass: player.colorClass,
                    colorHex: player.color,
                    action: getCoordStr(row, col)
                });
                goToLastHistoryPage();
                updateHistory();
                startAnimation(oldRow, oldCol, row, col, player, () => {
                    if (captureTarget) {
                        animateCapture(() => {
                            checkWinAfterMove(player);
                            if (!gameOver) advanceTurn();
                            updateActivePlayerUI();
                            draw();
                            sendOnlineCheckpoint()
                        })
                    } else {
                        checkWinAfterMove(player);
                        // BUGFIX: this used to only check proximity when the
                        // HUNTER moved, so an escaper who voluntarily stepped
                        // right next to the hunter never counted toward the
                        // proximity win condition at all — proximity is about
                        // the two pawns' distance, not about who moved, so it
                        // has to be checked after either side's move.
                        if (!gameOver && gameMode === 'hunter') checkHuntProximity();
                        if (!gameOver) advanceTurn();
                        updateActivePlayerUI();
                        draw();
                        sendOnlineCheckpoint()
                    }
                });
                return !0
            }

            function animateCapture(callback) {
                isAnimating = !0;
                captureAnim = { progress: 0 };
                sfxBite();

                function loop() {
                    captureAnim.progress += 1 / 24;
                    draw();
                    if (captureAnim.progress >= 1) {
                        captureAnim = null;
                        isAnimating = !1;
                        draw();
                        if (callback) callback();
                        // Same reasoning as in loopAnimation(): only replay
                        // queued opponent messages once our own turn state
                        // has fully settled after this animation.
                        drainOnlineMsgQueue();
                        return
                    }
                    requestAnimationFrame(loop)
                }
                loop()
            }

            // Returns true if the wall was accepted and placed, false if it
            // was rejected — same reasoning as executeMove()'s return value:
            // lets processOnlineMessage tell a rejected remote wall apart
            // from one it can't tell was ever handled, and trigger an
            // automatic resync instead of leaving the two devices desynced.
            function confirmWall() {
                if (!pendingWallPos || gameOver || isAnimating) return !1;
                if (onlineState.active && !onlineState.applyingRemote && !isMyOnlineTurn()) {
                    pendingWallPos = null;
                    wallPreviewPos = null;
                    hideWallConfirm();
                    draw();
                    return !1
                }
                if (onlineState.active && !onlineState.applyingRemote && anyDisconnectPending()) {
                    showToast(t('matchPausedToast'), 'warning');
                    return !1
                }
                const player = currentPlayer();
                if (player.walls <= 0) {
                    showToast(t('toastNoWalls'), 'warning');
                    pendingWallPos = null;
                    wallPreviewPos = null;
                    hideWallConfirm();
                    draw();
                    return !1
                }
                const snap0 = makeSnapshot();
                const pos = pendingWallPos;
                const backupH = hWalls.map(a => [...a]);
                const backupV = vWalls.map(a => [...a]);
                let wallKey = null;
                try {
                    if (pos.mode === 'hwall') {
                        const row = pos.row,
                            col = pos.col;
                        if (row < 0 || row > 7 || col < 0 || col > 7) return !1;
                        if (vWalls[row][col] && vWalls[row + 1][col]) {
                            showToast(t('alertPerpendicular'), 'warning');
                            pendingWallPos = null;
                            wallPreviewPos = null;
                            hideWallConfirm();
                            draw();
                            return !1
                        }
                        if (hWalls[row][col] || hWalls[row][col + 1]) {
                            showToast(t('toastWallExists'), 'warning');
                            pendingWallPos = null;
                            wallPreviewPos = null;
                            hideWallConfirm();
                            draw();
                            return !1
                        }
                        hWalls[row][col] = !0;
                        hWalls[row][col + 1] = !0;
                        wallKey = { row, col, isH: !0 }
                    } else {
                        const row = pos.row,
                            col = pos.col;
                        if (row < 0 || row > 7 || col < 0 || col > 7) return !1;
                        if (hWalls[row][col] && hWalls[row][col + 1]) {
                            showToast(t('alertPerpendicular'), 'warning');
                            pendingWallPos = null;
                            wallPreviewPos = null;
                            hideWallConfirm();
                            draw();
                            return !1
                        }
                        if (vWalls[row][col] || vWalls[row + 1][col]) {
                            showToast(t('toastWallExists'), 'warning');
                            pendingWallPos = null;
                            wallPreviewPos = null;
                            hideWallConfirm();
                            draw();
                            return !1
                        }
                        vWalls[row][col] = !0;
                        vWalls[row + 1][col] = !0;
                        wallKey = { row, col, isH: !1 }
                    }
                    let blocksSomeone;
                    if (gameMode === 'hunter') {
                        const hunterP = players.find(p => p.role === 'hunter');
                        const escaperP = players.find(p => p.role === 'escaper');
                        blocksSomeone = !canReachCell(hunterP, escaperP.row, escaperP.col) || !canReachTarget(escaperP)
                    } else {
                        blocksSomeone = players.some(p => !p.finished && !canReachTarget(p))
                    }
                    if (blocksSomeone) {
                        hWalls = backupH;
                        vWalls = backupV;
                        showToast(t('alertBlocked'), 'warning');
                        pendingWallPos = null;
                        wallPreviewPos = null;
                        hideWallConfirm();
                        draw();
                        return !1
                    }
                    if (onlineState.active && !onlineState.applyingRemote) sendOnline({ type: 'wall', row: pos.row, col: pos.col, mode: pos.mode });
                    undoStack.push(snap0);
                    sfxWall();
                    player.walls--;
                    const wallStr = (pos.mode === 'hwall' ? 'H ' : 'V ') + getCoordStr(pos.row, pos.col);
                    history.push({
                        type: 'WALL',
                        player: player.name,
                        colorClass: player.colorClass,
                        colorHex: player.color,
                        action: wallStr
                    });
                    goToLastHistoryPage();
                    updateHistory();
                    updateScores();
                    pendingWallPos = null;
                    wallPreviewPos = null;
                    hideWallConfirm();
                    animateWall(wallKey, () => {
                        advanceTurn();
                        updateActivePlayerUI();
                        draw();
                        sendOnlineCheckpoint()
                    });
                    return !0
                } catch (e) {
                    hWalls = backupH;
                    vWalls = backupV;
                    return !1
                }
            }

            function goToLastHistoryPage() {
                const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE);
                if (currentPage !== totalPages - 1) currentPage = totalPages - 1
            }

            function checkWinAfterMove(player) {
                if (gameMode === 'hunter') {
                    const hunterP = players.find(p => p.role === 'hunter');
                    const escaperP = players.find(p => p.role === 'escaper');
                    if (hunterP.row === escaperP.row && hunterP.col === escaperP.col) {
                        gameOver = !0;
                        setTimeout(() => showGameOverDialog(hunterP, escaperP), 100);
                        updateScores();
                        return
                    }
                    if (isTargetCell(escaperP, escaperP.row, escaperP.col)) {
                        escaperP.finished = !0;
                        gameOver = !0;
                        setTimeout(() => showGameOverDialog(escaperP, hunterP), 100)
                    }
                    updateScores();
                    return
                }
                if (!isTargetCell(player, player.row, player.col)) return;
                player.finished = !0;
                if (gameMode === '2p') {
                    gameOver = !0;
                    const loser = players.find(p => p.id !== player.id);
                    setTimeout(() => showGameOverDialog(player, loser), 100)
                } else {
                    const mate = players.find(p => p.team === player.team && p.id !== player.id);
                    if (mate && mate.finished) {
                        gameOver = !0;
                        setTimeout(() => showGameOverDialog(null, null, player.team), 100)
                    }
                }
                updateScores()
            }

            function updateProximityUI() {
                document.querySelectorAll('.hunt-proximity').forEach(badge => {
                    const dots = badge.querySelectorAll('.hunt-dot');
                    dots.forEach((d, i) => d.classList.toggle('filled', i < huntProximity))
                })
            }

            function wallBetween(r1, c1, r2, c2) {
                if (r1 === r2) {
                    const col = Math.min(c1, c2);
                    return !!vWalls[r1][col]
                }
                if (c1 === c2) {
                    const row = Math.min(r1, r2);
                    return !!hWalls[row][c1]
                }
                return !1
            }

            function checkHuntProximity() {
                if (gameMode !== 'hunter' || gameOver) return;
                const hunterP = players.find(p => p.role === 'hunter');
                const escaperP = players.find(p => p.role === 'escaper');
                if (isAdjacent(hunterP.row, hunterP.col, escaperP.row, escaperP.col) && !wallBetween(hunterP.row, hunterP.col,
                        escaperP.row, escaperP.col)) {
                    huntProximity++;
                    updateProximityUI();
                    sfxProximity();
                    if (huntProximity >= HUNT_PROXIMITY_MAX) {
                        gameOver = !0;
                        showToast(t('huntProximityWinToast'), 'warning');
                        setTimeout(() => showGameOverDialog(hunterP, escaperP), 150)
                    } else {
                        showToast(fmt(t('huntProximityToast'), { n: huntProximity }), 'warning')
                    }
                }
            }

            function updateDangerState() {
                if (gameMode !== 'hunter') {
                    boardWrapper.classList.remove('danger');
                    return
                }
                const hunterP = players.find(p => p.role === 'hunter');
                const escaperP = players.find(p => p.role === 'escaper');
                const player = currentPlayer();
                const dangerNow = !gameOver && player && player.role === 'escaper' && isAdjacent(hunterP.row, hunterP.col,
                    escaperP.row, escaperP.col) && !wallBetween(hunterP.row, hunterP.col, escaperP.row, escaperP.col);
                boardWrapper.classList.toggle('danger', dangerNow);
            }

            function showGameOverDialog(winnerPlayer, loserPlayer, winnerTeam) {
                clearOnlineSession();
                let winnerLabel, loserLabel, winnerColorClass, winnerColor;
                if (winnerTeam !== undefined && winnerTeam !== null) {
                    const loserTeam = winnerTeam === 0 ? 1 : 0;
                    winnerLabel = teamPlayerNames(winnerTeam);
                    loserLabel = teamPlayerNames(loserTeam);
                    const wp = players.find(p => p.team === winnerTeam);
                    winnerColorClass = wp.colorClass;
                    winnerColor = wp.color
                } else {
                    winnerLabel = playerDisplayName(winnerPlayer);
                    loserLabel = playerDisplayName(loserPlayer);
                    winnerColorClass = winnerPlayer.colorClass;
                    winnerColor = winnerPlayer.color
                }
                goWinnerName.textContent = winnerLabel;
                goWinnerName.className = 'go-winner-name ' + winnerColorClass;
                goWinnerName.style.color = winnerColor;
                goNameWinner.textContent = winnerLabel;
                goNameLoser.textContent = loserLabel;
                gameOverOverlay.classList.add('visible');
                resetOnlineRematchState();
                refreshGameOverDialogOnlineState();
                sfxWin()
            }

            function hideGameOverOverlay() {
                gameOverOverlay.classList.remove('visible')
            }

            function resetOnlineRematchState() {
                onlineRematch.requestedByMe = !1;
                onlineRematch.requestedByOpponent = !1
            }

            function refreshGameOverDialogOnlineState() {
                const statusEl = document.getElementById('go-online-status');
                if (!onlineState.active) {
                    btnGoRepeat.style.display = '';
                    btnGoRepeat.disabled = !1;
                    setTextContent('lbl-go-repeat', t('goPlayAgain'));
                    if (statusEl) statusEl.style.display = 'none';
                    return
                }
                if (onlineState.peerLeft) {
                    btnGoRepeat.style.display = 'none';
                    if (statusEl) { statusEl.textContent = t('opponentLeftMsg'); statusEl.style.display = 'block' }
                    return
                }
                if (statusEl) statusEl.style.display = 'none';
                btnGoRepeat.style.display = '';
                if (onlineRematch.requestedByOpponent) {
                    btnGoRepeat.disabled = !1;
                    setTextContent('lbl-go-repeat', t('rematchAcceptLabel'))
                } else if (onlineRematch.requestedByMe) {
                    btnGoRepeat.disabled = !0;
                    setTextContent('lbl-go-repeat', t('rematchWaitingLabel'))
                } else {
                    btnGoRepeat.disabled = !1;
                    setTextContent('lbl-go-repeat', t('goPlayAgain'))
                }
            }

            function restartSameGame() {
                hideGameOverOverlay();
                resetOnlineRematchState();
                clearAllDisconnectCountdowns();
                initGame(gameMode);
                if (onlineState.active) {
                    applyOnlineIdentitiesToPlayers();
                    renderTopbar();
                    updateScores();
                    updateActivePlayerUI();
                    draw()
                }
            }

            function goHome() {
                hideGameOverOverlay();
                stopTurnTimer();
                turnTimerPlayerId = null;
                onlineEntryFromNameEntry = false;
                if (onlineState.active) { teardownOnline(!0); resetOnlineSetupUI() }
                showStartScreen('mode-select-view');
                startOverlay.style.display = 'flex';
                appEl.classList.remove('visible');
                setThemeColor('#000000');
                const topCtrls = document.getElementById('top-controls');
                if (topCtrls) topCtrls.style.display = 'flex';
                const soundBtnHeader = document.getElementById('btn-sound-board');
                if (soundBtnHeader) soundBtnHeader.classList.remove('visible');
                const mobileTopbar = document.getElementById('topbar-4p-mobile');
                if (mobileTopbar) mobileTopbar.remove();
                window.scrollTo(0, 0)
            }
            btnGoRepeat.onclick = async () => {
                if (!onlineState.active) { restartSameGame(); return }
                if (onlineState.peerLeft) return;
                if (onlineRematch.requestedByOpponent) {
                    onlineRematch.requestedByOpponent = !1;
                    onlineRematch.requestedByMe = !1;
                    sendOnline({ type: 'rematch-accept' });
                    restartSameGame();
                    return
                }
                if (!onlineRematch.requestedByMe) {
                    onlineRematch.requestedByMe = !0;
                    sendOnline({ type: 'rematch-request' });
                    refreshGameOverDialogOnlineState()
                }
            };
            btnGoHome.onclick = goHome;

            function advanceTurn() {
                if (gameOver) return;
                let attempts = 0;
                const allFinished = players.every(p => p.finished || p.forfeited);
                if (allFinished) return;
                do {
                    turnIndex = (turnIndex + 1) % turnOrder.length;
                    attempts++
                } while ((players.find(p => p.id === turnOrder[turnIndex]).finished || players.find(p => p.id === turnOrder[turnIndex]).forfeited) && attempts <= turnOrder.length);
                turn = turnOrder[turnIndex]
            }

            function updateActivePlayerUI() {
                for (const p of players) {
                    document.querySelectorAll(`.player-card[data-player-id="${p.id}"]`).forEach(card => {
                        card.classList.toggle('active', p.id === turn && !gameOver);
                        card.classList.toggle('finished', p.finished)
                    })
                }
                const player = currentPlayer();
                if (player) {
                    statusText.textContent = gameOver ? t('gameOver') : `${playerDisplayName(player)}${t('turnSuffix')}`;
                    statusText.className = gameOver ? '' : `text-${player.colorClass}`;
                    statusText.style.color = gameOver ? '' : player.color;
                    infoWalls.textContent = `${localizeNum(player.walls)} / ${localizeNum(player.maxWalls || 10)}`
                }
                updateDangerState();
                updateOnlineTurnLockUI();
                syncTurnTimer()
            }

            function updateOnlineTurnLockUI() {
                if (!onlineState.active) {
                    hideTurnBanner();
                    return
                }
                const myTurn = isMyOnlineTurn();
                if (!myTurn) {
                    uiMode = 'move';
                    wallPreviewPos = null;
                    pendingWallPos = null;
                    hideWallConfirm();
                    updateBtnState()
                }
                if (!gameOver) showTurnBanner(myTurn); else hideTurnBanner();
                draw()
            }

            function showTurnBanner(myTurn) {
                const row = document.getElementById('online-turn-row');
                if (!row) return;
                row.classList.toggle('otb-mine', myTurn);
                row.classList.toggle('otb-theirs', !myTurn);
                row.querySelector('.otb-text').textContent = myTurn ?
                    'Your turn' :
                    "Opponent's turn";
                row.style.display = 'flex'
            }

            function hideTurnBanner() {
                const row = document.getElementById('online-turn-row');
                if (row) row.style.display = 'none'
            }

            function updateScores() {
                for (const p of players) {
                    document.querySelectorAll(`.wall-gauge-num[data-player-id="${p.id}"]`).forEach(el => {
                        el.textContent = localizeNum(p.walls)
                    });
                    document.querySelectorAll(`.wall-gauge[data-player-id="${p.id}"]`).forEach(gauge => {
                        const pips = gauge.querySelectorAll('.wall-pip');
                        pips.forEach((pip, i) => {
                            const filled = i < p.walls;
                            pip.classList.toggle('filled', filled);
                            pip.style.background = filled ? p.color : '';
                            pip.style.color = p.color
                        })
                    })
                }
                const player = currentPlayer();
                if (player) infoWalls.textContent = `${localizeNum(player.walls)} / ${localizeNum(player.maxWalls || 10)}`
            }

            function updateHistory() {
                historyList.innerHTML = '';
                if (history.length === 0) {
                    const msg = document.createElement('div');
                    msg.style.cssText = 'color: #4a5568; font-size: 12px; text-align: center; padding: 20px 0;';
                    msg.textContent = t('startGame');
                    historyList.appendChild(msg);
                    document.querySelector('.history-pagination').innerHTML =
                        `<span>‹</span> ${localizeNum(1)} / ${localizeNum(1)} <span>›</span>`;
                    return
                }
                const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE);
                if (currentPage >= totalPages) currentPage = totalPages - 1;
                if (currentPage < 0) currentPage = 0;
                const startIndex = currentPage * ITEMS_PER_PAGE;
                const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, history.length);
                const displayHistory = history.slice(startIndex, endIndex);
                const groupSize = (gameMode === '2p' || gameMode === 'hunter') ? 2 : 4;
                const fragment = document.createDocumentFragment();
                for (let i = 0; i < displayHistory.length; i++) {
                    const move = displayHistory[i];
                    const item = document.createElement('div');
                    item.className = 'history-item';
                    const numSpan = document.createElement('span');
                    numSpan.className = 'num';
                    if ((startIndex + i) % groupSize === 0) {
                        numSpan.textContent = localizeNum(Math.floor((startIndex + i) / groupSize) + 1) + '.'
                    }
                    const symbolContainer = document.createElement('span');
                    symbolContainer.className = 'symbol-container';
                    const symbolInner = document.createElement('span');
                    const pClass = move.colorClass || 'red';
                    if (move.type === 'WALL') {
                        symbolInner.className = `symbol-line ${pClass}`;
                        if (move.action.startsWith('H ')) symbolInner.classList.add('horizontal');
                        else symbolInner.classList.add('vertical')
                    } else {
                        symbolInner.className = `symbol-circle ${pClass}`
                    }
                    if (move.colorHex) symbolInner.style.background = move.colorHex;
                    symbolContainer.appendChild(symbolInner);
                    const moveSpan = document.createElement('span');
                    moveSpan.className = 'action-text';
                    moveSpan.textContent = move.action;
                    item.append(numSpan, symbolContainer, moveSpan);
                    fragment.appendChild(item)
                }
                historyList.appendChild(fragment);
                const pagination = document.querySelector('.history-pagination');
                pagination.innerHTML =
                    `<span id="history-prev">‹</span> ${localizeNum(currentPage + 1)} / ${localizeNum(totalPages)} <span id="history-next">›</span>`;
                const prevBtn = document.getElementById('history-prev');
                const nextBtn = document.getElementById('history-next');
                if (currentPage === 0) {
                    prevBtn.style.cursor = 'default';
                    prevBtn.style.color = '#4a5568'
                } else {
                    prevBtn.style.cursor = 'pointer';
                    prevBtn.style.color = 'var(--text-muted)';
                    prevBtn.onclick = () => {
                        if (currentPage > 0) {
                            currentPage--;
                            updateHistory()
                        }
                    }
                }
                if (currentPage === totalPages - 1) {
                    nextBtn.style.cursor = 'default';
                    nextBtn.style.color = '#4a5568'
                } else {
                    nextBtn.style.cursor = 'pointer';
                    nextBtn.style.color = 'var(--text-muted)';
                    nextBtn.onclick = () => {
                        if (currentPage < totalPages - 1) {
                            currentPage++;
                            updateHistory()
                        }
                    }
                }
            }

            function updateBtnState() {
                btnMove.classList.toggle('active', uiMode === 'move');
                btnHWall.classList.toggle('active', uiMode === 'hwall');
                btnVWall.classList.toggle('active', uiMode === 'vwall')
            }

            function showWallConfirm(pos) {
                const canvasRect = canvas.getBoundingClientRect();
                const wrapperRect = boardWrapper.getBoundingClientRect();
                const scaleX = canvasRect.width / canvas.width;
                const scaleY = canvasRect.height / canvas.height;
                let cx, cy;
                if (pos.mode === 'hwall') {
                    cx = padding + pos.col * cellSize + cellSize;
                    cy = padding + (pos.row + 1) * cellSize
                } else {
                    cx = padding + (pos.col + 1) * cellSize;
                    cy = padding + pos.row * cellSize + cellSize
                }
                if (isBoardFlippedForMe()) {
                    cx = canvas.width - cx;
                    cy = canvas.height - cy
                }
                let screenX = (canvasRect.left - wrapperRect.left) + cx * scaleX;
                let screenY = (canvasRect.top - wrapperRect.top) + cy * scaleY;

                const margin = 6;
                const popupW = wallConfirmPopup.offsetWidth;
                const popupH = wallConfirmPopup.offsetHeight;
                const wrapperW = wrapperRect.width;
                const wrapperH = wrapperRect.height;

                if (popupW > 0 && popupH > 0) {
                    // Horizontal clamp: transform is translate(-50%, -140%), so the
                    // popup's rendered left/right edges sit at screenX ± popupW/2.
                    const leftEdge = screenX - popupW / 2;
                    const rightEdge = screenX + popupW / 2;
                    if (leftEdge < margin) screenX += margin - leftEdge;
                    else if (rightEdge > wrapperW - margin) screenX -= rightEdge - (wrapperW - margin);

                    // Vertical clamp: top edge is screenY - 1.4*popupH, bottom edge
                    // is screenY - 0.4*popupH.
                    const topEdge = screenY - popupH * 1.4;
                    const bottomEdge = screenY - popupH * 0.4;
                    if (topEdge < margin) screenY += margin - topEdge;
                    else if (bottomEdge > wrapperH - margin) screenY -= bottomEdge - (wrapperH - margin);
                }

                wallConfirmPopup.style.left = screenX + 'px';
                wallConfirmPopup.style.top = screenY + 'px';
                wallConfirmPopup.classList.add('visible')
            }

            function hideWallConfirm() {
                wallConfirmPopup.classList.remove('visible')
            }
            wallConfirmYes.onclick = confirmWall;
            wallConfirmNo.onclick = () => {
                pendingWallPos = null;
                wallPreviewPos = null;
                hideWallConfirm();
                draw()
            };

            const WALL_OFFSET_MIN = 0;
            const WALL_OFFSET_MAX = 63;
            const WALL_OFFSET_DEFAULT = 54;
            function loadWallPreviewOffset() {
                const raw = parseInt(safeStorageGet('barricade-wall-offset'), 10);
                if (isNaN(raw)) return WALL_OFFSET_DEFAULT;
                return Math.min(WALL_OFFSET_MAX, Math.max(WALL_OFFSET_MIN, raw))
            }
            let wallPreviewOffset = loadWallPreviewOffset();
            function setWallPreviewOffset(px) {
                wallPreviewOffset = Math.min(WALL_OFFSET_MAX, Math.max(WALL_OFFSET_MIN, px));
                safeStorageSet('barricade-wall-offset', String(wallPreviewOffset))
            }
            const wallOffsetSlider = document.getElementById('wall-offset-slider');
            const wallOffsetValue = document.getElementById('wall-offset-value');
            function updateWallOffsetUI() {
                if (wallOffsetSlider) wallOffsetSlider.value = String(wallPreviewOffset);
                if (wallOffsetValue) wallOffsetValue.textContent = wallPreviewOffset + 'px'
            }
            if (wallOffsetSlider) {
                wallOffsetSlider.addEventListener('input', () => {
                    setWallPreviewOffset(parseInt(wallOffsetSlider.value, 10) || 0);
                    updateWallOffsetUI()
                })
            }
            updateWallOffsetUI();

            function getCellFromEvent(e, offsetX, offsetY) {
                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const clientX = e.clientX - (offsetX || 0);
                const clientY = e.clientY - (offsetY || 0);
                let rawX = (clientX - rect.left) * scaleX;
                let rawY = (clientY - rect.top) * scaleY;
                if (isBoardFlippedForMe()) {
                    // Canvas is visually rotated 180deg for this player, so map
                    // the screen point back into the underlying (unrotated)
                    // canvas coordinate space before doing any row/col math.
                    rawX = canvas.width - rawX;
                    rawY = canvas.height - rawY
                }
                let x = rawX - padding;
                let y = rawY - padding;
                if (x < 0 || y < 0 || x > 9 * cellSize || y > 9 * cellSize) return null;
                return { x, y }
            }

            function getWallSnap(e, offsetX, offsetY) {
                const pos = getCellFromEvent(e, offsetX, offsetY);
                if (!pos) return null;
                let x = pos.x,
                    y = pos.y;
                if (uiMode === 'hwall') {
                    let lineIdx = Math.round(y / cellSize);
                    if (lineIdx < 1 || lineIdx > 8) return null;
                    let row = lineIdx - 1;
                    let col = Math.floor(x / cellSize);
                    if (col < 0 || col > 7) return null;
                    return { row, col, mode: 'hwall' }
                } else if (uiMode === 'vwall') {
                    let lineIdx = Math.round(x / cellSize);
                    if (lineIdx < 1 || lineIdx > 8) return null;
                    let col = lineIdx - 1;
                    let row = Math.floor(y / cellSize);
                    if (row < 0 || row > 7) return null;
                    return { row, col, mode: 'vwall' }
                }
                return null
            }

            function handleWallTap(e, offsetX, offsetY) {
                const snap = getWallSnap(e, offsetX, offsetY);
                if (!snap) {
                    if (pendingWallPos) {
                        pendingWallPos = null;
                        hideWallConfirm();
                        draw()
                    }
                    return
                }
                if (!pendingWallPos || pendingWallPos.row !== snap.row || pendingWallPos.col !== snap.col || pendingWallPos
                    .mode !== snap.mode) {
                    pendingWallPos = snap;
                    wallPreviewPos = snap;
                    showWallConfirm(snap);
                    draw()
                }
            }
            canvas.addEventListener('mousemove', (e) => {
                if (gameOver || isAnimating) return;
                if (onlineState.active && !isMyOnlineTurn()) return;
                touchAnchorPos = null;
                if (uiMode !== 'move' && !pendingWallPos) {
                    wallPreviewPos = getWallSnap(e) || null;
                    draw()
                }
            });
            canvas.addEventListener('mousedown', (e) => {
                if (gameOver || isAnimating) return;
                if (onlineState.active && !isMyOnlineTurn()) return;
                if (uiMode === 'move') {
                    const pos = getCellFromEvent(e);
                    if (!pos) return;
                    let col = Math.floor(pos.x / cellSize);
                    let row = Math.floor(pos.y / cellSize);
                    executeMove(row, col)
                } else {
                    handleWallTap(e)
                }
            });
            canvas.addEventListener('mouseleave', () => {
                if (!pendingWallPos) {
                    wallPreviewPos = null;
                    draw()
                }
            });
            canvas.addEventListener('touchstart', (e) => {
                touchDidMove = false
            }, { passive: !0 });
            canvas.addEventListener('touchmove', (e) => {
                e.preventDefault();
                if (gameOver || isAnimating) return;
                if (onlineState.active && !isMyOnlineTurn()) return;
                touchDidMove = true;
                const touch = e.touches[0];
                if (uiMode !== 'move' && !pendingWallPos) {
                    const offsetX = uiMode === 'vwall' ? wallPreviewOffset : 0;
                    const offsetY = uiMode === 'hwall' ? wallPreviewOffset : 0;
                    wallPreviewPos = getWallSnap(touch, offsetX, offsetY) || null;
                    touchAnchorPos = wallPreviewPos ? (getCellFromEvent(touch) || null) : null;
                    draw()
                }
            }, { passive: !1 });
            canvas.addEventListener('touchend', (e) => {
                e.preventDefault();
                if (gameOver || isAnimating) return;
                if (onlineState.active && !isMyOnlineTurn()) return;
                const touch = e.changedTouches[0];
                const offsetX = (touchDidMove && uiMode === 'vwall') ? wallPreviewOffset : 0;
                const offsetY = (touchDidMove && uiMode === 'hwall') ? wallPreviewOffset : 0;
                if (uiMode === 'move') {
                    const pos = getCellFromEvent(touch);
                    if (!pos) return;
                    let col = Math.floor(pos.x / cellSize);
                    let row = Math.floor(pos.y / cellSize);
                    executeMove(row, col)
                } else {
                    handleWallTap(touch, offsetX, offsetY)
                }
                touchAnchorPos = null;
                if (!pendingWallPos) wallPreviewPos = null;
                draw()
            }, { passive: !1 });
            btnMove.onclick = () => {
                uiMode = 'move';
                wallPreviewPos = null;
                pendingWallPos = null;
                hideWallConfirm();
                updateBtnState();
                draw()
            };
            btnHWall.onclick = () => {
                if (onlineState.active && !isMyOnlineTurn()) return;
                uiMode = (uiMode === 'hwall' ? 'move' : 'hwall');
                wallPreviewPos = null;
                pendingWallPos = null;
                hideWallConfirm();
                updateBtnState();
                draw()
            };
            btnVWall.onclick = () => {
                if (onlineState.active && !isMyOnlineTurn()) return;
                uiMode = (uiMode === 'vwall' ? 'move' : 'vwall');
                wallPreviewPos = null;
                pendingWallPos = null;
                hideWallConfirm();
                updateBtnState();
                draw()
            };

            function animateLoop() {
                if (!isAnimating && !gameOver && uiMode === 'move') draw();
                if (pendingWallPos && !isAnimating) draw();
                requestAnimationFrame(animateLoop)
            }
            animateLoop();

            // ========== هدر ثابت: همیشه ارتفاع واقعی آن را اندازه می‌گیریم تا محتوای وسط هرگز زیرش نرود ==========
            const topControls = document.getElementById('top-controls');
            if (topControls) {
                const syncHeaderHeight = () => {
                    document.documentElement.style.setProperty('--header-h', topControls.offsetHeight + 'px');
                };
                syncHeaderHeight();
                window.addEventListener('resize', syncHeaderHeight);
                window.addEventListener('orientationchange', syncHeaderHeight);
                if (window.visualViewport) {
                    window.visualViewport.addEventListener('resize', syncHeaderHeight);
                }
                if (window.ResizeObserver) {
                    new ResizeObserver(syncHeaderHeight).observe(topControls);
                }
            }

            // ========== مدیریت دکمه بازگشت گوشی: هرگز کاربر را کلا از سایت خارج نکن ==========
            // هر بار که back فشرده می‌شود، فقط بالاترین لایه‌ی باز (دیالوگ یا صفحه) بسته/برگردانده
            // می‌شود و یک state تله دوباره push می‌شود تا خروج تصادفی از سایت رخ ندهد.
            function trapBackNav() {
                try {
                    window.history.pushState({ route9BackTrap: true }, '')
                } catch (err) {}
            }

            function handleHardwareBack() {
                const nameEntryView = document.getElementById('name-entry-view');
                if (settingsOverlay.classList.contains('visible')) {
                    settingsOverlay.classList.remove('visible');
                    trapBackNav();
                    return
                }
                const aboutOverlayEl = document.getElementById('about-overlay');
                if (aboutOverlayEl.classList.contains('visible')) {
                    aboutOverlayEl.classList.remove('visible');
                    trapBackNav();
                    return
                }
                if (confirmOverlay.classList.contains('visible')) {
                    closeConfirmDialog(false);
                    trapBackNav();
                    return
                }
                if (gameOverOverlay.classList.contains('visible')) {
                    trapBackNav();
                    btnGoHome.click();
                    return
                }
                if (wallConfirmPopup.classList.contains('visible')) {
                    wallConfirmNo.onclick();
                    trapBackNav();
                    return
                }
                if (appEl.classList.contains('visible')) {
                    trapBackNav();
                    confirmGoHome();
                    return
                }
                if (nameEntryView && nameEntryView.style.display === 'block') {
                    document.getElementById('btn-name-back').click();
                    trapBackNav();
                    return
                }
                // Online setup flow: back out of whichever nested step is
                // currently showing (join code entry -> create/waiting room
                // -> the create/join picker), one step at a time, using the
                // same cancel/back buttons already wired to their onclick
                // handlers — instead of falling through and exiting the site.
                const onlineJoinViewEl = document.getElementById('online-join-view');
                const onlineCreateViewEl = document.getElementById('online-create-view');
                const onlineSetupViewEl = document.getElementById('online-setup-view');
                if (onlineJoinViewEl && onlineJoinViewEl.style.display === 'flex') {
                    document.getElementById('btn-online-cancel-join').click();
                    trapBackNav();
                    return
                }
                if (onlineCreateViewEl && onlineCreateViewEl.style.display === 'flex') {
                    document.getElementById('btn-online-cancel-create').click();
                    trapBackNav();
                    return
                }
                if (onlineSetupViewEl && onlineSetupViewEl.style.display === 'block') {
                    document.getElementById('btn-online-back1').click();
                    trapBackNav();
                    return
                }
                const offlinePickViewEl = document.getElementById('offline-mode-pick-view');
                if (offlinePickViewEl && offlinePickViewEl.style.display === 'block') {
                    document.getElementById('btn-offline-pick-back').click();
                    trapBackNav();
                    return
                }
                const onlineLobbyViewEl = document.getElementById('online-lobby-view');
                if (onlineLobbyViewEl && onlineLobbyViewEl.style.display === 'block') {
                    // No defined "back" step inside the timed name/avatar
                    // lobby (leaving mid-lobby would desync the room) — just
                    // absorb the back press so it can't exit the site.
                    trapBackNav();
                    return
                }
                // در صفحه‌ی اصلی (انتخاب حالت بازی) و بدون هیچ دیالوگ بازی: اجازه بده رفتار عادی مرورگر انجام شود
            }
            trapBackNav();
            window.addEventListener('popstate', handleHardwareBack);

            // Always land on the normal start screen first, then — if this
            // device remembers a match still in progress — surface the
            // resume/forfeit dialog on top of it.
            checkForResumableOnlineSession();
        })()
