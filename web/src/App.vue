<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'

// ─── State ───
const health = ref('checking')  // checking | healthy | unhealthy
const busy = ref(false)
const currentAction = ref('')
const termTitle = ref('输出终端')
const termLines = ref([])
const termRef = ref(null)
const lastExitCode = ref(null)
const runtime = ref({
  image: 'alpine/openclaw',
  adminPort: '3000',
  gatewayPort: '18789',
  bridgePort: '18790',
  gatewayToken: '',
  installed: false,
  gatewayUrl: 'http://127.0.0.1:18789/',
  gatewayUrlWithToken: 'http://127.0.0.1:18789/',
  healthUrl: 'http://127.0.0.1:18789/health',
})

// Logs
const logsActive = ref(false)
let logSource = null

// Modals
const showChannelModal = ref(false)
const showPairModal = ref(false)
const channelForm = ref({ platform: 'telegram', token: '', appToken: '' })
const pairForm = ref({ platform: 'telegram', code: '' })

let healthTimer = null

// ─── Health Check ───
async function checkHealth() {
  try {
    const r = await fetch('/api/health')
    const data = await r.json()
    health.value = data.healthy ? 'healthy' : 'unhealthy'
  } catch {
    health.value = 'unhealthy'
  }
}

async function fetchRuntimeMeta() {
  try {
    const r = await fetch('/api/meta')
    if (!r.ok) return
    const data = await r.json()
    runtime.value = data
  } catch {}
}

// ─── Terminal ───
function appendTerm(text, type = 'stdout') {
  termLines.value.push({ text, type })
  nextTick(() => {
    if (termRef.value) termRef.value.scrollTop = termRef.value.scrollHeight
  })
}

function clearTerm() {
  termLines.value = []
}

function handleSSEMessage(msg) {
  if (msg.type === 'stdout') appendTerm(msg.data, 'stdout')
  else if (msg.type === 'stderr') appendTerm(msg.data, 'stderr')
  else if (msg.type === 'exit') {
    const code = msg.data.code
    lastExitCode.value = code
    appendTerm(`\n[退出码: ${code}]\n`, code === 0 ? 'success' : 'error')
  } else if (msg.type === 'error') {
    appendTerm(`\n错误: ${msg.data}\n`, 'error')
  }
}

function parseSSEEvent(rawEvent) {
  for (const line of rawEvent.split('\n')) {
    if (!line.startsWith('data: ')) continue
    try {
      const msg = JSON.parse(line.slice(6))
      handleSSEMessage(msg)
    } catch {}
  }
}

// ─── Run Action ───
async function exec(action, method = 'POST', body = null) {
  if (busy.value) return
  if (logsActive.value) stopLogs()

  lastExitCode.value = null
  busy.value = true
  currentAction.value = action
  clearTerm()
  termTitle.value = actionLabels[action] || action
  appendTerm(`>>> ${actionLabels[action] || action}\n`, 'info')

  try {
    const opts = { method }
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' }
      opts.body = JSON.stringify(body)
    }

    const response = await fetch(`/api/${action}`, opts)
    if (!response.ok) {
      throw new Error(`请求失败 (${response.status})`)
    }
    if (!response.body) {
      throw new Error('服务器未返回可读取的流')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const events = pending.split('\n\n')
      pending = events.pop() || ''
      for (const event of events) parseSSEEvent(event)
    }

    pending += decoder.decode()
    if (pending.trim()) {
      parseSSEEvent(pending)
    }

    if (lastExitCode.value === 0 && ['install', 'start', 'restart', 'update'].includes(action)) {
      appendTerm('\n=== 下一步建议 ===\n', 'success')
      appendTerm(`OpenClaw 控制台(推荐): ${runtime.value.gatewayUrlWithToken}\n`, 'info')
      appendTerm(`OpenClaw 控制台(不带 token): ${runtime.value.gatewayUrl}\n`, 'info')
      appendTerm(`健康检查地址: ${runtime.value.healthUrl}\n`, 'info')
      appendTerm('若看到 "unauthorized: gateway token missing"，请用上面的推荐链接重新打开一次。\n', 'warning')
      appendTerm('你可以继续执行「状态检查」或开启「实时日志」确认运行情况。\n', 'info')
    }
    if (lastExitCode.value === 0 && action === 'channel/add') {
      appendTerm('\n频道插件已启用，Gateway 已重启。\n', 'success')
      appendTerm(`请打开控制台继续配置频道: ${runtime.value.gatewayUrlWithToken}\n`, 'info')
      appendTerm('若 Telegram 页面之前显示 "Channel config schema unavailable"，刷新后应恢复。\n', 'info')
    }
  } catch (err) {
    appendTerm(`\n连接错误: ${err.message}\n`, 'error')
  } finally {
    busy.value = false
    currentAction.value = ''
    fetchRuntimeMeta()
    checkHealth()
  }
}

