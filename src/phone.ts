// The phone page: a live mirror of the lens, the same options as buttons, a
// box to type what you'd say, and the slower stuff -- the story so far, the
// hero, the pack, the Hall of Fame, settings and credits.

import type { App } from './app'
import { hallText } from './app'
import type { LensFrame } from './glasses'
import { iconSvg } from './art'
import { ICON_AUTHORS, type IconName } from './icons.gen'
import { CONSUMABLES } from './engine/data'
import { itemName, itemDesc } from './engine/items'
import { normalizeServerUrl, looksWhitelisted } from './store'
import { PROVIDERS, listModels, type Provider } from './llm'
import type { DmStatus } from './dm'

type Tab = 'story' | 'hero' | 'pack' | 'legends' | 'settings'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

export function mountPhone(root: HTMLElement, app: App) {
  let tab: Tab = app.settings.server ? 'story' : 'settings'
  let lastIcon = ''

  root.innerHTML = `
    <div class="wrap">
      <div class="top">
        <h1 class="brand">DEL<span>VE</span></h1>
        <span class="spacer"></span>
        <span class="pill" id="dmPill"></span>
        <span class="pill" id="micPill"></span>
      </div>
      <div class="lens" id="lens">
        <div class="l-hdr"></div>
        <div class="l-art"></div>
        <div class="l-cap"></div>
        <div class="l-body"></div>
        <div class="l-ftr"></div>
      </div>
      <button class="btn mic" id="mic" hidden></button>
      <div class="card">
        <h3 id="optTitle">Choose</h3>
        <div class="actions" id="opts"></div>
        <form class="say" id="sayForm" autocomplete="off">
          <input id="sayInput" placeholder="Say or type anything: &quot;kick the table at the orc&quot;" enterkeyhint="send" />
          <button class="btn primary" type="submit">Do it</button>
        </form>
      </div>
      <div class="tabs" id="tabs">
        <button data-tab="story">Story</button>
        <button data-tab="hero">Hero</button>
        <button data-tab="pack">Pack</button>
        <button data-tab="legends">Legends</button>
        <button data-tab="settings">Settings</button>
      </div>
      <div class="card panel" id="panel"></div>
    </div>`

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const lens = $('#lens')
  const opts = $('#opts')
  const panel = $('#panel')
  const mic = $<HTMLButtonElement>('#mic')

  $('#sayForm').addEventListener('submit', e => {
    e.preventDefault()
    const input = $<HTMLInputElement>('#sayInput')
    const text = input.value
    input.value = ''
    void app.say(text)
  })
  opts.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-id]')
    if (b) app.pick(b.dataset.id!)
  })
  mic.addEventListener('click', () => {
    if (app.voice === 'listening') app.stopListening()
    else void app.listen()
  })
  $('#tabs').addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]')
    if (!b) return
    tab = b.dataset.tab as Tab
    renderPanel(true)
  })

  function drawLens(f: LensFrame) {
    lens.querySelector('.l-hdr')!.textContent = f.header
    lens.querySelector('.l-body')!.textContent = f.body
    lens.querySelector('.l-cap')!.textContent = f.caption
    lens.querySelector('.l-ftr')!.textContent = f.footer
    const art = lens.querySelector<HTMLElement>('.l-art')!
    const key = `${f.icon}|${f.dim}`
    if (key !== lastIcon) {
      lastIcon = key
      art.innerHTML = iconSvg(f.icon)
      art.classList.toggle('dim', f.dim)
    }
  }

  function renderControls() {
    const visible = app.visibleOptions()
    $('#optTitle').textContent = app.game.mode === 'class' ? 'Choose your hero' : 'What do you do?'
    opts.innerHTML = visible
      .map((o, i) => `<button class="opt" data-id="${esc(o.id)}"><b>${i + 1}</b>${esc(o.label)}</button>`)
      .join('')
    mic.hidden = !app.voiceReady
    mic.classList.toggle('live', app.voice === 'listening')
    mic.textContent = app.voice === 'listening' ? `● Listening… ${app.partial ? `"${app.partial}"` : '(tap to send)'}` : app.voice === 'thinking' ? '◐ The Dungeon Master considers…' : 'Speak (uses the glasses mic)'

    const dm = app.dm.status
    const dmPill = $('#dmPill')
    const pills: Record<DmStatus, string> = { off: 'DM off', unset: 'DM: set up', checking: 'DM…', ready: 'AI DM ready', offline: 'DM offline', 'old-server': 'Wrong server', 'no-key': 'DM: add key', 'bad-key': 'DM: bad key' }
    dmPill.textContent = pills[dm]
    dmPill.className = `pill ${dm === 'ready' ? 'ok' : dm === 'checking' || dm === 'off' ? '' : 'warn'}`
    const micPill = $('#micPill')
    micPill.textContent = app.voiceReady ? 'Voice on' : app.hasMic ? 'Voice: set server' : 'No glasses mic'
    micPill.className = `pill ${app.voiceReady ? 'ok' : 'warn'}`
  }

  function renderPanel(force = false) {
    root.querySelectorAll<HTMLButtonElement>('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
    // Settings has live inputs; never rebuild it under the user's fingers.
    if (tab === 'settings' && !force) return updateSettingsStatus()
    const g = app.game
    switch (tab) {
      case 'story': {
        const items = app.log.slice(-60)
        panel.innerHTML = items.length
          ? `<div class="log">${items.map(e => `<p class="${e.kind}">${esc(e.text)}</p>`).join('')}</div>`
          : '<p class="hint">Your story will be written here.</p>'
        return
      }
      case 'hero':
        panel.textContent = g.run ? g.sheetText() : 'Choose a hero to begin.'
        return
      case 'pack': {
        if (!g.run) {
          panel.textContent = 'Choose a hero to begin.'
          return
        }
        const h = g.run.hero
        const canUse = !['combat', 'dead', 'loot', 'perk', 'name'].includes(g.mode)
        const gear = [h.weapon, h.armor, ...h.trinkets].filter(Boolean).map(it => `<div class="it"><div>${esc(itemName(it!))}<small>${esc(itemDesc(it!))}</small></div></div>`)
        const pack = h.pack.map(it => {
          const def = CONSUMABLES[it.base]
          const use = canUse && def.outside ? `<button class="btn" data-use="${esc(it.base)}">Use</button>` : ''
          return `<div class="it"><div>${esc(itemName(it))}${it.qty > 1 ? ` ×${it.qty}` : ''}<small>${esc(itemDesc(it))}</small></div>${use}</div>`
        })
        panel.innerHTML = `<h3>Equipped</h3><div class="items">${gear.join('')}</div><h3 style="margin-top:14px">Pack · ${h.gold} gold</h3><div class="items">${pack.join('') || '<p class="hint">Empty.</p>'}</div>`
        panel.querySelectorAll<HTMLButtonElement>('button[data-use]').forEach(b => b.addEventListener('click', () => app.pick(`use:${b.dataset.use}`)))
        return
      }
      case 'legends':
        panel.textContent = hallText(g)
        return
      case 'settings':
        return renderSettings()
    }
  }

  let serverState = ''

  function renderSettings() {
    const s = app.settings
    const authors = Object.entries(ICON_AUTHORS) as [IconName, string][]
    const byAuthor = new Map<string, string[]>()
    for (const [icon, author] of authors) byAuthor.set(author, [...(byAuthor.get(author) ?? []), icon])
    const cloud = s.provider !== 'local'
    const saved = s.keys[s.provider]
    const keyHint = PROVIDERS.find(p => p.id === s.provider)?.keyHint ?? ''
    panel.innerHTML = `
      <h3>Voice</h3>
      <div class="field">
        <label for="server">Delve server address (speech-to-text runs on your PC)</label>
        <div class="row">
          <input type="text" id="server" placeholder="my-pc.tail1234.ts.net" value="${esc(s.server)}" autocapitalize="off" spellcheck="false" />
          <button class="btn primary" id="saveServer">Save</button>
        </div>
        <p class="hint" id="serverHint"></p>
      </div>
      <div class="toggle"><div>Hands-free<small>The mic reopens after every turn. No tapping.</small></div><input type="checkbox" id="hands" ${s.handsFree ? 'checked' : ''} /></div>

      <h3 style="margin-top:16px">Dungeon Master</h3>
      <div class="toggle"><div>AI Dungeon Master<small>Narrates, invents encounters, and rules on anything you say.</small></div><input type="checkbox" id="ai" ${s.ai ? 'checked' : ''} /></div>
      <div class="field" style="margin-top:10px">
        <label for="provider">AI provider</label>
        <div class="row"><select id="provider">${PROVIDERS.map(p => `<option value="${p.id}" ${p.id === s.provider ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field" ${cloud ? '' : 'hidden'}>
        <label for="apikey">API key</label>
        <div class="row">
          <input type="password" id="apikey" placeholder="${saved ? `saved (…${esc(saved.slice(-4))})` : esc(keyHint)}" autocapitalize="off" autocomplete="off" spellcheck="false" />
          <button class="btn primary" id="saveKey">Save</button>
          ${saved ? '<button class="btn danger" id="forgetKey">Remove</button>' : ''}
        </div>
      </div>
      <div class="field">
        <label for="model">Model</label>
        <div class="row"><select id="model"><option value="">Default</option></select></div>
        <p class="hint" id="dmHint"></p>
      </div>

      <div class="toggle"><div>Abandon this run<small>Your hero is lost. The Hall of Fame stays.</small></div><button class="btn danger" id="abandon">Abandon</button></div>
      <div class="credits" style="margin-top:14px">
        <h3>Credits</h3>
        Portraits and icons from game-icons.net, used under Creative Commons Attribution 3.0 (CC BY 3.0), by
        ${[...byAuthor.entries()].map(([a, icons]) => `<b>${esc(a)}</b> (${icons.length})`).join(', ')}.
        Rules inspired by the D&amp;D 5e SRD. Dice, loot and monsters are Delve's own.
      </div>`
    const q = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel)!
    const serverInput = q<HTMLInputElement>('#server')
    q('#saveServer').addEventListener('click', () => {
      const url = normalizeServerUrl(serverInput.value)
      if (serverInput.value.trim() && !url) {
        q('#serverHint').textContent = 'That doesn\'t look like an address.'
        return
      }
      serverInput.value = url
      app.updateSettings({ server: url })
      void checkServer()
      if (app.settings.provider === 'local') void loadModels()
    })
    q<HTMLInputElement>('#ai').addEventListener('change', e => app.updateSettings({ ai: (e.target as HTMLInputElement).checked }))
    q<HTMLInputElement>('#hands').addEventListener('change', e => app.updateSettings({ handsFree: (e.target as HTMLInputElement).checked }))
    q<HTMLSelectElement>('#provider').addEventListener('change', e => {
      app.updateSettings({ provider: (e.target as HTMLSelectElement).value as Provider })
      renderSettings()
    })
    panel.querySelector('#saveKey')?.addEventListener('click', () => {
      const key = q<HTMLInputElement>('#apikey').value.trim()
      if (!key) return
      app.updateSettings({ keys: { ...app.settings.keys, [app.settings.provider]: key } })
      renderSettings()
    })
    panel.querySelector('#forgetKey')?.addEventListener('click', () => {
      const keys = { ...app.settings.keys }
      delete keys[app.settings.provider]
      app.updateSettings({ keys })
      renderSettings()
    })
    q<HTMLSelectElement>('#model').addEventListener('change', e =>
      app.updateSettings({ models: { ...app.settings.models, [app.settings.provider]: (e.target as HTMLSelectElement).value } }),
    )
    q('#abandon').addEventListener('click', () => {
      if (confirm('Abandon this run? Your hero will be lost.')) app.abandonRun()
    })
    updateSettingsStatus()
    void checkServer()
    void loadModels()
  }

  async function checkServer() {
    const s = app.settings
    if (!s.server) {
      serverState = ''
      return updateSettingsStatus()
    }
    try {
      const res = await fetch(`${s.server}/api/health`)
      const h = (await res.json()) as { whisper?: boolean; server?: string }
      serverState = h.server === 'delve'
        ? h.whisper ? 'Server reachable; speech is ready.' : 'Server reachable, but Whisper isn\'t loaded yet.'
        : 'Something answered, but it isn\'t a Delve server. Delve uses port 8790.'
    } catch {
      serverState = 'Can\'t reach the Delve server.'
    }
    updateSettingsStatus()
  }

  async function loadModels() {
    const sel = panel.querySelector<HTMLSelectElement>('#model')
    if (!sel) return
    const cfg = app.dm.config()
    if ((cfg.provider === 'local' && !cfg.server) || (cfg.provider !== 'local' && !cfg.key)) return
    try {
      const list = await listModels(cfg)
      const chosen = app.settings.models[cfg.provider] ?? ''
      sel.innerHTML =
        `<option value="">Default (${esc(list.default || 'none')})</option>` +
        list.models.map(m => `<option value="${esc(m)}" ${m === chosen ? 'selected' : ''}>${esc(m)}</option>`).join('')
    } catch {
      /* the status line explains */
    }
  }

  function updateSettingsStatus() {
    const s = app.settings
    const serverHint = panel.querySelector('#serverHint')
    if (serverHint) {
      const parts: string[] = []
      if (!s.server) parts.push('Delve plays fine without it: tap or swipe to choose. Run the Delve server on your PC for voice control.')
      else {
        if (serverState) parts.push(serverState)
        if (!looksWhitelisted(s.server)) parts.push('Use a MagicDNS name (….ts.net) or delve.local: the glasses only allow those.')
      }
      if (!app.hasMic) parts.push('Voice needs the glasses: open Delve from the Even app.')
      serverHint.textContent = parts.join(' ')
    }
    const dmHint = panel.querySelector('#dmHint')
    if (!dmHint) return
    const name = PROVIDERS.find(p => p.id === s.provider)?.name ?? s.provider
    const local: Record<DmStatus, string> = {
      ready: 'Connected. The Dungeon Master runs on your own PC, free.',
      off: 'The AI Dungeon Master is switched off.',
      checking: 'Checking…',
      offline: 'Can\'t reach the Delve server, or Ollama is down.',
      'old-server': 'Something answered, but it isn\'t a Delve server. Delve uses port 8790.',
      unset: 'Enter your Delve server address above to use a local model.',
      'no-key': '',
      'bad-key': '',
    }
    const cloud: Record<DmStatus, string> = {
      ready: `Connected to ${name}. Every turn is a small paid API call on your account.`,
      off: 'The AI Dungeon Master is switched off.',
      checking: 'Checking the key…',
      offline: `Can't reach ${name} right now.`,
      'old-server': '',
      unset: '',
      'no-key': `Paste your ${name} API key. It stays in Delve's private storage on this phone and is only ever sent to ${name}.`,
      'bad-key': `${name} rejected that key.`,
    }
    dmHint.textContent = (s.provider === 'local' ? local : cloud)[app.dm.status]
  }

  app.onChange(() => {
    renderControls()
    renderPanel()
  })
  renderControls()
  renderPanel(true)

  return { drawLens }
}
