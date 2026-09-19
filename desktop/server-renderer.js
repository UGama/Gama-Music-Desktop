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
                `${connectionInfo.localUrl}/api/health`
            );


        if (!response.ok) {
            throw new Error(
                `HTTP ${response.status}`
            );
        }


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
            '后台连接正常';


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

async function refreshAccessClients() {

    const list =
        $('#accessClientsList');


    try {

        const clients =
            await window
                .gamaDesktop
                .getAccessClients();


        list.replaceChildren();


        const activeClients =
            clients.filter(
                (client) =>
                    !client.revokedAt
            );


        if (!activeClients.length) {

            const empty =
                document.createElement(
                    'div'
                );

            empty.className =
                'muted';

            empty.textContent =
                '还没有已授权设备';

            list.appendChild(
                empty
            );

            return;

        }


        for (
            const client
            of activeClients
        ) {

            const item =
                document.createElement(
                    'div'
                );

            item.className =
                'access-client';


            const name =
                document.createElement(
                    'div'
                );

            name.className =
                'access-client-name';

            const deviceName =
                client.name ||
                [
                    client.browser,
                    client.platform
                ]
                    .filter(Boolean)
                    .join(' · ') ||
                '未命名设备';


            const deviceCode =
                client.id
                    ? String(
                        client.id
                    )
                        .slice(-4)
                        .toUpperCase()
                    : '';


            const deviceLabel =
                deviceCode
                    ? `${deviceName} · ${deviceCode}`
                    : deviceName;


            name.textContent =
                deviceLabel;


            const meta =
                document.createElement(
                    'div'
                );

            meta.className =
                'access-client-meta';


            const createdAt =
                new Date(
                    client.createdAt
                );


            const authorizedText =
                Number.isNaN(
                    createdAt.getTime()
                )
                    ? '已授权'
                    : `授权于 ${createdAt.toLocaleString()}`;


            const lastUsedAt =
                client.lastUsedAt
                    ? new Date(
                        client.lastUsedAt
                    )
                    : null;


            const lastUsedText =
                lastUsedAt &&
                    !Number.isNaN(
                        lastUsedAt.getTime()
                    )
                    ? `最近使用 ${lastUsedAt.toLocaleString()}`
                    : '尚未使用';


            const ipText =
                client.ipAddress
                    ? `连接 IP: ${client.ipAddress}`
                    : '连接 IP: 未知';


            meta.textContent =
                `${ipText} · ${authorizedText} · ${lastUsedText}`;


            const info =
                document.createElement(
                    'div'
                );

            info.className =
                'access-client-info';

            info.append(
                name,
                meta
            );


            const revokeButton =
                document.createElement(
                    'button'
                );

            revokeButton.type =
                'button';

            revokeButton.className =
                'access-client-revoke';

            revokeButton.textContent =
                '撤销授权';


            revokeButton.addEventListener(
                'click',
                async () => {

                    const confirmed =
                        window.confirm(
                            `确定撤销「${deviceLabel}」的授权吗？`
                        );

                    if (!confirmed) {
                        return;
                    }


                    revokeButton.disabled =
                        true;

                    revokeButton.textContent =
                        '正在撤销…';


                    try {

                        await window
                            .gamaDesktop
                            .revokeAccessClient(
                                client.id
                            );


                        await refreshAccessClients();

                    } catch (error) {

                        window.alert(
                            error?.message ||
                            '撤销授权失败'
                        );


                        revokeButton.disabled =
                            false;

                        revokeButton.textContent =
                            '撤销授权';

                    }

                }
            );


            item.append(
                info,
                revokeButton
            );


            list.appendChild(
                item
            );

        }

    } catch (error) {

        list.textContent =
            error?.message ||
            '读取授权设备失败';

    }

}

async function createAccessInvite() {

    const button =
        $('#createInviteButton');

    const panel =
        $('#invitePanel');

    const codeElement =
        $('#inviteCode');

    const expiryElement =
        $('#inviteExpiry');

    const errorElement =
        $('#inviteError');


    button.disabled =
        true;

    button.textContent =
        '正在生成……';

    errorElement.hidden =
        true;


    try {

        const invite =
            await window
                .gamaDesktop
                .createAccessInvite();


        codeElement.textContent =
            invite.code;


        const expiresAt =
            new Date(
                invite.expiresAt
            );


        if (
            Number.isNaN(
                expiresAt.getTime()
            )
        ) {

            expiryElement.textContent =
                '15 分钟内有效，只能使用一次。';

        } else {

            expiryElement.textContent =
                `有效至 ${expiresAt.toLocaleTimeString(
                    [],
                    {
                        hour: '2-digit',
                        minute: '2-digit'
                    }
                )}，只能使用一次。`;

        }


        panel.hidden =
            false;

        await refreshAccessClients();

    } catch (error) {

        errorElement.textContent =
            error?.message ||
            '生成邀请码失败';

        errorElement.hidden =
            false;

    } finally {

        button.disabled =
            false;

        button.textContent =
            '重新生成邀请码';

    }

}


