#!/usr/bin/env node
'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { URL } = require('node:url');

const ROOT_DIR = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT_DIR, 'web');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MEDIA_DIR = path.join(ROOT_DIR, 'media');
const LIBRARY_PATH = path.join(DATA_DIR, 'library.json');

const PORT = Number(process.env.PORT || 7330);
const HOST = process.env.HOST || '0.0.0.0';
const YTDLP_BIN = process.env.GAMA_MUSIC_YTDLP || 'yt-dlp';
const COOKIE_BROWSER = process.env.GAMA_MUSIC_COOKIE_BROWSER || 'chrome';
const CORS_ORIGIN = process.env.GAMA_MUSIC_CORS_ORIGIN || '*';

const jobs = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function defaultLibrary() {
  return {
    version: 1,
    tracks: [],
    playlists: [],
    updatedAt: nowIso()
  };
}

function readLibrary() {
  if (!fs.existsSync(LIBRARY_PATH)) {
    const initial = defaultLibrary();
    writeLibrary(initial);
    return initial;
  }

  const parsed = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
  parsed.version = parsed.version || 1;
  parsed.tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
  parsed.playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
  return parsed;
}

function writeLibrary(library) {
  library.updatedAt = nowIso();
  const tmpPath = `${LIBRARY_PATH}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(library, null, 2)}\n`);
  fs.renameSync(tmpPath, LIBRARY_PATH);
}

function publicTrack(track) {
  return {
    id: track.id,
    title: track.title,
    originalTitle: track.originalTitle,
    file: track.file,
    source: track.source,
    duration: track.duration || null,
    uploader: track.uploader || null,
    createdAt: track.createdAt,
    updatedAt: track.updatedAt
  };
}

function publicPlaylist(playlist) {
  return {
    id: playlist.id,
    name: playlist.name,
    trackIds: playlist.trackIds,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt
  };
}

function publicLibrary(library) {
  return {
    version: library.version,
    tracks: library.tracks.map(publicTrack),
    playlists: library.playlists.map(publicPlaylist),
    updatedAt: library.updatedAt
  };
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function cleanTitle(value, fallback = 'Untitled') {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  return (title || fallback).slice(0, 160);
}

function addCookieArgs(args) {
  if (COOKIE_BROWSER && COOKIE_BROWSER.toLowerCase() !== 'none') {
    args.push('--cookies-from-browser', COOKIE_BROWSER);
  }
}

function execYtDlpJson(videoUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings'
    ];
    addCookieArgs(args);
    args.push(videoUrl);

    execFile(YTDLP_BIN, args, { maxBuffer: 30 * 1024 * 1024, timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(formatToolError('读取视频信息失败', error, stderr)));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`yt-dlp 返回的视频信息不是有效 JSON: ${parseError.message}`));
      }
    });
  });
}

function formatToolError(prefix, error, stderr) {
  const details = String(stderr || error.message || '').trim();
  if (!details) return prefix;
  return `${prefix}: ${details.split('\n').slice(-4).join('\n')}`;
}

function normalizeUrl(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    const identity = extractBilibiliIdentity(url.toString());
    if (identity) return identity.canonicalUrl;

    url.hash = '';
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();

    const droppedParams = new Set([
      'bbid',
      'bsource',
      'from',
      'is_story_h5',
      'mid',
      'plat_id',
      'share_from',
      'share_medium',
      'share_plat',
      'share_session_id',
      'share_source',
      'spm_id_from',
      'timestamp',
      'ts',
      'unique_k',
      'up_id',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term',
      'vd_source'
    ]);

    const entries = Array.from(url.searchParams.entries())
      .filter(([key]) => !droppedParams.has(key.toLowerCase()))
      .sort(([aKey, aValue], [bKey, bValue]) => `${aKey}=${aValue}`.localeCompare(`${bKey}=${bValue}`));

    url.search = '';
    for (const [key, value] of entries) {
      url.searchParams.append(key, value);
    }

    return url.toString();
  } catch {
    return raw;
  }
}

