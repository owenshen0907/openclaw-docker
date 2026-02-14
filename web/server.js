const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ─── 路径配置 ───
// Docker 内: PROJECT_DIR=/project, HOST_PROJECT_DIR=宿主机绝对路径
// 本地运行: 都是 web/ 的上一级目录
const RUNNING_IN_DOCKER = Boolean(process.env.PROJECT_DIR);
const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const HOST_DIR = path.resolve(process.env.HOST_PROJECT_DIR || PROJECT_DIR);
const COMPOSE_FILE = path.join(PROJECT_DIR, 'docker-compose.yml');
const ENV_FILE = path.join(PROJECT_DIR, '.env');
const OPENCLAW_CONFIG_FILE = path.join(PROJECT_DIR, 'data/openclaw-config/openclaw.json');
const DEVICES_PENDING_FILE = path.join(PROJECT_DIR, 'data/openclaw-config/devices/pending.json');
const DEVICES_PAIRED_FILE = path.join(PROJECT_DIR, 'data/openclaw-config/devices/paired.json');
const HEALTH_URL = process.env.HEALTH_URL ||
  (RUNNING_IN_DOCKER ? 'http://openclaw-gateway:18789/health' : 'http://127.0.0.1:18789/health');

// 生产模式下提供 Vue 构建产物
app.use(express.static(path.join(__dirname, 'dist')));

// ─── Docker Compose 参数构建 ───
function composeArgs(...args) {
  const base = ['compose', '-f', COMPOSE_FILE, '--env-file', ENV_FILE];
  // 在 Docker 容器内需要用宿主机路径解析 volume 挂载
  if (HOST_DIR !== PROJECT_DIR) {
    base.push('--project-directory', HOST_DIR);
  }
  return [...base, ...args];
}

function composeCliArgs(...args) {
  return composeArgs('--profile', 'cli', ...args);
}

function buildChannelAddCliArgs(channel, token, appToken) {
  const args = ['run', '--rm', 'openclaw-cli', 'channels', 'add', '--channel', channel];
  if (channel === 'slack') {
    args.push('--bot-token', token);
    if (appToken) args.push('--app-token', appToken);
    return args;
  }
  args.push('--token', token);
  return args;
}

function isPortConflictError(text) {
  if (!text) return false;
  return /ports are not available|address already in use|bind: address already in use/i.test(text);
}

// ─── SSE 流式执行命令 ───
function execSSE(res, command, args) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  const proc = spawn(command, args, {
    cwd: PROJECT_DIR,
    shell: false,
    env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
  });

  proc.stdout.on('data', (chunk) => send('stdout', chunk.toString()));
  proc.stderr.on('data', (chunk) => send('stderr', chunk.toString()));

  proc.on('close', (code) => {
    send('exit', { code });
    res.end();
  });

  proc.on('error', (err) => {
    send('error', err.message);
    res.end();
  });

  res.on('close', () => {
    if (proc.exitCode === null) proc.kill('SIGTERM');
  });
}

// ─── SSE 多步骤执行 ───
function execStep(command, args, send) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn(command, args, {
      cwd: PROJECT_DIR,
      shell: false,
      env: { ...process.env, TERM: 'dumb', FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      send('stdout', text);
    });

    proc.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      send('stderr', text);
    });

    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', (err) => {
      const message = err.message || 'unknown error';
      stderr += message;
      send('error', message);
      resolve({ code: -1, stdout, stderr });
    });
  });
}

