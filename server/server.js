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

const STORAGE_DIR =
  process.env.GAMA_MUSIC_STORAGE_DIR ||
  ROOT_DIR;

const DATA_DIR =
  path.join(STORAGE_DIR, 'data');

const MEDIA_DIR =
  path.join(STORAGE_DIR, 'media');

const LIBRARY_PATH =
  path.join(DATA_DIR, 'library.json');

const PORT = Number(process.env.PORT || 7330);
const HOST = process.env.HOST || '0.0.0.0';
const YTDLP_BIN = process.env.GAMA_MUSIC_YTDLP || 'yt-dlp';
const FFMPEG_DIR =
  process.env.GAMA_MUSIC_FFMPEG_DIR ||
  '';
const COOKIE_BROWSER = process.env.GAMA_MUSIC_COOKIE_BROWSER || 'chrome';
const CORS_ORIGIN = process.env.GAMA_MUSIC_CORS_ORIGIN || '*';

const jobs = new Map();
const favoriteJobs = new Map();

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

    cover: track.cover || null,

    source: track.source,
    duration: track.duration || null,
    uploader: track.uploader || null,
    createdAt: track.createdAt,
    updatedAt: track.updatedAt
  };
}

function publicLibrary(library) {
  return {
    version: library.version,
    tracks: library.tracks.map(publicTrack),
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

function trackHasCover(track) {
  if (!track?.cover) return false;

  const coverPath =
    path.join(MEDIA_DIR, track.cover);

  return (
    fs.existsSync(coverPath) &&
    fs.statSync(coverPath).isFile() &&
    fs.statSync(coverPath).size > 0
  );
}


function pickThumbnailUrl(info = {}) {
  const direct =
    String(info.thumbnail || '').trim();

  if (direct) {
    return direct;
  }

  const thumbnails =
    Array.isArray(info.thumbnails)
      ? info.thumbnails
      : [];

  for (
    let index = thumbnails.length - 1;
    index >= 0;
    index -= 1
  ) {
    const candidate =
      String(thumbnails[index]?.url || '').trim();

    if (candidate) {
      return candidate;
    }
  }

  return '';
}


function coverExtension(contentType, urlValue) {
  const type =
    String(contentType || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

  if (
    type === 'image/jpeg' ||
    type === 'image/jpg'
  ) {
    return 'jpg';
  }

  if (type === 'image/png') {
    return 'png';
  }

  if (type === 'image/webp') {
    return 'webp';
  }

  if (type === 'image/avif') {
    return 'avif';
  }

  try {
    const ext =
      path.extname(
        new URL(urlValue).pathname
      ).toLowerCase();

    if (ext === '.jpeg') {
      return 'jpg';
    }

    if (
      [
        '.jpg',
        '.png',
        '.webp',
        '.avif'
      ].includes(ext)
    ) {
      return ext.slice(1);
    }
  } catch {
    // ignore
  }

  return 'jpg';
}


function downloadCoverImage(
  urlValue,
  trackId,
  redirectCount = 0
) {
  return new Promise((resolve, reject) => {

    if (redirectCount > 5) {
      reject(
        new Error('封面下载重定向次数过多')
      );
      return;
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(urlValue);
    } catch {
      reject(
        new Error('封面 URL 无效')
      );
      return;
    }

    const client =
      parsedUrl.protocol === 'https:'
        ? https
        : http;

    const request =
      client.get(
        parsedUrl,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Referer':
              'https://www.bilibili.com/'
          }
        },
        (response) => {

          const status =
            response.statusCode || 0;

          /*
           * CDN 重定向
           */
          if (
            [
              301,
              302,
              303,
              307,
              308
            ].includes(status) &&
            response.headers.location
          ) {
            response.resume();

            const nextUrl =
              new URL(
                response.headers.location,
                parsedUrl
              ).toString();

            resolve(
              downloadCoverImage(
                nextUrl,
                trackId,
                redirectCount + 1
              )
            );

            return;
          }

          if (
            status < 200 ||
            status >= 300
          ) {
            response.resume();

            reject(
              new Error(
                `封面下载失败：HTTP ${status}`
              )
            );

            return;
          }

          const ext =
            coverExtension(
              response.headers['content-type'],
              parsedUrl.toString()
            );

          const fileName =
            `${trackId}-cover.${ext}`;

          const finalPath =
            path.join(
              MEDIA_DIR,
              fileName
            );

          const tempPath =
            `${finalPath}.part`;

          const output =
            fs.createWriteStream(tempPath);

          response.pipe(output);

          output.on(
            'finish',
            () => {
              output.close(() => {

                try {
                  if (
                    !fs.existsSync(tempPath) ||
                    fs.statSync(tempPath).size <= 0
                  ) {
                    fs.rmSync(
                      tempPath,
                      { force: true }
                    );

                    reject(
                      new Error(
                        '下载到的封面文件为空'
                      )
                    );

                    return;
                  }

                  fs.renameSync(
                    tempPath,
                    finalPath
                  );

                  resolve(fileName);

                } catch (error) {
                  fs.rmSync(
                    tempPath,
                    { force: true }
                  );

                  reject(error);
                }
              });
            }
          );

          output.on(
            'error',
            (error) => {
              fs.rmSync(
                tempPath,
                { force: true }
              );

              reject(error);
            }
          );
        }
      );

    request.setTimeout(
      60000,
      () => {
        request.destroy(
          new Error('封面下载超时')
        );
      }
    );

    request.on(
      'error',
      reject
    );
  });
}


async function ensureTrackCover(
  trackId,
  info
) {
  const library =
    readLibrary();

  const track =
    library.tracks.find(
      (item) => item.id === trackId
    );

  if (!track) {
    return null;
  }

  /*
   * 本地真的已经有封面：
   * 什么都不下载。
   */
  if (trackHasCover(track)) {
    return publicTrack(track);
  }

  const thumbnailUrl =
    pickThumbnailUrl(info);

  /*
   * B站没有提供封面：
   * 留空，前端以后显示默认封面。
   */
  if (!thumbnailUrl) {
    return publicTrack(track);
  }

  try {
    const coverFile =
      await downloadCoverImage(
        thumbnailUrl,
        track.id
      );

    track.cover =
      coverFile;

    track.updatedAt =
      nowIso();

    writeLibrary(library);

  } catch (error) {
    /*
     * 封面失败不应该导致整首 MP3 失败。
     */
    console.warn(
      `封面下载失败 ${track.title}:`,
      error.message
    );
  }

  return publicTrack(track);
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

function execYtDlpPlaylistJson(playlistUrl) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--flat-playlist',
      '--yes-playlist',
      '--skip-download',
      '--no-warnings'
    ];

    addCookieArgs(args);
    args.push(playlistUrl);

    execFile(
      YTDLP_BIN,
      args,
      {
        maxBuffer: 100 * 1024 * 1024,
        timeout: 300000
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              formatToolError(
                '读取 B站收藏夹失败',
                error,
                stderr
              )
            )
          );
          return;
        }

        try {
          const info = JSON.parse(stdout);

          const entries = Array.isArray(info.entries)
            ? info.entries
            : [];

          const videos = entries
            .map((entry) => {
              const identity =
                extractBilibiliIdentity(entry.webpage_url) ||
                extractBilibiliIdentity(entry.url) ||
                extractBilibiliIdentity(entry.id);

              if (!identity) {
                return null;
              }

              return {
                id: identity.id,
                key: identity.key,
                url: identity.canonicalUrl,
                title: cleanTitle(
                  entry.title,
                  identity.id
                )
              };
            })
            .filter(Boolean);

          resolve({
            title: cleanTitle(
              info.title,
              'B站收藏夹'
            ),
            count: videos.length,
            videos
          });
        } catch (parseError) {
          reject(
            new Error(
              `读取收藏夹结果失败: ${parseError.message}`
            )
          );
        }
      }
    );
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

