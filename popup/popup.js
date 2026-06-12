let state = {
  isConnected: false,
  activeProfileId: null,
  activeProfile: null,
  profiles: [],
  bypassList: [],
  logs: [],
  dataUsage: { upload: 0, download: 0 },
  connectionStartTime: null,
  connectionIP: '',
  backupConfig: { gistId: '', token: '', autoBackup: false }
}

let timerInterval = null
let stateRefreshInterval = null
let activePanel = null
let prevUpload = 0
let prevDownload = 0
let prevTime = 0

async function sendMessage(action, payload = {}) {
  try {
    const result = await chrome.runtime.sendMessage({ action, ...payload })
    if (!result || !result.success) {
      throw new Error(result?.error || 'Service worker not responding')
    }
    return result.data
  } catch (e) {
    console.error('sendMessage error:', e)
    throw e
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return (bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function formatSpeed(bps) {
  if (bps === 0) return '0 KB/s'
  const units = ['B/s', 'KB/s', 'MB/s']
  const i = Math.min(Math.floor(Math.log(bps) / Math.log(1024)), units.length - 1)
  return (bps / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i]
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':')
}

async function loadState() {
  state = await sendMessage('getState')
}

async function resolveConnectionIP() {
  try {
    const ip = await sendMessage('getPublicIP')
    if (ip) {
      state.connectionIP = ip
      const el = document.getElementById('connIp')
      if (el) el.textContent = ip
    }
  } catch {}
}

function setFormStatus(msg, type) {
  const el = document.getElementById('formStatus')
  if (el) {
    el.textContent = msg
    el.className = 'form-status' + (type ? ' ' + type : '')
  }
}

function renderMainUI() {
  const powerBtn = document.getElementById('powerBtn')
  const statusText = document.getElementById('statusText')
  const timerEl = document.getElementById('timer')

  powerBtn.classList.remove('connected', 'disconnected', 'connecting')
  if (state.isConnected) {
    powerBtn.classList.add('connected')
    statusText.textContent = 'Connected'
    statusText.className = 'status-text'
  } else {
    powerBtn.classList.add('disconnected')
    statusText.textContent = 'Disconnected'
    statusText.className = 'status-text disconnected'
  }

  if (state.connectionStartTime && state.isConnected) {
    const elapsed = Date.now() - state.connectionStartTime
    timerEl.textContent = formatTime(elapsed)
    startTimer()
    startStateRefresh()
  } else {
    timerEl.textContent = '00:00:00'
    stopTimer()
    stopStateRefresh()
  }

  document.getElementById('uploadValue').textContent = '0 KB/s'
  document.getElementById('downloadValue').textContent = '0 KB/s'

  const profile = state.activeProfile
  const profileNameEl = document.getElementById('profileName')
  const profileIpEl = document.getElementById('profileIp')

  if (profile) {
    profileNameEl.textContent = profile.name || 'Unnamed'
    profileIpEl.textContent = `${profile.host}:${profile.port}`
  } else {
    profileNameEl.textContent = 'No Profile'
    profileIpEl.textContent = '-'
  }

  document.querySelectorAll('.protocol-badge').forEach(badge => {
    const proto = badge.dataset.proto
    badge.classList.toggle('active', profile ? profile.protocol === proto : false)
  })

  const connIpRow = document.getElementById('connIpRow')
  const connIpEl = document.getElementById('connIp')
  if (state.isConnected && profile) {
    connIpRow.style.display = 'flex'
    connIpEl.textContent = state.connectionIP || 'Resolving...'
    if (state.connectionIP) {
      connIpEl.dataset.blurred = 'true'
    }
  } else {
    connIpRow.style.display = 'none'
  }

  renderBypassList()
  renderLogs()
  renderBackupForm()
}

function startTimer() {
  stopTimer()
  timerInterval = setInterval(() => {
    if (state.connectionStartTime && state.isConnected) {
      const elapsed = Date.now() - state.connectionStartTime
      document.getElementById('timer').textContent = formatTime(elapsed)
    }
  }, 1000)
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

function startStateRefresh() {
  stopStateRefresh()
  prevUpload = state.dataUsage.upload
  prevDownload = state.dataUsage.download
  prevTime = Date.now()

  stateRefreshInterval = setInterval(async () => {
    try {
      const fresh = await sendMessage('getState')
      const now = Date.now()
      const dt = (now - prevTime) / 1000

      const dUpload = fresh.dataUsage.upload - prevUpload
      const dDownload = fresh.dataUsage.download - prevDownload

      prevUpload = fresh.dataUsage.upload
      prevDownload = fresh.dataUsage.download
      prevTime = now

      state.dataUsage = fresh.dataUsage
      state.logs = fresh.logs
      state.connectionStartTime = fresh.connectionStartTime
      state.isConnected = fresh.isConnected
      state.activeProfile = fresh.activeProfile
      state.activeProfileId = fresh.activeProfileId
      state.profiles = fresh.profiles
      state.bypassList = fresh.bypassList
      state.backupConfig = fresh.backupConfig

      if (!fresh.isConnected) {
        stopStateRefresh()
      }

      document.getElementById('uploadValue').textContent = formatSpeed(dUpload / dt)
      document.getElementById('downloadValue').textContent = formatSpeed(dDownload / dt)
    } catch (e) {
      // ignore refresh errors
    }
  }, 2000)
}

function stopStateRefresh() {
  if (stateRefreshInterval) {
    clearInterval(stateRefreshInterval)
    stateRefreshInterval = null
  }
}

function renderBypassList() {
  const container = document.getElementById('bypassList')
  const countEl = document.getElementById('bypassCount')

  countEl.textContent = state.bypassList.length

  if (state.bypassList.length === 0) {
    container.innerHTML = '<div class="bypass-empty">No bypass entries</div>'
    return
  }

  container.innerHTML = state.bypassList.map((entry, i) => `
    <div class="bypass-item">
      <span class="bypass-url">${escapeHtml(entry)}</span>
      <div class="bypass-actions">
        <button class="icon-btn remove" data-index="${i}" title="Remove">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
    </div>
  `).join('')

  container.querySelectorAll('.icon-btn.remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const index = parseInt(btn.dataset.index, 10)
      const entry = state.bypassList[index]
      try {
        const result = await sendMessage('removeBypass', { entry })
        state.bypassList = result.bypassList
        renderBypassList()
      } catch (e) {
        console.error(e)
      }
    })
  })
}

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