// ─── 读取 .env 文件 ───
function readEnvFile() {
  try {
    const content = fs.readFileSync(ENV_FILE, 'utf-8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return vars;
  } catch {
    return {};
  }
}

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function hasConfiguredChannel(openclawConfig, channel) {
  const channels = openclawConfig && typeof openclawConfig === 'object' ? openclawConfig.channels : null;
  if (!channels || typeof channels !== 'object') return false;
  const entry = channels[channel];
  return Boolean(entry && typeof entry === 'object');
}

function mergeUniqueStrings(...lists) {
  const out = new Set();
  for (const list of lists) {
    if (!list) continue;
    if (Array.isArray(list)) {
      for (const v of list) {
        const t = String(v || '').trim();
        if (t) out.add(t);
      }
    } else {
      const t = String(list || '').trim();
      if (t) out.add(t);
    }
  }
  return [...out];
}

function approvePendingDevicePairings() {
  const pending = readJsonFile(DEVICES_PENDING_FILE, {});
  const paired = readJsonFile(DEVICES_PAIRED_FILE, {});
  const pendingEntries = Object.entries(pending);

  if (pendingEntries.length === 0) {
    return { approved: 0, remaining: 0 };
  }

  const now = Date.now();
  for (const [requestId, req] of pendingEntries) {
    const existing = paired[req.deviceId] || {};
    const roles = mergeUniqueStrings(existing.roles, existing.role, req.roles, req.role);
    const scopes = mergeUniqueStrings(existing.scopes, req.scopes);

    paired[req.deviceId] = {
      deviceId: req.deviceId,
      publicKey: req.publicKey,
      displayName: req.displayName,
      platform: req.platform,
      clientId: req.clientId,
      clientMode: req.clientMode,
      role: req.role || existing.role,
      roles: roles.length > 0 ? roles : undefined,
      scopes: scopes.length > 0 ? scopes : undefined,
      remoteIp: req.remoteIp,
      tokens: existing.tokens,
      createdAtMs: existing.createdAtMs || now,
      approvedAtMs: now,
    };
    delete pending[requestId];
  }

  writeJsonFile(DEVICES_PAIRED_FILE, paired);
  writeJsonFile(DEVICES_PENDING_FILE, pending);
  return { approved: pendingEntries.length, remaining: Object.keys(pending).length };
}

function upsertEnvValue(key, value) {
  try {
    const line = `${key}=${value}`;
    let content = '';
    if (fs.existsSync(ENV_FILE)) {
      content = fs.readFileSync(ENV_FILE, 'utf-8');
    }
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${line}\n`;
    }
    fs.writeFileSync(ENV_FILE, content);
    return true;
  } catch {
    return false;
  }
}

function ensureGatewayToken(send) {
  const env = readEnvFile();
  const token = env.OPENCLAW_GATEWAY_TOKEN && env.OPENCLAW_GATEWAY_TOKEN.trim();
  if (token) return token;

  const generated = crypto.randomBytes(24).toString('hex');
  if (upsertEnvValue('OPENCLAW_GATEWAY_TOKEN', generated)) {
    if (send) send('stdout', '已自动生成 OPENCLAW_GATEWAY_TOKEN 并写入 .env\n');
    return generated;
  }

  if (send) {
    send('stderr', '警告: 自动写入 OPENCLAW_GATEWAY_TOKEN 失败，请手动在 .env 设置该值\n');
  }
  return generated;
}

function getRuntimeMeta() {
  const env = readEnvFile();
  const gatewayPort = env.OPENCLAW_GATEWAY_PORT || '18789';
  const bridgePort = env.OPENCLAW_BRIDGE_PORT || '18790';
  const adminPort = process.env.ADMIN_PORT || env.ADMIN_PORT || '3000';
  const image = env.OPENCLAW_IMAGE || 'alpine/openclaw';
  const gatewayToken = (env.OPENCLAW_GATEWAY_TOKEN || '').trim();
  const hasConfigDir = fs.existsSync(path.join(PROJECT_DIR, 'data/openclaw-config'));
  const hasWorkspaceDir = fs.existsSync(path.join(PROJECT_DIR, 'data/workspace'));
  const hasOpenClawConfig = fs.existsSync(OPENCLAW_CONFIG_FILE);
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}/`;
  const gatewayUrlWithToken = gatewayToken
    ? `${gatewayUrl}#token=${encodeURIComponent(gatewayToken)}`
    : gatewayUrl;

  return {
    image,
    adminPort,
    gatewayPort,
    bridgePort,
    gatewayToken,
    installed: hasConfigDir || hasWorkspaceDir || hasOpenClawConfig,
    gatewayUrl,
    gatewayUrlWithToken,
    healthUrl: `${gatewayUrl}health`,
  };
}

// ─── 运行时信息（用于前端展示说明和入口地址） ───
app.get('/api/meta', (_req, res) => {
  res.json(getRuntimeMeta());
});

// ─── 健康检查 ───
app.get('/api/health', async (_req, res) => {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    res.json({ healthy: r.ok });
  } catch {
    res.json({ healthy: false });
  }
});

// ─── 状态检查 ───
app.get('/api/status', (req, res) => {
  execSSE(res, 'docker', composeArgs('ps', '-a'));
});

// ─── 首次安装（多步骤） ───
app.post('/api/install', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  try {
    const env = readEnvFile();
    const gatewayToken = ensureGatewayToken(send);
    env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;
    const gatewayPort = env.OPENCLAW_GATEWAY_PORT || '18789';
    const hasTelegramToken = Boolean((env.TELEGRAM_BOT_TOKEN || '').trim());
    const totalSteps = hasTelegramToken ? 6 : 5;

    // Step 1: 校验配置
    send('stdout', `=== [1/${totalSteps}] 校验环境配置 ===\n`);
    if (!env.OPENAI_API_KEY && !env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY) {
      send('stderr', '错误: .env 中未配置任何 AI API Key\n');
      send('stderr', '请在 .env 文件中设置 OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY 之一\n');
      send('exit', { code: 1 });
      return res.end();
    }
    send('stdout', 'API Key 已配置\n');
    if (env.TELEGRAM_BOT_TOKEN) send('stdout', 'Telegram Bot Token 已配置\n');

    // Step 2: 创建目录
    send('stdout', `\n=== [2/${totalSteps}] 创建数据目录 ===\n`);
    const configDir = path.join(PROJECT_DIR, 'data/openclaw-config');
    const workspaceDir = path.join(PROJECT_DIR, 'data/workspace');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    send('stdout', `${configDir}\n${workspaceDir}\n`);

    // Step 3: 写入 API Key 到配置
    send('stdout', `\n=== [3/${totalSteps}] 写入 API 配置 ===\n`);
    let configEnv = '';
    if (env.OPENAI_API_KEY) configEnv += `OPENAI_API_KEY=${env.OPENAI_API_KEY}\n`;
    if (env.ANTHROPIC_API_KEY) configEnv += `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY}\n`;
    if (env.GEMINI_API_KEY) configEnv += `GEMINI_API_KEY=${env.GEMINI_API_KEY}\n`;
    fs.writeFileSync(path.join(configDir, '.env'), configEnv, { mode: 0o600 });
    send('stdout', '配置已写入 data/openclaw-config/.env\n');

    let currentStep = 4;

    if (hasTelegramToken) {
      send('stdout', `\n=== [${currentStep}/${totalSteps}] 配置 Telegram 频道（可选） ===\n`);

      const enableTelegramResult = await execStep(
        'docker',
        composeCliArgs('run', '--rm', 'openclaw-cli', 'plugins', 'enable', 'telegram'),
        send,
      );

      if (enableTelegramResult.code !== 0) {
        send('stderr', '警告: 启用 telegram 插件失败，已跳过自动频道配置\n');
      } else {
        const addTelegramResult = await execStep(
          'docker',
          composeCliArgs(
            ...buildChannelAddCliArgs('telegram', env.TELEGRAM_BOT_TOKEN.trim()),
          ),
          send,
        );
        if (addTelegramResult.code !== 0) {
          send('stderr', '警告: 自动写入 Telegram 配置失败，可在管理面板「添加频道」后重试\n');
        } else {
          send('stdout', 'Telegram 频道已配置\n');
        }
      }
      currentStep += 1;
    }

    // Step 4: 拉取镜像
    send('stdout', `\n=== [${currentStep}/${totalSteps}] 拉取 Docker 镜像 ===\n`);
    const pullResult = await execStep('docker', composeArgs('pull', 'openclaw-gateway'), send);
    if (pullResult.code !== 0) {
      send('exit', { code: pullResult.code });
      return res.end();
    }
    currentStep += 1;

    // Step 5: 启动服务
    send('stdout', `\n=== [${currentStep}/${totalSteps}] 启动 OpenClaw Gateway ===\n`);
    const upResult = await execStep('docker', composeArgs('up', '-d', 'openclaw-gateway'), send);
    if (upResult.code !== 0) {
      if (isPortConflictError(upResult.stderr)) {
        send('stderr', `\n检测到端口冲突：127.0.0.1:${gatewayPort} 已被占用\n`);
        send('stderr', `可先执行: lsof -nP -iTCP:${gatewayPort} -sTCP:LISTEN\n`);
        send('stderr', '处理方式:\n');
        send('stderr', '  1) 停掉占用该端口的进程/容器后重试「首次安装」\n');
        send('stderr', `  2) 或修改 .env 中 OPENCLAW_GATEWAY_PORT 为其它端口，再重试\n`);
      }
      send('exit', { code: upResult.code });
      return res.end();
    }

    // 等待健康检查
    send('stdout', '\n等待服务就绪');
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
        if (r.ok) { healthy = true; break; }
      } catch {}
      send('stdout', '.');
    }
    send('stdout', '\n');

    if (healthy) {
      send('stdout', '\nOpenClaw 安装完成，服务已就绪!\n');
    } else {
      send('stderr', '\n警告: 服务未在 60 秒内就绪，请检查日志\n');
    }

    send('exit', { code: healthy ? 0 : 1 });
  } catch (err) {
    send('error', err.message);
    send('exit', { code: -1 });
  }
  res.end();
});