function extractBilibiliFavoriteIdentity(rawUrl) {
  let url;

  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('收藏夹 URL 无效');
  }

  const fid = url.searchParams.get('fid');

  if (!fid || !/^\d+$/.test(fid)) {
    throw new Error('没有从这个链接里找到 B站收藏夹 fid');
  }

  const midMatch = url.pathname.match(/^\/(\d+)\/favlist\/?$/);
  const mid = midMatch?.[1] || url.searchParams.get('mid') || null;

  const key = mid
    ? `bili-fav:${mid}:${fid}`
    : `bili-fav:${fid}`;

  const canonicalUrl = mid
    ? `https://space.bilibili.com/${mid}/favlist?fid=${fid}`
    : `${url.origin}${url.pathname}?fid=${fid}`;

  return {
    kind: 'BILIBILI_FAVORITES',
    id: fid,
    mid,
    key,
    canonicalUrl,
    originalUrl: rawUrl
  };
}


function buildFavoritesImportPreview(result) {
  const library = readLibrary();

  const videos = result.videos.map((video, index) => {
    const source = buildSource(video.url, {
      id: video.id,
      webpage_url: video.url,
      title: video.title
    });

    const duplicate = findDuplicate(library, source);

    return {
      index: index + 1,
      id: video.id,
      key: source.key,
      url: video.url,
      title: video.title,
      duplicate: Boolean(duplicate),
      existingTrack: duplicate
        ? publicTrack(duplicate)
        : null
    };
  });

  const duplicateCount =
    videos.filter((video) => video.duplicate).length;

  return {
    title: result.title,
    count: videos.length,
    duplicateCount,
    pendingCount: videos.length - duplicateCount,
    videos
  };
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

    const downloadArgs =
      [...args];


    /*
     * Desktop App 可以指定自己内置的
     * ffmpeg / ffprobe 文件夹。
     */
    if (FFMPEG_DIR) {
      downloadArgs.unshift(
        '--ffmpeg-location',
        FFMPEG_DIR
      );
    }


    const child = spawn(
      YTDLP_BIN,
      downloadArgs,
      {
        cwd: MEDIA_DIR,
        stdio: [
          'ignore',
          'pipe',
          'pipe'
        ]
      }
    );

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

      job.stage =
        trackHasCover(duplicate)
          ? '这个视频已经下载过'
          : '歌曲已经存在，正在检查封面';

      job.progress =
        trackHasCover(duplicate)
          ? 100
          : 90;

      const updatedTrack =
        await ensureTrackCover(
          duplicate.id,
          info
        );

      job.status =
        'duplicate';

      job.stage =
        updatedTrack?.cover
          ? '歌曲已经存在，封面已检查'
          : '歌曲已经存在';

      job.progress = 100;

      job.existingTrack =
        updatedTrack ||
        publicTrack(duplicate);

      job.updatedAt =
        nowIso();

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

      fs.rmSync(
        finalPath,
        { force: true }
      );

      const updatedTrack =
        await ensureTrackCover(
          duplicateAfterDownload.id,
          info
        );

      job.status =
        'duplicate';

      job.stage =
        '这个视频已经下载过';

      job.progress =
        100;

      job.existingTrack =
        updatedTrack ||
        publicTrack(
          duplicateAfterDownload
        );

      job.updatedAt =
        nowIso();

      return;
    }

    let coverFileName = null;

    const thumbnailUrl =
      pickThumbnailUrl(info);

    if (thumbnailUrl) {
      job.stage =
        '正在下载封面';

      job.progress =
        Math.max(
          job.progress,
          95
        );

      try {
        coverFileName =
          await downloadCoverImage(
            thumbnailUrl,
            trackId
          );
      } catch (error) {
        console.warn(
          `封面下载失败 ${summary.title}:`,
          error.message
        );
      }
    }


    const track = {
      id: trackId,

      title:
        cleanTitle(
          job.title,
          summary.title
        ),

      originalTitle:
        summary.originalTitle,

      file:
        finalFileName,

      cover:
        coverFileName,

      sourceKey:
        summary.source.key,

      source:
        summary.source,

      duration:
        summary.duration,

      uploader:
        summary.uploader,

      createdAt:
        nowIso(),

      updatedAt:
        nowIso()
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

function publicFavoriteJob(job) {
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,

    playlistName:
      job.playlistName,

    favoriteKey:
      job.favoriteKey || null,

    trackIds:
      Array.isArray(job.trackIds)
        ? job.trackIds
        : [],

    total:
      job.total,

    processed:
      job.processed,

    downloaded:
      job.downloaded,

    duplicates:
      job.duplicates,

    failed:
      job.failed,

    currentIndex:
      job.currentIndex,

    currentVideo:
      job.currentVideo,

    progress:
      job.total
        ? Math.round(
          (job.processed / job.total) *
          100
        )
        : 0,

    failures:
      job.failures,

    error:
      job.error || null,

    createdAt:
      job.createdAt,

    updatedAt:
      job.updatedAt
  };
}

