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


/*
 * 新架构的临时传输目录。
 *
 * Desktop 以后下载出来的 MP3 / 封面
 * 会先放这里，
 * Web 保存进 IndexedDB 后即可清理。
 */
const TRANSFER_DIR =
  path.join(
    STORAGE_DIR,
    'transfer'
  );

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

/*
 * 手机同步会话。
 *
 * 只存在 Desktop 内存中，
 * Desktop 退出后自动消失。
 */
const syncSessions =
  new Map();


/*
 * 一个同步二维码最多有效 15 分钟。
 */
const SYNC_SESSION_MAX_AGE_MS =
  15 * 60 * 1000;


/*
 * B站收藏夹同时最多处理 3 首。
 *
 * 3 对目前的 Mac / yt-dlp / ffmpeg
 * 是速度和稳定性之间比较合适的平衡。
 */
const FAVORITE_DOWNLOAD_CONCURRENCY = 3;

/*
 * transfer 只是临时传输区。
 *
 * 正常情况下 Web 保存成功后
 * 会立刻通知 Desktop 删除。
 *
 * 如果 Web 中途关闭、断网或者崩溃，
 * 最迟 24 小时后自动清理。
 */
const TRANSFER_MAX_AGE_MS =
  24 * 60 * 60 * 1000;


const TRANSFER_CLEANUP_INTERVAL_MS =
  60 * 60 * 1000;

fs.mkdirSync(
  TRANSFER_DIR,
  { recursive: true }
);

function publicSyncSession(
  session
) {

  return {

    id:
      session.id,

    status:
      session.status,

    createdAt:
      session.createdAt,

    updatedAt:
      session.updatedAt,

    expiresAt:
      session.expiresAt,

    trackCount:
      session.trackCount || 0,

    playlistCount:
      session.playlistCount || 0,

    uploadedTrackCount:
      Object.values(
        session.files || {}
      ).filter(
        (entry) =>
          Boolean(
            entry?.audio
          )
      ).length

  };

}

function cleanupSyncSessionFiles(
  session
) {

  let removedCount = 0;


  const files =
    session?.files &&
      typeof session.files ===
      'object'
      ? session.files
      : {};


  for (
    const entry
    of Object.values(files)
  ) {

    for (
      const fileName
      of [
        entry?.audio,
        entry?.cover
      ]
    ) {

      if (!fileName) {
        continue;
      }


      const filePath =
        safeJoin(
          TRANSFER_DIR,
          `/${fileName}`
        );


      if (!filePath) {
        continue;
      }


      try {

        if (
          fs.existsSync(
            filePath
          )
        ) {

          fs.rmSync(
            filePath,
            {
              force: true
            }
          );


          removedCount += 1;

        }

      } catch (error) {

        console.warn(
          `同步临时文件清理失败 ${fileName}:`,
          error.message
        );

      }

    }

  }


  return removedCount;

}

function refreshSyncSessionExpiry(
  session
) {

  const now =
    Date.now();


  session.updatedAt =
    new Date(
      now
    ).toISOString();


  session.expiresAtMs =
    now +
    SYNC_SESSION_MAX_AGE_MS;


  session.expiresAt =
    new Date(
      session.expiresAtMs
    ).toISOString();

}

function cleanupExpiredSyncSessions() {

  const now =
    Date.now();


  let removedCount = 0;


  for (
    const [
      sessionId,
      session
    ]
    of syncSessions
  ) {

    if (
      session.expiresAtMs >
      now
    ) {

      continue;

    }


    cleanupSyncSessionFiles(
      session
    );
    syncSessions.delete(
      sessionId
    );


    removedCount += 1;

  }


  if (
    removedCount > 0
  ) {

    console.log(
      `已清理 ${removedCount} 个过期同步会话`
    );

  }


  return removedCount;

}