function renderLogs() {
  const container = document.getElementById('logsList')
  const countEl = document.getElementById('logsCount')

  countEl.textContent = state.logs.length

  if (state.logs.length === 0) {
    container.innerHTML = '<div class="bypass-empty">No logs yet</div>'
    return
  }

  container.innerHTML = state.logs.map(log => `
    <div class="log-entry" data-url="${escapeHtml(log.fullUrl || log.url)}">
      <span class="log-time">${escapeHtml(log.timestamp)}</span>
      <span class="log-method">${escapeHtml(log.method)}</span>
      <span class="log-type">${escapeHtml(log.type)}</span>
      <span class="log-url">${escapeHtml(log.url)}</span>
    </div>
  `).join('')

  container.querySelectorAll('.log-entry').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url
      if (url) {
        navigator.clipboard.writeText(url.replace(/^\[ERR\].*–\s*/, '')).catch(() => {})
      }
    })
  })
}

function renderBackupForm() {
  const config = state.backupConfig
  document.getElementById('gistIdInput').value = config.gistId || ''
  document.getElementById('tokenInput').value = config.token || ''
  document.getElementById('autoBackupToggle').checked = config.autoBackup || false
}

function showPanel(panelId) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.action-btn').forEach(b => b.classList.remove('active'))
  if (activePanel === panelId) {
    activePanel = null
    return
  }
  const panel = document.getElementById(panelId)
  if (panel) {
    panel.classList.add('active')
    activePanel = panelId
  }
}

function showMainView() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  document.getElementById('mainView').classList.add('active')
}

function showProxyEditView(profileId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'))
  document.getElementById('proxyEditView').classList.add('active')
  setFormStatus('', '')

  const title = document.getElementById('proxyEditTitle')
  const nameInput = document.getElementById('proxyNameInput')
  const hostInput = document.getElementById('proxyHostInput')
  const portInput = document.getElementById('proxyPortInput')
  const editId = document.getElementById('editProfileId')
  const deleteBtn = document.getElementById('deleteProfileBtn')

  if (profileId && state.profiles.length > 0) {
    const profile = state.profiles.find(p => p.id === profileId)
    if (profile) {
      title.textContent = 'Edit Proxy'
      nameInput.value = profile.name || ''
      hostInput.value = profile.host || ''
      portInput.value = profile.port || ''
      editId.value = profile.id
      deleteBtn.style.display = ''
      document.querySelectorAll('input[name="protocol"]').forEach(r => {
        r.checked = r.value === profile.protocol
      })
    }
  } else {
    title.textContent = 'Add Proxy'
    nameInput.value = ''
    hostInput.value = ''
    portInput.value = ''
    editId.value = ''
    deleteBtn.style.display = 'none'
    document.querySelector('input[name="protocol"][value="http"]').checked = true
  }

  renderProfileList()
}