function extractBilibiliIdentity(value) {
  const text = safeDecodeURIComponent(String(value || ''));
  const bvMatch = text.match(/(?:^|[^0-9A-Za-z])(BV[0-9A-Za-z]{10,})(?:[^0-9A-Za-z]|$)/i);
  if (bvMatch) {
    const id = `BV${bvMatch[1].slice(2)}`;
    return {
      kind: 'BV',
      id,
      key: `bv:${id}`,
      canonicalUrl: `https://www.bilibili.com/video/${id}/`
    };
  }

  const avPathMatch = text.match(/\/video\/av(\d+)/i);
  const avPlainMatch = text.match(/(?:^|[^0-9A-Za-z])av(\d+)(?:[^0-9A-Za-z]|$)/i);
  const aidParamMatch = text.match(/[?&]aid=(\d+)/i);
  const avNumber = avPathMatch?.[1] || avPlainMatch?.[1] || aidParamMatch?.[1];

  if (avNumber) {
    const id = `av${avNumber}`;
    return {
      kind: 'AV',
      id,
      key: `av:${avNumber}`,
      canonicalUrl: `https://www.bilibili.com/video/${id}/`
    };
  }

  return null;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildSource(rawUrl, info = {}) {
  const candidates = [
    info.webpage_url,
    info.original_url,
    info.url,
    info.id,
    rawUrl
  ].filter(Boolean);

  let identity = null;
  for (const candidate of candidates) {
    identity = extractBilibiliIdentity(candidate);
    if (identity) break;
  }

  const normalizedInputUrl = normalizeUrl(rawUrl);
  const normalizedInfoUrl = normalizeUrl(info.webpage_url || rawUrl);
  const normalizedUrl = identity?.canonicalUrl || normalizedInfoUrl || normalizedInputUrl;
  const key = identity?.key || `url:${normalizedUrl}`;
  const keys = new Set([key]);

  for (const candidate of [identity?.canonicalUrl, normalizedUrl, normalizedInputUrl, normalizedInfoUrl]) {
    const normalized = normalizeUrl(candidate);
    if (normalized) keys.add(`url:${normalized}`);
  }

  return {
    kind: identity?.kind || 'URL',
    id: identity?.id || normalizedUrl,
    key,
    keys: Array.from(keys),
    canonicalUrl: identity?.canonicalUrl || normalizedUrl,
    normalizedUrl,
    originalUrl: rawUrl,
    webpageUrl: info.webpage_url || null
  };
}

function trackKeys(track) {
  const keys = new Set();
  if (track.sourceKey) keys.add(String(track.sourceKey));
  if (track.source?.key) keys.add(String(track.source.key));
  if (Array.isArray(track.source?.keys)) {
    for (const key of track.source.keys) keys.add(String(key));
  }
  for (const urlValue of [track.source?.canonicalUrl, track.source?.normalizedUrl, track.source?.webpageUrl, track.source?.originalUrl]) {
    const normalized = normalizeUrl(urlValue);
    if (normalized) keys.add(`url:${normalized}`);
  }
  return keys;
}

function findDuplicate(library, source) {
  const incomingKeys = new Set((source.keys || [source.key]).map((key) => String(key)));
  return library.tracks.find((track) => {
    for (const key of trackKeys(track)) {
      if (incomingKeys.has(key)) return true;
    }
    return false;
  });
}

function summarizeInfo(rawUrl, info) {
  const source = buildSource(rawUrl, info);
  const library = readLibrary();
  const duplicate = findDuplicate(library, source);

  return {
    title: cleanTitle(info.title, source.id),
    originalTitle: cleanTitle(info.title, source.id),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    uploader: info.uploader || info.channel || null,
    source,
    duplicate: Boolean(duplicate),
    existingTrack: duplicate ? publicTrack(duplicate) : null
  };
}

function spawnDownload(job, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_BIN, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const collect = [];

    function handleOutput(buffer) {
      const text = buffer.toString();
      collect.push(text);
      if (collect.join('').length > 12000) collect.shift();

      const percent = text.match(/\[download\]\s+([0-9]+(?:\.[0-9]+)?)%/);
      if (percent) {
        job.progress = Math.max(job.progress, Math.min(88, 10 + Number(percent[1]) * 0.75));
        job.stage = '正在下载音频';
      }

      if (text.includes('[ExtractAudio]') || text.includes('Destination:')) {
        job.stage = '正在转换 MP3';
        job.progress = Math.max(job.progress, 90);
      }

      job.updatedAt = nowIso();
    }

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`yt-dlp 下载失败，退出码 ${code}: ${collect.join('').split('\n').slice(-8).join('\n')}`));
    });
  });
}

