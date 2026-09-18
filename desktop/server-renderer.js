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

            name.textContent =
                client.name ||
                '未命名设备';


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


            meta.textContent =
                Number.isNaN(
                    createdAt.getTime()
                )
                    ? '已授权'
                    : `授权于 ${createdAt.toLocaleString()}`;


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
                            `确定撤销「${client.name || '未命名设备'}」的授权吗？`
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
}


document.addEventListener(
    'DOMContentLoaded',
    init
);