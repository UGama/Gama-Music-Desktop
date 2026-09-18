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

    createAccessInvite() {
      return ipcRenderer.invoke(
        'desktop:create-access-invite'
      );
    },


    getAccessClients() {
      return ipcRenderer.invoke(
        'desktop:get-access-clients'
      );
    },

    revokeAccessClient(clientId) {
      return ipcRenderer.invoke(
        'desktop:revoke-access-client',
        clientId
      );
    },

    getServerLogs() {
      return ipcRenderer.invoke(
        'desktop:get-server-logs'
      );
    },


    openLogFolder() {
      return ipcRenderer.invoke(
        'desktop:open-log-folder'
      );
    },



    openDataFolder() {
      return ipcRenderer.invoke(
        'desktop:open-data-folder'
      );
    },


    openWebApp() {
      return ipcRenderer.invoke(
        'desktop:open-web-app'
      );
    }

  }
);