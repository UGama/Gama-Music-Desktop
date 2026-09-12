'use strict';

const storageKeys = {
  apiBase: 'gamaMusic.apiBase',
  mode: 'gamaMusic.mode',
  selectedPlaylist: 'gamaMusic.selectedPlaylist'
};

const offlineDb = {
  name: 'gamaMusic.offline',
  version: 1,
  audioStore: 'audio',
  dataStore: 'data'
};

const state = {
  library: { tracks: [], playlists: [] },
  selectedPlaylistId: localStorage.getItem(storageKeys.selectedPlaylist) || null,
  currentTrackId: null,
  queue: [],
  activeView: 'library',
  mobilePlaylistDetailOpen: false,
  mode: localStorage.getItem(storageKeys.mode) || 'loop',
  preview: null,
  previewUrl: '',
  jobTimer: null,
  favoriteJobTimer: null,
  isSeeking: false,
  serverConnected: false,
  offlineTrackIds: new Set(),
  offlineCoverUrls: new Map(),
  offlineUsage: 0,
  playlistSaveJobs: new Map(),
  playerCoverUrl: null,
  playlistHeaderScrollHandler: null,
  activeObjectUrl: ''
};

const els = {};

function $(selector) {
  return document.querySelector(selector);
}

function icon(name) {
  const paths = {
    play: 'M8 5v14l11-7-11-7Z',
    pause: 'M7 5h4v14H7V5Zm6 0h4v14h-4V5Z',
    add: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
    edit: 'M15.8 4.6a2.1 2.1 0 0 1 3 3L8.2 18.2 4 19l.8-4.2 11-10.2ZM14.4 6l3.6 3.6',
    trash: 'M8 7h8l-.6 12H8.6L8 7Zm-2-3h12v2H6V4Zm4-2h4v2h-4V2Z',
    remove: 'M5 11h14v2H5v-2Z',
    list: 'M5 6h14v2H5V6Zm0 5h14v2H5v-2Zm0 5h14v2H5v-2Z',
    download: 'M11 3h2v10.2l3.6-3.6 1.4 1.4-6 6-6-6 1.4-1.4 3.6 3.6V3Zm-6 16h14v2H5v-2Z',
    saved: 'm5 12 4 4L19 6l1.4 1.4L9 18.8l-5.4-5.4L5 12Z'
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
}

function getPlaylistCover(playlist) {
  const covers = [
    { image: './assets/playlist/cat.svg' },
    { image: './assets/playlist/dog.svg' },
    { image: './assets/playlist/panda.svg' },
    { image: './assets/playlist/rabbit.svg' },
    { image: './assets/playlist/fox.svg' },
    { image: './assets/playlist/bear.svg' },
    { image: './assets/playlist/koala.svg' },
    { image: './assets/playlist/penguin.svg' },
    { image: './assets/playlist/red-panda.svg' },
    { image: './assets/playlist/frog.svg' },
    { image: './assets/playlist/tiger.svg' },
    { image: './assets/playlist/lion.svg' }
  ];

  function preferredIndex(item) {
    const seed = String(item.id || item.name || 'playlist');
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
      hash = ((hash * 31) + seed.charCodeAt(i)) >>> 0;
    }
    return hash % covers.length;
  }

  // Resolve in the same order as the cards, so every view gets the same cover.
  // Only move away from the hash choice when it repeats the previous animal.
  let previousIndex = -1;
  for (const item of state.library.playlists) {
    let index = preferredIndex(item);
    if (index === previousIndex) index = (index + 1) % covers.length;
    if (item === playlist || (playlist.id != null && item.id === playlist.id)) {
      return covers[index];
    }
    previousIndex = index;
  }

  return covers[preferredIndex(playlist)];
}

function initElements() {
  Object.assign(els, {
    audio: $('#audio'),
    connectionText: $('#connectionText'),
    libraryCount: $('#libraryCount'),
    downloadForm: $('#downloadForm'),
    urlInput: $('#urlInput'),
    titleInput: $('#titleInput'),
    previewButton: $('#previewButton'),
    downloadButton: $('#downloadButton'),
    downloadStatus: $('#downloadStatus'),
    mobileStatus: $('#mobileStatus'),
    favoriteImportForm: $('#favoriteImportForm'),
    favoriteUrlInput: $('#favoriteUrlInput'),
    favoriteImportButton: $('#favoriteImportButton'),
    favoriteImportStatus: $('#favoriteImportStatus'),
    trackList: $('#trackList'),
    searchInput: $('#searchInput'),
    playAllButton: $('#playAllButton'),
    offlineSummary: $('#offlineSummary'),
    playlistSaveStatus: $('#playlistSaveStatus'),
    playlistForm: $('#playlistForm'),
    playlistNameInput: $('#playlistNameInput'),
    playlistList: $('#playlistList'),
    playlistDetail: $('#playlistDetail'),
    libraryView: $('#libraryView'),
    playlistsView: $('#playlistsView'),
    contentSurface: $('.content-surface'),
    settingsButton: $('#settingsButton'),
    player: $('.player'),
    playerArt: $('.player-art'),
    playPauseButton: $('#playPauseButton'),
    playPauseIcon: $('#playPauseIcon'),
    prevButton: $('#prevButton'),
    nextButton: $('#nextButton'),
    nowTitle: $('#nowTitle'),
    nowMeta: $('#nowMeta'),
    currentTime: $('#currentTime'),
    durationTime: $('#durationTime'),
    progressInput: $('#progressInput'),
    modal: $('#modal'),
    modalTitle: $('#modalTitle'),
    modalBody: $('#modalBody'),
    modalPrimaryButton: $('#modalPrimaryButton'),
    modalCancelButton: $('#modalCancelButton'),
    modalCloseButton: $('#modalCloseButton')
  });
}

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('这台设备不支持离线歌曲存储。'));
      return;
    }

    const request = indexedDB.open(offlineDb.name, offlineDb.version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(offlineDb.audioStore)) {
        db.createObjectStore(offlineDb.audioStore, { keyPath: 'trackId' });
      }
      if (!db.objectStoreNames.contains(offlineDb.dataStore)) {
        db.createObjectStore(offlineDb.dataStore, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开 iPhone 本地存储。'));
  });
}

async function offlineRequest(storeName, mode, operation) {
  const db = await openOfflineDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('iPhone 本地存储操作失败。'));
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => reject(transaction.error || new Error('iPhone 本地存储空间不足。'));
  });
}

function getOfflineTrack(trackId) {
  return offlineRequest(offlineDb.audioStore, 'readonly', (store) => store.get(trackId));
}

function putOfflineTrack(record) {
  return offlineRequest(offlineDb.audioStore, 'readwrite', (store) => store.put(record));
}

function deleteOfflineTrack(trackId) {
  return offlineRequest(offlineDb.audioStore, 'readwrite', (store) => store.delete(trackId));
}

function getOfflineTrackIds() {
  return offlineRequest(offlineDb.audioStore, 'readonly', (store) => store.getAllKeys());
}

function getAllOfflineTracks() {
  return offlineRequest(
    offlineDb.audioStore,
    'readonly',
    (store) => store.getAll()
  );
}

function cacheLibrary(library) {
  return offlineRequest(offlineDb.dataStore, 'readwrite', (store) => store.put({ key: 'library', value: library }));
}

async function getCachedLibrary() {
  const record = await offlineRequest(offlineDb.dataStore, 'readonly', (store) => store.get('library'));
  return record?.value || null;
}

function mergeOfflineTracks(library, cachedLibrary) {
  const serverTrackIds = new Set(library.tracks.map((track) => track.id));
  const cachedTracks = cachedLibrary?.tracks || [];
  const localOnlyTracks = cachedTracks
    .filter((track) => state.offlineTrackIds.has(track.id) && !serverTrackIds.has(track.id))
    .map((track) => ({ ...track, localOnly: true }));

  return {
    ...library,
    tracks: [...library.tracks.map((track) => ({ ...track, localOnly: false })), ...localOnlyTracks]
  };
}

function formatBytes(bytes) {
  if (
    !Number.isFinite(bytes) ||
    bytes <= 0
  ) {
    return '0 MB';
  }

  const mb =
    bytes / (1024 * 1024);

  if (mb < 1024) {
    return `${mb < 10
        ? mb.toFixed(1)
        : Math.round(mb)
      } MB`;
  }

  const gb =
    mb / 1024;

  return `${gb.toFixed(2)} GB`;
}