const actionLabels = {
  install: '首次安装',
  start: '启动服务',
  stop: '停止服务',
  restart: '重启服务',
  update: '更新镜像',
  backup: '备份数据',
  status: '状态检查',
  doctor: 'Doctor 诊断',
  'pairing/approve-pending': '批准待处理设备配对',
}

const recommendation = computed(() => {
  if (busy.value) {
    return {
      tone: 'working',
      stateLabel: '执行中',
      title: '正在处理命令',
      description: `当前任务：${actionLabels[currentAction.value] || currentAction.value || '处理中'}`,
      button: '请等待当前任务结束',
      action: null,
      method: 'POST',
    }
  }

  if (health.value === 'checking') {
    return {
      tone: 'checking',
      stateLabel: '检测中',
      title: '正在检查服务状态',
      description: '页面会根据当前运行状态自动推荐下一步操作。',
      button: '等待状态检测完成',
      action: null,
      method: 'POST',
    }
  }

  if (health.value !== 'healthy') {
    if (runtime.value.installed) {
      return {
        tone: 'warning',
        stateLabel: '待启动',
        title: '检测到你已安装，但当前服务未运行',
        description: '建议先点「一键启动服务」，启动后再查看日志或接入频道。',
        button: '一键启动服务',
        action: 'start',
        method: 'POST',
      }
    }
    return {
      tone: 'warning',
      stateLabel: '首次使用',
      title: '看起来你还没有完成初始化',
      description: '建议先点「一键首次安装」，系统会自动创建目录、拉镜像并启动 Gateway。',
      button: '一键首次安装',
      action: 'install',
      method: 'POST',
    }
  }

  return {
    tone: 'healthy',
    stateLabel: '可使用',
    title: 'OpenClaw 已就绪',
    description: '现在可以直接打开控制台，或按场景手册选择你的使用路径。',
    button: '做一次状态检查',
    action: 'status',
    method: 'GET',
  }
})

function runRecommendation() {
  const rec = recommendation.value
  if (!rec.action) return
  exec(rec.action, rec.method)
}

// ─── Logs ───
function toggleLogs() {
  logsActive.value ? stopLogs() : startLogs()
}

function startLogs() {
  if (busy.value) return
  clearTerm()
  termTitle.value = '实时日志'
  appendTerm('>>> 开始接收日志...\n', 'info')
  logsActive.value = true

  const es = new EventSource('/api/logs')
  logSource = es
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      handleSSEMessage(msg)
    } catch {}
  }
  es.onerror = () => stopLogs()
}

function stopLogs() {
  if (logSource) { logSource.close(); logSource = null }
  logsActive.value = false
  appendTerm('\n>>> 日志已停止\n', 'info')
}

// ─── Channel ───
function submitChannel() {
  const { platform, token, appToken } = channelForm.value
  if (!token.trim()) return
  showChannelModal.value = false
  const body = { channel: platform, token: token.trim() }
  if (appToken.trim()) body.appToken = appToken.trim()
  exec('channel/add', 'POST', body)
  channelForm.value = { platform: 'telegram', token: '', appToken: '' }
}

// ─── Pair ───
function submitPair() {
  const { platform, code } = pairForm.value
  if (!code.trim()) return
  showPairModal.value = false
  exec('pair', 'POST', { platform, code: code.trim() })
  pairForm.value = { platform: 'telegram', code: '' }
}

// ─── Lifecycle ───
onMounted(() => {
  fetchRuntimeMeta()
  checkHealth()
  healthTimer = setInterval(checkHealth, 30000)
})
onUnmounted(() => {
  clearInterval(healthTimer)
  if (logSource) logSource.close()
})
</script>

