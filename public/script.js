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
// 极限提速：使用 128KB 分块
const CHUNK_SIZE = 128 * 1024; 

const peersContainer = document.getElementById('peers-container');

// 传输队列
let transferQueue = [];
let isTransferring = false;

// 生成设备唯一颜色 (Hash string to color)
function getDeviceColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    // 使用 HSL 颜色空间，并避开蓝色系 (200-260)，因为蓝色是“我”的颜色
    let h = Math.abs(hash) % 360;
    if (h > 200 && h < 260) {
        h = (h + 60) % 360;
    }
    return `hsl(${h}, 75%, 60%)`;
}
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
            case 'transfer-complete':
                if (peers[msg.sender] && peers[msg.sender].resolveTransfer) {
                    console.log('Received transfer-complete signal');
                    peers[msg.sender].resolveTransfer();
                    peers[msg.sender].resolveTransfer = null;
                }
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
        // 设置唯一颜色边框，便于区分
        icon.style.borderColor = getDeviceColor(user.name);
        
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

// 队列处理函数
async function processQueue() {
    if (isTransferring || transferQueue.length === 0) return;
    
    isTransferring = true;
    const { peerId, file } = transferQueue.shift();
    
    try {
        await startSendingFile(peerId, file);
    } catch (e) {
        console.error('Transfer failed in queue', e);
    } finally {
        isTransferring = false;
        // 稍微延迟处理下一个，确保连接清理完成
        setTimeout(processQueue, 500); 
    }
}

fileInput.onchange = (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;
    
    files.forEach(file => {
        transferQueue.push({ peerId: selectedPeerId, file });
    });
    
    processQueue();
    // 重置 input 以便下次可以选择相同文件
    fileInput.value = '';
};

async function startSendingFile(peerId, file) {
    return new Promise((resolve, reject) => {
        startConnection(peerId, 'file', file, resolve, reject).catch(reject);
    });
}

async function startSendingText(peerId, text) {
    return new Promise((resolve, reject) => {
        startConnection(peerId, 'text', text, resolve, reject).catch(reject);
    });
}

