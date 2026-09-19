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

/*
* 已授权朋友设备。
*
* 这里永久保存设备授权，
* Desktop 重启后仍然有效。
*
* 文件里只保存 Token 的哈希，
* 不保存真正的 Token。
*/
const ACCESS_CLIENTS_PATH =
  path.join(
    STORAGE_DIR,
    'access-clients.json'
  );

const PORT = Number(process.env.PORT || 7330);
const HOST = process.env.HOST || '0.0.0.0';
const YTDLP_BIN = process.env.GAMA_MUSIC_YTDLP || 'yt-dlp';
const FFMPEG_DIR =
  process.env.GAMA_MUSIC_FFMPEG_DIR ||
  '';
const COOKIE_BROWSER = process.env.GAMA_MUSIC_COOKIE_BROWSER || 'chrome';
const CORS_ORIGIN = process.env.GAMA_MUSIC_CORS_ORIGIN || '*';

/*
 * 共享后台访问密码。
 *
 * 开发时留空：
 * 不启用鉴权。
 *
 * 公网运行时设置以后，
 * Computer Web 必须携带这个密码。
 */
const RELAY_ACCESS_KEY =
  String(
    process.env.GAMA_MUSIC_RELAY_KEY ||
    ''
  ).trim();

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
 * 临时朋友邀请码。
 *
 * 只保存在内存里：
 * - 15 分钟过期
 * - 使用一次后删除
 * - Desktop 重启后全部失效
 */
const accessInvites =
  new Map();
/*
 * 一个同步二维码最多有效 15 分钟。
 */
const SYNC_SESSION_MAX_AGE_MS =
  15 * 60 * 1000;

/*
 * 朋友连接邀请：
 * 15 分钟内有效。
 */
const ACCESS_INVITE_MAX_AGE_MS =
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
      ).length,

    expectedCoverCount:
      (
        Array.isArray(
          session.manifest?.tracks
        )
          ? session.manifest.tracks
          : []
      ).filter(
        (track) =>
          Boolean(
            track?.hasCover
          )
      ).length,

    uploadedCoverCount:
      Object.values(
        session.files || {}
      ).filter(
        (entry) =>
          Boolean(
            entry?.cover
          )
      ).length,
    preparation:
      session.preparation
        ? {

          status:
            session.preparation.status,

          total:
            session.preparation.total,

          completed:
            session.preparation.completed,

          failed:
            session.preparation.failed

        }
        : null

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

function updateSyncSessionStatus(
  session
) {

  const tracks =
    Array.isArray(
      session.manifest?.tracks
    )
      ? session.manifest.tracks
      : [];


  if (!tracks.length) {

    session.status =
      'ready';

    return;

  }


  const allAudioReady =
    tracks.every(
      (track) =>
        Boolean(
          session.files?.[
            String(track.id)
          ]?.audio
        )
    );


  const coverTracks =
    tracks.filter(
      (track) =>
        Boolean(
          track?.hasCover
        )
    );


  const allCoversReady =
    coverTracks.every(
      (track) =>
        Boolean(
          session.files?.[
            String(track.id)
          ]?.cover
        )
    );


  session.status =
    allAudioReady &&
      allCoversReady
      ? 'ready'
      : 'uploading';

}


