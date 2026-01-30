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
let connections = {}; // 存储所有的 PeerConnections (Key: peerId, Value: { pc, ... })
let activeConnection = null; // 指向当前 UI 聚焦或最近使用的连接 (Legacy & UI Helper)
let pendingCandidates = {}; // 暂存未建立连接时的 ICE Candidates (Key: peerId, Value: array)

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
        document.getElementById('network-id').textContent = myIp;
        myNameEl.innerHTML = `${myName} <span class="text-blue-400">(在线)</span>`;

        // 2. 连接 MQTT
        connectMqtt();

    } catch (e) {
        console.error('Init failed:', e);
        myNameEl.textContent = '初始化失败，请刷新重试';
        document.getElementById('network-id').textContent = '获取 ID 失败';
    }
}

function updateConnectionStatus(status) {
    const statusText = document.getElementById('connection-status');
    const indicator = document.getElementById('connection-indicator');
    
    if (!statusText || !indicator) return;

    // Reset indicator classes but keep base ones
    const baseClasses = isMobile ? 'w-1.5 h-1.5 rounded-full pulse-animation' : 'w-2 h-2 rounded-full pulse-animation';
    indicator.className = baseClasses;
    
    if (status === 'connected') {
        statusText.textContent = '服务已连接';
        indicator.classList.add('bg-green-500');
    } else if (status === 'connecting') {
        statusText.textContent = '连接服务器...';
        indicator.classList.add('bg-yellow-500');
    } else if (status === 'error') {
        statusText.textContent = '服务错误';
        indicator.classList.add('bg-red-500');
    } else {
        statusText.textContent = '服务断开';
        indicator.classList.add('bg-slate-500');
    }
}

