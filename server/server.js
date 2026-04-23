const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const app = express();

// --- CONFIGURATION ---
const MEDIA_DIR = '/sdcard/Movies';

// --- SECURITY: Path Jail Check (Prevents accessing system files) ---
function getSafePath(filename) {
    if (!filename) return null;
    const cleanName = path.basename(filename); 
    const resolvedPath = path.join(MEDIA_DIR, cleanName);
    // Ensure the resolved path is still inside MEDIA_DIR
    if (!resolvedPath.startsWith(MEDIA_DIR)) return null;
    return resolvedPath;
}

// --- SAFE SPAWN HELPER (Replaces exec for Security) ---
function runProbe(args) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', args);
        let output = '';
        proc.stdout.on('data', (d) => output += d.toString());
        proc.on('close', (code) => {
            if (code !== 0) resolve(null);
            else resolve(output.trim());
        });
        proc.on('error', () => resolve(null)); // Handle missing ffprobe
    });
}

// --- HELPER 1: Get Audio Tracks ---
async function getAudioTrackCount(filePath) {
    const out = await runProbe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath]);
    if (!out) return 1;
    const lines = out.split('\n').filter(l => l.length > 0).length;
    return lines > 0 ? lines : 1;
}

// --- HELPER 2: Get Duration ---
async function getVideoDuration(filePath) {
    const out = await runProbe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
    const d = parseFloat(out);
    return isNaN(d) ? 0 : d;
}

// --- HELPER 3: Get Height ---
async function getVideoHeight(filePath) {
    const out = await runProbe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=height', '-of', 'csv=p=0', filePath]);
    const h = parseInt(out, 10);
    return isNaN(h) ? 0 : h;
}