// ─── 启动 ───
app.post('/api/start', (req, res) => {
  execSSE(res, 'docker', composeArgs('up', '-d', 'openclaw-gateway'));
});

// ─── 停止（仅停止 gateway，不影响 admin） ───
app.post('/api/stop', (req, res) => {
  execSSE(res, 'docker', composeArgs('stop', 'openclaw-gateway'));
});

// ─── 重启 ───
app.post('/api/restart', (req, res) => {
  execSSE(res, 'docker', composeArgs('restart', 'openclaw-gateway'));
});

// ─── 更新 ───
app.post('/api/update', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  send('stdout', '=== 拉取最新镜像 ===\n');
  const pullResult = await execStep('docker', composeArgs('pull', 'openclaw-gateway'), send);
  if (pullResult.code !== 0) { send('exit', { code: pullResult.code }); return res.end(); }

  send('stdout', '\n=== 重建容器 ===\n');
  const upResult = await execStep('docker', composeArgs('up', '-d', 'openclaw-gateway'), send);
  send('exit', { code: upResult.code });
  res.end();
});

// ─── 备份 ───
app.post('/api/backup', (req, res) => {
  const ts = new Date().toISOString().replace(/[:-]/g, '').slice(0, 15);
  const filename = `openclaw-backup-${ts}.tar.gz`;
  execSSE(res, 'tar', ['czf', filename, '-C', PROJECT_DIR, 'data/']);
});