function cleanupExpiredTransferFiles() {

  const cutoff =
    Date.now() -
    TRANSFER_MAX_AGE_MS;


  let entries;


  try {

    entries =
      fs.readdirSync(
        TRANSFER_DIR,
        {
          withFileTypes: true
        }
      );

  } catch (error) {

    console.warn(
      '无法读取 transfer 目录：',
      error.message
    );

    return 0;

  }


  let removedCount = 0;


  for (
    const entry
    of entries
  ) {

    if (!entry.isFile()) {
      continue;
    }


    const filePath =
      path.join(
        TRANSFER_DIR,
        entry.name
      );


    try {

      const stat =
        fs.statSync(
          filePath
        );


      /*
       * 24 小时以内的文件保留。
       */
      if (
        stat.mtimeMs >= cutoff
      ) {

        continue;

      }


      fs.rmSync(
        filePath,
        {
          force: true
        }
      );


      removedCount += 1;

    } catch (error) {

      console.warn(
        `清理临时文件失败 ${entry.name}:`,
        error.message
      );

    }

  }


  if (removedCount > 0) {

    console.log(
      `已清理 ${removedCount} 个过期临时文件`
    );

  }


  return removedCount;

}

function nowIso() {
  return new Date().toISOString();
}

/*
 * Desktop 启动时先清理一次。
 */
cleanupExpiredTransferFiles();


/*
 * 之后每小时检查一次。
 */
const transferCleanupTimer =
  setInterval(
    cleanupExpiredTransferFiles,
    TRANSFER_CLEANUP_INTERVAL_MS
  );

/*
 * 同步会话很短，
 * 每分钟检查一次即可。
 */
const syncSessionCleanupTimer =
  setInterval(
    cleanupExpiredSyncSessions,
    60 * 1000
  );


syncSessionCleanupTimer.unref?.();
/*
 * 清理定时器本身不能阻止
 * Node / Electron 正常退出。
 */
transferCleanupTimer.unref?.();

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
  targetDir = TRANSFER_DIR,
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
                targetDir,
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
              targetDir,
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

