// 使用公共 MQTT Broker
const MQTT_BROKER = 'wss://broker.hivemq.com:8884/mqtt';
const TOPIC_PREFIX = 'localdrop/v1';

let mqttClient = null;
let myId = generateUUID();
let myIp = null;
let myName = generateRandomName();

// 简单的 UUID 生成器
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

let peers = {}; // 存储在线用户列表
let activeConnection = null; // 当前活跃的连接对象 { pc, channel, ... }
let pendingCandidates = []; // 暂存未建立连接时的 ICE Candidates

// 检测是否为移动设备
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
// 统一使用 32KB 分块，平衡速度与稳定性
const CHUNK_SIZE = 32 * 1024; 

const peersContainer = document.getElementById('peers-container');
const myNameEl = document.getElementById('my-name');
const fileInput = document.getElementById('file-input');
const receiveDialog = document.getElementById('receive-dialog');
const progressDialog = document.getElementById('progress-dialog');

// 初始化
myNameEl.textContent = myName;

// 添加手动修改网络 ID 的功能
document.getElementById('network-id').style.cursor = 'pointer';
document.getElementById('network-id').title = '点击修改网络 ID';
document.getElementById('network-id').onclick = () => {
    const newId = prompt('请输入新的网络 ID (确保两台设备一致):', myIp || '');
    if (newId && newId.trim() !== '') {
        myIp = newId.trim();
        document.getElementById('network-id').textContent = `网络 ID: ${myIp}`;
        // 重新连接 MQTT
        if (mqttClient) {
            mqttClient.end();
            connectMqtt();
        } else {
            connectMqtt();
        }
    }
};

initApp();

