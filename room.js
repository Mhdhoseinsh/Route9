        (function() {
            // ====== آدرس سرور آنلاین بازی (Socket.io) ======
            // بعد از دیپلوی سرور (پوشه‌ی server/) روی Render یا هر هاست دیگری،
            // این مقدار را با آدرس واقعی سرورت جایگزین کن. همین رشته دقیقاً توی
            // متای CSP بالای فایل هم هست — هر دو جا را با هم عوض کن.
            // مثال: "https://route9-server.onrender.com"
            const GAME_SERVER_URL = "https://route9.onrender.com";

            let socket = null;

            function getSocket() {
                if (!socket) {
                    socket = io(GAME_SERVER_URL, {
                        // Socket.io's default is to connect over HTTP long-
                        // polling first and only upgrade to a WebSocket a
                        // moment later — that extra request/response round
                        // trip adds real, noticeable delay to the very
                        // first connect AND to every automatic reconnect
                        // after a network blip. Listing 'websocket' first
                        // makes it attempt the fast path immediately; it
                        // still automatically falls back to polling for any
                        // network that blocks WebSocket outright, so nothing
                        // about connectivity changes — only how quickly a
                        // normal connection gets there.
                        transports: ['websocket', 'polling']
                    });
                    // ===== Silent reconnect ==========================
                    // A brief WiFi/mobile drop mid-match closes the
                    // underlying connection; Socket.io's own auto-reconnect
                    // brings the transport back, but the SERVER treats that
                    // as a brand-new, roomless connection (fresh socket.data)
                    // — it has no idea which room/slot this player was in.
                    // Previously nothing here re-joined on the player's
                    // behalf, so a few seconds of bad signal silently broke
                    // move/wall delivery in both directions until the player
                    // manually reloaded and went through the resume dialog.
                    // Now: the moment the transport comes back, if we were
                    // in a room, immediately reclaim the same slot with the
                    // token we already hold — same mechanism as a manual
                    // resume, just automatic and without ever leaving the
                    // game screen.
                    let hasConnectedBefore = false;
                    socket.on('connect', () => {
                        if (!hasConnectedBefore) { hasConnectedBefore = true; return }
                        const code = window.FBRoom._roomCode;
                        const token = window.FBRoom._token;
                        if (!code || !token) return; // not mid-match — nothing to reclaim
                        emitAck('joinRoom', { code, maxPlayers: window.FBRoom._maxPlayers, token })
                            .then((res) => {
                                if (!res || !res.ok) return; // room gone / token stale — leave it to the normal resume flow
                                window.FBRoom._mySlotId = res.slot;
                                window.FBRoom._token = res.token || token;
                                window.FBRoom._joinedAt = (typeof res.t === 'number') ? res.t : Date.now();
                                window.FBRoom._roomMode = res.mode || window.FBRoom._roomMode;
                                window.FBRoom._reconnectListeners.forEach(cb => { try { cb() } catch (e) {} })
                            })
                            .catch(() => {})
                    })
                }
                return socket
            }

            function emitAck(event, data) {
                return new Promise((resolve, reject) => {
                    getSocket().emit(event, data, (res) => {
                        if (res === undefined) { reject(new Error('no-response')); return }
                        resolve(res)
                    })
                })
            }

            window.FBRoom = {
                _roomCode: null,
                _mySlotId: null,
                _token: null,
                _maxPlayers: null,
                _msgListeners: [],
                _presenceListeners: [],
                _reconnectListeners: [],
                _joinedAt: 0,
                // حالت واقعی اتاق (2p/4p/hunter) همونیه که سرور موقع
                // createRoom/joinRoom برمی‌گردونه — این تنها منبع معتبرشه.
                // بلافاصله بعد از join (چه میزبان چه جوین‌شونده) پر می‌شه،
                // بدون نیاز به منتظر موندن برای پیام جداگونه‌ی «start».
                _roomMode: null,

                async createRoom(maxPlayers, mode) {
                    const res = await emitAck('createRoom', { maxPlayers, mode });
                    if (!res || !res.ok) throw new Error((res && res.error) || 'create-failed');
                    return res.code
                },

                async roomExists(code) {
                    const res = await emitAck('roomExists', { code });
                    if (res && res.mode) window.FBRoom._roomMode = res.mode;
                    return !!(res && res.exists)
                },

                // `token` (optional) is the private reconnect token this same
                // browser got back the first time it joined this room — passing
                // it makes the server return the caller to their OWN original
                // slot instead of "whatever's free", and lets it be their slot
                // even if it's currently marked disconnected. Without a token
                // (first-time join), the server only ever hands out a slot that
                // was never claimed by anyone, so a disconnected player's spot
                // can't be taken by a stranger who just knows the room code.
                async joinRoom(code, maxPlayers, token) {
                    const res = await emitAck('joinRoom', { code, maxPlayers, token: token || null });
                    if (!res || !res.ok) return null;
                    window.FBRoom._roomCode = code;
                    // Stashed so a silent post-drop reconnect (see
                    // getSocket() above) can re-join with the exact same
                    // parameters without the app having to remember them.
                    window.FBRoom._maxPlayers = maxPlayers;
                    window.FBRoom._mySlotId = res.slot;
                    window.FBRoom._token = res.token || null;
                    // BUGFIX: this used to be the CLIENT's own Date.now(),
                    // but onMessage() below compares it against `msg.t`,
                    // which is the SERVER's Date.now() when it relayed the
                    // message. Mixing a client clock with a server clock
                    // here meant any real clock drift between the two (a
                    // phone with a slightly-off clock is common) could make
                    // every message from the moment you joined onward look
                    // "too old" and get silently dropped forever — with no
                    // visible error, just moves that never arrive. The
                    // server now returns its own current time (`t`) in the
                    // join ack, so this baseline and `msg.t` are always on
                    // the same clock. Fall back to the client clock only if
                    // an older server build didn't send `t`.
                    window.FBRoom._joinedAt = (typeof res.t === 'number') ? res.t : Date.now();
                    window.FBRoom._roomMode = res.mode || null;
                    return res.slot
                },

                send(data) {
                    if (!window.FBRoom._roomCode) return;
                    getSocket().emit('roomMessage', { payload: data })
                },

                // Best-effort snapshot of the live match, cached server-side so
                // a reconnecting opponent can be served state even if this
                // device itself isn't online at that moment (e.g. both players
                // reloaded around the same time). Cheap/throttling is the
                // caller's job; this just fires the event.
                checkpoint(state) {
                    if (!window.FBRoom._roomCode) return;
                    getSocket().emit('checkpoint', { state })
                },

                onMessage(callback) {
                    const handler = (msg) => {
                        if (!msg) return;
                        if (msg.from === window.FBRoom._mySlotId) return;
                        if (msg.t && msg.t < window.FBRoom._joinedAt - 2000) return;
                        // `from` is the sender's slot as verified by the server
                        // from the socket itself — never from anything the
                        // sender's payload claims. `seq` is a per-room, ever-
                        // increasing counter so the caller can notice a missed
                        // message (network hiccup, etc.) and ask for a fresh
                        // state sync instead of silently drifting out of sync.
                        callback(msg.payload, msg.from, msg.seq)
                    };
                    getSocket().on('roomMessage', handler);
                    const unsub = () => { try { getSocket().off('roomMessage', handler) } catch (e) {} };
                    window.FBRoom._msgListeners.push(unsub);
                    return unsub
                },

                // Server-originated fallback reply to a 'request-state' message
                // when nobody else is currently connected to answer it — see
                // the matching comment in server.js's roomMessage handler.
                onStateFallback(callback) {
                    const handler = (msg) => { if (msg && msg.state) callback(msg.state) };
                    getSocket().on('stateFallback', handler);
                    const unsub = () => { try { getSocket().off('stateFallback', handler) } catch (e) {} };
                    window.FBRoom._msgListeners.push(unsub);
                    return unsub
                },

                // Registers a callback fired after a SILENT reconnect (a
                // transient drop, not a page reload) successfully reclaims
                // our slot — see the 'connect' handler in getSocket(). Lets
                // the game trigger its existing live-resync machinery right
                // away instead of waiting on the next presence broadcast.
                onReconnected(callback) {
                    window.FBRoom._reconnectListeners.push(callback)
                },

                onPresence(maxPlayers, callback) {
                    const handler = (playersObj) => callback(playersObj || {});
                    getSocket().on('presence', handler);
                    const unsub = () => { try { getSocket().off('presence', handler) } catch (e) {} };
                    window.FBRoom._presenceListeners.push(unsub);
                    emitAck('getPresence', {}).then((res) => {
                        if (res && res.players) callback(res.players)
                    }).catch(() => {});
                    return unsub
                },

                async leaveRoom() {
                    if (window.FBRoom._roomCode && socket) {
                        try { socket.emit('leaveRoom') } catch (e) {}
                    }
                    window.FBRoom._msgListeners.forEach(u => { try { u() } catch (e) {} });
                    window.FBRoom._presenceListeners.forEach(u => { try { u() } catch (e) {} });
                    window.FBRoom._msgListeners = [];
                    window.FBRoom._presenceListeners = [];
                    window.FBRoom._roomCode = null;
                    window.FBRoom._mySlotId = null;
                    window.FBRoom._token = null;
                    window.FBRoom._maxPlayers = null;
                    window.FBRoom._roomMode = null
                }
            };

            window.dispatchEvent(new Event('fbroom-ready'));
        })()
