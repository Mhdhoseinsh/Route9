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
                    socket = io(GAME_SERVER_URL);
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
                _msgListeners: [],
                _presenceListeners: [],
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
                    window.FBRoom._mySlotId = res.slot;
                    window.FBRoom._token = res.token || null;
                    window.FBRoom._joinedAt = Date.now();
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
                    window.FBRoom._roomMode = null
                }
            };

            window.dispatchEvent(new Event('fbroom-ready'));
        })()