async function refreshOfflineState() {
  /*
   * 先释放以前生成的封面 blob URL，
   * 防止一直占内存。
   */
  for (const url of state.offlineCoverUrls.values()) {
    URL.revokeObjectURL(url);
  }

  state.offlineCoverUrls.clear();

  try {
    const records =
      await getAllOfflineTracks();

    const audioRecords =
      records.filter(
        (record) =>
          record?.trackId &&
          record?.blob?.size
      );

    state.offlineTrackIds =
      new Set(
        audioRecords.map(
          (record) => record.trackId
        )
      );

    /*
     * 把存在 IndexedDB 里的封面 Blob
     * 转成当前页面能直接显示的 URL。
     */
    for (const record of records) {
      if (
        !record?.trackId ||
        !record?.coverBlob?.size
      ) {
        continue;
      }

      state.offlineCoverUrls.set(
        record.trackId,
        URL.createObjectURL(
          record.coverBlob
        )
      );
    }

    state.offlineUsage =
      records.reduce(
        (total, record) => {
          const audioSize =
            record?.blob?.size || 0;

          const coverSize =
            record?.coverBlob?.size || 0;

          return (
            total +
            audioSize +
            coverSize
          );
        },
        0
      );

  } catch {
    state.offlineTrackIds =
      new Set();

    state.offlineCoverUrls =
      new Map();

    state.offlineUsage = 0;
  }

  renderOfflineSummary();
}

function renderOfflineSummary() {
  if (!els.offlineSummary) return;
  els.offlineSummary.textContent = `iPhone 本地：${state.offlineTrackIds.size} 首 · 约 ${formatBytes(state.offlineUsage)}`;
}