async function runDownloadJob(job) {
  try {
    job.status = 'checking';
    job.stage = '正在检查视频';
    job.progress = 3;
    job.updatedAt = nowIso();

    const info = await execYtDlpJson(job.url);
    const summary = summarizeInfo(job.url, info);
    job.preview = summary;

    const libraryBeforeDownload = readLibrary();
    const duplicate = findDuplicate(libraryBeforeDownload, summary.source);
    if (duplicate) {
      job.status = 'duplicate';
      job.stage = '这个视频已经下载过';
      job.progress = 100;
      job.existingTrack = publicTrack(duplicate);
      job.updatedAt = nowIso();
      return;
    }

    const trackId = makeId('trk');
    const outputTemplate = path.join(MEDIA_DIR, `${trackId}.%(ext)s`);
    const finalFileName = `${trackId}.mp3`;
    const finalPath = path.join(MEDIA_DIR, finalFileName);

    job.status = 'downloading';
    job.stage = '正在下载音频';
    job.progress = 10;
    job.updatedAt = nowIso();

    const args = [
      '--no-playlist',
      '--newline',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '-o',
      outputTemplate
    ];
    addCookieArgs(args);
    args.push(job.url);

    await spawnDownload(job, args);

    if (!fs.existsSync(finalPath)) {
      throw new Error('下载完成，但没有找到转换后的 MP3 文件。请检查 ffmpeg 是否可用。');
    }

    const library = readLibrary();
    const duplicateAfterDownload = findDuplicate(library, summary.source);
    if (duplicateAfterDownload) {
      fs.rmSync(finalPath, { force: true });
      job.status = 'duplicate';
      job.stage = '这个视频已经下载过';
      job.progress = 100;
      job.existingTrack = publicTrack(duplicateAfterDownload);
      job.updatedAt = nowIso();
      return;
    }

    const track = {
      id: trackId,
      title: cleanTitle(job.title, summary.title),
      originalTitle: summary.originalTitle,
      file: finalFileName,
      sourceKey: summary.source.key,
      source: summary.source,
      duration: summary.duration,
      uploader: summary.uploader,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    library.tracks.unshift(track);
    writeLibrary(library);

    job.status = 'complete';
    job.stage = '下载完成';
    job.progress = 100;
    job.track = publicTrack(track);
    job.updatedAt = nowIso();
  } catch (error) {
    job.status = 'failed';
    job.stage = '下载失败';
    job.progress = 100;
    job.error = error.message;
    job.updatedAt = nowIso();
  }
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('请求内容太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求内容不是有效 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function requireUrl(body) {
  const value = String(body.url || '').trim();
  if (!value) throw new Error('请先输入 Bilibili 视频 URL');
  if (!/^https?:\/\//i.test(value)) throw new Error('URL 需要以 http:// 或 https:// 开头');
  return value;
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      name: 'Gama Music',
      cookieBrowser: COOKIE_BROWSER,
      protocol: activeProtocol,
      urls: localUrls()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/library') {
    sendJson(res, 200, publicLibrary(readLibrary()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/preview') {
    const body = await readJsonBody(req);
    const videoUrl = requireUrl(body);
    const info = await execYtDlpJson(videoUrl);
    sendJson(res, 200, summarizeInfo(videoUrl, info));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/download') {
    const body = await readJsonBody(req);
    const videoUrl = requireUrl(body);
    const job = {
      id: makeId('job'),
      url: videoUrl,
      title: cleanTitle(body.title || ''),
      status: 'queued',
      stage: '排队中',
      progress: 0,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    jobs.set(job.id, job);
    runDownloadJob(job);
    sendJson(res, 202, { job: publicJob(job) });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (req.method === 'GET' && jobMatch) {
    const job = jobs.get(decodeURIComponent(jobMatch[1]));
    if (!job) {
      sendJson(res, 404, { error: '没有找到这个下载任务' });
      return;
    }
    sendJson(res, 200, { job: publicJob(job) });
    return;
  }

  const trackMatch = url.pathname.match(/^\/api\/tracks\/([^/]+)$/);
  if (trackMatch) {
    const trackId = decodeURIComponent(trackMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const title = cleanTitle(body.title || '');
      if (!title) throw new Error('歌名不能为空');
      const library = readLibrary();
      const track = library.tracks.find((item) => item.id === trackId);
      if (!track) {
        sendJson(res, 404, { error: '没有找到这首歌' });
        return;
      }
      track.title = title;
      track.updatedAt = nowIso();
      writeLibrary(library);
      sendJson(res, 200, { track: publicTrack(track) });
      return;
    }

    if (req.method === 'DELETE') {
      const library = readLibrary();
      const trackIndex = library.tracks.findIndex((item) => item.id === trackId);
      if (trackIndex === -1) {
        sendJson(res, 404, { error: '没有找到这首歌' });
        return;
      }
      const [track] = library.tracks.splice(trackIndex, 1);
      for (const playlist of library.playlists) {
        playlist.trackIds = playlist.trackIds.filter((id) => id !== trackId);
        playlist.updatedAt = nowIso();
      }
      writeLibrary(library);
      if (track.file) {
        fs.rmSync(path.join(MEDIA_DIR, track.file), { force: true });
      }
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/playlists') {
    const body = await readJsonBody(req);
    const name = cleanTitle(body.name || '', '新播放列表');
    const library = readLibrary();
    const playlist = {
      id: makeId('pl'),
      name,
      trackIds: [],
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    library.playlists.unshift(playlist);
    writeLibrary(library);
    sendJson(res, 201, { playlist: publicPlaylist(playlist) });
    return;
  }

  const playlistMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)$/);
  if (playlistMatch) {
    const playlistId = decodeURIComponent(playlistMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const name = cleanTitle(body.name || '');
      if (!name) throw new Error('播放列表名称不能为空');
      const library = readLibrary();
      const playlist = library.playlists.find((item) => item.id === playlistId);
      if (!playlist) {
        sendJson(res, 404, { error: '没有找到这个播放列表' });
        return;
      }
      playlist.name = name;
      playlist.updatedAt = nowIso();
      writeLibrary(library);
      sendJson(res, 200, { playlist: publicPlaylist(playlist) });
      return;
    }

    if (req.method === 'DELETE') {
      const library = readLibrary();
      const nextPlaylists = library.playlists.filter((item) => item.id !== playlistId);
      if (nextPlaylists.length === library.playlists.length) {
        sendJson(res, 404, { error: '没有找到这个播放列表' });
        return;
      }
      library.playlists = nextPlaylists;
      writeLibrary(library);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  const playlistTrackMatch = url.pathname.match(/^\/api\/playlists\/([^/]+)\/tracks(?:\/([^/]+))?$/);
  if (playlistTrackMatch) {
    const playlistId = decodeURIComponent(playlistTrackMatch[1]);
    const trackIdFromPath = playlistTrackMatch[2] ? decodeURIComponent(playlistTrackMatch[2]) : null;
    const library = readLibrary();
    const playlist = library.playlists.find((item) => item.id === playlistId);
    if (!playlist) {
      sendJson(res, 404, { error: '没有找到这个播放列表' });
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const trackId = String(body.trackId || '').trim();
      const track = library.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error('没有找到这首歌');
      if (!playlist.trackIds.includes(trackId)) {
        playlist.trackIds.push(trackId);
        playlist.updatedAt = nowIso();
        writeLibrary(library);
      }
      sendJson(res, 200, { playlist: publicPlaylist(playlist) });
      return;
    }

    if (req.method === 'DELETE' && trackIdFromPath) {
      playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== trackIdFromPath);
      playlist.updatedAt = nowIso();
      writeLibrary(library);
      sendJson(res, 200, { playlist: publicPlaylist(playlist) });
      return;
    }
  }

  sendJson(res, 404, { error: '没有找到这个接口' });
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: Math.round(job.progress),
    preview: job.preview || null,
    track: job.track || null,
    existingTrack: job.existingTrack || null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function safeJoin(baseDir, requestPath) {
  const resolved = path.resolve(baseDir, `.${requestPath}`);
  if (resolved === baseDir || resolved.startsWith(`${baseDir}${path.sep}`)) {
    return resolved;
  }
  return null;
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function serveFile(req, res, filePath, contentType) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Content-Type', contentType || mimeTypes[path.extname(filePath)] || 'application/octet-stream');

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start <= end && end < stat.size) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(filePath, { start, end }).pipe(res);
        return;
      }
    }
    res.statusCode = 416;
    res.end();
    return;
  }

  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
}

function serveMedia(req, res, url) {
  const fileName = safeDecodeURIComponent(url.pathname.replace(/^\/media\//, ''));
  const filePath = safeJoin(MEDIA_DIR, `/${fileName}`);
  if (!filePath) {
    res.statusCode = 400;
    res.end('Bad path');
    return;
  }
  serveFile(req, res, filePath, 'audio/mpeg');
}

function serveWeb(req, res, url) {
  let requestPath = safeDecodeURIComponent(url.pathname);
  if (requestPath === '/') requestPath = '/index.html';
  const filePath = safeJoin(WEB_DIR, requestPath);
  if (!filePath) {
    res.statusCode = 400;
    res.end('Bad path');
    return;
  }
  if (path.basename(filePath) === 'service-worker.js') {
    res.setHeader('Service-Worker-Allowed', '/');
  }
  serveFile(req, res, filePath);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `${activeProtocol}://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith('/media/')) {
      serveMedia(req, res, url);
      return;
    }

    serveWeb(req, res, url);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

function createServer() {
  const certPath = process.env.GAMA_MUSIC_HTTPS_CERT;
  const keyPath = process.env.GAMA_MUSIC_HTTPS_KEY;
  if (certPath && keyPath) {
    activeProtocol = 'https';
    return https.createServer({
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath)
    }, handleRequest);
  }

  activeProtocol = 'http';
  return http.createServer(handleRequest);
}

function localUrls() {
  const urls = [`${activeProtocol}://localhost:${PORT}`];
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) {
        urls.push(`${activeProtocol}://${entry.address}:${PORT}`);
      }
    }
  }
  return Array.from(new Set(urls));
}

let activeProtocol = 'http';
const server = createServer();

server.listen(PORT, HOST, () => {
  console.log('Gama Music is running.');
  console.log('');
  console.log('Open one of these addresses on your iPhone while it is on the same Wi-Fi:');
  for (const address of localUrls()) {
    console.log(`  ${address}`);
  }
  console.log('');
  console.log(`Cookie browser: ${COOKIE_BROWSER}`);
  console.log(`Media folder: ${MEDIA_DIR}`);
});