// --- HELPER 4: Get Subtitles ---
async function getSubtitleTrackCount(filePath) {
    const out = await runProbe(['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath]);
    if (!out) return 0;
    return out.split('\n').filter(l => l.length > 0).length;
}

// 1. Home Page
app.get('/', (req, res) => {
    fs.readdir(MEDIA_DIR, (err, files) => {
        if (err) return res.send(`<h3>Error: Cannot read folder ${MEDIA_DIR}. Grant storage permission?</h3>`);
        const videos = files.filter(f => f.match(/\.(mp4|mkv|webm|avi|mov|flv|wmv|mpg)$/i));
        const html = `
        <html>
            <head>
                <style>
                    body { font-family: sans-serif; background: #121212; color: #fff; padding: 20px; }
                    a { background: #1e1e1e; padding: 15px; margin-top: 10px; display: block; color: #4CAF50; text-decoration: none; border: 1px solid transparent; }
                    a:focus { background: #4CAF50; color: white; border-color: white; transform: scale(1.02); outline: none; }
                </style>
            </head>
            <body>
                <h1 style="border-bottom: 2px solid #4CAF50; padding-bottom: 10px;">Server</h1>
                ${videos.length === 0 ? '<p>No videos found.</p>' : ''}
                ${videos.map(f => `<a href="/play/${encodeURIComponent(f)}" tabindex="0">▶ ${f}</a>`).join('')}
                <script>
                    const firstLink = document.querySelector('a');
                    if(firstLink) firstLink.focus();
                </script>
            </body>
        </html>`;
        res.send(html);
    });
});

// 2. Video Player
app.get('/play/:filename', async (req, res) => {
    let cleanName;
    try { cleanName = decodeURIComponent(req.params.filename); } catch(e) { return res.status(400).send("Bad Request"); }
    
    const filePath = getSafePath(cleanName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).send("File not found or Access Denied");

    const totalTracks = await getAudioTrackCount(filePath);
    const duration = await getVideoDuration(filePath);
    const totalSubs = await getSubtitleTrackCount(filePath);
    const height = await getVideoHeight(filePath);

    let statusMsg = "Ready";
    if (height > 1080) statusMsg = "4K Detected: Auto-Downscaling to 1080p";

    let trackTags = '';
    if (totalSubs > 0) {
        for (let i = 0; i < totalSubs; i++) {
            trackTags += `<track label="Sub ${i + 1}" kind="subtitles" src="/subs/${encodeURIComponent(cleanName)}?track=${i}">`;
        }
    }

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <style>
                body { background: black; margin: 0; overflow: hidden; font-family: sans-serif; user-select: none; -webkit-user-select: none; }
                #vid { width: 100vw; height: 100vh; object-fit: contain; }
                ::cue { background: rgba(0, 0, 0, 0.8) !important; color: white !important; font-size: clamp(20px, 4vw, 40px) !important; font-family: 'Arial', sans-serif !important; writing-mode: horizontal-tb !important; width: auto !important; text-shadow: 2px 2px 3px black !important; white-space: pre-wrap !important; line-height: 1.4 !important; text-align: center !important; }
                video::-webkit-media-text-track-display { transform: translateY(-50px); margin: 0; writing-mode: horizontal-tb !important; }
                .controls { position: absolute; bottom: 20px; left: 20px; right: 20px; background: rgba(0,0,0,0.8); padding: 15px; border-radius: 10px; display: flex; flex-direction: column; gap: 15px; transition: opacity 0.5s; z-index: 10; }
                .slider-row { display: flex; gap: 10px; color: white; align-items: center; position: relative; }
                input[type=range] { flex-grow: 1; accent-color: #4CAF50; cursor: pointer; height: 20px; outline: none; }
                input[type=range]:focus { box-shadow: 0 0 0 2px white; }
                .btn-row { display: flex; justify-content: center; gap: 15px; flex-wrap: wrap;}
                button { background: #333; border: 2px solid #4CAF50; color: white; padding: 12px 20px; border-radius: 5px; font-weight: bold; cursor: pointer; flex: 1; min-width: 80px; outline: none; transition: all 0.2s; font-size: 16px; }
                button:focus { background: white; color: black; transform: scale(1.1); box-shadow: 0 0 10px rgba(255,255,255,0.5); }
                .hidden { opacity: 0; pointer-events: none; }
                #status { position: absolute; top: 20px; left: 20px; background: rgba(0,0,0,0.7); color: white; padding: 10px 16px; border-radius: 5px; pointer-events: none; font-size: 20px; transition: opacity 0.5s; z-index: 20; font-weight: bold; border: 1px solid #555; }
                .status-hidden { opacity: 0; }
                #loader { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #4CAF50; font-size: 24px; display: none; z-index: 15; pointer-events: none; font-weight: bold; text-shadow: 0 0 5px black; }
                .ripple { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255, 255, 255, 0.2); width: 100px; height: 100px; border-radius: 50%; opacity: 0; pointer-events: none; animation: rippleAnim 0.5s linear; z-index: 5; }
                @keyframes rippleAnim { 0% { opacity: 1; transform: translateY(-50%) scale(0.5); } 100% { opacity: 0; transform: translateY(-50%) scale(2); } }
                #preview { position: absolute; bottom: 50px; width: 160px; height: 90px; background: black; border: 2px solid white; border-radius: 4px; display: none; pointer-events: none; box-shadow: 0 0 10px rgba(0,0,0,0.8); z-index: 25; overflow: hidden; }
                #preview img { width: 100%; height: 100%; object-fit: cover; }
                #preview-time { position: absolute; bottom: 0; width: 100%; background: rgba(0,0,0,0.7); color: white; text-align: center; font-size: 12px; padding: 2px 0; }
            </style>
        </head>
        <body>
            <div id="status">${statusMsg}</div>
            <div id="loader">Buffering...</div>
            <div id="ripple-left" class="ripple" style="left: 10%; display:none;"></div>
            <div id="ripple-right" class="ripple" style="right: 10%; display:none;"></div>

            <video id="vid" autoplay crossorigin="anonymous" tabindex="0">
                <source src="/stream/${encodeURIComponent(cleanName)}" type="video/mp4">
                ${trackTags}
            </video>

            <div id="ui" class="controls">
                <div class="slider-row">
                    <div id="preview">
                        <img id="preview-img" src="">
                        <div id="preview-time">0:00</div>
                    </div>
                    <span id="cur" style="min-width: 50px; text-align: center;">0:00</span>
                    <input type="range" id="seek" value="0" min="0" step="1" tabindex="1">
                    <span id="dur" style="min-width: 50px; text-align: center;">0:00</span>
                </div>
                
                <div class="btn-row">
                    <button onclick="togglePlay()" id="playBtn" tabindex="2">Pause</button>
                    <button onclick="switchAudio()" tabindex="3">Audio (${totalTracks})</button>
                    <button onclick="toggleSubs()" tabindex="4">CC (${totalSubs})</button>
                    <button onclick="toggleQuality()" id="qBtn" tabindex="5">Quality: Auto</button>
                    <button onclick="toggleSpeed()" id="spdBtn" tabindex="6">1.0x</button>
                    <button onclick="toggleFull()" tabindex="7">Full</button>
                </div>
            </div>

            <script>
                const video = document.getElementById('vid');
                const seek = document.getElementById('seek');
                const ui = document.getElementById('ui');
                const status = document.getElementById('status');
                const loader = document.getElementById('loader');
                const spdBtn = document.getElementById('spdBtn');
                const qBtn = document.getElementById('qBtn');
                const playBtn = document.getElementById('playBtn');
                const previewBox = document.getElementById('preview');
                const previewImg = document.getElementById('preview-img');
                const previewTime = document.getElementById('preview-time');
                const filename = "${encodeURIComponent(cleanName)}";
                const totalTracks = ${totalTracks};
                const totalSubs = ${totalSubs};
                const serverDuration = ${isFinite(duration) ? duration : 0};
                const isMp4 = filename.toLowerCase().endsWith('.mp4');

                // State
                let currentTrack = 0;
                let hideTimer;
                let statusTimer;
                let seekOffset = 0;
                let currentSubIndex = -1;
                let isDragging = false;
                let playbackSpeeds = [0.5, 1.0, 1.25, 1.5, 2.0];
                let speedIndex = 1;
                let qualityOptions = [0, 1080, 720, 480];
                let qualityLabels = ['Auto', '1080p', '720p', '480p'];
                let qualityIndex = 0;
                let lastClickTime = 0;
                let clickTimeout;

                function debounce(func, wait) {
                    let timeout;
                    return function(...args) { clearTimeout(timeout); timeout = setTimeout(() => func.apply(this, args), wait); };
                }
                const updatePreview = debounce((timeVal) => {
                    if (timeVal < 0 || isNaN(timeVal)) return;
                    previewImg.src = "/thumbnail/" + filename + "?time=" + Math.floor(timeVal);
                }, 50);

                window.onload = function() { video.focus(); };

                seek.addEventListener('mousemove', (e) => {
                    const rect = seek.getBoundingClientRect();
                    const max = parseFloat(seek.max) || 100;
                    const offsetX = e.clientX - rect.left;
                    const percent = offsetX / rect.width;
                    let hoverTime = percent * max;
                    if(hoverTime < 0) hoverTime = 0;
                    if(hoverTime > max) hoverTime = max;
                    previewBox.style.display = 'block';
                    previewTime.innerText = fmt(hoverTime);
                    let boxPercent = (hoverTime / max) * 100;
                    if(boxPercent < 10) boxPercent = 10;
                    if(boxPercent > 90) boxPercent = 90;
                    previewBox.style.left = \`calc(\${boxPercent}% - 80px)\`;
                    updatePreview(hoverTime);
                });
                seek.addEventListener('mouseleave', () => { previewBox.style.display = 'none'; });
                
                video.addEventListener('click', (e) => {
                    video.focus();
                    const now = Date.now();
                    const width = video.offsetWidth;
                    const x = e.clientX;
                    const isLeft = x < width * 0.25;
                    const isRight = x > width * 0.75;
                    if (isLeft || isRight) {
                        if (now - lastClickTime < 300) {
                            clearTimeout(clickTimeout); lastClickTime = 0;
                            if (isLeft) { skip(-10); showRipple('ripple-left'); } else { skip(10); showRipple('ripple-right'); }
                        } else {
                            lastClickTime = now;
                            clickTimeout = setTimeout(() => { togglePlay(); lastClickTime = 0; }, 300);
                        }
                    } else { togglePlay(); lastClickTime = 0; }
                });

                function showRipple(id) {
                    const r = document.getElementById(id);
                    if(r) { r.style.display = 'block'; r.style.animation = 'none'; r.offsetHeight; r.style.animation = 'rippleAnim 0.5s linear'; setTimeout(() => r.style.display = 'none', 500); }
                }

                function fmt(s) {
                    if(isNaN(s) || !isFinite(s)) return "0:00";
                    s = Math.max(0, Math.floor(s));
                    const h = Math.floor(s / 3600);
                    const m = Math.floor((s % 3600) / 60);
                    const sc = s % 60;
                    const mStr = (h > 0 && m < 10) ? "0" + m : m;
                    const scStr = sc < 10 ? "0" + sc : sc;
                    return h > 0 ? h + ":" + mStr + ":" + scStr : mStr + ":" + scStr;
                }

                setTimeout(() => status.classList.add('status-hidden'), 3000);
                if(serverDuration > 0) { seek.max = serverDuration; document.getElementById('dur').innerText = fmt(serverDuration); }

                let resumeChecked = false;
                video.addEventListener('loadedmetadata', () => {
                    if(video.textTracks) { for (let i = 0; i < video.textTracks.length; i++) { video.textTracks[i].mode = 'hidden'; } }
                    if ((serverDuration === 0) && video.duration && isFinite(video.duration)) {
                        seek.max = video.duration; document.getElementById('dur').innerText = fmt(video.duration);
                    }
                    video.playbackRate = playbackSpeeds[speedIndex];
                    if (!resumeChecked) {
                        resumeChecked = true;
                        try {
                            const savedTime = parseFloat(localStorage.getItem('resume_' + filename));
                            if (!isNaN(savedTime) && savedTime > 5) {
                                if(isNativeMode()) { video.currentTime = savedTime; } 
                                else { reloadStream(savedTime); return; }
                                showStatus("Resumed at " + fmt(savedTime));
                            }
                        } catch(e) {}
                    }
                });

                video.addEventListener('ended', () => { playBtn.innerText = "Play"; showStatus("Finished"); if(isNativeMode()) video.currentTime = 0; else reloadStream(0); });
                setInterval(() => { if (!video.paused && !isDragging) { try { const t = isNativeMode() ? video.currentTime : seekOffset + video.currentTime; localStorage.setItem('resume_' + filename, t); } catch(e) {} } }, 5000);

                function toggleSpeed() { speedIndex = (speedIndex + 1) % playbackSpeeds.length; applySpeed(); }
                function modifySpeed(direction) {
                    let newIndex = speedIndex + direction;
                    if (newIndex < 0) newIndex = 0;
                    if (newIndex >= playbackSpeeds.length) newIndex = playbackSpeeds.length - 1;
                    if (newIndex !== speedIndex) { speedIndex = newIndex; applySpeed(); }
                }
                function applySpeed() { const newSpeed = playbackSpeeds[speedIndex]; video.playbackRate = newSpeed; spdBtn.innerText = newSpeed + "x"; showStatus("Speed: " + newSpeed + "x"); }
                function toggleQuality() { qualityIndex = (qualityIndex + 1) % qualityOptions.length; qBtn.innerText = "Quality: " + qualityLabels[qualityIndex]; let resumeTime = isNativeMode() ? video.currentTime : seekOffset + video.currentTime; reloadStream(resumeTime); showStatus("Switched to " + qualityLabels[qualityIndex]); }
                function toggleSubs() {
                    if (totalSubs === 0 || !video.textTracks || video.textTracks.length === 0) { showStatus("No subtitles"); return; }
                    currentSubIndex++;
                    if (currentSubIndex >= video.textTracks.length) currentSubIndex = -1;
                    for (let i = 0; i < video.textTracks.length; i++) { video.textTracks[i].mode = (i === currentSubIndex) ? 'showing' : 'hidden'; }
                    const msg = currentSubIndex === -1 ? "Subtitles: Off" : "Subtitle: " + (currentSubIndex + 1); showStatus(msg);
                }
                
                video.addEventListener('waiting', () => loader.style.display = 'block');
                video.addEventListener('playing', () => { loader.style.display = 'none'; playBtn.innerText = "Pause"; });
                video.addEventListener('pause', () => { playBtn.innerText = "Play"; });
                video.addEventListener('canplay', () => loader.style.display = 'none');
                video.addEventListener('error', () => { loader.style.display = 'none'; showStatus("Playback Error"); });

                function switchAudio() {
                    if(totalTracks <= 1) { showStatus("No other tracks"); return; }
                    let resumeTime = isNativeMode() ? video.currentTime : seekOffset + video.currentTime;
                    currentTrack = (currentTrack + 1) % totalTracks;
                    reloadStream(resumeTime);
                    showStatus("Audio: " + (currentTrack + 1) + "/" + totalTracks);
                }
                function isNativeMode() { return isMp4 && currentTrack === 0 && qualityOptions[qualityIndex] === 0; }
                
                function reloadStream(time) {
                    loader.style.display = 'block';
                    const targetRes = qualityOptions[qualityIndex];
                    if (isNativeMode()) {
                        seekOffset = 0; video.src = "/stream/" + filename + "?track=0"; video.load();
                        video.onloadedmetadata = () => {
                            video.currentTime = time; video.playbackRate = playbackSpeeds[speedIndex];
                            video.play().catch(e => console.log("Auto-play blocked", e));
                            video.onloadedmetadata = null;
                            if(currentSubIndex > -1 && video.textTracks && video.textTracks[currentSubIndex]) video.textTracks[currentSubIndex].mode = 'showing';
                        };
                    } else {
                        seekOffset = time;
                        video.src = "/stream/" + filename + "?track=" + currentTrack + "&start=" + time + "&res=" + targetRes;
                        video.load();
                        video.playbackRate = playbackSpeeds[speedIndex];
                        video.play().catch(e => console.log("Auto-play blocked", e));
                    }
                }
                
                video.ontimeupdate = () => { if(!isDragging) { let realTime = isNativeMode() ? video.currentTime : seekOffset + video.currentTime; if (!isNaN(realTime)) { seek.value = realTime; document.getElementById('cur').innerText = fmt(realTime); } } };
                
                seek.oninput = () => { 
                    isDragging = true; 
                    const val = parseFloat(seek.value); 
                    document.getElementById('cur').innerText = fmt(val); 
                    wake(); 
                    previewBox.style.display = 'block'; 
                    previewTime.innerText = fmt(val); 
                    updatePreview(val); 
                    if (isNativeMode()) video.currentTime = val; 
                };

                seek.onchange = () => { 
                    isDragging = false; 
                    previewBox.style.display = 'none'; 
                    const targetTime = parseFloat(seek.value); 
                    try { localStorage.setItem('resume_' + filename, targetTime); } catch(e) {} 
                    if (isNativeMode()) video.currentTime = targetTime; 
                    else reloadStream(targetTime); 
                    
                    // --- EDGE CASE FIX: FORCE FOCUS BACK TO VIDEO ---
                    video.focus(); 
                    wake(); 
                };
                
                function wake() { ui.classList.remove('hidden'); clearTimeout(hideTimer); hideTimer = setTimeout(() => ui.classList.add('hidden'), 3000); }
                function showStatus(msg) { status.innerText = msg; status.classList.remove('status-hidden'); clearTimeout(statusTimer); statusTimer = setTimeout(() => status.classList.add('status-hidden'), 3000); wake(); }
                document.addEventListener('mousemove', wake); document.addEventListener('click', (e) => { if(e.target.id !== 'vid') wake(); }); wake();

                async function togglePlay() {
                    if(video.paused) { try { await video.play(); showStatus("Playing"); } catch(e) {} } 
                    else { video.pause(); try { const t = isNativeMode() ? video.currentTime : seekOffset + video.currentTime; localStorage.setItem('resume_' + filename, t); } catch(e) {} showStatus("Paused"); }
                }
                function stopVideo() { video.pause(); try { const t = isNativeMode() ? video.currentTime : seekOffset + video.currentTime; localStorage.setItem('resume_' + filename, t); } catch(e) {} if(isNativeMode()) video.currentTime = 0; else reloadStream(0); showStatus("Stopped"); }
                function skip(s) {
                    let target = parseFloat(seek.value) + s; if (target < 0) target = 0; if (serverDuration > 0 && target > serverDuration) target = serverDuration;
                    seek.value = target; document.getElementById('cur').innerText = fmt(target);
                    if (isNativeMode()) video.currentTime = target; else reloadStream(target);
                    showStatus(s > 0 ? "+" + s + "s" : s + "s"); wake();
                }
                function toggleFull() { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(); }

                document.addEventListener('keydown', (e) => {
                    wake(); const active = document.activeElement; const tag = active ? active.tagName : '';
                    let key = e.key; const code = e.keyCode;
                    
                    if (code === 89) key = "MediaRewind"; if (code === 90) key = "MediaFastForward"; if (code === 85) key = "MediaPlayPause";
                    if (code === 86) key = "MediaStop"; if (code === 87) key = "MediaTrackNext"; if (code === 88) key = "MediaTrackPrevious";
                    if (code === 227) key = "MediaRewind"; if (code === 228) key = "MediaFastForward"; if (code === 179) key = "MediaPlayPause";
                    
                    if (e.shiftKey) { if (key === 'ArrowRight') { e.preventDefault(); modifySpeed(1); return; } if (key === 'ArrowLeft') { e.preventDefault(); modifySpeed(-1); return; } }
                    if (e.code === "Space" && tag !== 'INPUT') { e.preventDefault(); togglePlay(); return; }
                    if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(key)) { if (tag !== 'INPUT' && tag !== 'BUTTON') { e.preventDefault(); } }

                    switch(key) {
                        case "MediaPlayPause": e.preventDefault(); togglePlay(); break;
                        case "MediaPlay": e.preventDefault(); video.play().catch(()=>{}); showStatus("Playing"); break;
                        case "MediaPause": e.preventDefault(); video.pause(); showStatus("Paused"); break;
                        case "MediaStop": e.preventDefault(); stopVideo(); break;
                        case "Escape": window.history.back(); break;
                        case "MediaRewind": case "Rewind": case "MediaTrackPrevious": e.preventDefault(); skip(-10); showRipple('ripple-left'); break;
                        case "MediaFastForward": case "FastForward": case "MediaTrackNext": e.preventDefault(); skip(10); showRipple('ripple-right'); break;
                        case "ArrowLeft": if(tag !== 'INPUT' && tag !== 'BUTTON') { skip(-10); showRipple('ripple-left'); } break;
                        case "ArrowRight": if(tag !== 'INPUT' && tag !== 'BUTTON') { skip(10); showRipple('ripple-right'); } break;
                        case "ArrowUp": if(tag !== 'BUTTON') { try { if(video.volume < 1) video.volume = Math.min(1, parseFloat((video.volume + 0.1).toFixed(1))); showStatus("Vol: " + Math.round(video.volume * 100) + "%"); } catch(err) {} } else { if (active === playBtn || (active.parentElement && active.parentElement.classList.contains('btn-row'))) video.focus(); } break;
                        case "ArrowDown": if(tag !== 'BUTTON') { if(active === video) playBtn.focus(); else { try { if(video.volume > 0) video.volume = Math.max(0, parseFloat((video.volume - 0.1).toFixed(1))); showStatus("Vol: " + Math.round(video.volume * 100) + "%"); } catch(err) {} } } break;
                        case "Enter": case "Select": case "Ok": if(tag !== 'BUTTON' && tag !== 'INPUT') { togglePlay(); } break;
                        case "f": case "F": toggleFull(); break;
                        case "c": case "C": case "Subtitle": toggleSubs(); break;
                        case "m": case "M": case "ContextMenu": toggleQuality(); break;
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// 3. Subtitle Route (STRICT SANITIZER + SPAWN)
app.get('/subs/:filename', (req, res) => {
    let cleanName;
    try { cleanName = decodeURIComponent(req.params.filename); } catch(e) { return res.status(400).end(); }
    const filePath = getSafePath(cleanName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();

    const trackIndex = req.query.track || 0;
    const ffmpeg = spawn('ffmpeg', ['-i', filePath, '-map', `0:s:${trackIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', '-']);
    ffmpeg.on('error', (err) => { console.error("FFmpeg spawn error:", err); res.end(); });
    res.setHeader('Content-Type', 'text/vtt');
    let buffer = '';
    ffmpeg.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let lines = buffer.split('\n');
        buffer = lines.pop(); 
        const cleanedData = lines.map(line => {
            if (line.includes('-->')) { return line.replace(/.*(\d{2}:\d{2}:\d{2}\.\d{3}\s-->\s\d{2}:\d{2}:\d{2}\.\d{3}).*/, '$1 line:90% align:center size:100%'); }
            return line;
        }).join('\n') + '\n';
        res.write(cleanedData);
    });
    ffmpeg.stderr.on('data', () => {}); 
    ffmpeg.on('close', () => { if (buffer) res.write(buffer); res.end(); });
    req.on('close', () => ffmpeg.kill());
});

// --- INSTANT THUMBNAIL (SPAWN) ---
app.get('/thumbnail/:filename', (req, res) => {
    let cleanName;
    try { cleanName = decodeURIComponent(req.params.filename); } catch(e) { return res.status(400).end(); }
    const filePath = getSafePath(cleanName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();
    let time = parseFloat(req.query.time);
    if (isNaN(time) || time < 0) time = 0;

    const ffmpeg = spawn('ffmpeg', ['-skip_frame', 'nokey', '-ss', String(time), '-i', filePath, '-an', '-sn', '-vframes', '1', '-vf', 'scale=160:-2', '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', '-']);
    ffmpeg.on('error', () => res.end());
    res.setHeader('Content-Type', 'image/jpeg');
    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', () => {});
    req.on('close', () => ffmpeg.kill('SIGKILL'));
});

// 4. Stream Route (OPTIMIZED: Low Latency, Safe Spawn, Range Checks)
app.get('/stream/:filename', async (req, res) => {
    let cleanName;
    try { cleanName = decodeURIComponent(req.params.filename); } catch(e) { return res.status(400).end(); }
    const filePath = getSafePath(cleanName);
    if (!filePath || !fs.existsSync(filePath)) return res.status(404).end();

    const track = req.query.track;
    const startTime = req.query.start || '0';
    let targetRes = parseInt(req.query.res || '0');
    if (isNaN(targetRes)) targetRes = 0;

    if (req.method === 'HEAD') {
        try { const stat = fs.statSync(filePath); res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4' }); return res.end(); } catch(e) { return res.status(404).end(); }
    }

    if (targetRes === 0) {
        const height = await getVideoHeight(filePath);
        if (height > 1080) { targetRes = 1080; }
    }

    const isStandardMp4 = cleanName.match(/\.mp4$/i);
    const useDirectStream = isStandardMp4 && (!track || track === '0') && targetRes === 0;

    if (!useDirectStream) {
        let scaleFilter = [];
        let maxRate = '6M'; let bufSize = '6M'; // Optimized for Latency

        if (targetRes === 1080) { scaleFilter = ['-vf', 'scale=-2:1080:flags=fast_bilinear,setsar=1']; maxRate = '3M'; bufSize = '6M'; } 
        else if (targetRes === 720) { scaleFilter = ['-vf', 'scale=-2:720:flags=fast_bilinear,setsar=1']; maxRate = '1500k'; bufSize = '3M'; } 
        else if (targetRes === 480) { scaleFilter = ['-vf', 'scale=-2:480:flags=fast_bilinear,setsar=1']; maxRate = '800k'; bufSize = '1500k'; } 
        else { maxRate = '10M'; bufSize = '20M'; }

        // --- OPTIMIZED FFMPEG ARGS ---
        const ffmpegArgs = [
            '-fflags', '+nobuffer',                 // Instant Read
            '-ss', startTime, 
            '-analyzeduration', '0', 
            '-probesize', '1000000',                // Fast Probe (1MB)
            '-i', filePath,
            '-map', '0:v:0', '-map', `0:a:${track || 0}`, '-map_metadata', '-1', '-sn',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', 
            '-flags', '+low_delay',                 // Low Latency Mode
            '-crf', '28',
            '-maxrate', maxRate, '-bufsize', bufSize,
            '-pix_fmt', 'yuv420p', '-g', '30', '-sc_threshold', '0', '-threads', '0',
            ...scaleFilter,
            '-c:a', 'aac', '-ac', '2', '-ar', '44100', '-b:a', '128k', '-af', 'aresample=async=1',
            '-avoid_negative_ts', 'make_zero', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', '-'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        ffmpeg.on('error', (err) => { console.error("FFmpeg stream error:", err); if(!res.headersSent) res.status(500).end(); });
        res.setHeader('Content-Type', 'video/mp4');
        ffmpeg.stdout.pipe(res);
        ffmpeg.stderr.on('data', () => {});
        const killProc = () => ffmpeg.kill('SIGKILL');
        req.on('close', killProc); res.on('close', killProc);

    } else {
        try {
            const stat = fs.statSync(filePath);
            const fileSize = stat.size;
            const range = req.headers.range;
            if (range) {
                const parts = range.replace(/bytes=/, "").split("-");
                let start = parseInt(parts[0], 10);
                const CHUNK_SIZE = 5 * (10**6);
                let end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + CHUNK_SIZE, fileSize - 1);
                if (isNaN(start)) start = 0; if (isNaN(end)) end = fileSize - 1;
                if (start > end) { res.status(416).send('Range Not Satisfiable'); return; }
                if (start >= fileSize) { res.status(416).send('Requested Range Not Satisfiable\n'); return; }
                res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${fileSize}`, 'Accept-Ranges': 'bytes', 'Content-Length': (end - start) + 1, 'Content-Type': 'video/mp4' });
                const fileStream = fs.createReadStream(filePath, { start, end });
                fileStream.on('error', () => res.end());
                fileStream.pipe(res);
            } else {
                res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': 'video/mp4' });
                const fileStream = fs.createReadStream(filePath);
                fileStream.on('error', () => res.end());
                fileStream.pipe(res);
            }
        } catch (e) { console.error("Stream error:", e); if (!res.headersSent) res.status(404).end(); }
    }
});

process.on('uncaughtException', (err) => { console.log('Caught exception: ' + err); });
app.listen(8080, '0.0.0.0', () => console.log('Server Ready! http://localhost:8080')).on('error', (err) => {
    if(err.code === 'EADDRINUSE') { console.log("Port 8080 is busy. Exiting..."); process.exit(1); }
});