async function copyInviteCode() {

    const code =
        $('#inviteCode')
            .textContent
            .trim();

    if (
        !code ||
        code === '—'
    ) {
        return;
    }


    const button =
        $('#copyInviteButton');


    try {

        await navigator
            .clipboard
            .writeText(
                code
            );


        button.textContent =
            '已复制';


        setTimeout(
            () => {
                button.textContent =
                    '复制';
            },
            1500
        );

    } catch {

        /*
         * Clipboard API 不可用时的备用方案。
         */
        const textarea =
            document.createElement(
                'textarea'
            );

        textarea.value =
            code;

        textarea.style.position =
            'fixed';

        textarea.style.opacity =
            '0';

        document.body.appendChild(
            textarea
        );

        textarea.select();

        document.execCommand(
            'copy'
        );

        textarea.remove();


        button.textContent =
            '已复制';


        setTimeout(
            () => {
                button.textContent =
                    '复制';
            },
            1500
        );

    }

}

function startAccessClientsRefresh() {

    /*
     * 控制面板打开时，
     * 每 10 秒自动刷新一次授权设备。
     */
    window.setInterval(
        () => {

            if (document.hidden) {
                return;
            }

            refreshAccessClients();

        },
        10000
    );


    /*
     * 从后台重新打开控制面板时，
     * 立即刷新，不需要等待 10 秒。
     */
    document.addEventListener(
        'visibilitychange',
        () => {

            if (!document.hidden) {
                refreshAccessClients();
            }

        }
    );

}

function startServerLogsRefresh() {

    /*
     * 控制面板打开时，
     * 每 10 秒自动刷新一次最新日志。
     */
    window.setInterval(
        () => {

            if (document.hidden) {
                return;
            }


            refreshServerLogs();

        },
        10000
    );


    /*
     * 从后台重新打开控制面板时，
     * 立即刷新日志。
     */
    document.addEventListener(
        'visibilitychange',
        () => {

            if (!document.hidden) {

                refreshServerLogs();

            }

        }
    );

}

function parseServerLogLine(
    line
) {

    const match =
        String(line || '')
            .match(
                /^\[([^\]]+)\]\s+\[([^\]]+)\]\s*(.*)$/
            );


    if (!match) {

        return {
            time: '',
            level: '',
            message:
                String(line || '')
        };

    }


    const date =
        new Date(
            match[1]
        );


    const time =
        Number.isNaN(
            date.getTime()
        )
            ? match[1]
            : date.toLocaleTimeString(
                [],
                {
                    hour:
                        '2-digit',
                    minute:
                        '2-digit',
                    second:
                        '2-digit'
                }
            );


    return {
        time,
        level:
            match[2],
        message:
            match[3]
    };

}


async function refreshServerLogs() {

    const list =
        $('#serverLogList');


    try {

        const lines =
            await window
                .gamaDesktop
                .getServerLogs();


        list.replaceChildren();


        if (!lines.length) {

            const empty =
                document.createElement(
                    'div'
                );

            empty.className =
                'muted';

            empty.textContent =
                '暂时还没有日志';

            list.appendChild(
                empty
            );

            return;

        }


        for (
            const line
            of lines
        ) {

            const parsed =
                parseServerLogLine(
                    line
                );


            const row =
                document.createElement(
                    'div'
                );

            row.className =
                'server-log-line';


            const time =
                document.createElement(
                    'span'
                );

            time.className =
                'server-log-time';

            time.textContent =
                parsed.time;


            const level =
                document.createElement(
                    'span'
                );

            level.className =
                'server-log-level';


            if (
                parsed.level ===
                'WARN'
            ) {
                level.classList.add(
                    'warn'
                );
            }


            if (
                parsed.level ===
                'ERROR'
            ) {
                level.classList.add(
                    'error'
                );
            }


            level.textContent =
                parsed.level;


            const message =
                document.createElement(
                    'span'
                );

            message.textContent =
                parsed.message;


            row.append(
                time,
                level,
                message
            );


            list.appendChild(
                row
            );

        }


        /*
         * 最新日志在最下面，
         * 每次刷新自动滚到底部。
         */
        list.scrollTop =
            list.scrollHeight;

    } catch (error) {

        list.textContent =
            error?.message ||
            '读取日志失败';

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

    $('#refreshAccessClientsButton')
        .addEventListener(
            'click',
            async () => {

                const button =
                    $('#refreshAccessClientsButton');


                button.disabled =
                    true;

                button.textContent =
                    '↻';


                try {

                    await refreshAccessClients();

                } finally {

                    button.disabled =
                        false;

                    button.textContent =
                        '↻';
                }

            }
        );

    $('#createInviteButton')
        .addEventListener(
            'click',
            createAccessInvite
        );


    $('#copyInviteButton')
        .addEventListener(
            'click',
            copyInviteCode
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

    $('#refreshServerLogsButton')
        .addEventListener(
            'click',
            async () => {

                const button =
                    $('#refreshServerLogsButton');


                button.disabled =
                    true;


                try {

                    await refreshServerLogs();

                } finally {

                    button.disabled =
                        false;

                }

            }
        );


    $('#openLogFolderButton')
        .addEventListener(
            'click',
            () => {

                window
                    .gamaDesktop
                    .openLogFolder();

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

    await refreshAccessClients();

    startAccessClientsRefresh();

    await refreshServerLogs();

    startServerLogsRefresh();
}


document.addEventListener(
    'DOMContentLoaded',
    init
);