function summarizeInfo(
  rawUrl,
  info
) {

  const source =
    buildSource(
      rawUrl,
      info
    );


  /*
   * Desktop 不再判断
   * 用户的音乐库里有没有这首歌。
   *
   * 音乐库属于 Web。
   */
  return {

    title:
      cleanTitle(
        info.title,
        source.id
      ),

    originalTitle:
      cleanTitle(
        info.title,
        source.id
      ),

    duration:
      Number.isFinite(
        info.duration
      )
        ? info.duration
        : null,

    uploader:
      info.uploader ||
      info.channel ||
      null,

    source

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
        cwd: TRANSFER_DIR,
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

    const trackId = makeId('trk');
    const outputTemplate =
      path.join(
        TRANSFER_DIR,
        `${trackId}.%(ext)s`
      );

    const finalFileName =
      `${trackId}.mp3`;

    const finalPath =
      path.join(
        TRANSFER_DIR,
        finalFileName
      );

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
            trackId,
            TRANSFER_DIR
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


    /*
 * 新架构：
 *
 * 下载完成以后不再写入
 * Desktop 的 library.json。
 *
 * MP3 + 封面暂时留在 transfer，
 * job.track 直接交给 Web。
 */
    job.status =
      'complete';

    job.stage =
      '等待 Web 保存';

    job.progress =
      100;

    job.track =
      publicTrack(
        track
      );

    job.updatedAt =
      nowIso();
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

    tracks:
      Array.isArray(job.tracks)
        ? job.tracks
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
  track
) {

  if (!track?.id) {
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
    !Array.isArray(
      job.tracks
    )
  ) {

    job.tracks = [];

  }


  /*
   * 保留旧 trackIds，
   * 这样现在的 Web 不会被破坏。
   */
  if (
    !job.trackIds.includes(
      track.id
    )
  ) {

    job.trackIds.push(
      track.id
    );

  }


  /*
   * 同时保存完整歌曲信息。
   *
   * 下一阶段 Web 就可以直接使用这里，
   * 不再依赖 /api/library。
   */
  const existingIndex =
    job.tracks.findIndex(
      (item) =>
        item.id === track.id
    );


  if (
    existingIndex === -1
  ) {

    job.tracks.push(
      track
    );

  } else {

    job.tracks[
      existingIndex
    ] = track;

  }

}


async function runFavoriteImportJob(
  job,
  videos,
  existingTracks = []
) {

  /*
   * 这是 Web 临时告诉 Desktop 的
   * “我已经真正保存好的歌曲”。
   *
   * 它只存在于当前任务内存中，
   * 不写 library.json。
   */
  const webLibrary = {
    tracks:
      Array.isArray(
        existingTracks
      )
        ? existingTracks
        : []
  };

  try {

    job.status =
      'running';

    job.stage =
      '正在导入收藏夹';

    job.updatedAt =
      nowIso();


    /*
     * 下一个还没有分配给 worker 的歌曲序号。
     */
    let nextIndex = 0;


    /*
     * 处理单独一首歌曲。
     */
    async function processVideo(
      index
    ) {

      const video =
        videos[index];


      /*
       * 有 3 个任务同时运行，
       * 所以这里显示最近开始处理的歌曲。
       */
      job.currentIndex =
        Math.max(
          job.currentIndex || 0,
          index + 1
        );


      job.currentVideo = {
        id:
          video.id,

        url:
          video.url,

        title:
          video.title
      };


      job.stage =
        `正在处理 ${index + 1} / ${videos.length}`;


      job.updatedAt =
        nowIso();


      try {


        const source =
          buildSource(
            video.url,
            {
              id:
                video.id,

              webpage_url:
                video.url
            }
          );


        const duplicate =
          findDuplicate(
            webLibrary,
            source
          );

        /*
         * 已经存在：
         * 不重新下载 MP3。
         */
        if (duplicate) {

          /*
           * Web 已经真正拥有这首歌，
           * Desktop 不需要做任何事情。
           */
          job.duplicates += 1;


          addFavoriteJobTrack(
            job,
            duplicate
          );


          return;

        }

        /*
         * 不存在：
         * 创建普通单曲下载任务。
         */
        const childJob = {

          id:
            makeId('job'),

          url:
            video.url,

          title:
            '',

          status:
            'queued',

          stage:
            '排队中',

          progress:
            0,

          createdAt:
            nowIso(),

          updatedAt:
            nowIso()

        };


        jobs.set(
          childJob.id,
          childJob
        );


        /*
         * 注意：
         *
         * 这里仍然 await 单个任务，
         * 但我们会同时启动 3 个 worker。
         *
         * 所以最多同时存在
         * 3 个 runDownloadJob。
         */
        await runDownloadJob(
          childJob
        );


        if (
          childJob.status ===
          'complete' &&
          childJob.track
        ) {

          job.downloaded += 1;


          addFavoriteJobTrack(
            job,
            childJob.track
          );


        } else {
          job.failed += 1;


          job.failures.push({
            id:
              video.id,

            url:
              video.url,

            title:
              video.title,

            error:
              childJob.error ||
              '未知错误'
          });

        }

      } catch (error) {

        /*
         * 单独一首出错，
         * 不让整个收藏夹停止。
         */
        job.failed += 1;


        job.failures.push({
          id:
            video.id,

          url:
            video.url,

          title:
            video.title,

          error:
            error.message ||
            '未知错误'
        });

      } finally {

        /*
         * 无论成功、重复还是失败，
         * 这一首都算处理完成。
         *
         * JS 在这里修改数字是同步的，
         * 三个 worker 不会把计数覆盖掉。
         */
        job.processed += 1;


        job.stage =
          `已处理 ${job.processed} / ${videos.length}`;


        job.updatedAt =
          nowIso();

      }

    }


    /*
     * 一个 worker：
     *
     * 拿一首
     * ↓
     * 处理完
     * ↓
     * 马上拿下一首
     */
    async function worker() {

      while (true) {

        if (
          nextIndex >=
          videos.length
        ) {
          return;
        }


        const index =
          nextIndex;


        nextIndex += 1;


        await processVideo(
          index
        );

      }

    }


    /*
     * 最多同时 3 个 worker。
     *
     * 如果收藏夹只有 1～2 首，
     * 就只创建实际需要的数量。
     */
    const workerCount =
      Math.min(
        FAVORITE_DOWNLOAD_CONCURRENCY,
        videos.length
      );


    await Promise.all(
      Array.from(
        {
          length:
            workerCount
        },
        () =>
          worker()
      )
    );


    job.status =
      'complete';


    job.stage =
      '收藏夹导入完成';


    job.currentIndex =
      videos.length;


    job.currentVideo =
      null;


    job.updatedAt =
      nowIso();

  } catch (error) {

    job.status =
      'failed';


    job.stage =
      '收藏夹导入失败';


    job.error =
      error.message;


    job.currentVideo =
      null;


    job.updatedAt =
      nowIso();

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

function readBinaryBody(
  req,
  maxBytes =
    150 * 1024 * 1024
) {

  return new Promise(
    (resolve, reject) => {

      const chunks = [];

      let totalBytes = 0;
      let failed = false;


      req.on(
        'data',
        (chunk) => {

          if (failed) {
            return;
          }


          totalBytes +=
            chunk.length;


          if (
            totalBytes >
            maxBytes
          ) {

            failed = true;

            reject(
              new Error(
                '同步文件过大'
              )
            );

            return;

          }


          chunks.push(
            chunk
          );

        }
      );


      req.on(
        'end',
        () => {

          if (failed) {
            return;
          }


          resolve(
            Buffer.concat(
              chunks,
              totalBytes
            )
          );

        }
      );


      req.on(
        'error',
        (error) => {

          if (failed) {
            return;
          }

          failed = true;

          reject(error);

        }
      );

    }
  );

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

function cleanupTransferFiles(
  trackId
) {

  const id =
    String(
      trackId || ''
    ).trim();


  /*
   * Gama Music 自己生成的歌曲 ID：
   *
   * trk_ + 16 位十六进制字符
   *
   * 严格检查 ID，
   * 避免这个接口删除 transfer
   * 目录以外的任何文件。
   */
  if (
    !/^trk_[0-9a-f]{16}$/i.test(
      id
    )
  ) {

    throw new Error(
      '临时歌曲 ID 无效'
    );

  }


  const removedFiles =
    [];


  const entries =
    fs.readdirSync(
      TRANSFER_DIR,
      {
        withFileTypes: true
      }
    );


  for (
    const entry
    of entries
  ) {

    if (!entry.isFile()) {
      continue;
    }


    const fileName =
      entry.name;


    const isAudio =
      fileName ===
      `${id}.mp3`;


    const isCover =
      fileName.startsWith(
        `${id}-cover.`
      );


    if (
      !isAudio &&
      !isCover
    ) {

      continue;

    }


    fs.rmSync(
      path.join(
        TRANSFER_DIR,
        fileName
      ),
      {
        force: true
      }
    );


    removedFiles.push(
      fileName
    );

  }


  return removedFiles;

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

  if (
    req.method === 'POST' &&
    url.pathname ===
    '/api/sync/sessions'
  ) {

    /*
     * 创建前顺手清理过期会话。
     */
    cleanupExpiredSyncSessions();


    const createdAtMs =
      Date.now();


    const expiresAtMs =
      createdAtMs +
      SYNC_SESSION_MAX_AGE_MS;


    const session = {

      id:
        makeId('sync'),

      status:
        'waiting',

      trackCount:
        0,

      playlistCount:
        0,

      manifest:
        null,

      files:
        {},

      createdAt:
        new Date(
          createdAtMs
        ).toISOString(),

      updatedAt:
        new Date(
          createdAtMs
        ).toISOString(),

      expiresAt:
        new Date(
          expiresAtMs
        ).toISOString(),

      expiresAtMs

    };


    syncSessions.set(
      session.id,
      session
    );


    sendJson(
      res,
      201,
      {
        session:
          publicSyncSession(
            session
          )
      }
    );


    return;

  }

  const syncTrackAudioMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)\/tracks\/([^/]+)\/audio$/
    );


  if (
    req.method === 'POST' &&
    syncTrackAudioMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncTrackAudioMatch[1]
      );


    const trackId =
      decodeURIComponent(
        syncTrackAudioMatch[2]
      );


    const session =
      syncSessions.get(
        sessionId
      );


    if (!session) {

      sendJson(
        res,
        404,
        {
          error:
            '同步会话不存在或已经过期'
        }
      );

      return;

    }


    /*
     * 必须先在 manifest 中存在这首歌，
     * 才允许上传对应 MP3。
     */
    const trackExists =
      Array.isArray(
        session.manifest?.tracks
      ) &&
      session.manifest.tracks.some(
        (track) =>
          String(track?.id) ===
          trackId
      );


    if (!trackExists) {

      sendJson(
        res,
        400,
        {
          error:
            '这首歌不在当前同步清单中'
        }
      );

      return;

    }


    const audioBuffer =
      await readBinaryBody(req);


    if (!audioBuffer.length) {

      sendJson(
        res,
        400,
        {
          error:
            '没有收到 MP3 数据'
        }
      );

      return;

    }


    /*
     * Desktop 自己生成随机临时文件名，
     * 不直接使用用户的 trackId 当文件名。
     */
    const fileName =
      `${makeId('sync-audio')}.mp3`;


    const filePath =
      path.join(
        TRANSFER_DIR,
        fileName
      );


    fs.writeFileSync(
      filePath,
      audioBuffer
    );


    /*
     * 如果同一首歌重新上传，
     * 删除上一份临时 MP3。
     */
    const oldAudio =
      session.files?.[
        trackId
      ]?.audio;


    if (oldAudio) {

      const oldPath =
        safeJoin(
          TRANSFER_DIR,
          `/${oldAudio}`
        );


      if (
        oldPath &&
        oldPath !== filePath
      ) {

        fs.rmSync(
          oldPath,
          {
            force: true
          }
        );

      }

    }


    session.files[
      trackId
    ] = {

      ...(
        session.files[
        trackId
        ] || {}
      ),

      audio:
        fileName,

      audioBytes:
        audioBuffer.length

    };


    session.status =
      'uploading';


    refreshSyncSessionExpiry(
      session
    );

    sendJson(
      res,
      200,
      {
        session:
          publicSyncSession(
            session
          ),

        upload: {
          trackId,

          bytes:
            audioBuffer.length
        }
      }
    );


    return;

  }

  const syncManifestMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)\/manifest$/
    );


  if (
    req.method === 'POST' &&
    syncManifestMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncManifestMatch[1]
      );


    const session =
      syncSessions.get(
        sessionId
      );


    if (!session) {

      sendJson(
        res,
        404,
        {
          error:
            '同步会话不存在或已经过期'
        }
      );

      return;

    }


    const body =
      await readJsonBody(req);


    const tracks =
      Array.isArray(body.tracks)
        ? body.tracks
        : [];


    const playlists =
      Array.isArray(body.playlists)
        ? body.playlists
        : [];


    /*
     * 这里只保存元数据。
     *
     * 还没有上传 MP3 或封面。
     */
    session.manifest = {
      tracks,
      playlists
    };


    session.trackCount =
      tracks.length;


    session.playlistCount =
      playlists.length;


    session.status =
      'manifest-ready';


    refreshSyncSessionExpiry(
      session
    );

    sendJson(
      res,
      200,
      {
        session:
          publicSyncSession(
            session
          )
      }
    );


    return;

  }

  const syncSessionMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)$/
    );


  if (
    req.method === 'GET' &&
    syncSessionMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncSessionMatch[1]
      );


    const session =
      syncSessions.get(
        sessionId
      );


    if (!session) {

      sendJson(
        res,
        404,
        {
          error:
            '同步会话不存在或已经过期'
        }
      );

      return;

    }


    sendJson(
      res,
      200,
      {
        session:
          publicSyncSession(
            session
          )
      }
    );


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
    url.pathname === '/api/favorites/import'
  ) {
    const body = await readJsonBody(req);
    const playlistUrl = requireUrl(body);
    const existingTracks =
      Array.isArray(
        body.existingTracks
      )
        ? body.existingTracks
          .filter(
            (track) =>
              track?.id
          )
        : [];

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

      tracks:
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
      rawResult.videos,
      existingTracks
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

  const transferCompleteMatch =
    url.pathname.match(
      /^\/api\/transfers\/([^/]+)\/complete$/
    );


  if (
    req.method === 'POST' &&
    transferCompleteMatch
  ) {

    const trackId =
      decodeURIComponent(
        transferCompleteMatch[1]
      );


    /*
     * Web 已经把 MP3 / 封面
     * 成功保存进 IndexedDB。
     *
     * Desktop 的临时副本
     * 现在可以安全删除。
     */
    const removedFiles =
      cleanupTransferFiles(
        trackId
      );


    sendJson(
      res,
      200,
      {
        ok: true,
        trackId,
        removedFiles
      }
    );


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

function serveMedia(
  req,
  res,
  url
) {

  const fileName =
    safeDecodeURIComponent(
      url.pathname.replace(
        /^\/media\//,
        ''
      )
    );


  /*
   * /media/ 现在只是一个
   * 临时传输文件接口。
   *
   * 所有文件都来自 transfer。
   */
  const filePath =
    safeJoin(
      TRANSFER_DIR,
      `/${fileName}`
    );


  if (!filePath) {

    res.statusCode = 400;
    res.end('Bad path');
    return;

  }


  /*
   * 临时文件不做长期浏览器缓存。
   * Web 拿到以后会自己保存进 IndexedDB。
   */
  res.setHeader(
    'Cache-Control',
    'no-store'
  );


  serveFile(
    req,
    res,
    filePath
  );

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
  console.log(
    `Transfer folder: ${TRANSFER_DIR}`
  );
});