function renderProfileList() {
  const container = document.getElementById('profileList')

  if (!state || !state.profiles || state.profiles.length === 0) {
    container.innerHTML = '<div class="bypass-empty">No saved profiles</div>'
    return
  }

  container.innerHTML = state.profiles.map(p => {
    const isActive = p.id === state.activeProfileId
    return `
      <div class="profile-list-item ${isActive ? 'active' : ''}" data-id="${p.id}">
        <div>
          <div class="pli-name">${escapeHtml(p.name || 'Unnamed')}</div>
          <div class="pli-detail">${p.host}:${p.port} • ${p.protocol}</div>
        </div>
        <div class="pli-actions">
          <button class="pli-delete" data-id="${p.id}" title="Delete">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
          <button class="pli-edit" data-id="${p.id}" title="Edit">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        </div>
      </div>
    `
  }).join('')

  container.querySelectorAll('.profile-list-item').forEach(item => {
    item.addEventListener('click', async (e) => {
      if (e.target.closest('.pli-edit')) return
      if (e.target.closest('.pli-delete')) return
      const id = item.dataset.id
      await setActiveProfile(id)
    })
  })

  container.querySelectorAll('.pli-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id
      showProxyEditView(id)
    })
  })

  container.querySelectorAll('.pli-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      const id = btn.dataset.id
      try {
        const result = await sendMessage('deleteProfile', { profileId: id })
        state.profiles = result.profiles
        state.activeProfileId = result.activeProfileId
        state = await sendMessage('getState')
        renderProfileList()
        renderMainUI()
      } catch (e) {
        console.error(e)
      }
    })
  })
}