// ─── 诊断 ───
app.post('/api/doctor', (req, res) => {
  execSSE(res, 'docker', composeCliArgs('run', '--rm', 'openclaw-cli', 'doctor'));
});

// ─── 实时日志 ───
app.get('/api/logs', (req, res) => {
  execSSE(res, 'docker', composeArgs('logs', '-f', '--tail', '100', 'openclaw-gateway'));
});

// ─── 频道管理 ───
app.post('/api/channel/add', (req, res) => {
  const { channel, token, appToken } = req.body;
  const normalizedChannel = String(channel || '').trim().toLowerCase();
  if (!normalizedChannel || !token) {
    return res.status(400).json({ error: '缺少 channel 或 token 参数' });
  }
  if (!['telegram', 'slack', 'discord'].includes(normalizedChannel)) {
    return res.status(400).json({ error: '暂仅支持 telegram / slack / discord' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  (async () => {
    try {
      send('stdout', '=== [1/3] 启用频道插件 ===\n');
      const enableResult = await execStep(
        'docker',
        composeCliArgs('run', '--rm', 'openclaw-cli', 'plugins', 'enable', normalizedChannel),
        send,
      );
      if (enableResult.code !== 0) {
        send('exit', { code: enableResult.code });
        return res.end();
      }

      send('stdout', '\n=== [2/3] 写入频道配置 ===\n');
      const addResult = await execStep(
        'docker',
        composeCliArgs(...buildChannelAddCliArgs(normalizedChannel, token, appToken)),
        send,
      );
      if (addResult.code !== 0) {
        send('exit', { code: addResult.code });
        return res.end();
      }

      send('stdout', '\n=== [3/3] 重启 Gateway 使插件生效 ===\n');
      const restartResult = await execStep(
        'docker',
        composeArgs('restart', 'openclaw-gateway'),
        send,
      );
      if (restartResult.code !== 0) {
        send('exit', { code: restartResult.code });
        return res.end();
      }

      const currentConfig = readJsonFile(OPENCLAW_CONFIG_FILE, {});
      if (!hasConfiguredChannel(currentConfig, normalizedChannel)) {
        send('stderr', `警告: 未在 openclaw.json 中检测到 channels.${normalizedChannel}，请执行「状态检查」确认\n`);
      } else {
        send('stdout', `频道 ${normalizedChannel} 已配置并生效\n`);
      }

      send('exit', { code: 0 });
      res.end();
    } catch (err) {
      send('error', err.message || String(err));
      send('exit', { code: 1 });
      res.end();
    }
  })();
});

// ─── 配对 ───
app.post('/api/pair', (req, res) => {
  const { platform, code } = req.body;
  if (!platform || !code) {
    return res.status(400).json({ error: '缺少 platform 或 code 参数' });
  }
  execSSE(res, 'docker', composeCliArgs('run', '--rm', 'openclaw-cli', 'pairing', 'approve', platform, code));
});

// ─── 批准待处理设备配对（修复 control-ui pairing required） ───
app.post('/api/pairing/approve-pending', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };

  try {
    const result = approvePendingDevicePairings();
    if (result.approved > 0) {
      send('stdout', `已批准设备配对请求: ${result.approved}\n`);
      send('stdout', '请刷新 OpenClaw 控制台页面后重试 Chat\n');
    } else {
      send('stdout', '没有待处理的设备配对请求\n');
    }
    send('exit', { code: 0 });
  } catch (err) {
    send('error', err.message || String(err));
    send('exit', { code: 1 });
  }
  res.end();
});

// ─── SPA 回退 ───
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'dist', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('请先运行 npm run build 构建前端');
  }
});

// ─── 启动服务器 ───
const PORT = process.env.ADMIN_PORT || 3000;
// Docker 内绑定 0.0.0.0, 本地绑定 127.0.0.1
const HOST = RUNNING_IN_DOCKER ? '0.0.0.0' : '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`OpenClaw 管理面板已启动: http://${HOST}:${PORT}`);
});