function getApiBase() {
  return (localStorage.getItem(storageKeys.apiBase) || '').trim().replace(/\/$/, '');
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

function mediaUrl(track) {
  if (!track?.file) return '';
  return `${getApiBase()}/media/${encodeURIComponent(track.file)}`;
}

function coverMediaUrl(track) {
  if (!track?.cover) {
    return '';
  }

  return (
    `${getApiBase()}/media/` +
    encodeURIComponent(track.cover)
  );
}


function trackCoverUrl(track) {
  if (!track) {
    return '';
  }

  /*
   * 优先使用 iPhone 本地封面。
   */
  const offlineUrl =
    state.offlineCoverUrls.get(
      track.id
    );

  if (offlineUrl) {
    return offlineUrl;
  }

  /*
   * 连着 Mac 时读取 Mac 上的封面。
   */
  if (
    state.serverConnected &&
    track.cover
  ) {
    return coverMediaUrl(track);
  }

  return '';
}


function renderTrackCover(track) {
  const coverUrl =
    trackCoverUrl(track);

  if (coverUrl) {
    return `
      <div class="track-cover">
        <img
          src="${escapeHtml(coverUrl)}"
          alt=""
          loading="lazy"
        >
      </div>
    `;
  }

  return `
    <div
      class="track-cover track-cover-default"
      aria-hidden="true"
    >
      <span>♪</span>
    </div>
  `;
}

function setConnection(text, ok = true) {
  els.connectionText.textContent = text;
  els.connectionText.style.color = ok ? '' : '#9b372b';
}

function setStatus(message, type = 'info', progress = null) {
  const content = `<div>${escapeHtml(message)}</div>${progress === null ? '' : `<progress max="100" value="${progress}"></progress>`}`;
  [els.downloadStatus, els.mobileStatus].filter(Boolean).forEach((element) => {
    element.hidden = false;
    element.classList.toggle('warning', type === 'warning');
    element.innerHTML = content;
  });
}

function clearStatus() {
  [els.downloadStatus, els.mobileStatus].filter(Boolean).forEach((element) => {
    element.hidden = true;
    element.textContent = '';
  });
}

// Each playlist owns a persistent row; progress updates never replace other rows.
function updatePlaylistSaveStatus(playlistId, message, type = 'info', progress = null) {
  const job = state.playlistSaveJobs.get(playlistId);
  if (!job || !els.playlistSaveStatus) return;
  if (!job.element) {
    job.element = document.createElement('div');
    job.element.className = 'status-card playlist-save-status';
    job.element.innerHTML = '<strong></strong><div class="playlist-save-message"></div><progress max="100"></progress><button type="button" class="secondary-button compact" data-action="dismiss-playlist-save" hidden>关闭</button>';
    job.element.querySelector('strong').textContent = `保存到手机 · ${job.name}`;
    job.element.querySelector('progress').setAttribute('aria-label', `保存 ${job.name} 的进度`);
    job.element.querySelector('button').dataset.playlistId = playlistId;
    els.playlistSaveStatus.append(job.element);
  }
  els.playlistSaveStatus.hidden = false;
  job.element.classList.toggle('warning', type === 'warning');
  job.element.querySelector('.playlist-save-message').textContent = message;
  const bar = job.element.querySelector('progress');
  bar.hidden = progress === null;
  if (progress !== null) bar.value = Math.max(0, Math.min(100, progress));
  job.element.querySelector('button').hidden = job.active;
}

function isPlaylistFullySaved(playlist) {
  return Boolean(playlist?.trackIds.length) && playlist.trackIds.every((id) => {
    const track = state.library.tracks.find((item) => item.id === id);
    return Boolean(track) && state.offlineTrackIds.has(id) &&
      (!track.cover || state.offlineCoverUrls.has(id));
  });
}

function playlistSaveButtonState(playlist) {
  if (state.playlistSaveJobs.get(playlist?.id)?.active) {
    return { disabled: true, label: '正在保存…' };
  }
  if (isPlaylistFullySaved(playlist)) {
    return { disabled: true, label: '已全部保存' };
  }
  return { disabled: false, label: '↓ 保存全部' };
}

function syncPlaylistSaveButtons() {
  document.querySelectorAll('[data-action="save-playlist-offline"]').forEach((button) => {
    const playlist = state.library.playlists.find((item) => item.id === button.dataset.playlistId);
    const status = playlistSaveButtonState(playlist);
    button.disabled = status.disabled;
    button.textContent = status.label;
  });
}

function setFavoriteStatus(message, type = 'info', progress = null) {
  const element = els.favoriteImportStatus;

  if (!element) return;

  element.hidden = false;
  element.classList.toggle('warning', type === 'warning');

  element.innerHTML =
    `<div>${escapeHtml(message)}</div>` +
    (progress === null
      ? ''
      : `<progress max="100" value="${progress}"></progress>`);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

async function loadLibrary() {
  try {
    const [serverLibrary, cachedLibrary] = await Promise.all([
      api('/api/library'),
      getCachedLibrary().catch(() => null)
    ]);
    const library = mergeOfflineTracks(serverLibrary, cachedLibrary);
    state.library = library;
    state.serverConnected = true;
    cacheLibrary(library).catch(() => { });
    if (state.selectedPlaylistId && !library.playlists.some((item) => item.id === state.selectedPlaylistId)) {
      state.selectedPlaylistId = library.playlists[0]?.id || null;
    }
    if (!state.selectedPlaylistId && library.playlists[0]) {
      state.selectedPlaylistId = library.playlists[0].id;
    }
    if (state.selectedPlaylistId) {
      localStorage.setItem(storageKeys.selectedPlaylist, state.selectedPlaylistId);
    }
    setConnection(`${serverLibrary.tracks.length} 首歌，Mac 服务已连接`, true);
    render();
  } catch (error) {
    state.serverConnected = false;
    const cached = await getCachedLibrary().catch(() => null);
    if (cached?.tracks) {
      state.library = cached;
      setConnection(`离线模式 · iPhone 已保存 ${state.offlineTrackIds.size} 首`, true);
      render();
    } else {
      setConnection('没有连上 Mac 服务', false);
      renderEmptyConnection(error.message);
    }
  }
}

function render() {
  els.libraryCount.textContent = `${state.library.tracks.length} 首`;
  renderOfflineSummary();
  renderModeButtons();
  renderTracks();
  renderPlaylists();
  renderPlayer();
}

function renderEmptyConnection(message) {
  const html = `
    <div class="empty-state">
      没有连上 Mac 服务。请确认 Mac 上的 Gama Music 服务正在运行，iPhone 和 Mac 在同一个 Wi-Fi。<br>
      ${escapeHtml(message)}
    </div>
  `;
  els.trackList.innerHTML = html;
  els.playlistList.innerHTML = html;
  els.playlistDetail.innerHTML = '';
}

function renderTracks() {
  const query = els.searchInput.value.trim().toLowerCase();
  const tracks = state.library.tracks.filter((track) => track.title.toLowerCase().includes(query));
  els.trackList.innerHTML = renderTrackCards(tracks, { context: 'library' });
}

function renderTrackCards(
  tracks,
  options = {}
) {
  if (!tracks.length) {
    return '<div class="empty-state">还没有歌曲。</div>';
  }


  return tracks.map((track) => {

    const isActive =
      track.id ===
      state.currentTrackId;

    const isOffline =
      state.offlineTrackIds.has(
        track.id
      );


    const meta = [
      track.localOnly
        ? '仅存 iPhone'
        : track.source?.id ||
        'Bilibili',

      track.duration
        ? formatTime(
          track.duration
        )
        : '',

      track.uploader || ''

    ].filter(Boolean)
      .join(' · ');


    const removeButton =
      options.playlistId

        ? `
          <button
            class="mini-button"
            type="button"
            data-action="remove-from-playlist"
            data-playlist-id="${options.playlistId}"
            data-track-id="${track.id}"
            aria-label="从播放列表移除"
          >
            ${icon('remove')}
          </button>
        `

        : `
          <button
            class="mini-button"
            type="button"
            data-action="delete-track"
            data-track-id="${track.id}"
            aria-label="删除歌曲"
          >
            ${icon('trash')}
          </button>
        `;


    const offlineButton =
      isOffline

        ? `
          <button
            class="mini-button offline-action offline-saved"
            type="button"
            data-action="remove-offline"
            data-track-id="${track.id}"
            aria-label="删除 iPhone 本地副本"
          >
            ${icon('saved')}
          </button>
        `

        : `
          <button
            class="mini-button offline-action"
            type="button"
            data-action="save-offline"
            data-track-id="${track.id}"
            aria-label="保存到 iPhone"
          >
            ${icon('download')}
          </button>
        `;


    const managementButtons =
      track.localOnly
        ? ''
        : `
          <button
            class="mini-button"
            type="button"
            data-action="add-track"
            data-track-id="${track.id}"
            aria-label="加入播放列表"
          >
            ${icon('add')}
          </button>

          <button
            class="mini-button"
            type="button"
            data-action="rename-track"
            data-track-id="${track.id}"
            aria-label="改名"
          >
            ${icon('edit')}
          </button>

          ${removeButton}
        `;


    return `
      <article
        class="track-card ${isActive ? 'active' : ''}"
        data-track-id="${track.id}"
      >

        ${renderTrackCover(track)}

        <div class="track-copy">

          <div class="track-title">
            ${escapeHtml(track.title)}
            ${isOffline
        ? '<span class="offline-badge">iPhone</span>'
        : ''
      }
          </div>

          <div class="track-meta">
            ${escapeHtml(meta)}
          </div>

        </div>


        <div class="track-actions">

          <button
            class="mini-button"
            type="button"
            data-action="play-track"
            data-track-id="${track.id}"
            data-context="${options.playlistId || 'library'}"
            aria-label="播放"
          >
            ${icon('play')}
          </button>

          ${offlineButton}

          ${managementButtons}

        </div>

      </article>
    `;
  }).join('');
}

function syncPlaylistDetailChrome() {
  const detailMode =
    state.activeView === 'playlists' &&
    state.mobilePlaylistDetailOpen;

  els.contentSurface?.classList.toggle(
    'playlist-detail-mode',
    detailMode
  );

  document.body.classList.toggle(
    'playlist-detail-mode',
    detailMode
  );
}

function clearMobilePlaylistHeaderWatcher() {
  if (!state.playlistHeaderScrollHandler) {
    return;
  }

  window.removeEventListener(
    'scroll',
    state.playlistHeaderScrollHandler
  );

  window.removeEventListener(
    'resize',
    state.playlistHeaderScrollHandler
  );

  state.playlistHeaderScrollHandler = null;
}


function bindMobilePlaylistHeaderWatcher() {
  clearMobilePlaylistHeaderWatcher();

  const hero =
    els.playlistDetail?.querySelector(
      '.playlist-detail-hero'
    );

  const stickyTitle =
    els.playlistDetail?.querySelector(
      '.mobile-playlist-sticky-title'
    );

  const topbar =
    els.playlistDetail?.querySelector(
      '.mobile-playlist-topbar'
    );

  if (
    !hero ||
    !stickyTitle ||
    !topbar
  ) {
    return;
  }

  const update = () => {
    const mobile =
      window.matchMedia(
        '(max-width: 719px)'
      ).matches;

    if (
      !mobile ||
      state.activeView !== 'playlists' ||
      !state.mobilePlaylistDetailOpen
    ) {
      stickyTitle.classList.remove(
        'visible'
      );

      return;
    }

    const heroRect =
      hero.getBoundingClientRect();

    const topbarRect =
      topbar.getBoundingClientRect();

    /*
     * 大标题碰到顶部导航栏时，
     * 中间的小标题出现。
     */
    const shouldShow =
      heroRect.top <=
      topbarRect.bottom + 4;

    stickyTitle.classList.toggle(
      'visible',
      shouldShow
    );
  };

  state.playlistHeaderScrollHandler =
    update;

  window.addEventListener(
    'scroll',
    update,
    { passive: true }
  );

  window.addEventListener(
    'resize',
    update
  );

  requestAnimationFrame(update);
}

function renderPlaylists() {
  clearMobilePlaylistHeaderWatcher();
  els.playlistsView.classList.toggle(
    'mobile-detail-open',
    state.mobilePlaylistDetailOpen
  );

  syncPlaylistDetailChrome();

  if (!state.library.playlists.length) {
    state.mobilePlaylistDetailOpen = false;

    els.playlistList.innerHTML =
      '<div class="empty-state">还没有播放列表。</div>';

    els.playlistDetail.innerHTML = '';
    return;
  }

  els.playlistList.innerHTML =
    state.library.playlists.map((playlist) => {
      const active =
        playlist.id === state.selectedPlaylistId;

      const cover =
        getPlaylistCover(playlist);

      return `
        <article
          class="playlist-card ${active ? 'active' : ''}"
          data-action="select-playlist"
          data-playlist-id="${playlist.id}"
          >
        <div
          class="playlist-cover"
          aria-hidden="true"
          >
          <img src="${cover.image}" alt="" draggable="false">
        </div>
          <button
            class="choice-title"
            type="button"
            data-action="select-playlist"
            data-playlist-id="${playlist.id}"
          >
            <div class="playlist-title">
              ${escapeHtml(playlist.name)}
            </div>

            <div class="playlist-meta">
              ${playlist.trackIds.length} 首
            </div>
          </button>

          <div class="playlist-actions">
            <button
              class="mini-button"
              type="button"
              data-action="play-playlist"
              data-playlist-id="${playlist.id}"
              aria-label="播放列表"
            >
              ${icon('play')}
            </button>

            <button
              class="mini-button"
              type="button"
              data-action="rename-playlist"
              data-playlist-id="${playlist.id}"
              aria-label="改名"
            >
              ${icon('edit')}
            </button>

            <button
              class="mini-button"
              type="button"
              data-action="delete-playlist"
              data-playlist-id="${playlist.id}"
              aria-label="删除"
            >
              ${icon('trash')}
            </button>
          </div>
        </article>
      `;
    }).join('');

  const selected = getSelectedPlaylist();

  if (!selected) {
    els.playlistDetail.innerHTML = '';
    return;
  }

  const selectedCover =
    getPlaylistCover(selected);
  const tracks = selected.trackIds
    .map((id) =>
      state.library.tracks.find(
        (track) => track.id === id
      )
    )
    .filter(Boolean);

  const addable =
    state.library.tracks.filter(
      (track) =>
        !selected.trackIds.includes(track.id)
    );

  els.playlistDetail.innerHTML = `

    <div class="mobile-playlist-topbar">

      <button
        class="mobile-playlist-back"
        type="button"
        data-action="back-to-playlists"
        >
        <span class="back-arrow">←</span>
      </button>
      <div
        class="mobile-playlist-sticky-title"
        aria-hidden="true"
        >
      <div
        class="playlist-cover playlist-sticky-cover"
        >
      <img src="${selectedCover.image}" alt="" draggable="false">
    </div>

    <span class="mobile-playlist-sticky-name">
        ${escapeHtml(selected.name)}
      </span>
    </div>

      <button
        class="mini-button mobile-add-song"
        type="button"
        data-action="show-add-to-selected"
        aria-label="添加歌曲"
      >
        ${icon('add')}
      </button>

    </div>


    <div class="detail-heading playlist-detail-hero">

  <div class="playlist-detail-identity">

    <div
      class="playlist-cover playlist-detail-cover"
      aria-hidden="true"
    >
      <img src="${selectedCover.image}" alt="" draggable="false">
    </div>

    <div class="playlist-detail-title">

      <h2>
        ${escapeHtml(selected.name)}
      </h2>

      <div class="playlist-detail-meta">
        ${tracks.length} 首
      </div>

    </div>

  </div>

      <button
        class="secondary-button compact desktop-add-song"
        type="button"
        data-action="show-add-to-selected"
      >
        ${icon('add')} 添加歌曲
      </button>

    </div>


    <div class="mobile-playlist-main-actions">

      <button
        class="playlist-main-action"
        type="button"
        data-action="play-playlist"
        data-playlist-id="${selected.id}"
      >
        ▶ 播放全部
      </button>

      <button
        class="playlist-main-action"
        type="button"
        data-action="save-playlist-offline"
        data-playlist-id="${selected.id}"
        ${playlistSaveButtonState(selected).disabled ? 'disabled' : ''}
      >
        ${playlistSaveButtonState(selected).label}
      </button>

    </div>


    <div class="playlist-detail-list">

      ${tracks.length
      ? renderTrackCards(
        tracks,
        { playlistId: selected.id }
      )
      : '<div class="empty-state">这个播放列表还没有歌曲。</div>'
    }

    </div>


    <div class="hidden" id="addableTracks">

      <div class="choice-list">

        ${addable.length
      ? addable.map((track) => `
                <button
                  type="button"
                  data-action="add-track-to-selected"
                  data-track-id="${track.id}"
                >
                  ${escapeHtml(track.title)}
                </button>
              `).join('')
      : '<div class="empty-state">没有可添加的歌曲。</div>'
    }

      </div>

    </div>
  `;
  bindMobilePlaylistHeaderWatcher();
}

function getSelectedPlaylist() {
  return state.library.playlists.find((playlist) => playlist.id === state.selectedPlaylistId) || null;
}

function setActiveView(view) {
  state.activeView = view;
  syncPlaylistDetailChrome();
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
  els.libraryView.classList.toggle('hidden', view !== 'library');
  els.playlistsView.classList.toggle('hidden', view !== 'playlists');
}

async function previewVideo() {
  const url = els.urlInput.value.trim();
  if (!url) {
    setStatus('请先输入 Bilibili 视频 URL。', 'warning');
    return;
  }

  els.previewButton.disabled = true;
  setStatus('正在读取视频标题，并检查是否已经下载过。', 'info', 8);

  try {
    const preview = await api('/api/preview', { method: 'POST', body: { url } });
    state.preview = preview;
    state.previewUrl = url;

    if (!els.titleInput.value.trim()) {
      els.titleInput.value = preview.title || '';
    }

    if (preview.duplicate) {

      setStatus(
        `歌曲已经存在：${preview.existingTrack.title}。再次提交不会重复下载 MP3，只会检查并补齐封面。`,
        'info'
      );

    } else {

      setStatus(
        `可以下载。默认歌名：${preview.title}`,
        'info'
      );

    }
  } catch (error) {
    setStatus(error.message, 'warning');
  } finally {
    els.previewButton.disabled = false;
  }
}

async function startDownload(event) {
  event.preventDefault();
  const url = els.urlInput.value.trim();
  const title = els.titleInput.value.trim();
  if (!url) {
    setStatus('请先输入 Bilibili 视频 URL。', 'warning');
    return;
  }



  els.downloadButton.disabled = true;
  els.previewButton.disabled = true;
  setStatus('已加入下载队列。', 'info', 1);

  try {
    const result = await api('/api/download', { method: 'POST', body: { url, title } });
    pollJob(result.job.id);
  } catch (error) {
    setStatus(error.message, 'warning');
    els.downloadButton.disabled = false;
    els.previewButton.disabled = false;
  }
}

function pollJob(jobId) {
  window.clearInterval(state.jobTimer);

  state.jobTimer = window.setInterval(async () => {
    try {
      const { job } = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
      setStatus(job.error || job.stage, job.status === 'failed' || job.status === 'duplicate' ? 'warning' : 'info', job.progress);

      if (['complete', 'failed', 'duplicate'].includes(job.status)) {
        window.clearInterval(state.jobTimer);
        els.downloadButton.disabled = false;
        els.previewButton.disabled = false;

        if (job.status === 'complete') {
          els.urlInput.value = '';
          els.titleInput.value = '';

          state.preview = null;
          state.previewUrl = '';

          await loadLibrary();

          setStatus(
            `下载完成：${job.track.title}`,
            'info',
            100
          );
        }


        if (job.status === 'duplicate') {
          /*
           * 即使 MP3 重复，
           * 后端可能刚刚补好了封面，
           * 所以必须重新载入音乐库。
           */
          await loadLibrary();

          setStatus(
            job.existingTrack?.cover
              ? `歌曲已经存在，MP3 已跳过，封面已检查：${job.existingTrack.title}`
              : `歌曲已经存在，MP3 已跳过：${job.existingTrack?.title || ''}`,
            'info',
            100
          );
        }
      }
    } catch (error) {
      window.clearInterval(state.jobTimer);
      setStatus(error.message, 'warning');
      els.downloadButton.disabled = false;
      els.previewButton.disabled = false;
    }
  }, 1200);
}

async function startFavoriteImport(event) {
  event.preventDefault();

  const url = els.favoriteUrlInput.value.trim();

  if (!url) {
    setFavoriteStatus('请先输入 B站收藏夹 URL。', 'warning');
    return;
  }

  els.favoriteImportButton.disabled = true;

  setFavoriteStatus(
    '正在读取收藏夹并检查音乐库……',
    'info',
    1
  );

  try {
    const { job } = await api('/api/favorites/import', {
      method: 'POST',
      body: { url }
    });

    setFavoriteStatus(
      job.alreadyImported
        ? `已经导入过“${job.playlistName}”，正在同步更新……`
        : `已创建播放列表“${job.playlistName}”，开始导入……`,
      'info',
      job.progress
    );

    pollFavoriteJob(job.id);

  } catch (error) {
    setFavoriteStatus(error.message, 'warning');
    els.favoriteImportButton.disabled = false;
  }
}


function pollFavoriteJob(jobId) {
  window.clearInterval(state.favoriteJobTimer);

  state.favoriteJobTimer = window.setInterval(async () => {
    try {
      const { job } = await api(
        `/api/favorites/jobs/${encodeURIComponent(jobId)}`
      );

      const current =
        job.currentVideo?.title ||
        job.currentVideo?.id ||
        '';

      const message = [
        `${job.playlistName || '收藏夹'} · ${job.processed}/${job.total}`,
        `新下载 ${job.downloaded}`,
        `已有 ${job.duplicates}`,
        `加入列表 ${job.addedToPlaylist}`,
        `失败 ${job.failed}`
      ].join(' · ') + (current ? ` · ${current}` : '');

      setFavoriteStatus(
        message,
        job.status === 'failed' ? 'warning' : 'info',
        job.progress
      );

      if (['complete', 'failed'].includes(job.status)) {
        window.clearInterval(state.favoriteJobTimer);

        els.favoriteImportButton.disabled = false;

        await loadLibrary();

        if (job.playlistId) {
          state.selectedPlaylistId = job.playlistId;

          localStorage.setItem(
            storageKeys.selectedPlaylist,
            job.playlistId
          );

          setActiveView('playlists');
          renderPlaylists();
        }

        if (job.status === 'complete') {
          setFavoriteStatus(
            `${job.alreadyImported ? '同步完成' : '导入完成'}：${job.playlistName}` +
            ` · 新下载 ${job.downloaded} 首` +
            ` · 已有 ${job.duplicates} 首` +
            ` · 新加入播放列表 ${job.addedToPlaylist} 首` +
            ` · 已在列表 ${job.alreadyInPlaylist} 首` +
            (job.failed ? ` · 失败 ${job.failed} 首` : ''),
            job.failed ? 'warning' : 'info',
            100
          );
        } else {
          setFavoriteStatus(
            job.error || '收藏夹导入失败',
            'warning',
            100
          );
        }
      }

    } catch (error) {
      window.clearInterval(state.favoriteJobTimer);

      els.favoriteImportButton.disabled = false;

      setFavoriteStatus(
        error.message,
        'warning'
      );
    }

  }, 1200);
}

function queueForContext(context, trackId) {
  const playable = (ids) => ids.filter((id) => {
    const exists = state.library.tracks.some((track) => track.id === id);
    return exists && (state.serverConnected || state.offlineTrackIds.has(id));
  });

  if (Array.isArray(context)) {
    const ids = playable(context);
    return ids.length ? ids : [trackId];
  }

  if (context && context !== 'library') {
    const playlist = state.library.playlists.find((item) => item.id === context);
    const ids = playlist ? playable(playlist.trackIds) : [];
    return ids.length ? ids : [trackId];
  }
  return playable(state.library.tracks.map((track) => track.id));
}

async function fetchBlobWithProgress(url, onProgress) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`读取 MP3 失败：${response.status}`);
  }

  const total =
    Number(response.headers.get('Content-Length')) || 0;

  /*
   * 老版本浏览器如果不支持 ReadableStream，
   * 就退回普通 blob 下载。
   */
  if (!response.body || !response.body.getReader) {
    onProgress?.(10);

    const blob = await response.blob();

    onProgress?.(100);

    return blob;
  }

  const reader = response.body.getReader();

  let received = 0;
  const chunks = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    chunks.push(value);
    received += value.length;

    if (total > 0) {
      const percent = Math.min(
        100,
        Math.round((received / total) * 100)
      );

      onProgress?.(percent);
    }
  }

  const blob = new Blob(
    chunks,
    {
      type:
        response.headers.get('Content-Type') ||
        'audio/mpeg'
    }
  );

  onProgress?.(100);

  return blob;
}


