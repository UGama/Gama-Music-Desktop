'use strict';


const path = require('path');
const os = require('os');

const {
  app,
  BrowserWindow,
  ipcMain,
  shell
} = require('electron');

const QRCode = require('qrcode');


const PORT = 7330;

const SERVER_URL =
  `http://127.0.0.1:${PORT}`;


let mainWindow = null;


/*
 * Desktop 正式数据目录。
 */
function getStorageDir() {

  return path.join(
    app.getPath('appData'),
    'Gama Music'
  );

}


/*
 * 找当前 Mac 的局域网 IPv4。
 *
 * 优先使用 Wi-Fi 常见的 en0。
 */
function getLanAddress() {

  const interfaces =
    os.networkInterfaces();

  const candidates = [];


  for (
    const [name, entries]
    of Object.entries(interfaces)
  ) {

    for (
      const entry of entries || []
    ) {

      if (
        entry.family !== 'IPv4' ||
        entry.internal ||
        entry.address.startsWith(
          '169.254.'
        )
      ) {
        continue;
      }


      candidates.push({
        name,
        address: entry.address
      });

    }

  }


  const preferred =
    candidates.find(
      (item) =>
        item.name === 'en0'
    ) ||
    candidates[0];


  return preferred?.address || '';

}


/*
 * iPhone 应该访问的地址。
 */
function getLanUrl() {

  const address =
    getLanAddress();


  if (!address) {
    return '';
  }


  return (
    `http://${address}:${PORT}`
  );

}


/*
 * 启动现有 Gama Music server。
 */
function startGamaServer() {

  const storageDir =
    path.join(
      app.getPath('appData'),
      'Gama Music'
    );


  /*
   * 开发模式：
   * 项目/vendor/mac-arm64
   *
   * 打包以后：
   * Gama Music.app/Contents/Resources/
   * vendor/mac-arm64
   */
  const vendorDir =
    app.isPackaged

      ? path.join(
          process.resourcesPath,
          'vendor',
          'mac-arm64'
        )

      : path.join(
          __dirname,
          '..',
          'vendor',
          'mac-arm64'
        );


  process.env.GAMA_MUSIC_STORAGE_DIR =
    storageDir;

  process.env.GAMA_MUSIC_YTDLP =
    path.join(
      vendorDir,
      'yt-dlp'
    );

  process.env.GAMA_MUSIC_FFMPEG_DIR =
    vendorDir;


  console.log(
    `Gama Music data: ${storageDir}`
  );

  console.log(
    `yt-dlp: ${
      process.env.GAMA_MUSIC_YTDLP
    }`
  );

  console.log(
    `ffmpeg folder: ${vendorDir}`
  );


  require(
    path.join(
      __dirname,
      '..',
      'server',
      'server.js'
    )
  );

}


/*
 * 创建 Desktop 窗口。
 */
function createWindow() {

  mainWindow =
    new BrowserWindow({

      width: 1180,
      height: 820,

      minWidth: 900,
      minHeight: 650,

      title: 'Gama Music',

      backgroundColor:
        '#f7f8fa',

      webPreferences: {

        preload:
          path.join(
            __dirname,
            'preload.js'
          ),

        nodeIntegration: false,

        contextIsolation: true

      }

    });


  setTimeout(
    () => {

      mainWindow.loadURL(
        SERVER_URL
      );

    },
    500
  );


  mainWindow.on(
    'closed',
    () => {

      mainWindow = null;

    }
  );

}


/*
 * App 启动。
 */
app.whenReady()
  .then(() => {

    app.setName(
      'Gama Music'
    );


    /*
     * 网页向 Electron 请求
     * iPhone 连接信息。
     */
    ipcMain.handle(
      'desktop:get-connection-info',
      async () => {

        const lanUrl =
          getLanUrl();


        let qrCode = '';


        if (lanUrl) {

          qrCode =
            await QRCode.toDataURL(
              lanUrl,
              {
                width: 300,
                margin: 1
              }
            );

        }


        return {

          lanUrl,

          qrCode,

          dataDir:
            getStorageDir()

        };

      }
    );


    /*
     * Finder 打开音乐数据目录。
     */
    ipcMain.handle(
      'desktop:open-data-folder',
      async () => {

        return shell.openPath(
          getStorageDir()
        );

      }
    );


    startGamaServer();

    createWindow();


    app.on(
      'activate',
      () => {

        if (
          BrowserWindow
            .getAllWindows()
            .length === 0
        ) {

          createWindow();

        }

      }
    );

  });


app.on(
  'window-all-closed',
  () => {

    if (
      process.platform !==
      'darwin'
    ) {

      app.quit();

    }

  }
);