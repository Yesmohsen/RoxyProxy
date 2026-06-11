function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return 'xxxx-xxxx-xxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16)
  )
}

const TYPE_LABELS = {
  main_frame: 'DOC',
  sub_frame: 'FRAME',
  stylesheet: 'CSS',
  script: 'JS',
  image: 'IMG',
  font: 'FONT',
  object: 'OBJ',
  xmlhttprequest: 'XHR',
  ping: 'PING',
  media: 'MEDIA',
  websocket: 'WS',
  web_manifest: 'MAN',
  other: 'OTHER'
}

const STORAGE_KEYS = {
  state: 'roxyState'
}

const DEFAULT_STATE = {
  isConnected: false,
  activeProfileId: null,
  profiles: [],
  bypassList: [],
  logs: [],
  dataUsage: { upload: 0, download: 0 },
  connectionStartTime: null,
  backupConfig: { gistId: '', token: '', autoBackup: false }
}

async function getState() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.state)
    return { ...DEFAULT_STATE, ...data[STORAGE_KEYS.state] }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

async function setState(partial) {
  const current = await getState()
  const next = { ...current, ...partial }
  await chrome.storage.local.set({ [STORAGE_KEYS.state]: next })
  return next
}

async function resetState() {
  await chrome.storage.local.remove(STORAGE_KEYS.state)
}

let loggingActive = false

const responseSizes = new Map()

function startLogging() {
  if (loggingActive) return
  loggingActive = true

  chrome.webRequest.onCompleted.addListener(handleRequest, { urls: ['<all_urls>'] })
  chrome.webRequest.onErrorOccurred.addListener(handleRequestError, { urls: ['<all_urls>'] })
  chrome.webRequest.onHeadersReceived.addListener(handleHeadersReceived, { urls: ['<all_urls>'] }, ['responseHeaders', 'extraHeaders'])
}

function stopLogging() {
  loggingActive = false
  chrome.webRequest.onCompleted.removeListener(handleRequest)
  chrome.webRequest.onErrorOccurred.removeListener(handleRequestError)
  chrome.webRequest.onHeadersReceived.removeListener(handleHeadersReceived)
  responseSizes.clear()
}

async function handleHeadersReceived(details) {
  if (!loggingActive) return
  if (!details.responseHeaders) return

  for (const h of details.responseHeaders) {
    if (h.name.toLowerCase() === 'content-length') {
      const size = parseInt(h.value, 10)
      if (!isNaN(size)) {
        responseSizes.set(details.requestId, size)
      }
      break
    }
  }
}

async function handleRequest(details) {
  if (!loggingActive) return

  const state = await getState()
  if (!state.isConnected) return

  const typeLabel = TYPE_LABELS[details.type] || 'OTHER'
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const respSize = details.responseSize || responseSizes.get(details.requestId) || 0
  responseSizes.delete(details.requestId)

  const entry = {
    id: generateId(),
    timestamp: timeStr,
    method: details.method || 'GET',
    type: typeLabel,
    url: details.url.length > 80 ? details.url.substring(0, 80) + '...' : details.url,
    fullUrl: details.url,
    size: respSize
  }

  const logs = [entry, ...state.logs].slice(0, 500)
  const download = state.dataUsage.download + respSize
  const upload = state.dataUsage.upload + details.url.length + 400

  await setState({
    logs,
    dataUsage: { upload, download }
  })
}

async function handleRequestError(details) {
  if (!loggingActive) return

  const state = await getState()
  if (!state.isConnected) return

  const typeLabel = TYPE_LABELS[details.type] || 'OTHER'
  const now = new Date()
  const timeStr = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const entry = {
    id: generateId(),
    timestamp: timeStr,
    method: details.method || 'GET',
    type: typeLabel,
    url: `[ERR] ${details.error} – ${details.url.length > 60 ? details.url.substring(0, 60) + '...' : details.url}`,
    fullUrl: details.url,
    size: 0
  }

  responseSizes.delete(details.requestId)

  const logs = [entry, ...state.logs].slice(0, 500)
  await setState({ logs })
}

async function getActiveProfile(state) {
  if (!state.activeProfileId) return null
  return state.profiles.find(p => p.id === state.activeProfileId) || null
}