async function saveTrackBlobToIphone(
  track,
  onProgress,
  onStage
) {
  const existing =
    await getOfflineTrack(
      track.id
    );

  let audioBlob =
    existing?.blob?.size
      ? existing.blob
      : null;

  let coverBlob =
    existing?.coverBlob?.size
      ? existing.coverBlob
      : null;

  let audioStatus =
    audioBlob
      ? 'exists'
      : 'missing';

  let coverStatus =
    !track.cover
      ? 'none'
      : coverBlob
        ? 'exists'
        : 'missing';


  /*
   * 第一步：
   * MP3 不存在才下载。
   */
  if (!audioBlob) {
    onStage?.('audio');

    audioBlob =
      await fetchBlobWithProgress(
        mediaUrl(track),
        onProgress
      );

    if (!audioBlob.size) {
      throw new Error(
        '收到的 MP3 文件为空。'
      );
    }

    audioStatus =
      'saved';

  } else {
    state.offlineTrackIds.add(
      track.id
    );
  }


  /*
   * 第二步：
   * 有服务器封面，但 iPhone
   * 没有封面时才下载。
   */
  if (
    track.cover &&
    !coverBlob
  ) {
    onStage?.('cover');

    try {
      const response =
        await fetch(
          coverMediaUrl(track)
        );

      if (!response.ok) {
        throw new Error(
          `读取封面失败：${response.status}`
        );
      }

      const downloadedCover =
        await response.blob();

      if (!downloadedCover.size) {
        throw new Error(
          '收到的封面文件为空。'
        );
      }

      coverBlob =
        downloadedCover;

      coverStatus =
        'saved';

    } catch (error) {
      /*
       * 封面失败不能导致已经下载好的
       * MP3 被丢掉。
       */
      console.warn(
        '保存封面失败：',
        track.title,
        error
      );

      coverStatus =
        'failed';
    }
  }


  /*
   * 把歌曲和封面一起保存。
   * 如果原来已有 MP3，
   * 这里只是在原记录上补封面。
   */
  await putOfflineTrack({
    ...(existing || {}),

    trackId: track.id,

    track: {
      ...track,
      localOnly: false
    },

    blob: audioBlob,

    size:
      audioBlob?.size || 0,

    coverBlob:
      coverBlob || null,

    coverSize:
      coverBlob?.size || 0,

    savedAt:
      existing?.savedAt ||
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString()
  });


  state.offlineTrackIds.add(
    track.id
  );


  return {
    audioStatus,
    coverStatus,

    size:
      audioBlob?.size || 0,

    coverSize:
      coverBlob?.size || 0
  };
}