function updateMissingSyncStatus(
  session
) {

  /*
   * 手机还没有报告 missing 时，
   * 保留旧同步逻辑。
   */
  if (
    !session?.missing?.reportedAt
  ) {

    updateSyncSessionStatus(
      session
    );

    return;

  }


  const audioTrackIds =
    Array.isArray(
      session.missing
        ?.audioTrackIds
    )
      ? session.missing
        .audioTrackIds
      : [];


  const coverTrackIds =
    Array.isArray(
      session.missing
        ?.coverTrackIds
    )
      ? session.missing
        .coverTrackIds
      : [];


  const allAudioReady =
    audioTrackIds.every(
      (trackId) =>
        Boolean(
          session.files?.[
            String(trackId)
          ]?.audio
        )
    );


  const allCoversReady =
    coverTrackIds.every(
      (trackId) =>
        Boolean(
          session.files?.[
            String(trackId)
          ]?.cover
        )
    );


  /*
   * 手机真正缺的东西全部齐了。
   */
  if (
    allAudioReady &&
    allCoversReady
  ) {

    session.status =
      'missing-ready';

    return;

  }


  const preparationFinished =
    [
      'complete',
      'partial'
    ].includes(
      session.preparation
        ?.status
    );


  const bilibiliAudioTrackIds =
    Array.isArray(
      session.plan
        ?.bilibiliAudioTrackIds
    )
      ? session.plan
        .bilibiliAudioTrackIds
      : [];


  const bilibiliCoverTrackIds =
    Array.isArray(
      session.plan
        ?.bilibiliCoverTrackIds
    )
      ? session.plan
        .bilibiliCoverTrackIds
      : [];


  const needsBilibiliFallback =
    preparationFinished &&
    (
      bilibiliAudioTrackIds.some(
        (trackId) =>
          !session.files?.[
            String(trackId)
          ]?.audio
      ) ||

      bilibiliCoverTrackIds.some(
        (trackId) =>
          !session.files?.[
            String(trackId)
          ]?.cover
      )
    );


  if (needsBilibiliFallback) {

    /*
     * Bilibili 已经准备结束，
     * 但仍有 MP3 或封面缺失。
     *
     * 等 Computer Web
     * 只上传缺失的那一部分。
     */
    session.status =
      'waiting-web-fallback';

    return;

  }


  /*
   * Bilibili 还在下载。
   */
  if (
    session.preparation
      ?.status === 'running'
  ) {

    session.status =
      'preparing';

    return;

  }


  /*
   * 剩余情况通常就是：
   * 等 Computer Web 上传本地歌曲。
   */
  session.status =
    'waiting-web-upload';

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
 * 读取朋友连接时的 IP。
 *
 * Tailscale Funnel / 反向代理如果提供
 * x-forwarded-for，就优先使用它。
 *
 * 这里只用于设备辨识，不参与权限判断。
 */
function getRequestIp(
  req
) {

  const forwarded =
    req.headers[
    'x-forwarded-for'
    ];


  const forwardedValue =
    Array.isArray(
      forwarded
    )
      ? forwarded[0]
      : forwarded;


  let ip =
    String(
      forwardedValue ||
      req.headers[
      'x-real-ip'
      ] ||
      req.socket
        ?.remoteAddress ||
      ''
    )
      .split(',')[0]
      .trim();


  /*
   * Node 有时会把 IPv4
   * 表示成 ::ffff:1.2.3.4。
   */
  if (
    ip.startsWith(
      '::ffff:'
    )
  ) {

    ip =
      ip.slice(7);

  }


  if (ip === '::1') {
    ip = '127.0.0.1';
  }


  return (
    ip ||
    '未知'
  );

}


/*
 * 从浏览器 User-Agent 做一个
 * 简单的设备辨识。
 *
 * 不需要额外 npm 包。
 */
function getClientDeviceInfo(
  req
) {

  const userAgent =
    String(
      req.headers[
      'user-agent'
      ] ||
      ''
    );


  let browser =
    'Web';


  if (
    /EdgA|EdgiOS|Edg\//i
      .test(userAgent)
  ) {

    browser =
      'Edge';

  } else if (
    /CriOS|Chrome\//i
      .test(userAgent)
  ) {

    browser =
      'Chrome';

  } else if (
    /FxiOS|Firefox\//i
      .test(userAgent)
  ) {

    browser =
      'Firefox';

  } else if (
    /OPR\//i
      .test(userAgent)
  ) {

    browser =
      'Opera';

  } else if (
    /Safari\//i
      .test(userAgent)
  ) {

    browser =
      'Safari';

  }


  let platform =
    '未知设备';


  if (
    /iPhone/i
      .test(userAgent)
  ) {

    platform =
      'iPhone';

  } else if (
    /iPad/i
      .test(userAgent)
  ) {

    platform =
      'iPad';

  } else if (
    /Android/i
      .test(userAgent)
  ) {

    platform =
      'Android';

  } else if (
    /Windows NT/i
      .test(userAgent)
  ) {

    platform =
      'Windows';

  } else if (
    /Macintosh|Mac OS X/i
      .test(userAgent)
  ) {

    platform =
      'macOS';

  } else if (
    /Linux/i
      .test(userAgent)
  ) {

    platform =
      'Linux';

  }


  return {
    browser,
    platform,

    label:
      `${browser} · ${platform}`
  };

}
/*
 * 生成容易手动输入的邀请码。
 *
 * 去掉容易混淆的：
 * I / O / 0 / 1
 */
function createInviteCode() {

  const alphabet =
    'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let value = '';

  for (
    let index = 0;
    index < 12;
    index += 1
  ) {

    value +=
      alphabet[
      crypto.randomInt(
        alphabet.length
      )
      ];

  }


  return [
    value.slice(0, 4),
    value.slice(4, 8),
    value.slice(8, 12)
  ].join('-');

}


/*
 * 清理已经过期的邀请码。
 */
function cleanupExpiredAccessInvites() {

  const now =
    Date.now();


  for (
    const [
      code,
      invite
    ]
    of accessInvites
  ) {

    if (
      invite.expiresAtMs <=
      now
    ) {

      accessInvites.delete(
        code
      );

    }

  }

}

/*
 * 从磁盘读取已经授权的朋友设备。
 */
function loadAccessClients() {

  try {

    if (
      !fs.existsSync(
        ACCESS_CLIENTS_PATH
      )
    ) {
      return [];
    }


    const parsed =
      JSON.parse(
        fs.readFileSync(
          ACCESS_CLIENTS_PATH,
          'utf8'
        )
      );


    if (
      !Array.isArray(
        parsed?.clients
      )
    ) {
      return [];
    }


    return parsed.clients;

  } catch (error) {

    console.warn(
      '读取朋友授权失败：',
      error.message
    );

    return [];

  }

}


/*
 * 保存朋友设备授权。
 *
 * 先写临时文件，
 * 再替换正式文件，
 * 避免写到一半损坏 JSON。
 */
function saveAccessClients() {

  const temporaryPath =
    `${ACCESS_CLIENTS_PATH}.tmp`;


  fs.writeFileSync(
    temporaryPath,

    JSON.stringify(
      {
        version: 1,
        clients:
          accessClients
      },
      null,
      2
    ),

    'utf8'
  );


  fs.renameSync(
    temporaryPath,
    ACCESS_CLIENTS_PATH
  );

}


/*
 * 后台启动时加载一次。
 */
const accessClients =
  loadAccessClients();
/*
 * 生成朋友设备的永久 Access Token。
 *
 * 真正的 Token 只在签发时返回一次，
 * 不会保存到 access-clients.json。
 */
function createClientAccessToken() {

  return (
    'gma_client_' +
    crypto
      .randomBytes(32)
      .toString('base64url')
  );

}


/*
 * 后台只保存 Token 的 SHA-256 哈希。
 *
 * 以后朋友访问后台时：
 * 收到 Token
 * → 计算哈希
 * → 与 access-clients.json 比较
 */
function hashClientAccessToken(
  token
) {

  return crypto
    .createHash('sha256')
    .update(
      String(token || ''),
      'utf8'
    )
    .digest('hex');

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

function favoriteVideoReadableTitle(
  value,
  videoId
) {

  const title =
    String(
      value || ''
    )
      .replace(/\s+/g, ' ')
      .trim();


  const id =
    String(
      videoId || ''
    ).trim();


  if (!title) {

    return null;

  }


  if (
    id &&
    title.toLowerCase() ===
    id.toLowerCase()
  ) {

    return null;

  }


  if (
    /^BV[0-9A-Za-z]+$/i.test(
      title
    )
  ) {

    return null;

  }


  return title.slice(
    0,
    160
  );

}


async function probeFavoriteFailure(
  video,
  originalError
) {

  let title =
    favoriteVideoReadableTitle(
      video?.title,
      video?.id
    );


  let error =
    String(
      originalError ||
      '未知错误'
    );


  /*
   * 收藏夹列表已经给了正常标题，
   * 就不额外请求一次。
   */
  if (title) {

    return {
      title,
      error
    };

  }


  try {

    const info =
      await execYtDlpJson(
        video.url,
        30000
      );


    title =
      favoriteVideoReadableTitle(
        info?.title ||
        info?.fulltitle,
        video?.id
      );


  } catch (probeError) {

    /*
     * 第二次检查经常能返回
     * 比下载阶段更明确的错误，
     * 例如“视频已经失效”。
     */
    const probeMessage =
      String(
        probeError?.message || ''
      ).trim();


    if (probeMessage) {

      error =
        probeMessage;

    }

  }


  console.warn(
    `[Bilibili 收藏夹] 失败项复查：` +
    `${title || video?.id || '未知视频'} · ` +
    `${error}`
  );


  return {
    title,
    error
  };

}

function execYtDlpJson(
  videoUrl,
  timeoutMs = 120000
) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--skip-download',
      '--no-playlist',
      '--no-warnings'
    ];
    addCookieArgs(args);
    args.push(videoUrl);

    execFile(YTDLP_BIN, args, { maxBuffer: 30 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
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
                  entry.title ||
                  entry.fulltitle ||
                  '',
                  ''
                ) || null
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

function isBilibiliSyncTrack(
  track
) {

  const source =
    track?.source || {};


  const kind =
    String(
      source.kind || ''
    ).toUpperCase();


  if (
    kind === 'BV' ||
    kind === 'AV'
  ) {

    return true;

  }


  const sourceKey =
    String(
      track?.sourceKey ||
      source.key ||
      ''
    ).toLowerCase();


  if (
    sourceKey.startsWith('bv:') ||
    sourceKey.startsWith('av:')
  ) {

    return true;

  }


  const candidates = [
    source.canonicalUrl,
    source.normalizedUrl,
    source.webpageUrl,
    source.originalUrl,
    source.id
  ].filter(Boolean);


  return candidates.some(
    (value) =>
      Boolean(
        extractBilibiliIdentity(
          value
        )
      )
  );

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

    console.log(
      `[Bilibili] 开始检查视频：${job.url}`
    );

    job.status = 'checking';
    job.stage = '正在检查视频';
    job.progress = 3;
    job.updatedAt = nowIso();

    const info = await execYtDlpJson(job.url);
    const summary =
      summarizeInfo(
        job.url,
        info
      );

    job.preview =
      summary;


    console.log(
      `[Bilibili] 视频信息读取完成：${summary.title}`
    );

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


    console.log(
      `[Bilibili] 开始下载音频：${summary.title}`
    );


    await spawnDownload(
      job,
      args
    );


    console.log(
      `[Bilibili] 音频下载完成：${summary.title}`
    );

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


    console.log(
      `[Bilibili] 导入完成：${track.title}`
    );

  } catch (error) {

    console.error(
      `[Bilibili] 导入失败：${job.url}`,
      error.message
    );

    job.status = 'failed';
    job.stage = '下载失败';
    job.progress = 100;
    job.error = error.message;
    job.updatedAt = nowIso();
  }
}

function getSyncTrackBilibiliUrl(
  track
) {

  const source =
    track?.source || {};


  const candidates = [
    source.canonicalUrl,
    source.webpageUrl,
    source.originalUrl,
    source.normalizedUrl
  ];


  for (const candidate of candidates) {

    if (
      typeof candidate === 'string' &&
      /^https?:\/\//i.test(candidate)
    ) {

      return candidate;

    }

  }


  const identity =
    extractBilibiliIdentity(
      source.id ||
      track?.sourceKey ||
      source.key ||
      ''
    );


  return (
    identity?.canonicalUrl ||
    ''
  );

}


function syncCoverType(
  fileName
) {

  const ext =
    path.extname(
      String(fileName || '')
    ).toLowerCase();


  if (ext === '.png') {
    return 'image/png';
  }

  if (ext === '.webp') {
    return 'image/webp';
  }

  if (ext === '.avif') {
    return 'image/avif';
  }

  return 'image/jpeg';

}


async function prepareMissingBilibiliAudio(
  session
) {

  const audioTrackIds =
    Array.isArray(
      session.plan
        ?.bilibiliAudioTrackIds
    )
      ? session.plan
        .bilibiliAudioTrackIds
      : [];


  const coverTrackIds =
    Array.isArray(
      session.plan
        ?.bilibiliCoverTrackIds
    )
      ? session.plan
        .bilibiliCoverTrackIds
      : [];


  /*
   * MP3 缺失或者封面缺失，
   * 都需要 Desktop 去 Bilibili
   * 准备一次资源。
   *
   * Set 防止同一首歌下载两次。
   */
  const trackIds =
    [
      ...new Set([
        ...audioTrackIds,
        ...coverTrackIds
      ])
    ];


  session.preparation = {

    status:
      trackIds.length
        ? 'running'
        : 'complete',

    total:
      trackIds.length,

    completed:
      0,

    failed:
      0,

    failures:
      [],

    updatedAt:
      nowIso()

  };


  if (!trackIds.length) {

    updateMissingSyncStatus(
      session
    );


    refreshSyncSessionExpiry(
      session
    );


    return;



  }


  const manifestTracks =
    Array.isArray(
      session.manifest?.tracks
    )
      ? session.manifest.tracks
      : [];


  for (const trackId of trackIds) {

    const track =
      manifestTracks.find(
        (item) =>
          String(item?.id) ===
          String(trackId)
      );


    try {

      if (!track) {

        throw new Error(
          '同步清单中找不到歌曲'
        );

      }


      const videoUrl =
        getSyncTrackBilibiliUrl(
          track
        );


      if (!videoUrl) {

        throw new Error(
          '找不到 Bilibili 来源地址'
        );

      }


      console.log(
        `按需下载手机缺失歌曲：${track.title}`
      );


      const job = {

        id:
          makeId('sync-job'),

        url:
          videoUrl,

        title:
          track.title || '',

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


      await runDownloadJob(
        job
      );


      if (
        job.status !== 'complete' ||
        !job.track?.file
      ) {

        throw new Error(
          job.error ||
          'Bilibili 下载失败'
        );

      }


      const audioPath =
        safeJoin(
          TRANSFER_DIR,
          `/${job.track.file}`
        );


      if (
        !audioPath ||
        !fs.existsSync(
          audioPath
        )
      ) {

        throw new Error(
          '下载完成但找不到 MP3'
        );

      }


      /*
       * 如果旧同步流程之前已经
       * 上传过一份 MP3，
       * 现在用后台重新下载的版本替换。
       */
      const oldAudio =
        session.files?.[
          trackId
        ]?.audio;


      if (
        oldAudio &&
        oldAudio !== job.track.file
      ) {

        const oldAudioPath =
          safeJoin(
            TRANSFER_DIR,
            `/${oldAudio}`
          );


        if (oldAudioPath) {

          fs.rmSync(
            oldAudioPath,
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
          job.track.file,

        audioBytes:
          fs.statSync(
            audioPath
          ).size

      };


      /*
       * runDownloadJob 本身也会取封面。
       *
       * 如果手机正好也缺封面，
       * 顺便直接使用这一份。
       */
      if (
        session.plan
          ?.bilibiliCoverTrackIds
          ?.includes(
            trackId
          ) &&
        job.track.cover
      ) {

        session.files[
          trackId
        ].cover =
          job.track.cover;

        session.files[
          trackId
        ].coverType =
          syncCoverType(
            job.track.cover
          );

      }


      session.preparation
        .completed += 1;


      console.log(
        `手机缺失歌曲准备完成：${track.title}`
      );

    } catch (error) {

      session.preparation
        .failed += 1;


      session.preparation
        .failures.push({

          trackId,

          error:
            error.message ||
            '未知错误'

        });


      console.warn(
        `手机缺失歌曲准备失败 ${trackId}:`,
        error.message
      );

    }


    session.preparation
      .updatedAt =
      nowIso();


    refreshSyncSessionExpiry(
      session
    );

  }


  session.preparation.status =
    session.preparation.failed
      ? 'partial'
      : 'complete';





  updateMissingSyncStatus(
    session
  );


  refreshSyncSessionExpiry(
    session
  );

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


          console.warn(
            `[Bilibili 收藏夹] 导入失败：` +
            `${video.title || video.id || '未知视频'} · ` +
            `${childJob.error || '未知错误'}`
          );
          const checkedFailure =
            await probeFavoriteFailure(
              video,
              childJob.error ||
              '未知错误'
            );
          job.failures.push({

            id:
              video.id,

            url:
              video.url,

            title:
              checkedFailure.title,

            error:
              checkedFailure.error

          });

        }

      } catch (error) {

        /*
         * 单独一首出错，
         * 不让整个收藏夹停止。
         */
        job.failed += 1;

        console.warn(
          `[Bilibili 收藏夹] 导入失败：` +
          `${video.title || video.id || '未知视频'} · ` +
          `${error.message || '未知错误'}`
        );

        const checkedFailure =
          await probeFavoriteFailure(
            video,
            error.message ||
            '未知错误'
          );

        job.failures.push({

          id:
            video.id,

          url:
            video.url,

          title:
            checkedFailure.title,

          error:
            checkedFailure.error

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

/*
 * 读取 Authorization 里的 Bearer Token。
 */
function getBearerToken(
  req
) {

  const authorization =
    String(
      req.headers.authorization ||
      ''
    ).trim();


  const match =
    authorization.match(
      /^Bearer\s+(.+)$/i
    );


  return (
    match?.[1] || ''
  ).trim();

}


/*
 * 管理员权限：
 * 只有后台主密码拥有。
 */
function hasAdminAccess(
  req
) {

  /*
   * 没配置主密码时，
   * 保持原来的本地开发模式。
   */
  if (!RELAY_ACCESS_KEY) {
    return true;
  }


  return (
    getBearerToken(req) ===
    RELAY_ACCESS_KEY
  );

}

/*
 * 记录朋友设备最近访问后台的时间。
 *
 * 下载时可能会频繁轮询，
 * 所以最多每 60 秒写一次磁盘。
 */
function touchAccessClient(
  client
) {

  if (!client) {
    return;
  }


  const now =
    Date.now();


  const previous =
    Date.parse(
      client.lastUsedAt ||
      ''
    );


  if (
    Number.isFinite(previous) &&
    now - previous <
    60 * 1000
  ) {

    return;

  }


  client.lastUsedAt =
    new Date(now)
      .toISOString();


  try {

    saveAccessClients();

  } catch (error) {

    console.warn(
      '更新设备最近使用时间失败：',
      error.message
    );

  }

}


/*
 * 查找有效的朋友设备授权。
 */
function findAccessClient(
  req
) {

  const token =
    getBearerToken(req);


  if (
    !token ||
    token === RELAY_ACCESS_KEY
  ) {
    return null;
  }


  const tokenHash =
    hashClientAccessToken(
      token
    );


  const client =
    accessClients.find(
      (item) =>
        item &&
        !item.revokedAt &&
        item.tokenHash ===
        tokenHash
    ) ||
    null;


  if (client) {

    touchAccessClient(
      client
    );

  }


  return client;

}


/*
 * 普通后台访问权限：
 *
 * - 管理员主密码
 * - 未撤销的朋友 Access Token
 *
 * 都可以访问普通 Gama Music API。
 */
function hasRelayAccess(
  req
) {

  if (!RELAY_ACCESS_KEY) {
    return true;
  }


  if (
    hasAdminAccess(
      req
    )
  ) {
    return true;
  }


  return Boolean(
    findAccessClient(
      req
    )
  );

}


function requireRelayAccess(
  req,
  res
) {

  if (
    hasRelayAccess(
      req
    )
  ) {

    return true;

  }


  sendJson(
    res,
    401,
    {
      error:
        '没有后台访问权限'
    }
  );


  return false;

}

/*
 * 手机端只凭随机同步 session
 * 下载自己的同步内容。
 *
 * 不把共享后台密码放进二维码。
 */
function isPublicSyncRead(
  req,
  pathname
) {


  if (
    req.method === 'POST' &&
    (
      /^\/api\/sync\/sessions\/sync_[0-9a-f]{32}\/missing$/i
        .test(pathname) ||

      /^\/api\/sync\/sessions\/sync_[0-9a-f]{32}\/complete$/i
        .test(pathname)
    )
  ) {

    return true;

  }

  if (
    req.method !== 'GET'
  ) {

    return false;

  }


  return (
    /^\/api\/sync\/sessions\/[^/]+$/
      .test(pathname) ||

    /^\/api\/sync\/sessions\/[^/]+\/manifest$/
      .test(pathname) ||

    /^\/api\/sync\/sessions\/[^/]+\/tracks\/[^/]+\/audio$/
      .test(pathname) ||

    /^\/api\/sync\/sessions\/[^/]+\/tracks\/[^/]+\/cover$/
      .test(pathname)
  );

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

  /*
 * 用一次性邀请码兑换永久设备授权。
 *
 * 这是新设备第一次连接时唯一不需要
 * 后台主密码的入口。
 */
  if (
    req.method === 'POST' &&
    url.pathname ===
    '/api/access/redeem'
  ) {

    cleanupExpiredAccessInvites();


    const body =
      await readJsonBody(req);


    /*
     * 允许朋友输入：
     *
     * ABCD-EFGH-JKLM
     * abcdefghjklm
     * ABCD EFGH JKLM
     *
     * 最后统一转换成后台保存的格式。
     */
    const compactCode =
      String(
        body?.code || ''
      )
        .toUpperCase()
        .replace(
          /[^A-Z0-9]/g,
          ''
        );


    if (
      compactCode.length !== 12
    ) {

      sendJson(
        res,
        400,
        {
          error:
            '邀请码无效或已过期'
        }
      );

      return;

    }


    const code =
      [
        compactCode.slice(0, 4),
        compactCode.slice(4, 8),
        compactCode.slice(8, 12)
      ].join('-');


    const invite =
      accessInvites.get(
        code
      );


    if (
      !invite ||
      invite.expiresAtMs <=
      Date.now()
    ) {

      accessInvites.delete(
        code
      );


      sendJson(
        res,
        400,
        {
          error:
            '邀请码无效或已过期'
        }
      );

      return;

    }


    const accessToken =
      createClientAccessToken();


    const createdAt =
      nowIso();


    const deviceInfo =
      getClientDeviceInfo(
        req
      );


    const ipAddress =
      getRequestIp(
        req
      );


    const name =
      deviceInfo.label;


    const client = {

      id:
        `client_${crypto
          .randomBytes(12)
          .toString('hex')}`,

      tokenHash:
        hashClientAccessToken(
          accessToken
        ),

      name,

      browser:
        deviceInfo.browser,

      platform:
        deviceInfo.platform,

      ipAddress,

      createdAt,

      lastUsedAt:
        null,

      revokedAt:
        null

    };


    /*
     * 必须先成功写入磁盘，
     * 然后才销毁邀请码。
     *
     * 否则如果磁盘写入失败，
     * 邀请码已经没了，
     * 朋友却又拿不到有效授权。
     */
    accessClients.push(
      client
    );


    try {

      saveAccessClients();

    } catch (error) {

      accessClients.pop();


      console.error(
        '保存朋友授权失败：',
        error
      );


      sendJson(
        res,
        500,
        {
          error:
            '保存设备授权失败'
        }
      );

      return;

    }


    /*
     * 保存成功以后立即销毁。
     * 所以一个邀请码只能兑换一次。
     */
    accessInvites.delete(
      code
    );


    sendJson(
      res,
      201,
      {
        accessToken,

        client: {
          id:
            client.id,

          name:
            client.name,

          createdAt:
            client.createdAt
        }
      }
    );

    return;

  }
  /*
 * health 可以公开访问。
 *
 * 手机读取某个随机同步 session
 * 也不要求共享密码。
 *
 * 其余后台能力：
 * B站下载、创建同步、
 * 上传 MP3 等都必须鉴权。
 */
  if (
    !isPublicSyncRead(
      req,
      url.pathname
    ) &&
    !requireRelayAccess(
      req,
      res
    )
  ) {

    return;

  }


  /*
 * 创建一次性朋友邀请码。
 *
 * 这个接口已经位于后台主密码鉴权之后，
 * 普通朋友不能自己生成邀请码。
 */
  if (
    req.method === 'POST' &&
    url.pathname ===
    '/api/access/invites'
  ) {

    /*
 * 普通朋友虽然拥有后台使用权限，
 * 但不能继续生成新的邀请码。
 */
    if (
      !hasAdminAccess(
        req
      )
    ) {

      sendJson(
        res,
        403,
        {
          error:
            '只有管理员可以生成邀请码'
        }
      );

      return;

    }
    if (!RELAY_ACCESS_KEY) {

      sendJson(
        res,
        400,
        {
          error:
            '后台尚未设置访问密码'
        }
      );

      return;

    }


    cleanupExpiredAccessInvites();


    let code;

    do {

      code =
        createInviteCode();

    } while (
      accessInvites.has(
        code
      )
    );


    const createdAtMs =
      Date.now();

    const expiresAtMs =
      createdAtMs +
      ACCESS_INVITE_MAX_AGE_MS;


    accessInvites.set(
      code,
      {
        code,

        createdAtMs,

        expiresAtMs
      }
    );


    sendJson(
      res,
      201,
      {
        invite: {
          code,

          expiresAt:
            new Date(
              expiresAtMs
            ).toISOString()
        }
      }
    );

    return;

  }

  /*
   * 当前朋友设备主动退出授权。
   *
   * 使用自己的 Access Token 即可，
   * 不需要管理员权限。
   */
  if (
    req.method === 'POST' &&
    url.pathname ===
    '/api/access/revoke-self'
  ) {

    const client =
      findAccessClient(
        req
      );


    if (!client) {

      sendJson(
        res,
        401,
        {
          error:
            '当前设备授权无效'
        }
      );

      return;

    }


    client.revokedAt =
      nowIso();


    try {

      saveAccessClients();

    } catch (error) {

      client.revokedAt =
        null;


      console.error(
        '保存设备退出授权失败：',
        error
      );


      sendJson(
        res,
        500,
        {
          error:
            '保存设备退出授权失败'
        }
      );

      return;

    }


    sendJson(
      res,
      200,
      {
        ok: true
      }
    );

    return;

  }



  /*
 * 查看已经授权的朋友设备。
 *
 * 只有管理员可以查看。
 * 不返回 tokenHash。
 */

  if (
    req.method === 'GET' &&
    url.pathname ===
    '/api/access/clients'
  ) {

    if (
      !hasAdminAccess(
        req
      )
    ) {

      sendJson(
        res,
        403,
        {
          error:
            '只有管理员可以查看授权设备'
        }
      );

      return;

    }


    const clients =
      accessClients.map(
        (client) => ({
          id:
            client.id,

          name:
            client.name,

          browser:
            client.browser ||
            null,

          platform:
            client.platform ||
            null,

          ipAddress:
            client.ipAddress ||
            null,

          createdAt:
            client.createdAt,

          lastUsedAt:
            client.lastUsedAt ||
            null,

          revokedAt:
            client.revokedAt ||
            null
        })
      );


    sendJson(
      res,
      200,
      {
        clients
      }
    );

    return;

  }


  /*
 * 撤销某个朋友设备的授权。
 *
 * 只有管理员可以操作。
 */
  const revokeAccessClientMatch =
    url.pathname.match(
      /^\/api\/access\/clients\/([^/]+)\/revoke$/
    );


  if (
    req.method === 'POST' &&
    revokeAccessClientMatch
  ) {

    if (
      !hasAdminAccess(
        req
      )
    ) {

      sendJson(
        res,
        403,
        {
          error:
            '只有管理员可以撤销授权'
        }
      );

      return;

    }


    const clientId =
      decodeURIComponent(
        revokeAccessClientMatch[1]
      );


    const client =
      accessClients.find(
        (item) =>
          item?.id === clientId
      );


    if (!client) {

      sendJson(
        res,
        404,
        {
          error:
            '没有找到这个授权设备'
        }
      );

      return;

    }


    /*
     * 已经撤销过的话直接返回成功，
     * 保持接口幂等。
     */
    if (!client.revokedAt) {

      client.revokedAt =
        nowIso();


      try {

        saveAccessClients();

      } catch (error) {

        client.revokedAt =
          null;

        console.error(
          '保存撤销授权失败：',
          error
        );


        sendJson(
          res,
          500,
          {
            error:
              '保存撤销授权失败'
          }
        );

        return;

      }

    }


    sendJson(
      res,
      200,
      {
        client: {
          id:
            client.id,

          name:
            client.name,

          revokedAt:
            client.revokedAt
        }
      }
    );

    return;

  }



  /*
 * 创建手机同步 Session。
 */
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
        `sync_${crypto
          .randomBytes(16)
          .toString('hex')}`,

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

      claimedByClientId:
        null,

      claimedAt:
        null,

      missing: {
        audioTrackIds: [],
        coverTrackIds: [],
        reportedAt: null
      },

      plan:
        null,

      preparation:
        null,

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


    updateMissingSyncStatus(
      session
    );


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

  if (
    req.method === 'GET' &&
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

    const clientId =
      String(
        url.searchParams.get(
          'clientId'
        ) || ''
      ).trim();


    if (!clientId) {

      sendJson(
        res,
        400,
        {
          error:
            '缺少手机同步身份'
        }
      );

      return;

    }


    if (
      !session.claimedByClientId ||
      session.claimedByClientId !==
      clientId
    ) {

      sendJson(
        res,
        403,
        {
          error:
            '无权下载这个同步会话的文件'
        }
      );

      return;

    }


    const fileName =
      session.files?.[
        trackId
      ]?.audio;


    if (!fileName) {

      sendJson(
        res,
        404,
        {
          error:
            '这首歌还没有上传到同步会话'
        }
      );

      return;

    }


    const filePath =
      safeJoin(
        TRANSFER_DIR,
        `/${fileName}`
      );


    if (
      !filePath ||
      !fs.existsSync(
        filePath
      )
    ) {

      sendJson(
        res,
        404,
        {
          error:
            '同步 MP3 文件不存在'
        }
      );

      return;

    }


    updateSyncSessionStatus(
      session
    );


    refreshSyncSessionExpiry(
      session
    );


    const stat =
      fs.statSync(
        filePath
      );


    res.writeHead(
      200,
      {
        'Content-Type':
          'audio/mpeg',

        'Content-Length':
          stat.size,

        'Cache-Control':
          'no-store',

        /*
         * 这里不能漏。
         *
         * 以后 GitHub Pages 上的 iPhone Web
         * 会跨域读取这个 MP3。
         */
        'Access-Control-Allow-Origin':
          CORS_ORIGIN
      }
    );


    fs.createReadStream(
      filePath
    ).pipe(
      res
    );


    return;

  }

  const syncTrackCoverMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)\/tracks\/([^/]+)\/cover$/
    );


  /*
   * Computer Web
   * → Desktop 临时封面。
   */
  if (
    req.method === 'POST' &&
    syncTrackCoverMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncTrackCoverMatch[1]
      );


    const trackId =
      decodeURIComponent(
        syncTrackCoverMatch[2]
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


    const coverBuffer =
      await readBinaryBody(
        req,
        25 * 1024 * 1024
      );


    if (!coverBuffer.length) {

      sendJson(
        res,
        400,
        {
          error:
            '没有收到封面数据'
        }
      );

      return;

    }


    const contentType =
      String(
        req.headers[
        'content-type'
        ] || 'image/jpeg'
      )
        .split(';')[0]
        .trim()
        .toLowerCase();


    const extension =
      contentType === 'image/png'
        ? 'png'
        : contentType === 'image/webp'
          ? 'webp'
          : contentType === 'image/avif'
            ? 'avif'
            : contentType === 'image/gif'
              ? 'gif'
              : 'jpg';


    const fileName =
      `${makeId('sync-cover')}.${extension}`;


    const filePath =
      path.join(
        TRANSFER_DIR,
        fileName
      );


    fs.writeFileSync(
      filePath,
      coverBuffer
    );


    /*
     * 同一首歌重新上传封面时，
     * 删除上一份临时文件。
     */
    const oldCover =
      session.files?.[
        trackId
      ]?.cover;


    if (oldCover) {

      const oldPath =
        safeJoin(
          TRANSFER_DIR,
          `/${oldCover}`
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

      cover:
        fileName,

      coverBytes:
        coverBuffer.length,

      coverType:
        contentType

    };


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
            coverBuffer.length,

          contentType
        }
      }
    );


    return;

  }


  /*
   * iPhone
   * ← Desktop 临时封面。
   */
  if (
    req.method === 'GET' &&
    syncTrackCoverMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncTrackCoverMatch[1]
      );


    const trackId =
      decodeURIComponent(
        syncTrackCoverMatch[2]
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

    const clientId =
      String(
        url.searchParams.get(
          'clientId'
        ) || ''
      ).trim();


    if (!clientId) {

      sendJson(
        res,
        400,
        {
          error:
            '缺少手机同步身份'
        }
      );

      return;

    }


    if (
      !session.claimedByClientId ||
      session.claimedByClientId !==
      clientId
    ) {

      sendJson(
        res,
        403,
        {
          error:
            '无权下载这个同步会话的文件'
        }
      );

      return;

    }


    const fileEntry =
      session.files?.[
      trackId
      ];


    const fileName =
      fileEntry?.cover;


    if (!fileName) {

      sendJson(
        res,
        404,
        {
          error:
            '这首歌没有同步封面'
        }
      );

      return;

    }


    const filePath =
      safeJoin(
        TRANSFER_DIR,
        `/${fileName}`
      );


    if (
      !filePath ||
      !fs.existsSync(
        filePath
      )
    ) {

      sendJson(
        res,
        404,
        {
          error:
            '同步封面文件不存在'
        }
      );

      return;

    }

    updateMissingSyncStatus(
      session
    );


    refreshSyncSessionExpiry(
      session
    );


    const stat =
      fs.statSync(
        filePath
      );


    res.writeHead(
      200,
      {
        'Content-Type':
          fileEntry.coverType ||
          'image/jpeg',

        'Content-Length':
          stat.size,

        'Cache-Control':
          'no-store',

        'Access-Control-Allow-Origin':
          CORS_ORIGIN
      }
    );


    fs.createReadStream(
      filePath
    ).pipe(
      res
    );


    return;

  }

  const syncMissingMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)\/missing$/
    );


  if (
    req.method === 'POST' &&
    syncMissingMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncMissingMatch[1]
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
 * 已经完成的同步不能重新打开。
 *
 * 防止旧二维码再次 POST /missing
 * 把 completed session 重新激活。
 */
    if (
      session.status ===
      'completed'
    ) {

      sendJson(
        res,
        409,
        {
          error:
            '这个同步已经完成，请在电脑上重新生成二维码'
        }
      );

      return;

    }


    if (!session.manifest) {

      sendJson(
        res,
        409,
        {
          error:
            '同步清单还没有准备完成'
        }
      );

      return;

    }


    const body =
      await readJsonBody(req);
    const clientId =
      String(
        body?.clientId || ''
      ).trim();


    if (!clientId) {

      sendJson(
        res,
        400,
        {
          error:
            '缺少手机同步身份'
        }
      );

      return;

    }


    /*
     * 第一个真正扫码并报告 missing 的手机，
     * 获得这个同步 session。
     */
    if (
      !session.claimedByClientId
    ) {

      session.claimedByClientId =
        clientId;

      session.claimedAt =
        nowIso();

    }


    /*
     * 后面的请求必须来自同一台手机。
     */
    if (
      session.claimedByClientId !==
      clientId
    ) {

      sendJson(
        res,
        409,
        {
          error:
            '这个同步二维码已经被另一台手机使用'
        }
      );

      return;

    }


    /*
     * 只接受 manifest 中真实存在的歌曲，
     * 防止客户端随便提交 trackId。
     */
    const manifestTracks =
      Array.isArray(
        session.manifest.tracks
      )
        ? session.manifest.tracks
        : [];


    const validTrackIds =
      new Set(
        manifestTracks.map(
          (track) =>
            String(track.id)
        )
      );


    const coverTrackIds =
      new Set(
        manifestTracks
          .filter(
            (track) =>
              track.hasCover
          )
          .map(
            (track) =>
              String(track.id)
          )
      );


    const normalizeIds =
      (
        values,
        allowedIds
      ) => {

        if (!Array.isArray(values)) {
          return [];
        }


        return [
          ...new Set(
            values
              .map(
                (value) =>
                  String(value)
              )
              .filter(
                (trackId) =>
                  allowedIds.has(
                    trackId
                  )
              )
          )
        ];

      };


    const missingAudioTrackIds =
      normalizeIds(
        body.audioTrackIds,
        validTrackIds
      );


    const missingCoverTrackIds =
      normalizeIds(
        body.coverTrackIds,
        coverTrackIds
      );
    /*
 * 根据 manifest 找到完整歌曲信息。
 */
    const trackById =
      new Map(
        manifestTracks.map(
          (track) => [
            String(track.id),
            track
          ]
        )
      );


    /*
     * 把缺失资源分成：
     *
     * Bilibili：
     * Desktop 以后可以自己重新下载。
     *
     * local：
     * Desktop 没有网络来源，
     * 以后需要 Computer Web 上传。
     */
    const classifyTrackIds =
      (trackIds) => {

        const bilibiliTrackIds =
          [];

        const localTrackIds =
          [];


        for (
          const trackId of trackIds
        ) {

          const track =
            trackById.get(
              trackId
            );


          if (
            isBilibiliSyncTrack(
              track
            )
          ) {

            bilibiliTrackIds.push(
              trackId
            );

          } else {

            localTrackIds.push(
              trackId
            );

          }

        }


        return {
          bilibiliTrackIds,
          localTrackIds
        };

      };


    const audioPlan =
      classifyTrackIds(
        missingAudioTrackIds
      );


    const coverPlan =
      classifyTrackIds(
        missingCoverTrackIds
      );


    const syncPlan = {

      bilibiliAudioTrackIds:
        audioPlan.bilibiliTrackIds,

      localAudioTrackIds:
        audioPlan.localTrackIds,

      bilibiliCoverTrackIds:
        coverPlan.bilibiliTrackIds,

      localCoverTrackIds:
        coverPlan.localTrackIds

    };


    session.missing = {

      audioTrackIds:
        missingAudioTrackIds,

      coverTrackIds:
        missingCoverTrackIds,

      reportedAt:
        nowIso()

    };

    session.plan =
      syncPlan;


    console.log(
      `手机同步缺失计划 ${session.id}: ` +
      `B站 MP3 ${syncPlan.bilibiliAudioTrackIds.length}, ` +
      `本地 MP3 ${syncPlan.localAudioTrackIds.length}, ` +
      `B站封面 ${syncPlan.bilibiliCoverTrackIds.length}, ` +
      `本地封面 ${syncPlan.localCoverTrackIds.length}`
    );


    /*
     * 现在只是记录“手机缺什么”。
     *
     * 下一阶段再根据来源决定：
     * - Bilibili → 后台下载
     * - local → 等待 Web 上传
     */
    session.status =
      'missing-reported';


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

        missing: {
          audioTrackIds:
            missingAudioTrackIds,

          coverTrackIds:
            missingCoverTrackIds
        },

        plan:
          syncPlan
      }
    );


    /*
     * HTTP 先立即回复手机。
     *
     * Bilibili 下载在后台继续进行，
     * 不让这个 POST 一直卡住。
     */
    prepareMissingBilibiliAudio(
      session
    ).catch(
      (error) => {

        console.error(
          `手机同步准备任务失败 ${session.id}:`,
          error
        );


        session.status =
          'missing-partial';


        if (session.preparation) {

          session.preparation.status =
            'partial';

        }


        refreshSyncSessionExpiry(
          session
        );

      }
    );


    return;

  }

  /*
 * Computer Web 查询手机同步计划。
 *
 * 这个接口不是公开接口，
 * 所以仍然需要后台访问密码。
 */
  const syncPlanMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)\/plan$/
    );


  if (
    req.method === 'GET' &&
    syncPlanMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncPlanMatch[1]
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
  * Bilibili 后台准备结束以后，
  * 分别检查 MP3 和封面。
  *
  * 哪一种资源没有准备成功，
  * Computer Web 就只兜底哪一种。
  */
    const preparationFinished =
      [
        'complete',
        'partial'
      ].includes(
        session.preparation
          ?.status
      );


    const bilibiliAudioTrackIds =
      Array.isArray(
        session.plan
          ?.bilibiliAudioTrackIds
      )
        ? session.plan
          .bilibiliAudioTrackIds
        : [];


    const bilibiliCoverTrackIds =
      Array.isArray(
        session.plan
          ?.bilibiliCoverTrackIds
      )
        ? session.plan
          .bilibiliCoverTrackIds
        : [];


    const fallbackAudioTrackIds =
      preparationFinished
        ? bilibiliAudioTrackIds
          .map(String)
          .filter(
            (trackId) =>
              !session.files?.[
                trackId
              ]?.audio
          )
        : [];


    const fallbackCoverTrackIds =
      preparationFinished
        ? bilibiliCoverTrackIds
          .map(String)
          .filter(
            (trackId) =>
              !session.files?.[
                trackId
              ]?.cover
          )
        : [];

    sendJson(
      res,
      200,
      {
        session:
          publicSyncSession(
            session
          ),

        missing:
          session.missing || {
            audioTrackIds: [],
            coverTrackIds: [],
            reportedAt: null
          },

        plan:
          session.plan || {
            bilibiliAudioTrackIds: [],
            localAudioTrackIds: [],
            bilibiliCoverTrackIds: [],
            localCoverTrackIds: []
          },

        fallback: {
          audioTrackIds:
            fallbackAudioTrackIds,

          coverTrackIds:
            fallbackCoverTrackIds
        }
      }
    );


    return;
  }




  const syncCompleteMatch =
    url.pathname.match(
      /^\/api\/sync\/sessions\/([^/]+)\/complete$/
    );


  if (
    req.method === 'POST' &&
    syncCompleteMatch
  ) {

    cleanupExpiredSyncSessions();


    const sessionId =
      decodeURIComponent(
        syncCompleteMatch[1]
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


    const clientId =
      String(
        body?.clientId || ''
      ).trim();


    if (!clientId) {

      sendJson(
        res,
        400,
        {
          error:
            '缺少手机同步身份'
        }
      );

      return;

    }


    /*
     * /missing 已经把 session
     * 锁定给第一台手机。
     *
     * /complete 必须来自同一台手机。
     */
    if (
      !session.claimedByClientId
    ) {

      sendJson(
        res,
        409,
        {
          error:
            '这个同步会话还没有被手机领取'
        }
      );

      return;

    }


    if (
      session.claimedByClientId !==
      clientId
    ) {

      sendJson(
        res,
        409,
        {
          error:
            '这个同步二维码属于另一台手机'
        }
      );

      return;

    }


    /*
     * 重复 ACK 也算成功。
     *
     * 避免手机因为网络重试
     * 得到奇怪的错误。
     */
    if (
      session.status ===
      'completed'
    ) {

      sendJson(
        res,
        200,
        {
          session:
            publicSyncSession(
              session
            ),

          removedFiles:
            0
        }
      );

      return;

    }


    /*
     * 手机只能在所有缺失资源
     * 都已经准备好以后确认完成。
     */
    if (
      session.status !==
      'missing-ready'
    ) {

      sendJson(
        res,
        409,
        {
          error:
            '同步文件还没有全部准备完成'
        }
      );

      return;

    }


    const removedFiles =
      cleanupSyncSessionFiles(
        session
      );


    /*
     * 文件已经不存在，
     * 清空引用，避免后面误以为
     * session 里还有媒体文件。
     */
    session.files = {};


    session.status =
      'completed';


    session.completedAt =
      nowIso();


    refreshSyncSessionExpiry(
      session
    );


    console.log(
      `手机同步完成 ${session.id}，已清理 ${removedFiles} 个临时文件`
    );


    sendJson(
      res,
      200,
      {
        session:
          publicSyncSession(
            session
          ),

        completedAt:
          session.completedAt,

        removedFiles
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

  if (
    req.method === 'GET' &&
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


    if (!session.manifest) {

      sendJson(
        res,
        409,
        {
          error:
            '同步清单还没有准备完成'
        }
      );

      return;

    }


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

        manifest:
          session.manifest
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


  /*
 * 只重试某个收藏夹任务里失败的歌曲。
 */
  const retryFavoriteJobMatch =
    url.pathname.match(
      /^\/api\/favorites\/jobs\/([^/]+)\/retry-failures$/
    );


  if (
    req.method === 'POST' &&
    retryFavoriteJobMatch
  ) {

    const originalJobId =
      decodeURIComponent(
        retryFavoriteJobMatch[1]
      );


    const originalJob =
      favoriteJobs.get(
        originalJobId
      );


    if (!originalJob) {

      sendJson(
        res,
        404,
        {
          error:
            '没有找到这个收藏夹导入任务'
        }
      );

      return;

    }


    const failures =
      Array.isArray(
        originalJob.failures
      )
        ? originalJob.failures
        : [];


    if (!failures.length) {

      sendJson(
        res,
        400,
        {
          error:
            '这个任务没有失败歌曲需要重试'
        }
      );

      return;

    }


    const body =
      await readJsonBody(req);


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


    const retryVideos =
      failures
        .filter(
          (failure) =>
            failure?.url
        )
        .map(
          (failure) => ({
            id:
              failure.id,

            url:
              failure.url,

            title:
              failure.title
          })
        );


    const retryJob = {

      id:
        makeId('fav'),

      status:
        'queued',

      stage:
        '准备重试失败歌曲',

      playlistName:
        originalJob.playlistName,

      favoriteKey:
        originalJob.favoriteKey,

      trackIds:
        [],

      tracks:
        [],

      total:
        retryVideos.length,

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


    favoriteJobs.set(
      retryJob.id,
      retryJob
    );


    runFavoriteImportJob(
      retryJob,
      retryVideos,
      existingTracks
    );


    sendJson(
      res,
      202,
      {
        job:
          publicFavoriteJob(
            retryJob
          )
      }
    );


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

    console.log(
      `[Bilibili] 收到导入请求：${videoUrl}`
    );

    runDownloadJob(job);

    sendJson(
      res,
      202,
      {
        job:
          publicJob(job)
      }
    );
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