<template>
  <div class="app">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <h1 class="logo">OpenClaw</h1>
        <span class="subtitle">管理面板</span>
      </div>
      <div class="status-badge" :class="health">
        <span class="status-dot"></span>
        <span v-if="health === 'checking'">检查中</span>
        <span v-else-if="health === 'healthy'">运行中</span>
        <span v-else>已停止</span>
      </div>
    </header>

    <section class="guide">
      <div class="guide-title-row">
        <h2>使用指引</h2>
        <span class="guide-chip">当前镜像: {{ runtime.image }}</span>
      </div>
      <p class="guide-text">1. 第一次使用先点击「首次安装」。</p>
      <p class="guide-text">2. 安装完成后点击「状态检查」或「实时日志」确认服务正常。</p>
      <p class="guide-text">3. 如果要接入 Telegram/Slack/Discord，先「添加频道」再「配对平台」。</p>
      <p class="guide-text">4. 进入 OpenClaw 时优先使用「带 token」入口，避免 Chat 显示 unauthorized。</p>
      <p class="guide-text">5. 若 Chat 显示 pairing required，可点下面的「修复配对」。</p>
      <p class="guide-text">6. 若 Telegram 页面提示 schema unavailable，先在这里点「添加频道」启用插件。</p>
      <div class="guide-links">
        <a class="guide-link" :href="runtime.gatewayUrlWithToken" target="_blank" rel="noopener">打开 OpenClaw 控制台（带 token）</a>
        <a class="guide-link" :href="runtime.gatewayUrl" target="_blank" rel="noopener">打开 OpenClaw 控制台</a>
        <a class="guide-link" :href="runtime.healthUrl" target="_blank" rel="noopener">查看健康检查</a>
        <a class="guide-link guide-link-soft" href="/scenarios.html" target="_blank" rel="noopener">新手场景手册</a>
      </div>
      <div class="guide-meta">
        <span>Gateway 端口: {{ runtime.gatewayPort }}</span>
        <span>Bridge 端口: {{ runtime.bridgePort }}</span>
        <span>Admin 端口: {{ runtime.adminPort }}</span>
      </div>
    </section>

    <section class="quickstart" :class="'quickstart-' + recommendation.tone">
      <div class="quickstart-head">
        <h2>新手快速入口</h2>
        <span class="quickstart-tag">{{ recommendation.stateLabel }}</span>
      </div>
      <p class="quickstart-title">{{ recommendation.title }}</p>
      <p class="quickstart-text">{{ recommendation.description }}</p>
      <div class="quickstart-actions">
        <button class="btn btn-accent" :disabled="busy || !recommendation.action" @click="runRecommendation">
          {{ recommendation.button }}
        </button>
        <button class="btn btn-default" :disabled="busy" @click="exec('status', 'GET')">
          状态检查
        </button>
        <a class="guide-link guide-link-soft" href="/scenarios.html" target="_blank" rel="noopener">
          查看场景手册
        </a>
      </div>
    </section>

    <!-- Dashboard Cards -->
    <main class="main">
      <div class="cards">
        <!-- 服务控制 -->
        <div class="card">
          <div class="card-icon">&#9881;</div>
          <h2>服务控制</h2>
          <p class="card-desc">管理 OpenClaw 服务的运行状态</p>
          <div class="btn-group">
            <button class="btn btn-success" :disabled="busy" @click="exec('start')">
              <span class="btn-icon">&#9654;</span> 启动
            </button>
            <button class="btn btn-danger" :disabled="busy" @click="exec('stop')">
              <span class="btn-icon">&#9632;</span> 停止
            </button>
            <button class="btn btn-warning" :disabled="busy" @click="exec('restart')">
              <span class="btn-icon">&#8635;</span> 重启
            </button>
          </div>
        </div>

        <!-- 部署管理 -->
        <div class="card">
          <div class="card-icon">&#128230;</div>
          <h2>部署管理</h2>
          <p class="card-desc">安装、更新和备份 OpenClaw（切换镜像后点「更新镜像」）</p>
          <div class="btn-group">
            <button class="btn btn-accent" :disabled="busy" @click="exec('install')">
              首次安装
            </button>
            <button class="btn btn-accent" :disabled="busy" @click="exec('update')">
              更新镜像
            </button>
            <button class="btn btn-default" :disabled="busy" @click="exec('backup')">
              备份数据
            </button>
          </div>
        </div>

        <!-- 诊断工具 -->
        <div class="card">
          <div class="card-icon">&#128269;</div>
          <h2>诊断工具</h2>
          <p class="card-desc">检查服务状态和运行环境</p>
          <div class="btn-group">
            <button class="btn btn-default" :disabled="busy" @click="exec('status', 'GET')">
              状态检查
            </button>
            <button class="btn btn-default" :disabled="busy" @click="exec('doctor')">
              Doctor
            </button>
            <button class="btn btn-default" :disabled="busy" @click="exec('pairing/approve-pending')">
              修复配对
            </button>
            <button class="btn" :class="logsActive ? 'btn-danger' : 'btn-default'"
                    :disabled="busy && !logsActive" @click="toggleLogs()">
              {{ logsActive ? '停止日志' : '实时日志' }}
            </button>
          </div>
        </div>

        <!-- 频道管理 -->
        <div class="card">
          <div class="card-icon">&#128172;</div>
          <h2>频道管理</h2>
          <p class="card-desc">连接 Telegram / Slack / Discord（自动启用插件并重启 Gateway）</p>
          <div class="btn-group">
            <button class="btn btn-default" :disabled="busy" @click="showChannelModal = true">
              添加频道
            </button>
            <button class="btn btn-default" :disabled="busy" @click="showPairModal = true">
              配对平台
            </button>
          </div>
        </div>
      </div>

      <!-- Terminal -->
      <div class="terminal-container">
        <div class="terminal-bar">
          <div class="terminal-dots">
            <span class="dot dot-red"></span>
            <span class="dot dot-yellow"></span>
            <span class="dot dot-green"></span>
          </div>
          <span class="terminal-title">{{ termTitle }}</span>
          <button class="btn-clear" @click="clearTerm">清空</button>
        </div>
        <div class="terminal" ref="termRef">
          <span v-for="(item, i) in termLines" :key="i" :class="'t-' + item.type">{{ item.text }}</span>
          <span v-if="termLines.length === 0" class="t-muted">等待操作...</span>
        </div>
      </div>
    </main>

    <!-- Channel Modal -->
    <Teleport to="body">
      <div class="modal-overlay" v-if="showChannelModal" @click.self="showChannelModal = false">
        <div class="modal">
          <h3>添加频道</h3>
          <div class="form-group">
            <label>平台</label>
            <select v-model="channelForm.platform">
              <option value="telegram">Telegram</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
            </select>
          </div>
          <div class="form-group">
            <label>Bot Token</label>
            <input v-model="channelForm.token" type="text" placeholder="输入 Bot Token" />
          </div>
          <div class="form-group" v-if="channelForm.platform === 'slack'">
            <label>App Token (Slack 专用)</label>
            <input v-model="channelForm.appToken" type="text" placeholder="xapp-..." />
          </div>
          <div class="modal-actions">
            <button class="btn btn-default" @click="showChannelModal = false">取消</button>
            <button class="btn btn-accent" @click="submitChannel">添加</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Pair Modal -->
    <Teleport to="body">
      <div class="modal-overlay" v-if="showPairModal" @click.self="showPairModal = false">
        <div class="modal">
          <h3>配对平台</h3>
          <div class="form-group">
            <label>平台</label>
            <select v-model="pairForm.platform">
              <option value="telegram">Telegram</option>
              <option value="slack">Slack</option>
              <option value="discord">Discord</option>
            </select>
          </div>
          <div class="form-group">
            <label>配对码</label>
            <input v-model="pairForm.code" type="text" placeholder="输入配对码"
                   @keyup.enter="submitPair" />
          </div>
          <div class="modal-actions">
            <button class="btn btn-default" @click="showPairModal = false">取消</button>
            <button class="btn btn-accent" @click="submitPair">配对</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.app {
  max-width: 1000px;
  margin: 0 auto;
  padding: 24px 20px 40px;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 32px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.header-left { display: flex; align-items: baseline; gap: 10px; }
.logo {
  font-size: 26px;
  font-weight: 800;
  background: linear-gradient(135deg, var(--accent) 0%, var(--accent-hover) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.subtitle { font-size: 14px; color: var(--text-muted); }

.guide {
  margin-bottom: 20px;
  padding: 16px 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
}
.guide-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.guide-title-row h2 {
  font-size: 16px;
  font-weight: 700;
}
.guide-chip {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
}
.guide-text {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  line-height: 1.5;
}
.guide-links {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.guide-link {
  display: inline-flex;
  align-items: center;
  padding: 6px 12px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent);
  color: var(--accent);
  text-decoration: none;
  font-size: 13px;
  font-weight: 600;
}
.guide-link:hover {
  background: rgba(15, 118, 110, 0.08);
}
.guide-link-soft {
  border-color: var(--border);
  color: var(--text-secondary);
}
.guide-link-soft:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.guide-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}

.quickstart {
  margin-bottom: 20px;
  padding: 16px 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-secondary);
}
.quickstart-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.quickstart-head h2 {
  font-size: 16px;
  font-weight: 700;
}
.quickstart-tag {
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
}
.quickstart-title {
  font-size: 15px;
  font-weight: 700;
  margin-bottom: 4px;
}
.quickstart-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.quickstart-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}
.quickstart-warning {
  border-color: rgba(234, 179, 8, 0.45);
  background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(234, 179, 8, 0.08) 100%);
}
.quickstart-warning .quickstart-tag {
  color: #8a6500;
  border-color: rgba(234, 179, 8, 0.35);
  background: var(--warning-bg);
}
.quickstart-healthy {
  border-color: rgba(34, 197, 94, 0.45);
  background: linear-gradient(180deg, var(--bg-secondary) 0%, rgba(34, 197, 94, 0.08) 100%);
}
.quickstart-healthy .quickstart-tag {
  color: #1c7d43;
  border-color: rgba(34, 197, 94, 0.35);
  background: var(--success-bg);
}
.quickstart-working,
.quickstart-checking {
  background: linear-gradient(180deg, var(--bg-secondary) 0%, var(--bg-tertiary) 100%);
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border);
  background: var(--bg-secondary);
  transition: all 0.3s;
}
.status-badge.healthy { border-color: var(--success); background: var(--success-bg); }
.status-badge.unhealthy { border-color: var(--danger); background: var(--danger-bg); }