async function saveTrackToIphone(
  trackId,
  button
) {
  const track =
    state.library.tracks.find(
      (item) =>
        item.id === trackId
    );

  if (!track) return;

  const existing =
    await getOfflineTrack(
      trackId
    );

  const hasAudio =
    Boolean(
      existing?.blob?.size
    );

  const hasCover =
    !track.cover ||
    Boolean(
      existing?.coverBlob?.size
    );


  /*
   * MP3 和封面都已经有了，
   * 才算真正可以全部跳过。
   */
  if (
    hasAudio &&
    hasCover
  ) {
    state.offlineTrackIds.add(
      trackId
    );

    render();

    setStatus(
      `iPhone 已经完整保存：${track.title}，已跳过。`,
      'info',
      100
    );

    return;
  }


  if (!state.serverConnected) {
    if (hasAudio) {
      setStatus(
        `歌曲已经在 iPhone，但封面尚未保存。连接 Mac 后可以补封面：${track.title}`,
        'warning',
        100
      );

      return;
    }

    throw new Error(
      '这首歌还没有保存到 iPhone，并且目前没有连接 Mac。'
    );
  }


  button.disabled = true;

  try {
    if (navigator.storage?.persist) {
      await navigator.storage
        .persist()
        .catch(() => false);
    }


    setStatus(
      hasAudio
        ? `音频已经存在，准备检查封面：${track.title}`
        : `准备保存到 iPhone：${track.title}`,
      'info',
      hasAudio
        ? 95
        : 0
    );


    const result =
      await saveTrackBlobToIphone(

        track,

        (percent) => {
          /*
           * 给封面预留最后约 5%。
           */
          const displayPercent =
            track.cover
              ? Math.round(
                percent * 0.95
              )
              : percent;

          setStatus(
            `正在保存音频：${track.title} · ${percent}%`,
            'info',
            displayPercent
          );
        },

        (stage) => {
          if (
            stage === 'cover'
          ) {
            setStatus(
              `正在保存封面：${track.title}`,
              'info',
              97
            );
          }
        }
      );


    await refreshOfflineState();

    render();


    const parts = [];

    if (
      result.audioStatus ===
      'saved'
    ) {
      parts.push('MP3 已保存');
    } else {
      parts.push('MP3 已有');
    }

    if (
      result.coverStatus ===
      'saved'
    ) {
      parts.push('封面已保存');

    } else if (
      result.coverStatus ===
      'exists'
    ) {
      parts.push('封面已有');

    } else if (
      result.coverStatus ===
      'failed'
    ) {
      parts.push('封面保存失败');

    } else {
      parts.push('使用默认封面');
    }


    setStatus(
      `${track.title} · ${parts.join(' · ')}`,
      result.coverStatus ===
        'failed'
        ? 'warning'
        : 'info',
      100
    );

  } catch (error) {
    const message =
      error?.name ===
        'QuotaExceededError'
        ? 'iPhone 可用存储空间不足，请先删除一些本地歌曲。'
        : error.message;

    setStatus(
      message,
      'warning'
    );

  } finally {
    button.disabled = false;
  }
}