function addFavoriteJobTrack(
  job,
  trackId
) {

  if (!trackId) {
    return;
  }


  if (
    !Array.isArray(
      job.trackIds
    )
  ) {

    job.trackIds = [];

  }


  if (
    !job.trackIds.includes(
      trackId
    )
  ) {

    job.trackIds.push(
      trackId
    );

  }

}


async function runFavoriteImportJob(job, videos) {
  try {
    job.status = 'running';
    job.stage = '正在导入收藏夹';

    job.updatedAt = nowIso();

    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index];

      job.currentIndex = index + 1;
      job.currentVideo = {
        id: video.id,
        url: video.url,
        title: video.title
      };

      job.stage = `正在处理 ${index + 1} / ${videos.length}`;
      job.updatedAt = nowIso();

      const library = readLibrary();

      const source = buildSource(video.url, {
        id: video.id,
        webpage_url: video.url
      });

      const duplicate = findDuplicate(library, source);

      // 已存在：不下载，直接加入播放列表
      if (duplicate) {

        job.duplicates += 1;

        /*
         * MP3 已经存在，
         * 但如果没有封面就单独补封面。
         */
        if (!trackHasCover(duplicate)) {

          job.stage =
            `正在补封面 ${index + 1} / ${videos.length}`;

          try {
            const info =
              await execYtDlpJson(
                video.url
              );

            await ensureTrackCover(
              duplicate.id,
              info
            );

          } catch (error) {
            console.warn(
              `补封面失败 ${video.title}:`,
              error.message
            );
          }
        }

        addFavoriteJobTrack(
          job,
          duplicate.id
        );


        job.processed += 1;
        job.updatedAt = nowIso();

        continue;
      }

      // 不存在：正常下载
      const childJob = {
        id: makeId('job'),
        url: video.url,
        title: '',
        status: 'queued',
        stage: '排队中',
        progress: 0,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      jobs.set(childJob.id, childJob);

      await runDownloadJob(childJob);

      if (
        childJob.status === 'complete' &&
        childJob.track
      ) {

        job.downloaded += 1;


        addFavoriteJobTrack(
          job,
          childJob.track.id
        );



      } else if (
        childJob.status === 'duplicate' &&
        childJob.existingTrack
      ) {

        job.duplicates += 1;


        addFavoriteJobTrack(
          job,
          childJob.existingTrack.id
        );



      } else {
        job.failed += 1;

        job.failures.push({
          id: video.id,
          url: video.url,
          title: video.title,
          error: childJob.error || '未知错误'
        });
      }

      job.processed += 1;
      job.updatedAt = nowIso();
    }

    job.status = 'complete';
    job.stage = '收藏夹导入完成';
    job.currentVideo = null;
    job.updatedAt = nowIso();

  } catch (error) {
    job.status = 'failed';
    job.stage = '收藏夹导入失败';
    job.error = error.message;
    job.currentVideo = null;
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

  if (
    req.method === 'POST' &&
    url.pathname === '/api/favorites/preview'
  ) {
    const body = await readJsonBody(req);
    const playlistUrl = requireUrl(body);

    const rawResult =
      await execYtDlpPlaylistJson(playlistUrl);

    const result =
      buildFavoritesImportPreview(rawResult);

    sendJson(res, 200, result);
    return;
  }

  if (
    req.method === 'POST' &&
    url.pathname === '/api/favorites/import'
  ) {
    const body = await readJsonBody(req);
    const playlistUrl = requireUrl(body);

    const rawResult =
      await execYtDlpPlaylistJson(playlistUrl);

    const favoriteSource =
      extractBilibiliFavoriteIdentity(
        playlistUrl
      );

    const job = {
      id:
        makeId('fav'),

      status:
        'queued',

      stage:
        '准备导入收藏夹',

      playlistName:
        cleanTitle(
          rawResult.title,
          'B站收藏夹'
        ),

      favoriteKey:
        favoriteSource.key,

      trackIds:
        [],

      total:
        rawResult.videos.length,

      processed:
        0,

      downloaded:
        0,

      duplicates:
        0,

      failed:
        0,

      currentIndex:
        0,

      currentVideo:
        null,

      failures:
        [],

      createdAt:
        nowIso(),

      updatedAt:
        nowIso()
    };

    favoriteJobs.set(job.id, job);

    // 注意：传全部视频
    runFavoriteImportJob(
      job,
      rawResult.videos
    );

    sendJson(res, 202, {
      job: publicFavoriteJob(job)
    });

    return;
  }

  const favoriteJobMatch =
    url.pathname.match(/^\/api\/favorites\/jobs\/([^/]+)$/);

  if (
    req.method === 'GET' &&
    favoriteJobMatch
  ) {
    const jobId =
      decodeURIComponent(favoriteJobMatch[1]);

    const job =
      favoriteJobs.get(jobId);

    if (!job) {
      sendJson(res, 404, {
        error: '没有找到这个收藏夹导入任务'
      });
      return;
    }

    sendJson(res, 200, {
      job: publicFavoriteJob(job)
    });

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
      const [track] =
        library.tracks.splice(
          trackIndex,
          1
        );

      writeLibrary(library);
      if (track.file) {
        fs.rmSync(path.join(MEDIA_DIR, track.file), { force: true });
      }
      if (track.cover) {
        fs.rmSync(
          path.join(
            MEDIA_DIR,
            track.cover
          ),
          { force: true }
        );
      }
      sendJson(res, 200, { ok: true });
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

  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',

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
  const extension =
    path.extname(filePath).toLowerCase();

  if (
    [
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.avif'
    ].includes(extension)
  ) {
    res.setHeader(
      'Cache-Control',
      'public, max-age=31536000, immutable'
    );
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


    /*
     * Server 根地址只用于确认服务状态。
     * 播放器已经完全移动到 Gama Music Web。
     */
    if (url.pathname === '/') {
      sendJson(res, 200, {
        ok: true,
        name: 'Gama Music Server',
        webApp:
          'https://ugama.github.io/Gama-Music-Web/'
      });

      return;
    }


    sendJson(res, 404, {
      error: '没有找到这个地址'
    });
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
  console.log('Gama Music Server addresses:');
  for (const address of localUrls()) {
    console.log(`  ${address}`);
  }
  console.log('');
  console.log(`Cookie browser: ${COOKIE_BROWSER}`);
  console.log(`Media folder: ${MEDIA_DIR}`);
});