function buildProxyConfig(profile, bypassList) {
  const schemeMap = {
    http: 'http',
    https: 'https',
    socks4: 'socks4',
    socks5: 'socks5'
  }

  const scheme = schemeMap[profile.protocol] || 'http'

  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme,
        host: profile.host,
        port: profile.port
      }
    }
  }

  if (bypassList && bypassList.length > 0) {
    config.rules.bypassList = bypassList
  }

  return config
}

async function reconnectProxy(state) {
  const profile = await getActiveProfile(state)
  if (!profile) return
  const config = buildProxyConfig(profile, state.bypassList)
  await chrome.proxy.settings.set({ value: config, scope: 'regular' })
}

async function connectProxy(state) {
  const profile = await getActiveProfile(state)
  if (!profile) {
    throw new Error('No active profile selected')
  }

  const config = buildProxyConfig(profile, state.bypassList)
  await chrome.proxy.settings.set({ value: config, scope: 'regular' })

  const now = Date.now()
  await setState({
    isConnected: true,
    connectionStartTime: now
  })

  startLogging()

  if (state.backupConfig.autoBackup) {
    scheduleAutoBackup()
  }
}

async function disconnectProxy(state) {
  await chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' })
  stopLogging()
  stopAutoBackup()

  await setState({
    isConnected: false,
    connectionStartTime: null
  })
}

let autoBackupTimerId = null

function scheduleAutoBackup() {
  if (autoBackupTimerId) {
    clearTimeout(autoBackupTimerId)
  }
  autoBackupTimerId = setTimeout(async () => {
    autoBackupTimerId = null
    const state = await getState()
    if (state.isConnected && state.backupConfig.autoBackup) {
      try {
        await backupToGist(state)
      } catch (e) {
        console.error('Auto-backup failed:', e)
      }
      scheduleAutoBackup()
    }
  }, 300000)
}

function stopAutoBackup() {
  if (autoBackupTimerId) {
    clearTimeout(autoBackupTimerId)
    autoBackupTimerId = null
  }
}

async function backupToGist(state) {
  const { gistId, token } = state.backupConfig
  if (!gistId || !token) {
    throw new Error('Gist ID and token required')
  }

  const data = {
    profiles: state.profiles,
    bypassList: state.bypassList,
    backupConfig: {
      autoBackup: state.backupConfig.autoBackup
    },
    updatedAt: new Date().toISOString()
  }

  const body = JSON.stringify(data, null, 2)

  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      files: {
        'roxyproxy-backup.json': { content: body }
      }
    })
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}${text ? ' — ' + text.slice(0, 200) : ''}`)
  }

  return true
}

async function restoreFromGist(state) {
  const { gistId, token } = state.backupConfig
  if (!gistId || !token) {
    throw new Error('Gist ID and token required')
  }

  const response = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      'Authorization': `token ${token}`
    }
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}${text ? ' — ' + text.slice(0, 200) : ''}`)
  }

  const gist = await response.json()
  const file = gist.files['roxyproxy-backup.json']
  if (!file) {
    throw new Error('Backup file not found in gist')
  }

  const data = JSON.parse(file.content)

  await setState({
    profiles: data.profiles || [],
    bypassList: data.bypassList || [],
    backupConfig: {
      ...state.backupConfig,
      autoBackup: data.backupConfig?.autoBackup ?? state.backupConfig.autoBackup
    }
  })

  return { profiles: data.profiles, bypassList: data.bypassList }
}

async function getCurrentTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab && tab.url) {
      return tab.url
    }
    return null
  } catch {
    return null
  }
}