async function savePlaylistToIphone(
  playlistId,
  button
) {
  const playlist =
    state.library.playlists.find(
      (item) =>
        item.id === playlistId
    );

  if (!playlist || playlistSaveButtonState(playlist).disabled) return;


  const tracks =
    playlist.trackIds
      .map((id) =>
        state.library.tracks.find(
          (track) =>
            track.id === id
        )
      )
      .filter(Boolean);


  if (!tracks.length) {
    setStatus(
      `“${playlist.name}”没有歌曲。`,
      'warning'
    );

    return;
  }


  const previousJob = state.playlistSaveJobs.get(playlistId);
  const job = { name: playlist.name, active: true, element: previousJob?.element || null };
  state.playlistSaveJobs.set(playlistId, job);
  const report = (message, type = 'info', progress = null) =>
    updatePlaylistSaveStatus(playlistId, message, type, progress);
  if (job.element) job.element.querySelector('strong').textContent = `保存到手机 · ${job.name}`;
  report('准备保存…', 'info', 0);
  syncPlaylistSaveButtons();
  button.disabled = true;

  let audioSavedCount = 0;
  let coverSavedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;


  try {
    if (navigator.storage?.persist) {
      await navigator.storage
        .persist()
        .catch(() => false);
    }


    for (
      let index = 0;
      index < tracks.length;
      index += 1
    ) {
      const track =
        tracks[index];

      const existing =
        await getOfflineTrack(
          track.id
        );

      const hasAudio =
        Boolean(
          existing?.blob?.size
        );

      const hasCover =
        !track.cover ||
        Boolean(
          existing?.coverBlob?.size
        );


      /*
       * MP3 + 封面都存在时
       * 才真正整首跳过。
       */
      if (
        hasAudio &&
        hasCover
      ) {
        skippedCount += 1;

        state.offlineTrackIds.add(
          track.id
        );

        const totalProgress =
          Math.round(
            (
              (index + 1) /
              tracks.length
            ) *
            100
          );

        report(
          `正在保存“${playlist.name}”` +
          ` · ${index + 1}/${tracks.length}` +
          ` · 已完整保存，跳过：${track.title}`,
          'info',
          totalProgress
        );

        continue;
      }


      /*
       * 缺 MP3 或缺封面，
       * 都需要 Mac。
       */
      if (!state.serverConnected) {
        failedCount += 1;
        continue;
      }


      try {
        const result =
          await saveTrackBlobToIphone(

            track,

            (songPercent) => {
              const songFraction =
                track.cover
                  ? (
                    songPercent /
                    100 *
                    0.95
                  )
                  : (
                    songPercent /
                    100
                  );

              const totalProgress =
                Math.round(
                  (
                    index +
                    songFraction
                  ) /
                  tracks.length *
                  100
                );

              report(
                `正在保存“${playlist.name}”` +
                ` · ${index + 1}/${tracks.length}` +
                ` · ${track.title}` +
                ` · 音频 ${songPercent}%`,
                'info',
                totalProgress
              );
            },

            (stage) => {
              if (
                stage !==
                'cover'
              ) {
                return;
              }

              const totalProgress =
                Math.round(
                  (
                    index +
                    0.97
                  ) /
                  tracks.length *
                  100
                );

              report(
                `正在保存“${playlist.name}”` +
                ` · ${index + 1}/${tracks.length}` +
                ` · 正在保存封面：${track.title}`,
                'info',
                totalProgress
              );
            }
          );


        if (
          result.audioStatus ===
          'saved'
        ) {
          audioSavedCount += 1;
        }

        if (
          result.coverStatus ===
          'saved'
        ) {
          coverSavedCount += 1;
        }

        if (
          result.audioStatus ===
          'exists' &&
          (
            result.coverStatus ===
            'exists' ||
            result.coverStatus ===
            'none'
          )
        ) {
          skippedCount += 1;
        }

        if (
          result.coverStatus ===
          'failed'
        ) {
          failedCount += 1;
        }

      } catch (error) {
        failedCount += 1;

        console.error(
          '保存歌曲失败：',
          track.title,
          error
        );
      }
    }


    await refreshOfflineState();

    await cacheLibrary(
      state.library
    ).catch(() => { });

    render();


    report(
      `“${playlist.name}”保存完成` +
      ` · 新保存 MP3 ${audioSavedCount} 首` +
      ` · 新保存封面 ${coverSavedCount} 个` +
      ` · 已完整保存 ${skippedCount} 首` +
      (
        failedCount
          ? ` · 失败 ${failedCount}`
          : ''
      ),
      failedCount
        ? 'warning'
        : 'info',
      100
    );

  } catch (error) {
    const message =
      error?.name ===
        'QuotaExceededError'
        ? 'iPhone 可用存储空间不足，请先删除一些本地歌曲。'
        : error.message;

    report(
      message,
      'warning'
    );

  } finally {
    job.active = false;
    if (job.element) job.element.querySelector('button').hidden = false;
    button.disabled = false;
    syncPlaylistSaveButtons();
  }
}

async function removeTrackFromIphone(trackId) {
  const track = state.library.tracks.find((item) => item.id === trackId);
  if (!window.confirm(`删除“${track?.title || '这首歌'}”在 iPhone 上的本地副本？Mac 上的 MP3 会保留。`)) return;

  await deleteOfflineTrack(trackId);
  if (track?.localOnly) {
    state.library.tracks = state.library.tracks.filter((item) => item.id !== trackId);
    state.library.playlists = state.library.playlists.map((playlist) => ({
      ...playlist,
      trackIds: playlist.trackIds.filter((id) => id !== trackId)
    }));
    await cacheLibrary(state.library).catch(() => { });
  }
  if (state.currentTrackId === trackId && state.activeObjectUrl) {
    els.audio.pause();
    els.audio.removeAttribute('src');
    URL.revokeObjectURL(state.activeObjectUrl);
    state.activeObjectUrl = '';
    state.currentTrackId = null;
  }
  await refreshOfflineState();
  render();
}

async function playTrack(trackId, context = 'library') {
  const track = state.library.tracks.find((item) => item.id === trackId);
  if (!track) return;

  let source = '';
  if (state.offlineTrackIds.has(trackId)) {
    const saved = await getOfflineTrack(trackId);
    if (saved?.blob) source = URL.createObjectURL(saved.blob);
  }
  if (!source) {
    if (!state.serverConnected) throw new Error('这首歌还没有保存到 iPhone，请连接 Mac 后保存。');
    source = mediaUrl(track);
  }

  if (state.activeObjectUrl) URL.revokeObjectURL(state.activeObjectUrl);
  state.activeObjectUrl = source.startsWith('blob:') ? source : '';
  state.queue = queueForContext(context, trackId);
  if (!state.queue.includes(trackId)) state.queue.unshift(trackId);
  state.currentTrackId = trackId;
  els.audio.src = source;
  els.audio.load();

  try {
    await els.audio.play();
    renderPlayer();
  } catch {
    renderPlayer();
  }
}

async function togglePlayPause() {
  if (!state.currentTrackId && state.library.tracks[0]) {
    await playTrack(state.library.tracks[0].id);
    return;
  }

  if (els.audio.paused) {
    await els.audio.play();
  } else {
    els.audio.pause();
  }
  renderPlayer();
}

function currentTrack() {
  return state.library.tracks.find((track) => track.id === state.currentTrackId) || null;
}

