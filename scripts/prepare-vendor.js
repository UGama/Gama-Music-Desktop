'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT_DIR =
  path.resolve(__dirname, '..');

const VENDOR_DIR =
  path.join(
    ROOT_DIR,
    'vendor',
    'mac-arm64'
  );

const YTDLP_VERSION =
  '2026.08.19';

const YTDLP_URL =
  `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos`;

const YTDLP_PATH =
  path.join(
    VENDOR_DIR,
    'yt-dlp'
  );

const FFMPEG_PATH =
  path.join(
    VENDOR_DIR,
    'ffmpeg'
  );

const FFPROBE_PATH =
  path.join(
    VENDOR_DIR,
    'ffprobe'
  );


fs.mkdirSync(
  VENDOR_DIR,
  {
    recursive: true
  }
);


/*
 * ffmpeg
 */
const ffmpegSource =
  require('ffmpeg-static');

fs.copyFileSync(
  ffmpegSource,
  FFMPEG_PATH
);

fs.chmodSync(
  FFMPEG_PATH,
  0o755
);


/*
 * ffprobe
 */
const ffprobeSource =
  require('ffprobe-static').path;

fs.copyFileSync(
  ffprobeSource,
  FFPROBE_PATH
);

fs.chmodSync(
  FFPROBE_PATH,
  0o755
);


/*
 * yt-dlp
 */
function downloadFile(
  url,
  destination,
  redirects = 0
) {

  return new Promise(
    (resolve, reject) => {

      if (redirects > 10) {
        reject(
          new Error(
            'yt-dlp 下载重定向次数过多'
          )
        );
        return;
      }


      https.get(
        url,
        (response) => {

          /*
           * GitHub release 会重定向。
           */
          if (
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {

            response.resume();

            downloadFile(
              response.headers.location,
              destination,
              redirects + 1
            )
              .then(resolve)
              .catch(reject);

            return;
          }


          if (
            response.statusCode !== 200
          ) {

            response.resume();

            reject(
              new Error(
                `yt-dlp 下载失败：HTTP ${response.statusCode}`
              )
            );

            return;
          }


          const tempPath =
            `${destination}.part`;

          const output =
            fs.createWriteStream(
              tempPath
            );


          response.pipe(output);


          output.on(
            'finish',
            () => {

              output.close(
                () => {

                  fs.renameSync(
                    tempPath,
                    destination
                  );

                  fs.chmodSync(
                    destination,
                    0o755
                  );

                  resolve();

                }
              );

            }
          );


          output.on(
            'error',
            reject
          );

        }
      )
        .on(
          'error',
          reject
        );

    }
  );

}


async function main() {

  console.log(
    'Preparing Gama Music tools...'
  );


  if (
    !fs.existsSync(YTDLP_PATH)
  ) {

    console.log(
      `Downloading yt-dlp ${YTDLP_VERSION}...`
    );

    await downloadFile(
      YTDLP_URL,
      YTDLP_PATH
    );

  } else {

    console.log(
      'yt-dlp already exists.'
    );

  }


  console.log('');
  console.log('Vendor tools ready:');
  console.log(FFMPEG_PATH);
  console.log(FFPROBE_PATH);
  console.log(YTDLP_PATH);

}


main()
  .catch(
    (error) => {

      console.error(
        error
      );

      process.exitCode = 1;

    }
  );