// 生成随机中文名称
function generateRandomName() {
    const adjectives = ['快乐的', '幸运的', '聪明的', '勇敢的', '冷静的', '热情的', '优雅的', '可爱的', '神秘的', '活泼的'];
    const animals = ['熊猫', '老虎', '狮子', '老鹰', '海豚', '狐狸', '狼', '熊', '考拉', '企鹅', '猫咪', '狗狗'];
    return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${animals[Math.floor(Math.random() * animals.length)]}`;
}

async function getPublicIP() {
    const services = [
        // 强制使用 IPv4 接口，因为 IPv6 每个设备通常不同，无法用于局域网发现
        { url: 'https://api4.ipify.org?format=json', type: 'json', field: 'ip' },
        { url: 'https://ipv4.icanhazip.com', type: 'text' },
        { url: 'https://v4.ident.me', type: 'text' },
        // 如果以上都失败（纯 IPv6 网络），尝试通用接口但可能获取到 IPv6
        { url: 'https://www.cloudflare.com/cdn-cgi/trace', type: 'trace' }
    ];

    for (const service of services) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000); 
            
            const res = await fetch(service.url, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!res.ok) continue;

            let ip = null;
            if (service.type === 'json') {
                const data = await res.json();
                ip = data[service.field];
            } else if (service.type === 'text') {
                ip = (await res.text()).trim();
            } else if (service.type === 'trace') {
                const text = await res.text();
                const lines = text.split('\n');
                const ipLine = lines.find(l => l.startsWith('ip='));
                if (ipLine) ip = ipLine.split('=')[1];
            }

            // 检查是否为 IPv6 (包含冒号)
            if (ip && ip.includes(':')) {
                console.warn('Detected IPv6, skipping as it is likely unique per device:', ip);
                // 继续尝试下一个服务，寻找 IPv4
                continue; 
            }

            if (ip) return ip;

        } catch (e) {
            console.warn(`${service.url} failed:`, e);
        }
    }
    return null;
}

async function initApp() {
    try {
        // 1. 获取公网 IP (作为房间号)
        myIp = await getPublicIP();

        if (!myIp) {
            console.warn('无法自动获取公网 IP');
            document.getElementById('network-id').textContent = '点击设置网络 ID';
            // 随机生成一个 ID 作为备用
            myIp = Math.floor(Math.random() * 10000).toString();
            if(confirm('无法获取公网IP，是否使用随机网络ID: ' + myIp + '？\n(请确保另一台设备也修改为相同的ID)')) {
                 document.getElementById('network-id').textContent = `网络 ID: ${myIp}`;
            } else {
                 document.getElementById('network-id').textContent = '点击设置网络 ID';
                 myIp = null; // 暂停连接
                 return;
            }
        }

        console.log('My IP:', myIp);
        document.getElementById('network-id').textContent = `网络 ID: ${myIp}`;
        myNameEl.textContent = `${myName} (在线)`;

        // 2. 连接 MQTT
        connectMqtt();

    } catch (e) {
        console.error('Init failed:', e);
        myNameEl.textContent = '初始化失败，请刷新重试';
        document.getElementById('network-id').textContent = '获取 ID 失败';
    }
}

function connectMqtt() {
    const clientId = 'localdrop_' + Math.random().toString(16).substr(2, 8);
    document.getElementById('connection-status').textContent = '🟡 连接服务器...';
    
    mqttClient = mqtt.connect(MQTT_BROKER, {
        clientId: clientId
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT Broker');
        document.getElementById('connection-status').textContent = '🟢 服务已连接';
        
        // 订阅房间广播
        mqttClient.subscribe(`${TOPIC_PREFIX}/${myIp}/broadcast`);
        // 订阅私信 (信令)
        mqttClient.subscribe(`${TOPIC_PREFIX}/${myIp}/${myId}`);

        // 上线广播
        announcePresence();
        
        // 定期广播心跳 (每 5 秒)
        setInterval(announcePresence, 5000);
        
        // 清理离线用户 (每 10 秒)
        setInterval(prunePeers, 10000);
    });
    
    mqttClient.on('error', (err) => {
        console.error('MQTT Error:', err);
        document.getElementById('connection-status').textContent = '🔴 服务错误';
    });

    mqttClient.on('offline', () => {
        document.getElementById('connection-status').textContent = '⚪ 服务断开';
    });

    mqttClient.on('message', (topic, message) => {
        try {
            const msg = JSON.parse(message.toString());
            handleMqttMessage(topic, msg);
        } catch (e) {
            console.error('Message parse error:', e);
        }
    });
}

function announcePresence() {
    if (!mqttClient || !myIp) return;
    const msg = {
        type: 'presence',
        id: myId,
        name: myName,
        timestamp: Date.now()
    };
    mqttClient.publish(`${TOPIC_PREFIX}/${myIp}/broadcast`, JSON.stringify(msg));
}

function sendSignalingMessage(targetId, type, payload) {
    if (!mqttClient) return;
    const msg = {
        type: type,
        sender: myId,
        target: targetId,
        ...payload
    };
    mqttClient.publish(`${TOPIC_PREFIX}/${myIp}/${targetId}`, JSON.stringify(msg));
}

function handleMqttMessage(topic, msg) {
    if (msg.sender === myId) return; // 忽略自己

    if (msg.type === 'presence') {
        updatePeer(msg);
    } else if (msg.target === myId) {
        // 处理信令
        switch (msg.type) {
            case 'offer':
                handleOffer(msg);
                break;
            case 'answer':
                handleAnswer(msg);
                break;
            case 'candidate':
                handleCandidate(msg);
                break;
        }
    }
}

function updatePeer(peerInfo) {
    // 更新或添加 peer
    peers[peerInfo.id] = {
        ...peerInfo,
        lastSeen: Date.now()
    };
    renderPeers();
}

function prunePeers() {
    const now = Date.now();
    let changed = false;
    for (const id in peers) {
        if (now - peers[id].lastSeen > 10000) { // 10秒没心跳视为离线
            delete peers[id];
            changed = true;
        }
    }
    if (changed) renderPeers();
}

function renderPeers() {
    const users = Object.values(peers);
    // 复用之前的 updatePeers 逻辑，这里重命名为 renderPeers 避免冲突
    // 逻辑基本一致，只需要把之前的 updatePeers 函数体搬过来或者适配一下
    
    peersContainer.innerHTML = '';
    
    users.forEach(user => {
        const peerEl = document.createElement('div');
        peerEl.className = 'peer-item';
        
        // 长按/右键检测逻辑
        let pressTimer;
        
        const startPress = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return; 
            pressTimer = setTimeout(() => {
                initiateTextChat(user.id);
            }, 600);
        };

        const cancelPress = () => {
            clearTimeout(pressTimer);
        };
        
        peerEl.oncontextmenu = (e) => {
            e.preventDefault();
            cancelPress();
            initiateTextChat(user.id);
        };

        peerEl.addEventListener('mousedown', startPress);
        peerEl.addEventListener('touchstart', startPress);
        peerEl.addEventListener('mouseup', cancelPress);
        peerEl.addEventListener('mouseleave', cancelPress);
        peerEl.addEventListener('touchend', cancelPress);

        peerEl.onclick = (e) => {
            if (pressTimer) {
                initiateFileTransfer(user.id);
            }
        };
        
        const icon = document.createElement('div');
        icon.className = 'device-icon peer';
        icon.textContent = user.name.substring(0, 2);
        
        const name = document.createElement('div');
        name.className = 'peer-name';
        name.textContent = user.name;
        
        peerEl.appendChild(icon);
        peerEl.appendChild(name);
        peersContainer.appendChild(peerEl);
    });

    if (users.length === 0) {
        const scanning = document.createElement('div');
        scanning.className = 'scanning-pulse';
        scanning.textContent = '正在扫描设备...';
        peersContainer.appendChild(scanning);
    }
}

// WebRTC 配置
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
    ]
};

// ... 后续代码保持发送/接收逻辑不变，但要把 ws.send 替换为 sendSignalingMessage



// --- 发送方逻辑 ---

let selectedPeerId = null;

function initiateFileTransfer(peerId) {
    selectedPeerId = peerId;
    fileInput.click();
}

// 文字聊天相关元素
const sendTextDialog = document.getElementById('send-text-dialog');
const receiveTextDialog = document.getElementById('receive-text-dialog');
const textInput = document.getElementById('text-input');
const textContent = document.getElementById('text-content');

// 文字聊天事件绑定
document.getElementById('btn-cancel-text').onclick = () => hideDialog(sendTextDialog);
document.getElementById('btn-close-text').onclick = () => hideDialog(receiveTextDialog);
document.getElementById('btn-copy-text').onclick = () => {
    navigator.clipboard.writeText(textContent.innerText);
    alert('已复制到剪贴板');
};

document.getElementById('btn-send-text').onclick = () => {
    const text = textInput.value;
    if (!text) return;
    
    startSendingText(selectedPeerId, text);
    hideDialog(sendTextDialog);
    textInput.value = '';
};

function initiateTextChat(peerId) {
    selectedPeerId = peerId;
    showDialog(sendTextDialog);
    textInput.focus();
}

fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    startSendingFile(selectedPeerId, file);
    // 重置 input 以便下次可以选择相同文件
    fileInput.value = '';
};

async function startSendingFile(peerId, file) {
    await startConnection(peerId, 'file', file);
}

async function startSendingText(peerId, text) {
    await startConnection(peerId, 'text', text);
}

async function startConnection(peerId, type, data) {
    console.log(`Starting ${type} transfer to ${peerId}`);
    const pc = new RTCPeerConnection(rtcConfig);
    
    // 创建数据通道
    const channel = pc.createDataChannel('transfer');
    channel.binaryType = 'arraybuffer';
    
    if (type === 'file') {
        setupSenderChannel(channel, type, data);
        activeConnection = { pc, channel, file: data, role: 'sender' };
    } else {
        setupSenderChannel(channel, type, data);
        activeConnection = { pc, channel, text: data, role: 'sender' };
    }

    pc.oniceconnectionstatechange = () => {
        console.log('ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            // 文字发送很快，通常不需要报错，除非一直在 connecting
            if (type === 'file') {
                alert(`连接断开 (State: ${pc.iceConnectionState})，请重试。如果频繁失败，请尝试刷新页面。`);
                hideDialog(progressDialog);
            }
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage(peerId, 'candidate', {
                candidate: event.candidate
            });
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const offerMsg = {
        sdp: offer,
        transferType: type
    };

    if (type === 'file') {
        offerMsg.fileInfo = {
            name: data.name,
            size: data.size,
            type: data.type
        };
        showProgressDialog(`等待对方接收...`, 0);
    }

    sendSignalingMessage(peerId, 'offer', offerMsg);
}

function setupSenderChannel(channel, type, data) {
    channel.onopen = () => {
        console.log('Data channel open');
        if (type === 'file') {
            sendFileData(channel, data);
        } else {
            // 发送文字
            channel.send(JSON.stringify({ type: 'text', content: data }));
            // 发送完可以关闭
            setTimeout(() => {
                // channel.close(); 
                // pc.close(); // 可以关闭连接
            }, 1000);
        }
    };
    channel.onclose = () => console.log('Data channel closed');
}

async function sendFileData(channel, file) {
    let offset = 0;
    let lastUpdateTime = Date.now();
    let loopCount = 0; // 用于控制强制 yield 的计数器
    document.getElementById('transfer-status').textContent = `正在发送 ${file.name}...`;

    try {
        while (offset < file.size) {
            if (channel.readyState !== 'open') throw new Error('Connection closed');

            // 动态背压控制：缓冲区 > 64KB 时暂停，防止拥塞
            if (channel.bufferedAmount > 64 * 1024) {
                await new Promise(resolve => {
                    const check = () => {
                        if (channel.bufferedAmount < 16 * 1024) { // 降到 16KB 以下再继续
                            channel.onbufferedamountlow = null;
                            resolve();
                        }
                    };
                    channel.onbufferedamountlow = check;
                    setTimeout(() => {
                        if (channel.onbufferedamountlow) check();
                    }, 50);
                });
            }

            // 移动端强制 CPU 让渡：大幅降低频率，每发送约 1MB (32 chunks * 32KB) 才休息一次
            // 既保证了心跳包发送，又避免了频繁 await 导致的性能损耗
            if (isMobile) {
                loopCount++;
                if (loopCount % 32 === 0) {
                    await new Promise(r => setTimeout(r, 0)); // 仅让出时间片，不强制睡眠太久
                }
            }

            const chunk = await readChunk(file, offset, CHUNK_SIZE);
            channel.send(chunk);
            offset += chunk.byteLength;
            
            // 节流更新进度：每 200ms 更新一次，避免频繁 DOM 操作阻塞主线程
            const now = Date.now();
            if (now - lastUpdateTime > 200 || offset >= file.size) {
                updateProgress(offset, file.size);
                lastUpdateTime = now;
            }
        }

        console.log('File sent successfully');
        setTimeout(() => hideDialog(progressDialog), 1000);

    } catch (e) {
        console.error('Send failed:', e);
        alert('发送中断：' + e.message);
        hideDialog(progressDialog);
    }
}

function readChunk(file, offset, length) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = reject;
        const blob = file.slice ? file.slice(offset, offset + length) : 
                    (file.webkitSlice ? file.webkitSlice(offset, offset + length) : 
                    file.mozSlice(offset, offset + length));
        reader.readAsArrayBuffer(blob);
    });
}

/* 移除旧的 sendChunk 函数 */


// --- 接收方逻辑 ---

let pendingOffer = null;
let receivedBlobs = []; // 存储已合并的大块 Blob
let receivedBuffer = []; // 暂存当前的小块 ArrayBuffer
let receivedBufferSize = 0; // 当前暂存区大小
let receivedTotalSize = 0; // 总接收大小
let incomingFileInfo = null;

async function handleOffer(msg) {
    if (msg.transferType === 'text') {
        // 文字聊天自动接收
        await acceptTransfer(msg);
        return;
    }

    pendingOffer = msg;
    pendingCandidates = []; // 清空之前的候选
    incomingFileInfo = msg.fileInfo;
    
    // 自动接收，跳过确认弹窗
    console.log(`Auto accepting file from ${peers[msg.sender]?.name}`);
    await acceptTransfer(msg);
}

// 移除手动接收的事件绑定，保留拒绝按钮逻辑以防万一（虽然界面上不再主动显示）
document.getElementById('btn-reject').onclick = () => {
    hideDialog(receiveDialog);
    pendingOffer = null;
    // 可以在这里发送 reject 消息通知对方
};

document.getElementById('btn-accept').onclick = async () => {
    hideDialog(receiveDialog);
    if (!pendingOffer) return;
    
    await acceptTransfer(pendingOffer);
};

async function acceptTransfer(offerMsg) {
    const pc = new RTCPeerConnection(rtcConfig);
    activeConnection = { pc, role: 'receiver' };
    
    pc.oniceconnectionstatechange = () => {
        console.log('ICE state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            if (offerMsg.transferType === 'file') {
                alert(`连接断开 (State: ${pc.iceConnectionState})，请重试。`);
                hideDialog(progressDialog);
            }
        }
    };

    pc.ondatachannel = (event) => {
        event.channel.binaryType = 'arraybuffer';
        setupReceiverChannel(event.channel, offerMsg.transferType, offerMsg.sender);
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            sendSignalingMessage(offerMsg.sender, 'candidate', {
                candidate: event.candidate
            });
        }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offerMsg.sdp));
    
    // 处理之前暂存的 Candidates
    if (pendingCandidates.length > 0) {
        console.log(`Adding ${pendingCandidates.length} pending candidates`);
        for (const candidate of pendingCandidates) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error('Error adding pending ice candidate', e);
            }
        }
        pendingCandidates = [];
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    sendSignalingMessage(offerMsg.sender, 'answer', {
        sdp: answer
    });
    
    if (offerMsg.transferType === 'file') {
        showProgressDialog(`正在接收 ${offerMsg.fileInfo.name}...`, 0);
        // 重置接收缓冲区
        receivedBlobs = [];
        receivedBuffer = [];
        receivedBufferSize = 0;
        receivedTotalSize = 0;
        lastReceiverPercent = 0;
        lastReceiverUpdateTime = 0;
        incomingFileInfo = offerMsg.fileInfo;
    }
}

let lastReceiverUpdateTime = 0;
let lastReceiverPercent = 0;

function setupReceiverChannel(channel, type, senderId) {
    channel.onmessage = (event) => {
        if (type === 'text') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'text') {
                    const senderName = peers[senderId]?.name || '未知用户';
                    document.getElementById('text-sender-name').textContent = senderName;
                    document.getElementById('text-content').innerText = msg.content;
                    showDialog(receiveTextDialog);
                }
            } catch (e) {
                console.error('Failed to parse text message', e);
            }
        } else {
            const data = event.data;
            const chunkSize = data.byteLength || data.size;
            
            receivedBuffer.push(data);
            receivedBufferSize += chunkSize;
            receivedTotalSize += chunkSize;
            
            // 每 10MB 合并一次 Blob，避免 ArrayBuffer 数组过大导致内存溢出
            if (receivedBufferSize > 10 * 1024 * 1024) {
                receivedBlobs.push(new Blob(receivedBuffer));
                receivedBuffer = [];
                receivedBufferSize = 0;
            }
            
            // 节流更新接收进度：每 200ms 更新一次，避免频繁 DOM 操作阻塞主线程
            const now = Date.now();
            if (now - lastReceiverUpdateTime > 200 || receivedTotalSize >= incomingFileInfo.size) {
                updateProgress(receivedTotalSize, incomingFileInfo.size);
                lastReceiverUpdateTime = now;
            }
            
            if (receivedTotalSize >= incomingFileInfo.size) {
                // 确保最后更新一次 100%
                updateProgress(receivedTotalSize, incomingFileInfo.size);
                
                // 合并剩余数据
                if (receivedBuffer.length > 0) {
                    receivedBlobs.push(new Blob(receivedBuffer));
                    receivedBuffer = [];
                    receivedBufferSize = 0;
                }
                saveFile();
                setTimeout(() => hideDialog(progressDialog), 1000);
            }
        }
    };
}

function saveFile() {
    const blob = new Blob(receivedBlobs, { type: incomingFileInfo.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = incomingFileInfo.name;
    a.click();
    
    // 清理
    setTimeout(() => {
        URL.revokeObjectURL(url);
        receivedBlobs = []; // 释放内存
    }, 100);
}

// --- 通用 WebRTC 处理 ---

async function handleAnswer(msg) {
    if (activeConnection && activeConnection.pc) {
        await activeConnection.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }
}

async function handleCandidate(msg) {
    if (activeConnection && activeConnection.pc) {
        try {
            await activeConnection.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
            console.error('Error adding received ice candidate', e);
        }
    } else {
        // 如果连接还没建立（比如正在等待用户点击接收），暂存起来
        console.log('Buffering ICE candidate');
        pendingCandidates.push(msg.candidate);
    }
}

// --- UI 辅助函数 ---

function showDialog(el) {
    el.classList.remove('hidden');
}

function hideDialog(el) {
    el.classList.add('hidden');
}

function showProgressDialog(status, percent) {
    document.getElementById('transfer-status').textContent = status;
    updateProgress(0, 100); // Reset
    showDialog(progressDialog);
}

function updateProgress(current, total) {
    const percent = Math.floor((current / total) * 100);
    document.getElementById('progress-fill').style.width = `${percent}%`;
    document.getElementById('progress-text').textContent = `${percent}%`;
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