function nextTrackId(direction = 1) {
  if (!state.queue.length) state.queue = state.library.tracks.map((track) => track.id);
  if (!state.queue.length) return null;

  if (state.mode === 'shuffle') {
    if (state.queue.length === 1) return state.queue[0];
    const candidates = state.queue.filter((id) => id !== state.currentTrackId);
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  const index = Math.max(0, state.queue.indexOf(state.currentTrackId));
  const nextIndex = index + direction;
  if (nextIndex >= 0 && nextIndex < state.queue.length) return state.queue[nextIndex];
  return state.queue[(nextIndex + state.queue.length) % state.queue.length];
}

async function goNext() {
  const nextId = nextTrackId(1);
  if (nextId) await playTrack(nextId, state.queue);
}

async function goPrev() {
  const prevId = nextTrackId(-1);
  if (prevId) await playTrack(prevId, state.queue);
}

async function handleEnded() {
  if (state.mode === 'one') {
    els.audio.currentTime = 0;
    await els.audio.play();
    return;
  }
  await goNext();
}

function updateActiveTrackCards() {
  document
    .querySelectorAll('.track-card[data-track-id]')
    .forEach((card) => {
      card.classList.toggle(
        'active',
        card.dataset.trackId === state.currentTrackId
      );
    });
}

function renderPlayer() {
  if (navigator.mediaSession) {
    navigator.mediaSession.playbackState = state.currentTrackId
      ? (els.audio.paused ? 'paused' : 'playing')
      : 'none';
  }
  const track =
    currentTrack();

  const paused =
    els.audio.paused;


  els.player.classList.toggle(
    'playing',
    !paused &&
    Boolean(track)
  );


  els.nowTitle.textContent =
    track
      ? track.title
      : '等待播放';


  els.nowMeta.textContent =
    track
      ? (
        [
          track.source?.id,
          track.uploader
        ]
          .filter(Boolean)
          .join(' · ') ||
        'Gama Music'
      )
      : '选择一首歌曲';


  els.playPauseIcon.setAttribute(
    'd',
    paused
      ? 'M8 5v14l11-7-11-7Z'
      : 'M7 5h4v14H7V5Zm6 0h4v14h-4V5Z'
  );


  /*
   * 播放器左侧封面
   */
  const coverUrl =
    track
      ? trackCoverUrl(track)
      : '';


  /*
 * 只有封面真的发生变化，
 * 才重新创建播放器封面。
 */
  if (
    coverUrl !==
    state.playerCoverUrl
  ) {
    state.playerCoverUrl =
      coverUrl;

    if (coverUrl) {

      /*
       * 有真实歌曲封面
       */
      els.playerArt.innerHTML = `
    <img
      src="${escapeHtml(coverUrl)}"
      alt=""
    >
  `;

      els.playerArt.classList.remove(
        'default',
        'idle'
      );

    } else if (track) {

      /*
       * 有歌曲，但这首歌没有真实封面
       */
      els.playerArt.innerHTML = `
    <span class="player-cover-symbol">
      ♪
    </span>
  `;

      els.playerArt.classList.add(
        'default'
      );

      els.playerArt.classList.remove(
        'idle'
      );

    } else {

      /*
       * 完全还没有开始播放：
       * 使用原来 Gama Music 的三色柱图标
       */
      els.playerArt.innerHTML = `
    <span class="idle-bar"></span>
    <span class="idle-bar"></span>
    <span class="idle-bar"></span>
  `;

      els.playerArt.classList.remove(
        'default'
      );

      els.playerArt.classList.add(
        'idle'
      );
    }
  }


  /*
   * iPhone 锁屏 / 控制中心封面
   */
  if (
    'mediaSession' in navigator &&
    track
  ) {
    const artworkUrl =
      coverUrl ||
      './assets/icon-512.png';

    navigator.mediaSession.metadata =
      new MediaMetadata({
        title:
          track.title,

        artist:
          track.uploader ||
          'Gama Music',

        album:
          'Gama Music',

        artwork: [
          {
            src:
              artworkUrl
          }
        ]
      });
  }
  updateActiveTrackCards();
}

function updateProgress() {
  if (state.isSeeking) return;
  const duration = els.audio.duration || 0;
  const current = els.audio.currentTime || 0;
  els.currentTime.textContent = formatTime(current);
  els.durationTime.textContent = formatTime(duration);
  els.progressInput.value = duration ? Math.round((current / duration) * 1000) : 0;
}

function renderModeButtons() {
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === state.mode);
  });
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem(storageKeys.mode, mode);
  renderModeButtons();
}

function openModal({ title, body, primaryText = '保存', onPrimary }) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = body;
  els.modalPrimaryButton.textContent = primaryText;
  els.modal.classList.remove('hidden');
  els.modalPrimaryButton.onclick = async () => {
    await onPrimary?.();
    closeModal();
  };
  const input = els.modalBody.querySelector('input');
  if (input) {
    input.focus({ preventScroll: true });
    input.setSelectionRange(0, input.value.length);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      els.modalPrimaryButton.click();
    });
  }
}

function closeModal() {
  els.modal.classList.add('hidden');
  els.modalPrimaryButton.onclick = null;
}

function openTextEditor({ title, label, value, primaryText, onSave }) {
  openModal({
    title,
    primaryText,
    body: `
      <label class="field">
        <span>${escapeHtml(label)}</span>
        <input id="modalTextInput" type="text" enterkeyhint="done" value="${escapeHtml(value)}">
      </label>
    `,
    onPrimary: async () => {
      const nextValue = $('#modalTextInput').value.trim();
      if (!nextValue) return;
      await onSave(nextValue);
    }
  });
}

async function openSettings() {

  /*
   * Electron Desktop 专属设置。
   */
  if (
    window.gamaDesktop
      ?.getConnectionInfo
  ) {

    let info = null;


    try {

      info =
        await window.gamaDesktop
          .getConnectionInfo();

    } catch {

      info = null;

    }


    if (info) {

      openModal({

        title:
          'Gama Music 设置',

        primaryText:
          '完成',

        body: `

          <div class="desktop-connect-card">

            <div class="desktop-connect-heading">

              <strong>
                iPhone 连接
              </strong>

              <span class="desktop-server-online">
                ● 服务已运行
              </span>

            </div>


            ${info.qrCode

            ? `
                  <div class="desktop-qr">

                    <img
                      src="${escapeHtml(info.qrCode)}"
                      alt="iPhone 连接二维码"
                    >

                  </div>
                `

            : ''
          }


            <p class="desktop-connect-label">
              iPhone Safari 打开：
            </p>


            <div class="desktop-connect-url">

              ${escapeHtml(
            info.lanUrl ||
            '没有找到局域网地址'
          )}

            </div>


            <p class="settings-note">

              iPhone 和 Mac
              需要连接同一个 Wi-Fi。

            </p>

          </div>


          <div class="desktop-data-card">

            <strong>
              音乐数据库
            </strong>


            <p class="settings-note">

              ${escapeHtml(
            info.dataDir
          )}

            </p>


            <button
              class="secondary-button"
              type="button"
              id="openDesktopDataFolder"
            >
              打开数据文件夹
            </button>

          </div>

        `,

        onPrimary:
          async () => { }

      });


      const openDataButton =
        document.querySelector(
          '#openDesktopDataFolder'
        );


      openDataButton
        ?.addEventListener(
          'click',
          () => {

            window.gamaDesktop
              .openDataFolder();

          }
        );


      return;

    }

  }


  /*
   * iPhone / 普通浏览器保持原来的设置。
   */
  const current =
    getApiBase();

  const isHttpsPage =
    location.protocol === 'https:';


  openModal({

    title:
      '连接设置',

    primaryText:
      '保存',

    body: `

      <label class="field">

        <span>
          Mac 服务地址
        </span>

        <input
          id="apiBaseInput"
          type="url"
          placeholder="留空则使用当前地址，例如 http://192.168.1.10:7330"
          value="${escapeHtml(current)}"
        >

      </label>


      <p class="settings-note">

        如果这个页面放在
        GitHub Pages 上，
        通常需要 HTTPS 的
        Mac 服务地址或隧道地址。

      </p>


      ${isHttpsPage

        ? `
            <p class="settings-note">

              当前页面是 HTTPS。
              如果填写 http:// 地址，
              Safari 可能会拦截。

            </p>
          `

        : ''
      }

    `,

    onPrimary:
      async () => {

        const next =
          $('#apiBaseInput')
            .value
            .trim()
            .replace(/\/$/, '');


        if (next) {

          localStorage.setItem(
            storageKeys.apiBase,
            next
          );

        } else {

          localStorage.removeItem(
            storageKeys.apiBase
          );

        }


        await loadLibrary();

      }

  });

}

function openPlaylistPicker(trackId) {
  if (!state.library.playlists.length) {
    openTextEditor({
      title: '创建播放列表',
      label: '名称',
      value: '开车听',
      primaryText: '创建并加入',
      onSave: async (name) => {
        const { playlist } = await api('/api/playlists', { method: 'POST', body: { name } });
        await api(`/api/playlists/${encodeURIComponent(playlist.id)}/tracks`, { method: 'POST', body: { trackId } });
        state.selectedPlaylistId = playlist.id;
        localStorage.setItem(storageKeys.selectedPlaylist, playlist.id);
        await loadLibrary();
      }
    });
    return;
  }

  openModal({
    title: '加入播放列表',
    primaryText: '关闭',
    body: `
      <div class="choice-list">
        ${state.library.playlists.map((playlist) => `
          <button type="button" data-picker-playlist="${playlist.id}">
            ${escapeHtml(playlist.name)}
          </button>
        `).join('')}
      </div>
    `,
    onPrimary: async () => { }
  });

  els.modalBody.querySelectorAll('[data-picker-playlist]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/playlists/${encodeURIComponent(button.dataset.pickerPlaylist)}/tracks`, {
        method: 'POST',
        body: { trackId }
      });
      closeModal();
      await loadLibrary();
    });
  });
}