async function setActiveProfile(id) {
  try {
    const result = await sendMessage('setActiveProfile', { profileId: id })
    if (result) {
      if (result.activeProfileId !== undefined) state.activeProfileId = result.activeProfileId
      if (result.activeProfile !== undefined) state.activeProfile = result.activeProfile
    }
    renderMainUI()
    renderProfileList()
  } catch (e) {
    console.error(e)
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  for (let i = 0; i < 3; i++) {
    try {
      state = await sendMessage('getState')
      break
    } catch (e) {
      console.error('Failed to load state (attempt ' + (i + 1) + '):', e)
      if (i < 2) await new Promise(r => setTimeout(r, 300))
    }
  }

  renderMainUI()

  if (state.isConnected) {
    resolveConnectionIP()
  }

  document.getElementById('powerBtn').addEventListener('click', async () => {
    try {
      const powerBtn = document.getElementById('powerBtn')
      if (state.isConnected) {
        powerBtn.classList.remove('connected', 'connecting')
        powerBtn.classList.add('disconnected')
        state = await sendMessage('disconnect')
        state.connectionIP = ''
        stopStateRefresh()
      } else {
        powerBtn.classList.remove('connected', 'disconnected')
        powerBtn.classList.add('connecting')
        state = await sendMessage('connect')
        state.connectionIP = ''
      }
      renderMainUI()
      if (state.isConnected) {
        resolveConnectionIP()
      }
    } catch (e) {
      console.error(e)
      const statusText = document.getElementById('statusText')
      statusText.textContent = 'Error: ' + e.message
      statusText.className = 'status-text disconnected'
    }
  })

  document.getElementById('profileCard').addEventListener('click', () => {
    showProxyEditView()
  })

  document.getElementById('eyeToggle').addEventListener('click', (e) => {
    e.stopPropagation()
    const el = document.getElementById('connIp')
    const isBlurred = el.dataset.blurred === 'true'
    el.dataset.blurred = isBlurred ? 'false' : 'true'
  })

  document.getElementById('backToMainBtn').addEventListener('click', async () => {
    try {
      state = await sendMessage('getState')
      renderMainUI()
      showMainView()
    } catch (e) {
      console.error(e)
    }
  })

  document.getElementById('saveProfileBtn').addEventListener('click', async () => {
    const editId = document.getElementById('editProfileId').value
    const name = document.getElementById('proxyNameInput').value.trim()
    const host = document.getElementById('proxyHostInput').value.trim()
    const port = parseInt(document.getElementById('proxyPortInput').value, 10)
    const protocol = document.querySelector('input[name="protocol"]:checked')?.value || 'http'

    if (!name || !host || !port) {
      setFormStatus('Please fill in all fields', 'error')
      return
    }

    const profile = { id: editId || undefined, name, host, port, protocol }

    try {
      const result = await sendMessage('addProfile', { profile })
      if (result && result.profiles) {
        state.profiles = result.profiles
      }
      state = await sendMessage('getState')
      if (result.newId) {
        await setActiveProfile(result.newId)
      }
      renderMainUI()
      renderProfileList()
      setFormStatus('Saved!', 'success')
      showMainView()
    } catch (e) {
      console.error(e)
      setFormStatus('Save failed: ' + e.message, 'error')
    }
  })

  document.getElementById('deleteProfileBtn').addEventListener('click', async () => {
    const editId = document.getElementById('editProfileId').value
    if (!editId) return

    try {
      const result = await sendMessage('deleteProfile', { profileId: editId })
      if (result) {
        if (result.profiles) state.profiles = result.profiles
        if (result.activeProfileId !== undefined) state.activeProfileId = result.activeProfileId
      }
      state = await sendMessage('getState')
      renderMainUI()
      showMainView()
    } catch (e) {
      console.error(e)
      setFormStatus('Delete failed: ' + e.message, 'error')
    }
  })

  async function addCurrentTabBypass(wildcard) {
    try {
      const result = await sendMessage('getTabUrl')
      if (result.tabUrl) {
        const action = wildcard ? 'addBypassWildcard' : 'addBypass'
        const bypassResult = await sendMessage(action, { url: result.tabUrl })
        state.bypassList = bypassResult.bypassList
        renderBypassList()
        showPanel('bypassPanel')
      }
    } catch (e) {
      console.error(e)
    }
  }

  document.getElementById('addBypassBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    await addCurrentTabBypass(false)
    if (document.getElementById('bypassPanel').classList.contains('active')) {
      btn.classList.add('active')
    }
  })
  document.getElementById('addWildcardBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    await addCurrentTabBypass(true)
    if (document.getElementById('bypassPanel').classList.contains('active')) {
      btn.classList.add('active')
    }
  })

  document.getElementById('logsBtn').addEventListener('click', (e) => {
    showPanel('logsPanel')
    if (document.getElementById('logsPanel').classList.contains('active')) {
      e.currentTarget.classList.add('active')
    }
  })
  document.getElementById('backupBtn').addEventListener('click', (e) => {
    showPanel('backupPanel')
    if (document.getElementById('backupPanel').classList.contains('active')) {
      e.currentTarget.classList.add('active')
    }
  })

  document.getElementById('clearLogsBtn').addEventListener('click', async () => {
    try {
      const result = await sendMessage('clearLogs')
      state.logs = result.logs
      state.dataUsage = result.dataUsage
      renderMainUI()
    } catch (e) {
      console.error(e)
    }
  })

  document.getElementById('copyLogsBtn').addEventListener('click', () => {
    const text = state.logs.map(l => `${l.timestamp} | ${l.method} | ${l.type} | ${l.url}`).join('\n')
    if (text) {
      navigator.clipboard.writeText(text).catch(() => {})
    }
  })

  async function saveBackupConfig() {
    const config = {
      gistId: document.getElementById('gistIdInput').value.trim(),
      token: document.getElementById('tokenInput').value.trim(),
      autoBackup: document.getElementById('autoBackupToggle').checked
    }
    try {
      const result = await sendMessage('updateBackupConfig', { config })
      state.backupConfig = result.backupConfig
    } catch (e) {
      console.error(e)
    }
  }

  document.getElementById('gistIdInput').addEventListener('change', saveBackupConfig)
  document.getElementById('tokenInput').addEventListener('change', saveBackupConfig)
  document.getElementById('autoBackupToggle').addEventListener('change', saveBackupConfig)

  document.getElementById('backupNowBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('backupStatus')
    statusEl.textContent = 'Backing up...'
    statusEl.className = 'backup-status'
    try {
      await saveBackupConfig()
      await sendMessage('backupToGist')
      statusEl.textContent = 'Backup completed!'
      statusEl.className = 'backup-status success'
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message
      statusEl.className = 'backup-status error'
    }
  })

  document.getElementById('restoreBtn').addEventListener('click', async () => {
    const statusEl = document.getElementById('backupStatus')
    statusEl.textContent = 'Restoring...'
    statusEl.className = 'backup-status'
    try {
      await saveBackupConfig()
      const result = await sendMessage('restoreFromGist')
      state.profiles = result.profiles || []
      state.bypassList = result.bypassList || []
      state = await sendMessage('getState')
      renderMainUI()
      statusEl.textContent = 'Restored successfully!'
      statusEl.className = 'backup-status success'
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message
      statusEl.className = 'backup-status error'
    }
  })
})
