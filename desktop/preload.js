'use strict';

const {
  contextBridge,
  ipcRenderer
} = require('electron');


contextBridge.exposeInMainWorld(
  'gamaDesktop',
  {

    getConnectionInfo() {
      return ipcRenderer.invoke(
        'desktop:get-connection-info'
      );
    },


    openDataFolder() {
      return ipcRenderer.invoke(
        'desktop:open-data-folder'
      );
    }

  }
);