async function createPlaylist(event) {
  event.preventDefault();
  const name = els.playlistNameInput.value.trim();
  if (!name) return;
  const { playlist } = await api('/api/playlists', { method: 'POST', body: { name } });
  els.playlistNameInput.value = '';
  state.selectedPlaylistId = playlist.id;
  localStorage.setItem(storageKeys.selectedPlaylist, playlist.id);
  await loadLibrary();
}

async function handleAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;

  const action = button.dataset.action;
  const trackId = button.dataset.trackId;
  const playlistId = button.dataset.playlistId;

  if (action === 'play-track') {
    await playTrack(trackId, button.dataset.context || 'library');
  }

  if (action === 'dismiss-playlist-save') {
    const job = state.playlistSaveJobs.get(playlistId);
    if (job && !job.active) {
      job.element?.remove();
      state.playlistSaveJobs.delete(playlistId);
      els.playlistSaveStatus.hidden = state.playlistSaveJobs.size === 0;
    }
    return;
  }

  if (action === 'save-offline') {
    await saveTrackToIphone(trackId, button);
  }

  if (action === 'save-playlist-offline') {
    await savePlaylistToIphone(
      playlistId,
      button
    );
  }

  if (action === 'remove-offline') {
    await removeTrackFromIphone(trackId);
  }

  if (action === 'add-track') {
    openPlaylistPicker(trackId);
  }

  if (action === 'rename-track') {
    const track = state.library.tracks.find((item) => item.id === trackId);
    if (!track) return;
    openTextEditor({
      title: '修改歌名',
      label: '歌名',
      value: track.title,
      primaryText: '保存',
      onSave: async (title) => {
        await api(`/api/tracks/${encodeURIComponent(track.id)}`, { method: 'PATCH', body: { title } });
        await loadLibrary();
      }
    });
  }

  if (action === 'delete-track') {
    if (!window.confirm('从 Mac 音乐库删除这首歌？其他设备已保存的本地副本会保留。')) return;
    await api(`/api/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
    if (state.currentTrackId === trackId && !state.offlineTrackIds.has(trackId)) {
      els.audio.pause();
      els.audio.removeAttribute('src');
      if (state.activeObjectUrl) URL.revokeObjectURL(state.activeObjectUrl);
      state.activeObjectUrl = '';
      state.currentTrackId = null;
    }
    await loadLibrary();
  }

  if (action === 'select-playlist') {
    state.selectedPlaylistId = playlistId;

    state.mobilePlaylistDetailOpen = true;

    localStorage.setItem(
      storageKeys.selectedPlaylist,
      playlistId
    );

    renderPlaylists();
  }
  if (action === 'back-to-playlists') {
    state.mobilePlaylistDetailOpen = false;
    renderPlaylists();
  }

  if (action === 'play-playlist') {
    const playlist = state.library.playlists.find((item) => item.id === playlistId);
    const firstTrackId = playlist?.trackIds.find((id) => {
      const exists = state.library.tracks.some((track) => track.id === id);
      return exists && (state.serverConnected || state.offlineTrackIds.has(id));
    });
    if (firstTrackId) await playTrack(firstTrackId, playlistId);
  }

  if (action === 'rename-playlist') {
    const playlist = state.library.playlists.find((item) => item.id === playlistId);
    if (!playlist) return;
    openTextEditor({
      title: '修改播放列表',
      label: '名称',
      value: playlist.name,
      primaryText: '保存',
      onSave: async (name) => {
        await api(`/api/playlists/${encodeURIComponent(playlist.id)}`, { method: 'PATCH', body: { name } });
        await loadLibrary();
      }
    });
  }

  if (action === 'delete-playlist') {
    if (!window.confirm('删除这个播放列表？歌曲文件会保留。')) return;
    await api(`/api/playlists/${encodeURIComponent(playlistId)}`, { method: 'DELETE' });
    if (state.selectedPlaylistId === playlistId) state.selectedPlaylistId = null;
    await loadLibrary();
  }

  if (action === 'remove-from-playlist') {
    await api(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
    await loadLibrary();
  }

  if (action === 'show-add-to-selected') {
    $('#addableTracks')?.classList.toggle('hidden');
  }

  if (action === 'add-track-to-selected') {
    const playlist = getSelectedPlaylist();
    if (!playlist) return;
    await api(`/api/playlists/${encodeURIComponent(playlist.id)}/tracks`, { method: 'POST', body: { trackId } });
    await loadLibrary();
  }
}

function bindEvents() {
  els.previewButton.addEventListener('click', previewVideo);
  els.downloadForm.addEventListener('submit', startDownload);
  if (els.favoriteImportForm) {
    els.favoriteImportForm.addEventListener('submit', startFavoriteImport);
  }
  els.searchInput.addEventListener('input', renderTracks);
  els.playlistForm.addEventListener('submit', createPlaylist);
  els.settingsButton.addEventListener('click', openSettings);
  els.playAllButton.addEventListener('click', async () => {
    const first = state.serverConnected
      ? state.library.tracks[0]
      : state.library.tracks.find((track) => state.offlineTrackIds.has(track.id));
    if (first) await playTrack(first.id, 'library');
  });

  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {

      const view = button.dataset.view;

      if (view === 'playlists') {
        state.mobilePlaylistDetailOpen = false;
        renderPlaylists();
      }

      setActiveView(view);
    });
  });

  document.addEventListener('click', (event) => {
    handleAction(event).catch((error) => setStatus(error.message, 'warning'));
  });

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  els.playPauseButton.addEventListener('click', () => {
    togglePlayPause().catch((error) => setStatus(error.message, 'warning'));
  });
  els.nextButton.addEventListener('click', () => {
    goNext().catch((error) => setStatus(error.message, 'warning'));
  });
  els.prevButton.addEventListener('click', () => {
    goPrev().catch((error) => setStatus(error.message, 'warning'));
  });

  els.audio.addEventListener('play', renderPlayer);
  els.audio.addEventListener('playing', configureMediaSessionActions);
  els.audio.addEventListener('pause', renderPlayer);
  els.audio.addEventListener('timeupdate', updateProgress);
  els.audio.addEventListener('loadedmetadata', updateProgress);
  els.audio.addEventListener('ended', () => {
    handleEnded().catch((error) => setStatus(error.message, 'warning'));
  });

  els.progressInput.addEventListener('input', () => {
    state.isSeeking = true;
    const duration = els.audio.duration || 0;
    const nextTime = duration * (Number(els.progressInput.value) / 1000);
    els.currentTime.textContent = formatTime(nextTime);
  });
  els.progressInput.addEventListener('change', () => {
    const duration = els.audio.duration || 0;
    els.audio.currentTime = duration * (Number(els.progressInput.value) / 1000);
    state.isSeeking = false;
    updateProgress();
  });

  els.modalCloseButton.addEventListener('click', closeModal);
  els.modalCancelButton.addEventListener('click', closeModal);
  els.modal.addEventListener('click', (event) => {
    if (event.target === els.modal) closeModal();
  });

  configureMediaSessionActions();
}

function configureMediaSessionActions() {
  if (!navigator.mediaSession?.setActionHandler) return;
  const run = (action) => () => {
    Promise.resolve().then(action).catch((error) => setStatus(error.message, 'warning'));
  };
  const handlers = {
    seekbackward: null,
    seekforward: null,
    play: run(() => els.audio.play()),
    pause: run(() => els.audio.pause()),
    previoustrack: run(() => goPrev()),
    nexttrack: run(() => goNext())
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      // An unsupported action must not prevent the other controls from registering.
      console.warn(`Media Session action unavailable: ${action}`, error);
    }
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js').catch(() => { });
}

document.addEventListener('DOMContentLoaded', async () => {
  initElements();
  bindEvents();
  setActiveView('library');
  setMode(state.mode);
  registerServiceWorker();
  await refreshOfflineState();
  await loadLibrary();
});