async function startConnection(peerId, type, data, resolve, reject) {
    console.log(`Starting ${type} transfer to ${peerId}`);
    let pc;
    let channel;
    
    // 检查是否已有活跃连接且对方是同一个人 (发送端复用逻辑)
    if (activeConnection && activeConnection.pc && 
        (activeConnection.pc.connectionState === 'connected' || activeConnection.pc.connectionState === 'connecting') &&
        activeConnection.role === 'sender' && // 确保自己之前的角色也是 sender
        selectedPeerId === peerId) { // 这里 selectedPeerId 可能不太准，最好是 activeConnection 记录了 targetId
        
        console.log('Reusing existing PeerConnection (Sender)');
        pc = activeConnection.pc;
        // 创建新的 DataChannel 用于此次传输
        channel = pc.createDataChannel('transfer');
        channel.binaryType = 'arraybuffer';
    } else {
        console.log('Creating new PeerConnection (Sender)');
        pc = new RTCPeerConnection(rtcConfig);
        
        // 创建数据通道
        channel = pc.createDataChannel('transfer');
        channel.binaryType = 'arraybuffer';
        
        pc.oniceconnectionstatechange = () => {
            console.log('ICE state:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                if (type === 'file') {
                    alert(`连接断开 (State: ${pc.iceConnectionState})，请重试。如果频繁失败，请尝试刷新页面。`);
                    hideDialog(progressDialog);
                    if (reject) reject(new Error('ICE connection failed'));
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
    }

    if (type === 'file') {
        setupSenderChannel(channel, type, data, resolve, reject, peerId);
        // 更新 activeConnection，但保留 pc
        activeConnection = { pc, channel, file: data, role: 'sender', peerId: peerId };
    } else {
        setupSenderChannel(channel, type, data, resolve, reject, peerId);
        activeConnection = { pc, channel, text: data, role: 'sender', peerId: peerId };
    }

    // 无论是否复用，都发送 Offer 告知对方有新文件/消息
    // 如果是复用，createOffer 会生成一个新的 Offer (包含新 DataChannel 的信息，如果有变化)
    // 注意：如果是单纯复用 DataChannel (比如只发文字)，可能不需要 createOffer，但这里我们要发新文件，还是走标准流程稳妥
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const offerMsg = {
        sdp: offer,
        transferType: type,
        sender: myId // 确保包含 sender ID
    };

    if (type === 'file') {
        // offerMsg.fileInfo = ... // 不再依赖 offerMsg 中的文件信息
        showProgressDialog(`等待对方接收...`, 0);
    }

    sendSignalingMessage(peerId, 'offer', offerMsg);
}

function setupSenderChannel(channel, type, data, resolve, reject, peerId) {
    channel.onopen = () => {
        console.log('Data channel open');
        
        // 立即发送元数据 (In-Band Metadata)，解决复用连接时的状态同步问题
        if (type === 'file') {
             const meta = {
                 type: 'file-info',
                 name: data.name,
                 size: data.size,
                 fileType: data.type
             };
             channel.send(JSON.stringify(meta));
        } else {
             // 文字聊天也可以发送个 meta，或者直接发内容
             // 之前的逻辑是直接发内容 { type: 'text', content: ... }
             // 保持不变，接收端根据 type 判断
        }

        if (type === 'file') {
            sendFileData(channel, data).then(() => {
                // 发送数据完成，等待接收端确认（通过信令或关闭通道）
                console.log('Data sent, waiting for receiver confirmation...');
                
                let completed = false;
                const cleanup = () => {
                    if (completed) return;
                    completed = true;
                    if (peers[peerId]) peers[peerId].resolveTransfer = null;
                    channel.onclose = () => console.log('Data channel closed after completion');
                    if (resolve) resolve();
                };

                // 1. 设置 10秒 超时（避免死锁）
                const timeout = setTimeout(() => {
                    console.warn('Transfer confirmation timeout, proceeding anyway...');
                    cleanup();
                }, 10000);

                // 2. 监听信令 (推荐，准确)
                if (peers[peerId]) {
                    peers[peerId].resolveTransfer = () => {
                        console.log('Received transfer-complete signal from receiver');
                        clearTimeout(timeout);
                        cleanup();
                    };
                }

                // 3. 监听通道关闭 (兼容旧逻辑)
                channel.onclose = () => {
                    console.log('Data channel closed by receiver');
                    clearTimeout(timeout);
                    cleanup();
                };
            }).catch(err => {
                if (reject) reject(err);
            });
        } else {
            // 发送文字
            channel.send(JSON.stringify({ type: 'text', content: data }));
            // 发送完可以关闭
            setTimeout(() => {
                if (resolve) resolve();
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

            // 动态背压控制：放宽缓冲区限制至 1MB
            // 缓冲区 > 1MB 时暂停，降到 256KB 以下恢复
            if (channel.bufferedAmount > 1024 * 1024) {
                await new Promise((resolve, reject) => {
                    const check = () => {
                        if (channel.bufferedAmount < 256 * 1024) { 
                            channel.onbufferedamountlow = null;
                            resolve();
                        }
                    };
                    channel.onbufferedamountlow = check;
                    
                    // 增加超时检查，防止背压死锁 (2秒)
                    const timeout = setTimeout(() => {
                        if (channel.onbufferedamountlow) {
                            console.warn('Backpressure timeout, forcing continue...');
                            channel.onbufferedamountlow = null;
                            // 检查连接状态，如果还活着就继续，否则报错
                            if (channel.readyState === 'open') {
                                resolve();
                            } else {
                                reject(new Error('Connection closed during backpressure'));
                            }
                        }
                    }, 2000);

                    // 同时也轮询一下，双重保险
                    setTimeout(() => {
                        if (channel.onbufferedamountlow) {
                            clearTimeout(timeout);
                            check();
                        }
                    }, 50);
                });
            }

            // 移动端强制 CPU 让渡：进一步减少频率
            // 每发送约 2MB (32 chunks * 64KB) 才休息一次，且只休息一瞬间
            if (isMobile) {
                loopCount++;
                if (loopCount % 32 === 0) {
                    await new Promise(r => setTimeout(r, 0)); 
                }
            }

            const chunk = await readChunk(file, offset, CHUNK_SIZE);
            channel.send(chunk);
            offset += chunk.byteLength;
            
            // 节流更新进度：每 200ms 更新一次，避免频繁 DOM 操作阻塞主线程
            const now = Date.now();
            if (now - lastUpdateTime > 200 || offset >= file.size) {
                // 计算实际发送进度 (减去还在缓冲区的)
                const sent = offset - channel.bufferedAmount;
                updateProgress(sent > 0 ? sent : 0, file.size);
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
// 移除全局的接收状态变量，改为在 setupReceiverChannel 中使用闭包
// let receivedBlobs = []; 
// let receivedBuffer = []; 
// let receivedBufferSize = 0; 
// let receivedTotalSize = 0; 
// let incomingFileInfo = null;
let downloadDirectoryHandle = null; // 用于存储用户选择的下载目录句柄

async function handleOffer(msg) {
    if (msg.transferType === 'text') {
        // 文字聊天自动接收
        await acceptTransfer(msg);
        return;
    }

    pendingOffer = msg;
    pendingCandidates = []; // 清空之前的候选
    // incomingFileInfo = msg.fileInfo; // 不再使用全局变量
    
    // 自动接收，跳过确认弹窗
    console.log(`Auto accepting file from ${peers[msg.sender]?.name}`);
    await acceptTransfer(msg);
}

// 移除手动接收的事件绑定，保留拒绝按钮逻辑以防万一
document.getElementById('btn-reject').onclick = () => {
    hideDialog(receiveDialog);
    pendingOffer = null;
};

document.getElementById('btn-accept').onclick = async () => {
    hideDialog(receiveDialog);
    if (!pendingOffer) return;
    
    await acceptTransfer(pendingOffer);
};

// 添加设置下载目录的功能
const downloadDirBtn = document.createElement('button');
downloadDirBtn.textContent = '📂 启用自动保存到文件夹';
downloadDirBtn.className = 'btn';
downloadDirBtn.style.marginTop = '15px';
downloadDirBtn.style.width = '100%';
downloadDirBtn.style.backgroundColor = '#2d2d2d';
downloadDirBtn.style.color = '#ccc';
downloadDirBtn.style.border = '1px dashed #555';
downloadDirBtn.style.borderRadius = '8px';
downloadDirBtn.style.padding = '12px';
downloadDirBtn.style.transition = 'all 0.3s ease';

// 封装按钮状态更新函数
function updateDownloadBtnState(state) {
    let folderName = downloadDirectoryHandle ? downloadDirectoryHandle.name : '';
    if (!folderName) folderName = '默认文件夹';
    
    if (state === 'active') {
        downloadDirBtn.textContent = `✅ 已启用自动保存 (${folderName})`;
        downloadDirBtn.style.backgroundColor = '#1e3a29'; // 暗绿色
        downloadDirBtn.style.borderColor = '#4caf50';
        downloadDirBtn.style.color = '#4caf50';
        downloadDirBtn.style.borderStyle = 'solid';
    } else if (state === 'pending') {
        downloadDirBtn.textContent = `📂 点击恢复自动保存到 "${folderName}"`;
        downloadDirBtn.style.backgroundColor = '#2d2d2d';
        downloadDirBtn.style.borderColor = '#ff9800'; // 橙色提示
        downloadDirBtn.style.color = '#ff9800';
        downloadDirBtn.style.borderStyle = 'dashed';
    } else {
        downloadDirBtn.textContent = '📂 启用自动保存到文件夹';
        downloadDirBtn.style.backgroundColor = '#2d2d2d';
        downloadDirBtn.style.borderColor = '#555';
        downloadDirBtn.style.color = '#ccc';
        downloadDirBtn.style.borderStyle = 'dashed';
    }
}

downloadDirBtn.onmouseover = () => {
    if (downloadDirBtn.textContent.includes('已启用')) return;
    downloadDirBtn.style.borderColor = '#4285f4';
    downloadDirBtn.style.color = '#fff';
    downloadDirBtn.style.backgroundColor = '#333';
};
downloadDirBtn.onmouseout = () => {
    if (downloadDirBtn.textContent.includes('已启用')) return;
    if (downloadDirBtn.textContent.includes('恢复')) {
        downloadDirBtn.style.borderColor = '#ff9800';
        downloadDirBtn.style.color = '#ff9800';
        downloadDirBtn.style.backgroundColor = '#2d2d2d';
    } else {
        downloadDirBtn.style.borderColor = '#555';
        downloadDirBtn.style.color = '#ccc';
        downloadDirBtn.style.backgroundColor = '#2d2d2d';
    }
};

downloadDirBtn.onclick = async () => {
    try {
        // 如果已经有句柄（比如从 DB 恢复的），只需要验证权限
        if (downloadDirectoryHandle) {
             const hasPermission = await verifyPermission(downloadDirectoryHandle, true);
             if (hasPermission) {
                 await saveDirectoryHandleToDB(downloadDirectoryHandle); // 刷新 DB
                 updateDownloadBtnState('active');
                 alert('自动保存权限已恢复！');
                 return;
             }
        }

        // 否则重新请求
        downloadDirectoryHandle = await window.showDirectoryPicker({
            mode: 'readwrite'
        });
        
        const hasPermission = await verifyPermission(downloadDirectoryHandle, true);
        if (!hasPermission) {
            throw new Error('未获得写入权限');
        }

        // 保存到 DB
        await saveDirectoryHandleToDB(downloadDirectoryHandle);

        updateDownloadBtnState('active');
        
        alert('已启用自动保存！文件将直接写入您选择的文件夹，不再频繁弹窗。');
    } catch (e) {
        console.error('Failed to get directory handle:', e);
        if (e.name !== 'AbortError') {
             alert('无法启用自动保存: ' + e.message);
        }
    }
};
// 将按钮添加到页面合适位置 (例如 my-info 下面)
document.getElementById('my-info').appendChild(downloadDirBtn);


async function acceptTransfer(offerMsg) {
    let pc;
    // 检查是否已有活跃连接且对方是同一个人
    if (activeConnection && activeConnection.pc && 
        (activeConnection.pc.connectionState === 'connected' || activeConnection.pc.connectionState === 'connecting') &&
        activeConnection.peerId === offerMsg.sender) {
        
        console.log('Reusing existing PeerConnection');
        pc = activeConnection.pc;
        // 复用连接时，不需要重新绑定 ondatachannel，因为我们使用了持久化的通用处理函数
        // 如果之前的逻辑是覆盖 ondatachannel，现在应该停止这样做
        // pc.ondatachannel = ... // REMOVED
    } else {
        console.log('Creating new PeerConnection');
        pc = new RTCPeerConnection(rtcConfig);
        activeConnection = { pc, role: 'receiver', peerId: offerMsg.sender };
        
        pc.oniceconnectionstatechange = () => {
            console.log('ICE state:', pc.iceConnectionState);
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                if (offerMsg.transferType === 'file') {
                    console.warn(`连接断开 (State: ${pc.iceConnectionState})`);
                }
            }
        };

        // 绑定持久化的通用处理函数
        pc.ondatachannel = (event) => {
            console.log('DataChannel received', event.channel.label);
            handleIncomingChannel(event.channel, offerMsg.sender);
        };
        
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignalingMessage(offerMsg.sender, 'candidate', {
                    candidate: event.candidate
                });
            }
        };
    }

    // 处理 SDP (Offer)
    // 无论是新连接还是复用连接，都需要设置 Remote Description (Renegotiation)
    // 检查状态，避免在不正确的状态下 setRemoteDescription
    if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
         // 如果处于 have-remote-offer 状态，可能是之前的协商还没完成，或者是重复的 offer
         console.warn('Signaling state is ' + pc.signalingState + ', waiting or resetting...');
         // 简单的冲突处理：如果正在协商，可能需要 rollback 或等待。
         // 这里假设我们始终是接收方，且 offer 是新的。
         // 如果是 rollback: await pc.setLocalDescription({type: "rollback"});
    }
    
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
    }
}

// 通用 DataChannel 处理函数 (Handles In-Band Metadata)
function handleIncomingChannel(channel, senderId) {
    channel.binaryType = 'arraybuffer';
    
    // 状态变量
    let fileInfo = null;
    let receivedBlobs = [];
    let receivedSize = 0;
    let lastUpdateTime = 0;
    
    channel.onmessage = async (event) => {
        const data = event.data;
        
        // 1. 尝试解析元数据 (JSON String)
        if (!fileInfo && typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'file-info') {
                    console.log('Received File Metadata:', msg);
                    fileInfo = {
                        name: msg.name,
                        size: msg.size,
                        type: msg.fileType
                    };
                    // 初始化 UI
                    showProgressDialog(`正在接收 ${fileInfo.name}...`, 0);
                    return;
                } else if (msg.type === 'text') {
                    // 兼容旧的文本消息格式
                    // 直接处理，不需要后续的 binary 流程
                    console.log('Received Text Message:', msg.content);
                    const senderName = peers[senderId] ? peers[senderId].name : '未知用户';
                    appendMessage(senderName, msg.content, 'in');
                    showToast(`收到来自 ${senderName} 的消息`);
                    
                    // 自动回复 answer/ack? (文本通常不需要严格 ack)
                    return;
                }
            } catch (e) {
                console.warn('Failed to parse metadata:', e);
            }
        }
        
        // 2. 处理文件内容 (ArrayBuffer)
        if (data instanceof ArrayBuffer) {
            if (!fileInfo) {
                console.warn('Received binary data before metadata! Ignoring or waiting...');
                // 这里可能是一个问题：如果元数据丢了？
                // 但 DataChannel 是有序可靠的 (Ordered, Reliable)，所以只要发了，肯定先到。
                // 除非是对端没有发元数据 (旧版本代码)。
                // 兼容性：如果收到了二进制但没元数据，可能是旧协议，或者 Text Chat 的误判？
                // 暂时忽略，或者尝试从 pendingOffer 获取 (如果不复用的话)
                if (pendingOffer && pendingOffer.fileInfo) {
                    console.log('Fallback to pendingOffer fileInfo');
                    fileInfo = pendingOffer.fileInfo;
                    showProgressDialog(`正在接收 ${fileInfo.name}...`, 0);
                } else {
                    return; 
                }
            }
            
            receivedBlobs.push(data);
            receivedSize += data.byteLength;
            
            // 更新进度条
            const now = Date.now();
            if (now - lastUpdateTime > 200 || receivedSize >= fileInfo.size) {
                updateProgress(receivedSize, fileInfo.size);
                lastUpdateTime = now;
            }
            
            // 接收完成
            if (receivedSize >= fileInfo.size) {
                console.log('File receive complete:', fileInfo.name);
                
                // 保存文件
                await saveFile(receivedBlobs, fileInfo);
                setTimeout(() => hideDialog(progressDialog), 1000);
                
                // 发送确认信令
                sendSignalingMessage(senderId, 'transfer-complete', {});

                // 清理资源
                setTimeout(() => {
                    channel.close();
                }, 1000);
                
                // 重置状态 (虽然 channel 会关闭，但闭包变量最好清理)
                fileInfo = null;
                receivedBlobs = [];
                receivedSize = 0;
            }
        } else if (typeof data === 'string' && !fileInfo) {
             // 可能是普通文本聊天
             try {
                const msg = JSON.parse(data);
                if (msg.type === 'text') {
                    const senderName = peers[senderId] ? peers[senderId].name : '未知用户';
                    appendMessage(senderName, msg.content, 'in');
                    showToast(`收到来自 ${senderName} 的消息`);
                }
             } catch(e) {}
        }
    };
    
    channel.onclose = () => {
        console.log('Incoming DataChannel closed');
    };
    
    channel.onerror = (err) => {
        console.error('DataChannel error:', err);
    };
}

// setupReceiverChannel 已被上面的通用函数替代，可以保留为空或者删除
function setupReceiverChannel(channel, type, senderId, fileInfo) {
    // Legacy support or specific logic if needed
    // This function is kept to avoid ReferenceError if it's called from somewhere else,
    // but the main logic is now in handleIncomingChannel.
}


// 验证并请求权限
async function verifyPermission(fileHandle, readWrite) {
    const options = {};
    if (readWrite) {
        options.mode = 'readwrite';
    }
    try {
        // Check if permission was already granted. If so, return true.
        if ((await fileHandle.queryPermission(options)) === 'granted') {
            return true;
        }
        // Request permission. If the user grants permission, return true.
        if ((await fileHandle.requestPermission(options)) === 'granted') {
            return true;
        }
    } catch (e) {
        console.error('Permission check failed:', e);
    }
    // The user did not grant permission, so return false.
    return false;
}

async function saveFile(blobs, fileInfo) {
    const blob = new Blob(blobs, { type: fileInfo.type });

    // 优先使用 File System Access API (如果用户启用了)
    if (downloadDirectoryHandle) {
        try {
            // 1. 净化文件名 (防止非法字符导致 API 报错)
            // Windows 不允许: < > : " / \ | ? *
            const safeName = fileInfo.name.replace(/[<>:"/\\|?*]/g, '_');
            
            // 2. 检查并请求权限
            const hasPermission = await verifyPermission(downloadDirectoryHandle, true);
            if (!hasPermission) {
                throw new Error('用户拒绝了目录写入权限');
            }

            // 获取文件句柄 (create: true 表示创建新文件)
            const fileHandle = await downloadDirectoryHandle.getFileHandle(safeName, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            console.log(`File saved to folder: ${safeName}`);
            return;
        } catch (e) {
            console.error('Auto-save failed, falling back to download:', e);
            // 提示用户自动保存失败，并说明原因
            alert(`自动保存失败 (${e.message})，将转为手动保存。`);
            
            // 如果是因为句柄失效（例如刷新页面后），可能需要重置句柄
            // 但为了不打扰用户，这里暂时不重置，只是回退
        }
    }

    // 回退方案：传统下载
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileInfo.name;
    a.click();
    
    // 清理
    setTimeout(() => {
        URL.revokeObjectURL(url);
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

// --- IndexedDB Helpers ---
const DB_NAME = 'LocalDropDB';
const STORE_NAME = 'settings';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
    });
}

async function saveDirectoryHandleToDB(handle) {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.put(handle, 'downloadHandle');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch (e) {
        console.error('Failed to save handle to DB:', e);
    }
}

async function getDirectoryHandleFromDB() {
    try {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.get('downloadHandle');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        console.error('Failed to get handle from DB:', e);
        return null;
    }
}

// Initialize on load
(async () => {
    try {
        const handle = await getDirectoryHandleFromDB();
        if (handle) {
            downloadDirectoryHandle = handle;
            // Update button UI to indicate a folder is remembered but needs verification
            if (typeof updateDownloadBtnState === 'function') {
                // Check if we already have permission (sometimes persists in same session or trusted sites)
                // verifyPermission(handle, false) doesn't trigger prompt usually? 
                // Actually 'readwrite' prompt is always required unless recently granted.
                // Let's verify 'read' first? No, we need write.
                // Just set to pending state.
                updateDownloadBtnState('pending');
            }
        }
    } catch (e) {
        console.log('No saved directory handle or IDB error:', e);
    }
})();
