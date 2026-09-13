'use strict';


const $ =
    (selector) =>
        document.querySelector(
            selector
        );


let connectionInfo =
    null;


function setToolStatus(
    element,
    ready
) {

    element.textContent =
        ready
            ? '● Ready'
            : '● Missing';


    element.classList.toggle(
        'tool-ready',
        ready
    );


    element.classList.toggle(
        'tool-error',
        !ready
    );
}


async function refreshServerStatus() {

    if (
        !connectionInfo?.localUrl
    ) {
        return;
    }


    try {

        const response =
            await fetch(
                `${connectionInfo.localUrl}/api/library`
            );


        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }


        const library =
            await response.json();


        $('#serverStatus')
            .textContent =
            '服务运行中';


        $('#serverDot')
            .classList.add(
                'online'
            );


        $('#serverDot')
            .classList.remove(
                'error'
            );


        $('#songCount')
            .textContent =
            `${Array.isArray(
                library.tracks
            )
                ? library.tracks.length
                : 0
            } 首歌曲`;


    } catch {

        $('#serverStatus')
            .textContent =
            '服务连接失败';


        $('#serverDot')
            .classList.remove(
                'online'
            );


        $('#serverDot')
            .classList.add(
                'error'
            );


        $('#songCount')
            .textContent =
            '正在等待 Server';


        setTimeout(
            refreshServerStatus,
            1500
        );
    }
}


async function init() {

    connectionInfo =
        await window
            .gamaDesktop
            .getConnectionInfo();


    $('#localUrl')
        .textContent =
        connectionInfo.localUrl ||
        '—';


    $('#lanUrl')
        .textContent =
        connectionInfo.lanUrl ||
        '不可用';


    $('#dataDir')
        .textContent =
        connectionInfo.dataDir ||
        '—';


    setToolStatus(
        $('#ytdlpStatus'),
        Boolean(
            connectionInfo.tools?.ytdlp
        )
    );


    setToolStatus(
        $('#ffmpegStatus'),
        Boolean(
            connectionInfo.tools?.ffmpeg
        )
    );


    $('#openWebButton')
        .addEventListener(
            'click',
            () => {

                window
                    .gamaDesktop
                    .openWebApp();

            }
        );


    $('#openDataButton')
        .addEventListener(
            'click',
            () => {

                window
                    .gamaDesktop
                    .openDataFolder();

            }
        );


    await refreshServerStatus();
}


document.addEventListener(
    'DOMContentLoaded',
    init
);