function connectMqtt() {
    const clientId = 'localdrop_' + Math.random().toString(16).substr(2, 8);
    updateConnectionStatus('connecting');
    
    mqttClient = mqtt.connect(MQTT_BROKER, {
        clientId: clientId
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT Broker');
        updateConnectionStatus('connected');
        
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
        updateConnectionStatus('error');
    });

    mqttClient.on('offline', () => {
        updateConnectionStatus('offline');
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
    peersContainer.innerHTML = '';
    
    users.forEach(user => {
        if (user.id === myId) return; // 不显示本机

        const peerEl = document.createElement('div');
        
        // Generate color for the icon
        const color = getDeviceColor(user.name); // returns HSL
        const bgStyle = color.replace('60%)', '20%)');

        if (isMobile) {
            // Mobile Style (Glass Morphism)
            peerEl.className = `glass-morphism p-4 rounded-2xl flex items-center active:scale-95 transition-transform mb-3 border border-transparent hover:border-blue-500/30`;
            peerEl.innerHTML = `
                <div class="w-12 h-12 rounded-xl flex items-center justify-center mr-4" style="background-color: ${bgStyle}; color: ${color}">
                    <i class="fas fa-mobile-screen text-xl"></i>
                </div>
                <div class="flex-grow">
                    <div class="font-bold text-sm">${user.name} ${user.name === myName ? '(本机)' : ''}</div>
                    <div class="text-[10px] text-slate-500">${user.id || 'Unknown ID'}</div>
                </div>
                <button class="w-10 h-10 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center active:scale-90 transition-transform" onclick="event.stopPropagation(); initiateTextChat('${user.id}')">
                    <i class="fas fa-comment-dots"></i>
                </button>
            `;
            // Note: Shared onclick below handles the file transfer trigger
            
        } else {
            // Desktop Style
            peerEl.className = 'flex items-center p-4 bg-white/5 rounded-2xl border border-transparent hover:border-blue-500/50 cursor-pointer transition-all mb-3';
            
            // Inner HTML structure
            peerEl.innerHTML = `
                <div class="w-12 h-12 rounded-xl flex items-center justify-center mr-4" style="background-color: ${bgStyle}; color: ${color}">
                    <i class="fas fa-mobile-alt text-xl"></i>
                </div>
                <div class="flex-grow">
                    <div class="font-bold text-sm text-slate-200">${user.name} ${user.name === myName ? '(本机)' : ''}</div>
                    <div class="text-xs text-slate-500">${user.id || 'Unknown ID'}</div>
                </div>
                <i class="fas fa-chevron-right text-slate-600 text-xs"></i>
            `;
        }

        // Long press / Click logic
        let pressTimer;
        let isLongPress = false;
        
        const startPress = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return; 
            isLongPress = false;
            pressTimer = setTimeout(() => {
                isLongPress = true;
                // Vibration feedback if supported
                if (navigator.vibrate) navigator.vibrate(50);
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
            if (!isLongPress) {
                initiateFileTransfer(user.id);
            }
        };
        
        peersContainer.appendChild(peerEl);
    });

    if (users.length === 0) {
        if (isMobile) {
            peersContainer.innerHTML = `
                <div class="border-2 border-dashed border-white/5 rounded-2xl p-6 flex flex-col items-center justify-center text-slate-600 scanning-pulse">
                    <i class="fas fa-user-plus text-xl mb-2 opacity-20"></i>
                    <p class="text-[10px]">等待其他设备加入局域网</p>
                </div>
            `;
        } else {
            peersContainer.innerHTML = `
                <div class="flex items-center justify-center p-8 border-2 border-dashed border-white/5 rounded-2xl scanning-pulse">
                    <div class="text-center">
                        <div class="inline-block animate-spin rounded-full h-4 w-4 border-2 border-blue-500 border-t-transparent mb-2"></div>
                        <p class="text-xs text-slate-500">发现同一局域网下的设备...</p>
                    </div>
                </div>
            `;
        }
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

function handleMobileSend() {
    if (selectedPeerId) {
        fileInput.click();
    } else {
        // If there's only one peer, auto-select and send?
        const users = Object.values(peers).filter(u => u.id !== myId);
        if (users.length === 1) {
            selectedPeerId = users[0].id;
            renderPeers();
            fileInput.click();
        } else {
            alert('请先选择一个设备');
        }
    }
}

function selectPeer(peerId) {
    selectedPeerId = peerId;
    renderPeers();
}

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

let lastMessage = { content: null, time: 0, sender: null };

function appendMessage(senderName, content, type) {
    // 简单的去重逻辑 (防止同一条消息显示两次)
    const now = Date.now();
    if (type === 'in' && 
        lastMessage.content === content && 
        lastMessage.sender === senderName && 
        now - lastMessage.time < 2000) {
        console.log('Duplicate message ignored:', content);
        return;
    }
    
    if (type === 'in') {
        lastMessage = { content, time: now, sender: senderName };
    }

    const contentEl = document.getElementById('text-content');
    
    // 如果是第一条消息，或者之前的消息被清空了，可能需要重置？
    // 这里我们简单地追加
    
    const msgDiv = document.createElement('div');
    msgDiv.style.marginBottom = '8px';
    msgDiv.style.padding = '8px';
    msgDiv.style.borderRadius = '4px';
    msgDiv.style.wordBreak = 'break-word';
    
    if (type === 'in') {
        msgDiv.style.backgroundColor = '#444';
        msgDiv.innerHTML = `<strong style="color: #aaa; font-size: 0.8em;">${senderName}:</strong><br>${content}`;
    } else {
        msgDiv.style.backgroundColor = '#1e3a29';
        msgDiv.style.textAlign = 'right';
        msgDiv.innerHTML = `<strong style="color: #4caf50; font-size: 0.8em;">我:</strong><br>${content}`;
    }
    
    contentEl.appendChild(msgDiv);
    contentEl.scrollTop = contentEl.scrollHeight;
    
    if (type === 'in') {
        showDialog(receiveTextDialog);
    }
}

// 队列处理函数
async function processQueue() {
    if (isTransferring || transferQueue.length === 0) return;
    
    isTransferring = true;
    const item = transferQueue.shift();
    const { peerId, file } = item;
    
    // 将批次信息附加到文件对象上，以便传递给 setupSenderChannel
    if (item.batchIndex) file.batchIndex = item.batchIndex;
    if (item.batchTotal) file.batchTotal = item.batchTotal;
    
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
    
    const total = files.length;
    files.forEach((file, index) => {
        transferQueue.push({ 
            peerId: selectedPeerId, 
            file,
            batchIndex: index + 1,
            batchTotal: total
        });
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
    
    // Update connections map
    connections[peerId] = activeConnection;

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
                 fileType: data.type,
                 batchIndex: data.batchIndex,
                 batchTotal: data.batchTotal
             };
             channel.send(JSON.stringify(meta));

             console.log('Metadata sent, waiting for ACK...');
             
             const handleMessage = (event) => {
                 try {
                     const msg = JSON.parse(event.data);
                     if (msg.type === 'ack-transfer') {
                         console.log('Received ACK, starting transfer...');
                         channel.removeEventListener('message', handleMessage);
                         
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
                     }
                 } catch (e) {}
             };
             
             channel.addEventListener('message', handleMessage);

        } else {
             // 文字聊天也可以发送个 meta，或者直接发内容
             // 之前的逻辑是直接发内容 { type: 'text', content: ... }
             // 保持不变，接收端根据 type 判断
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

// 接收队列
let receiveQueue = [];
let isReceivingFile = false; // 是否正在接收文件
let receivingFromId = null; // 当前正在接收的来源 ID

async function handleOffer(msg) {
    console.log(`Handle Offer from ${msg.sender}`);

    // 不再检查 busy 状态，总是建立连接以维持网络拓扑
    // 真正的文件传输排队逻辑已移至 handleIncomingChannel (基于 DataChannel 协议)
    
    if (msg.transferType === 'text') {
        // 文字聊天
        await acceptTransfer(msg);
        return;
    }

    pendingOffer = msg;
    if (pendingCandidates[msg.sender]) pendingCandidates[msg.sender] = []; 
    
    // 标记为正在接收 (legacy logic, keep for safety but rely on receivingFromId for queue)
    isReceivingFile = true;
    
    // 自动接收，建立连接
    console.log(`Auto accepting connection from ${peers[msg.sender]?.name}`);
    await acceptTransfer(msg);
}

// 处理接收队列
async function processReceiveQueue() {
    if (receiveQueue.length === 0) {
        isReceivingFile = false;
        // Do NOT clear receivingFromId here unconditionally.
        // It should be cleared by the transfer completion logic.
        return;
    }
    
    const item = receiveQueue.shift();
    console.log('Processing queued transfer from', item.senderId);
    
    if (item.resolve) {
        // 唤醒挂起的 handleIncomingChannel
        item.resolve();
    } else {
        // 兼容旧逻辑 (虽然理论上不会走到这里了)
        console.warn('Unknown queue item:', item);
        processReceiveQueue(); // Skip
    }
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
const downloadDirBtn = document.getElementById('download-dir-btn');
const downloadDirText = document.getElementById('download-dir-text');

// 封装按钮状态更新函数
function updateDownloadBtnState(state) {
    let folderName = downloadDirectoryHandle ? downloadDirectoryHandle.name : '';
    
    if (state === 'active') {
        downloadDirText.textContent = `自动保存到: "${folderName}"`;
        downloadDirText.classList.remove('text-amber-200/70');
        downloadDirText.classList.add('text-green-400');
        
        downloadDirBtn.textContent = '修改';
        downloadDirBtn.classList.remove('text-amber-500', 'hover:text-amber-400');
        downloadDirBtn.classList.add('tgree到n-500', 'hover:text-green-400');
    } else if (state === 'pending') {
        downloadDirText.textContent = `点击恢复自动保存: "${folderName}"`;
        downloadDirText.classList.add('text-amber-200/70');
        downloadDirText.classList.remove('text-green-400');
        
        downloadDirBtn.textContent = '恢复';
    } else {
        downloadDirText.textContent = `自动保存: (未启用)`;
        downloadDirText.classList.add('text-amber-200/70');
        downloadDirText.classList.remove('text-green-400');
        
        downloadDirBtn.textContent = '启用';
    }
}

downloadDirBtn.onclick = async () => {
    try {
        let handleToUse = downloadDirectoryHandle;
        let isChangeRequest = false;

        // 1. 如果当前已启用（active 或 pending 且有 handle），询问是否更改
        // 注意：这里逻辑稍微调整，只要点击修改，且已经有 active 状态，就视为更改
        if (handleToUse && downloadDirBtn.textContent === '修改') {
            if (confirm('是否更改保存文件夹？\n点击“确定”选择新文件夹，点击“取消”保持不变。')) {
                isChangeRequest = true;
                handleToUse = null; // 标记为需要新句柄
            } else {
                return; // 用户取消
            }
        }

        // 2. 如果有句柄且不是更改请求（即“恢复权限”场景），尝试验证
        if (handleToUse && !isChangeRequest) {
             const hasPermission = await verifyPermission(handleToUse, true);
             if (hasPermission) {
                 await saveDirectoryHandleToDB(handleToUse); // 刷新 DB
                 updateDownloadBtnState('active');
                 alert('自动保存权限已恢复！');
                 return;
             }
             // 如果验证失败（用户拒绝），继续向下执行，允许重新选择
        }

        // 3. 请求新文件夹（如果是更改请求，或没有句柄，或验证失败）
        const newHandle = await window.showDirectoryPicker({
            mode: 'readwrite'
        });
        
        const hasPermission = await verifyPermission(newHandle, true);
        if (!hasPermission) {
            throw new Error('未获得写入权限');
        }

        // 保存到 DB
        downloadDirectoryHandle = newHandle;
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
// 移除旧的 appendChild
// document.getElementById('my-info').appendChild(downloadDirBtn);


async function acceptTransfer(offerMsg) {
    let pc;
    const senderId = offerMsg.sender;

    // Check existing connection in connections map
    if (connections[senderId] && connections[senderId].pc && 
        (connections[senderId].pc.connectionState === 'connected' || connections[senderId].pc.connectionState === 'connecting')) {
        
        console.log('Reusing existing PeerConnection for sender:', senderId);
        pc = connections[senderId].pc;
        connections[senderId].role = 'receiver';
        
        // Update activeConnection for legacy support
        activeConnection = connections[senderId];
        
    } else {
        console.log('Creating new PeerConnection for:', senderId);
        pc = new RTCPeerConnection(rtcConfig);
        
        // Store in map
        connections[senderId] = { pc, role: 'receiver', peerId: senderId };
        activeConnection = connections[senderId];

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
            handleIncomingChannel(event.channel, senderId);
        };
        
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignalingMessage(senderId, 'candidate', {
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
    const candidates = pendingCandidates[offerMsg.sender];
    if (candidates && candidates.length > 0) {
        console.log(`Adding ${candidates.length} pending candidates from ${offerMsg.sender}`);
        for (const candidate of candidates) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
                console.error('Error adding pending ice candidate', e);
            }
        }
        delete pendingCandidates[offerMsg.sender];
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
                    
                    // 检查是否正忙 (基于 receivingFromId)
                    if (receivingFromId && receivingFromId !== senderId) {
                         console.log(`Receiver is busy (receiving from ${receivingFromId}), queuing transfer from ${senderId}`);
                         showToast(`当前正忙，已将 ${peers[senderId]?.name || '未知用户'} 的传输请求加入队列`);
                         
                         // 挂起 execution，直到 processReceiveQueue 调用 resolve
                         await new Promise(resolve => {
                             receiveQueue.push({ senderId, resolve });
                         });
                         
                         console.log(`Resuming transfer from ${senderId}`);
                    }

                    // 开始接收
                    receivingFromId = senderId;
                    
                    fileInfo = {
                        name: msg.name,
                        size: msg.size,
                        type: msg.fileType,
                        batchIndex: msg.batchIndex,
                        batchTotal: msg.batchTotal
                    };
                    
                    // 发送 ACK 确认
                    channel.send(JSON.stringify({ type: 'ack-transfer' }));

                    // 初始化 UI
                    const indexStr = (fileInfo.batchIndex && fileInfo.batchTotal) ? ` (${fileInfo.batchIndex}/${fileInfo.batchTotal})` : '';
                    showProgressDialog(`正在接收 ${fileInfo.name}${indexStr}...`, 0);
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

                // 检查是否有排队的接收任务
    setTimeout(() => {
        // 仅当当前接收者是自己时，才释放锁
        if (receivingFromId === senderId) {
            console.log('Releasing receiver lock from', senderId);
            receivingFromId = null;
        }
        processReceiveQueue();
    }, 1500); // 稍微延迟，确保UI和清理完成
            }
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
    // Check if we have a connection for this sender
    const conn = connections[msg.sender];
    if (conn && conn.pc) {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (activeConnection && activeConnection.pc && activeConnection.peerId === msg.sender) {
        // Fallback to activeConnection (legacy/sender side)
        await activeConnection.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else {
        console.warn('Received answer for unknown connection:', msg.sender);
    }
}

async function handleCandidate(msg) {
    // Check connection in map first
    const conn = connections[msg.sender];
    if (conn && conn.pc) {
        try {
            await conn.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
            console.error('Error adding received ice candidate (Map)', e);
        }
    } else if (activeConnection && activeConnection.pc && activeConnection.peerId === msg.sender) {
        // Fallback to activeConnection
        try {
            await activeConnection.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } catch (e) {
            console.error('Error adding received ice candidate (Active)', e);
        }
    } else {
        // Buffer if connection not ready
        console.log(`Buffering ICE candidate from ${msg.sender}`);
        if (!pendingCandidates[msg.sender]) pendingCandidates[msg.sender] = [];
        pendingCandidates[msg.sender].push(msg.candidate);
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