function extractDomain(url) {
  try {
    const u = new URL(url)
    return u.hostname
  } catch {
    return url
  }
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const state = await getState()
      let result

      switch (message.action) {
        case 'getState': {
          const profile = await getActiveProfile(state)
          result = { ...state, activeProfile: profile }
          break
        }

        case 'connect': {
          const profileId = message.profileId
          if (profileId) {
            await setState({ activeProfileId: profileId })
          }
          const updated = await getState()
          await connectProxy(updated)
          const connectedState = await getState()
          const activeProfile = await getActiveProfile(connectedState)
          result = { ...connectedState, activeProfile }
          break
        }

        case 'disconnect': {
          await disconnectProxy(state)
          const disconnected = await getState()
          const activeProfile = await getActiveProfile(disconnected)
          result = { ...disconnected, activeProfile }
          break
        }

        case 'addProfile': {
          const profile = message.profile
          const exists = state.profiles.find(p => p.id === profile.id)
          let profiles
          let newId
          if (exists) {
            profiles = state.profiles.map(p => p.id === profile.id ? profile : p)
            newId = profile.id
          } else {
            newId = generateId()
            profiles = [...state.profiles, { ...profile, id: newId }]
          }
          await setState({ profiles })
          const updated = await getState()
          if (updated.isConnected && newId === updated.activeProfileId) {
            await reconnectProxy(updated)
          }
          result = { profiles, newId }
          break
        }

        case 'updateProfile': {
          const profile = message.profile
          const profiles = state.profiles.map(p => p.id === profile.id ? { ...p, ...profile } : p)
          await setState({ profiles })
          result = { profiles }
          break
        }

        case 'deleteProfile': {
          const profileId = message.profileId
          let profiles = state.profiles.filter(p => p.id !== profileId)
          let activeProfileId = state.activeProfileId
          if (activeProfileId === profileId) {
            activeProfileId = profiles.length > 0 ? profiles[0].id : null
          }
          await setState({ profiles, activeProfileId })
          result = { profiles, activeProfileId }
          break
        }

        case 'setActiveProfile': {
          const profileId = message.profileId
          await setState({ activeProfileId: profileId })
          const updated = await getState()
          if (updated.isConnected) {
            await reconnectProxy(updated)
          }
          const activeProfile = await getActiveProfile(updated)
          result = { activeProfileId: profileId, activeProfile }
          break
        }

        case 'addBypass': {
          const url = message.url
          const domain = extractDomain(url)
          if (!state.bypassList.includes(domain)) {
            const bypassList = [...state.bypassList, domain]
            await setState({ bypassList })
            if (state.isConnected) {
              const updated = await getState()
              await reconnectProxy(updated)
            }
            result = { bypassList }
          } else {
            result = { bypassList: state.bypassList }
          }
          break
        }

        case 'addBypassWildcard': {
          const url = message.url
          const domain = extractDomain(url)
          const parts = domain.split('.')
          const rootDomain = parts.length > 2 ? parts.slice(-2).join('.') : domain
          const wildcard = `*.${rootDomain}`
          if (!state.bypassList.includes(wildcard)) {
            const bypassList = [...state.bypassList, wildcard]
            await setState({ bypassList })
            if (state.isConnected) {
              const updated = await getState()
              await reconnectProxy(updated)
            }
            result = { bypassList }
          } else {
            result = { bypassList: state.bypassList }
          }
          break
        }

        case 'removeBypass': {
          const entry = message.entry
          const bypassList = state.bypassList.filter(e => e !== entry)
          await setState({ bypassList })
          if (state.isConnected) {
            const updated = await getState()
            await reconnectProxy(updated)
          }
          result = { bypassList }
          break
        }

        case 'clearLogs': {
          await setState({ logs: [], dataUsage: { upload: 0, download: 0 } })
          result = { logs: [], dataUsage: { upload: 0, download: 0 } }
          break
        }

        case 'getTabUrl': {
          const tabUrl = await getCurrentTabUrl()
          result = { tabUrl }
          break
        }

        case 'getPublicIP': {
          try {
            const resp = await fetch('https://api.ipify.org?format=json')
            const data = await resp.json()
            result = data.ip || null
          } catch {
            result = null
          }
          break
        }

        case 'updateBackupConfig': {
          const config = message.config
          await setState({ backupConfig: config })
          result = { backupConfig: config }
          break
        }

        case 'backupToGist': {
          const success = await backupToGist(state)
          result = { success }
          break
        }

        case 'restoreFromGist': {
          const data = await restoreFromGist(state)
          result = data
          break
        }

        default:
          throw new Error(`Unknown action: ${message.action}`)
      }

      sendResponse({ success: true, data: result })
    } catch (error) {
      sendResponse({ success: false, error: error.message })
    }
  })()

  return true
})
