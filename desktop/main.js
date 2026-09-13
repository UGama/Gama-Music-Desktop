'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  Tray,
  nativeImage
} = require('electron');


const PORT = 7330;

const SERVER_URL =
  `http://127.0.0.1:${PORT}`;

const WEB_APP_URL =
  'https://ugama.github.io/Gama-Music-Web/';


let mainWindow = null;
let tray = null;
let isQuitting = false;


/*
 * Gama Music 数据目录。
 */
function getStorageDir() {
  return path.join(
    app.getPath('appData'),
    'Gama Music'
  );
}


/*
 * 找 Mac 局域网 IPv4。
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
 * yt-dlp / ffmpeg 所在目录。
 */
function getVendorDir() {
  return app.isPackaged

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
}


/*
 * 检查内置工具。
 */
function getToolInfo() {
  const vendorDir =
    getVendorDir();

  return {
    ytdlp:
      fs.existsSync(
        path.join(
          vendorDir,
          'yt-dlp'
        )
      ),

    ffmpeg:
      fs.existsSync(
        path.join(
          vendorDir,
          'ffmpeg'
        )
      ),

    ffprobe:
      fs.existsSync(
        path.join(
          vendorDir,
          'ffprobe'
        )
      )
  };
}


/*
 * 启动 Gama Music Server。
 */
function startGamaServer() {
  const storageDir =
    getStorageDir();

  const vendorDir =
    getVendorDir();


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
    `yt-dlp: ${process.env.GAMA_MUSIC_YTDLP
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

async function showMainWindow() {

  if (
    process.platform === 'darwin'
  ) {
    await app.dock.show();
  }


  if (!mainWindow) {
    createWindow();
    return;
  }


  mainWindow.show();
  mainWindow.focus();
}


function createTray() {

  if (tray) {
    return;
  }


  /*
   * 使用菜单栏文字图标，
   * 暂时不需要额外 PNG 文件。
   */
  tray =
    new Tray(
      nativeImage.createEmpty()
    );


  tray.setTitle(
    '♫'
  );


  tray.setToolTip(
    'Gama Music Server'
  );


  const menu =
    Menu.buildFromTemplate([
      {
        label:
          '● Server Running',

        enabled:
          false
      },

      {
        type:
          'separator'
      },

      {
        label:
          '打开控制面板',

        click:
          showMainWindow
      },

      {
        label:
          '打开 Gama Music Web',

        click:
          () => {
            shell.openExternal(
              WEB_APP_URL
            );
          }
      },

      {
        label:
          '打开数据文件夹',

        click:
          () => {
            shell.openPath(
              getStorageDir()
            );
          }
      },

      {
        type:
          'separator'
      },

      {
        label:
          '退出 Gama Music',

        click:
          () => {
            isQuitting = true;
            app.quit();
          }
      }
    ]);


  tray.setContextMenu(
    menu
  );


  tray.on(
    'click',
    showMainWindow
  );
}


/*
 * 创建 Server 控制窗口。
 */
function createWindow() {
  mainWindow =
    new BrowserWindow({
      width: 720,
      height: 680,

      minWidth: 620,
      minHeight: 560,

      title:
        'Gama Music Server',

      backgroundColor:
        '#f4f6fb',

      webPreferences: {
        preload:
          path.join(
            __dirname,
            'preload.js'
          ),

        nodeIntegration:
          false,

        contextIsolation:
          true
      }
    });


  mainWindow.loadFile(
    path.join(
      __dirname,
      'server.html'
    )
  );


  mainWindow.on(
    'close',
    (event) => {

      /*
       * 点窗口红色关闭按钮：
       * 不关闭 Server，
       * 只隐藏控制面板。
       */
      if (!isQuitting) {

        event.preventDefault();

        mainWindow.hide();


        if (
          process.platform === 'darwin'
        ) {
          app.dock.hide();
        }
      }
    }
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
 * 判断这次启动是不是：
 *
 * 1. macOS 登录后自动启动
 * 2. 开发时用 --background 模拟
 */
    const startedInBackground =
      Boolean(
        app
          .getLoginItemSettings()
          .wasOpenedAtLogin
      ) ||
      process.argv.includes(
        '--background'
      );


    /*
     * 后台启动时不显示 Dock 图标。
     */
    if (
      startedInBackground &&
      process.platform === 'darwin'
    ) {
      app.dock.hide();
    }


    /*
     * 控制面板需要的信息。
     */
    ipcMain.handle(
      'desktop:get-connection-info',
      async () => {

        return {
          localUrl:
            SERVER_URL,

          lanUrl:
            getLanUrl(),

          webAppUrl:
            WEB_APP_URL,

          dataDir:
            getStorageDir(),

          tools:
            getToolInfo()
        };
      }
    );


    /*
     * Finder 打开数据目录。
     */
    ipcMain.handle(
      'desktop:open-data-folder',
      async () => {

        return shell.openPath(
          getStorageDir()
        );
      }
    );


    /*
     * 打开 Gama Music Web。
     */
    ipcMain.handle(
      'desktop:open-web-app',
      async () => {

        await shell.openExternal(
          WEB_APP_URL
        );

        return true;
      }
    );


    startGamaServer();

    createTray();


    /*
     * 手动打开 App：
     * 显示控制面板。
     *
     * 登录自动启动：
     * 只启动 Server，不弹窗口。
     */
    if (!startedInBackground) {
      createWindow();
    }


    app.on(
      'activate',
      async () => {

        /*
         * 如果之前是后台模式，
         * 用户现在主动打开 Gama Music，
         * 恢复 Dock 图标。
         */
        if (
          process.platform === 'darwin'
        ) {
          await app.dock.show();
        }


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
app.on(
  'before-quit',
  () => {
    isQuitting = true;
  }
);