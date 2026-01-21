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
const CHUNK_SIZE = 8192; // 降至 8KB 以提高移动端兼容性

const peersContainer = document.getElementById('peers-container');
const myNameEl = document.getElementById('my-name');
const fileInput = document.getElementById('file-input');
const receiveDialog = document.getElementById('receive-dialog');
const progressDialog = document.getElementById('progress-dialog');

// 初始化
myNameEl.textContent = myName;
initApp();

// 生成随机中文名称
function generateRandomName() {
    const adjectives = ['快乐的', '幸运的', '聪明的', '勇敢的', '冷静的', '热情的', '优雅的', '可爱的', '神秘的', '活泼的'];
    const animals = ['熊猫', '老虎', '狮子', '老鹰', '海豚', '狐狸', '狼', '熊', '考拉', '企鹅', '猫咪', '狗狗'];
    return `${adjectives[Math.floor(Math.random() * adjectives.length)]}${animals[Math.floor(Math.random() * animals.length)]}`;
}

async function initApp() {
    try {
        // 1. 获取公网 IP (作为房间号)
        // 使用多个 API 备选，防止某个挂掉
        try {
            const res = await fetch('https://api.ipify.org?format=json');
            const data = await res.json();
            myIp = data.ip;
        } catch (e) {
            console.warn('ipify failed, trying fallback...');
            const res = await fetch('https://api.db-ip.com/v2/free/self');
            const data = await res.json();
            myIp = data.ipAddress;
        }

        if (!myIp) throw new Error('无法获取公网 IP');

        console.log('My IP:', myIp);
        myNameEl.textContent = `${myName} (在线)`;

        // 2. 连接 MQTT
        connectMqtt();

    } catch (e) {
        console.error('Init failed:', e);
        myNameEl.textContent = '初始化失败，请刷新重试';
        alert('无法初始化连接，请检查网络或关闭广告拦截插件。');
    }
}

function connectMqtt() {
    const clientId = 'localdrop_' + Math.random().toString(16).substr(2, 8);
    mqttClient = mqtt.connect(MQTT_BROKER, {
        clientId: clientId
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT Broker');
        
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
    document.getElementById('transfer-status').textContent = `正在发送 ${file.name}...`;

    try {
        while (offset < file.size) {
            if (channel.readyState !== 'open') throw new Error('Connection closed');

            // 简单的背压控制：缓冲区 > 1MB 时暂停
            if (channel.bufferedAmount > 1024 * 1024) {
                await new Promise(resolve => {
                    const check = () => {
                        if (channel.bufferedAmount < 256 * 1024) { // 降到 256KB 再继续
                            channel.onbufferedamountlow = null;
                            resolve();
                        }
                    };
                    channel.onbufferedamountlow = check;
                    setTimeout(check, 50); // 轮询作为保底
                });
            }

            const chunk = await readChunk(file, offset, CHUNK_SIZE);
            channel.send(chunk);
            offset += chunk.byteLength;
            updateProgress(offset, file.size);
            
            // 强制给手机端喘息时间，避免 IO 拥塞
            if (offset % (CHUNK_SIZE * 5) === 0) {
                 await new Promise(r => setTimeout(r, 10));
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
let receivedBuffers = [];
let receivedSize = 0;
let incomingFileInfo = null;

async function handleOffer(msg) {
    if (msg.transferType === 'text') {
        // 文字聊天自动接收
        await acceptTransfer(msg);
        return;
    }

    pendingOffer = msg;
    incomingFileInfo = msg.fileInfo;
    
    const senderName = peers[msg.sender]?.name || '未知用户';
    document.getElementById('sender-name').textContent = senderName;
    document.getElementById('file-name').textContent = incomingFileInfo.name;
    document.getElementById('file-size').textContent = formatBytes(incomingFileInfo.size);
    
    showDialog(receiveDialog);
}

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
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    sendSignalingMessage(offerMsg.sender, 'answer', {
        sdp: answer
    });
    
    if (offerMsg.transferType === 'file') {
        showProgressDialog(`正在接收 ${offerMsg.fileInfo.name}...`, 0);
        receivedBuffers = [];
        receivedSize = 0;
        incomingFileInfo = offerMsg.fileInfo;
    }
}

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
            receivedBuffers.push(data);
            receivedSize += data.byteLength || data.size; // 兼容 ArrayBuffer 和 Blob
            
            updateProgress(receivedSize, incomingFileInfo.size);
            
            if (receivedSize >= incomingFileInfo.size) {
                saveFile();
                setTimeout(() => hideDialog(progressDialog), 1000);
            }
        }
    };
}

function saveFile() {
    const blob = new Blob(receivedBuffers, { type: incomingFileInfo.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = incomingFileInfo.name;
    a.click();
    
    // 清理
    setTimeout(() => URL.revokeObjectURL(url), 100);
    receivedBuffers = [];
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