.status-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  transition: all 0.3s;
}
.status-badge.healthy .status-dot { background: var(--success); box-shadow: 0 0 8px var(--success); }
.status-badge.unhealthy .status-dot { background: var(--danger); box-shadow: 0 0 8px var(--danger); }
.status-badge.checking .status-dot { background: var(--warning); animation: pulse 1.2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

/* ── Cards ── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 20px;
  transition: border-color 0.2s, transform 0.2s;
}
.card:hover { border-color: var(--border-hover); transform: translateY(-1px); }
.card-icon { font-size: 24px; margin-bottom: 10px; }
.card h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.card-desc { font-size: 13px; color: var(--text-muted); margin-bottom: 16px; line-height: 1.4; }

.btn-group { display: flex; flex-wrap: wrap; gap: 8px; }

/* ── Buttons ── */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}
.btn:hover { background: var(--border); }
.btn:active { transform: scale(0.97); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
.btn-icon { font-size: 11px; }

.btn-accent { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-accent:hover { background: var(--accent-hover); }
.btn-success { background: rgba(34,197,94,0.15); border-color: var(--success); color: var(--success); }
.btn-success:hover { background: rgba(34,197,94,0.25); }
.btn-danger { background: rgba(239,68,68,0.15); border-color: var(--danger); color: var(--danger); }
.btn-danger:hover { background: rgba(239,68,68,0.25); }
.btn-warning { background: rgba(234,179,8,0.15); border-color: var(--warning); color: var(--warning); }
.btn-warning:hover { background: rgba(234,179,8,0.25); }
.btn-default { background: var(--bg-tertiary); border-color: var(--border); }

/* ── Terminal ── */
.terminal-container {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.terminal-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border);
}
.terminal-dots { display: flex; gap: 6px; }
.dot { width: 12px; height: 12px; border-radius: 50%; }
.dot-red { background: #ff5f57; }
.dot-yellow { background: #febc2e; }
.dot-green { background: #28c840; }
.terminal-title { flex: 1; font-size: 13px; color: var(--text-secondary); }
.btn-clear {
  padding: 3px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
}
.btn-clear:hover { color: var(--text-primary); border-color: var(--border-hover); }

.terminal {
  padding: 16px;
  height: 340px;
  overflow-y: auto;
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace;
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}
.t-stdout { color: var(--text-primary); }
.t-stderr { color: var(--warning); }
.t-info { color: var(--accent-hover); }
.t-warning { color: #b36b00; }
.t-error { color: var(--danger); }
.t-success { color: var(--success); }
.t-muted { color: var(--text-muted); font-style: italic; }

/* ── Modal ── */
.modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  animation: fadeIn 0.15s;
}
@keyframes fadeIn { from { opacity: 0; } }

.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 28px;
  width: 420px;
  max-width: 90vw;
  animation: slideUp 0.2s;
}
@keyframes slideUp { from { opacity: 0; transform: translateY(10px); } }

.modal h3 { font-size: 18px; font-weight: 600; margin-bottom: 20px; }
.form-group { margin-bottom: 16px; }
.form-group label {
  display: block;
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}
.form-group input,
.form-group select {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}
.form-group input:focus,
.form-group select:focus { border-color: var(--accent); }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 24px; }

/* ── Responsive ── */
@media (max-width: 640px) {
  .app { padding: 16px 12px 32px; }
  .header { flex-direction: column; align-items: flex-start; gap: 12px; }
  .logo { font-size: 22px; }
  .guide-title-row { flex-direction: column; align-items: flex-start; }
  .quickstart-head { flex-direction: column; align-items: flex-start; }
  .cards { grid-template-columns: 1fr; }
  .terminal { height: 260px; }
}
</style>
