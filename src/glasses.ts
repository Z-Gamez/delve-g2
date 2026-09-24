// Everything written to the glasses, and every gesture read from them.
//
// Two page layouts:
//
//   game   portrait + caption, a three-line story strip, and the options as a
//          native list: the firmware draws the hovered option as a rounded
//          pill, moves it on swipe by itself, and reports the index on tap.
//   page   a scrollable text body (character sheet, inventory, help), where
//          swipes turn pages.
//
// The list can't be edited in place, so a new set of options means a
// rebuildPageContainer (which also resets the pill to the top -- to Speak,
// when voice is on). Everything else is re-sent only when it changed, because
// every write is a BLE round trip; the portrait only when the subject changes.

import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import type { App } from './app'
import { portrait } from './art'
import type { IconName } from './icons.gen'
import {
  HEADER, BODY, FOOTER, CAPTION, ART, STORY, LIST,
  spread, footerLine, lensSafe, fitStory, pillText, captionText, paginate, pageDots, clampLines, STORY_INNER_W,
} from './lens'

export interface GlassesHost {
  createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<number>
  rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>
  textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>
  updateImageRawData(d: ImageRawDataUpdate): Promise<unknown>
  shutDownPageContainer(mode?: number): Promise<boolean>
}

type Layout = 'game' | 'page'

/** What's on the lens, for the phone's mirror. */
export interface LensFrame {
  layout: Layout
  header: string
  /** The story strip (game) or page text (page). */
  body: string
  /** Pill labels, top to bottom (game only). */
  items: string[]
  caption: string
  footer: string
  icon: IconName
  dim: boolean
}

const MENU = { sheet: 1, inventory: 2, help: 3, handsFree: 4, hall: 5, main: 6 } as const
/** Pills are one line; the firmware truncates, but a budget keeps the payload small. */
const MAX_ITEMS = 20

interface Features {
  menu: boolean
  brightness: boolean
}

export class Glasses {
  private features: Features = { menu: true, brightness: true }
  private layout: Layout | null = null
  private listKey = ''
  private sent: Record<string, string> = {}
  private artKey = ''
  private queue: Promise<unknown> = Promise.resolve()
  private pending = false
  private started = false
  frame: LensFrame = { layout: 'game', header: '', body: '', items: [], caption: '', footer: '', icon: 'dice-twenty-faces-twenty', dim: false }

  constructor(
    private host: GlassesHost,
    private app: App,
    private onFrame: (f: LensFrame) => void = () => {},
  ) {
    app.paginator = text => paginate(text)
    app.onChange(() => this.render())
  }

  // --- startup -------------------------------------------------------------------------

  /**
   * The contextual menu and text brightness are newer than the rest of the page
   * API, and an older host may hang instead of refusing them. Each attempt is
   * bounded; a plainer page beats a blank lens.
   */
  async start(): Promise<void> {
    const f = this.compose()
    const attempts: Features[] = [
      { menu: true, brightness: true },
      { menu: false, brightness: true },
      { menu: false, brightness: false },
    ]
    let ok = false
    for (const features of attempts) {
      this.features = features
      let result = -1
      try {
        result = await Promise.race([
          this.host.createStartUpPageContainer(new CreateStartUpPageContainer(this.containers(f))),
          new Promise<number>(resolve => setTimeout(() => resolve(-1), 4000)),
        ])
      } catch (err) {
        console.warn('page refused', features, err)
      }
      if (result === 0) {
        ok = true
        break
      }
    }
    if (!ok) this.features = { menu: true, brightness: false }
    // After a WebView reload the host can keep the previous page, and "success"
    // doesn't mean it was replaced; the first paint rebuilds into a known one.
    this.layout = null
    this.started = true
    this.render()
  }

  private text(c: { id: number; name: string; x: number; y: number; w: number; h: number; pad: number; brightness: number; border?: number; radius?: number }, content: string, capture: boolean) {
    return new TextContainerProperty({
      xPosition: c.x,
      yPosition: c.y,
      width: c.w,
      height: c.h,
      borderWidth: c.border ?? 0,
      borderColor: 5,
      ...(c.radius ? { borderRadius: c.radius } : {}),
      paddingLength: c.pad,
      containerID: c.id,
      containerName: c.name,
      content: content || ' ',
      ...(this.features.brightness ? { textColor: c.brightness } : {}),
      isEventCapture: capture ? 1 : 0,
    })
  }

  private containers(f: LensFrame) {
    const menu = this.features.menu
      ? {
          menuObject: new MenuContainerProperty({
            menuItems: [
              new MenuItemProperty({ itemID: MENU.main, itemName: 'Main menu' }),
              new MenuItemProperty({ itemID: MENU.sheet, itemName: 'Character' }),
              new MenuItemProperty({ itemID: MENU.inventory, itemName: 'Inventory' }),
              new MenuItemProperty({ itemID: MENU.handsFree, itemName: 'Hands-free on/off' }),
              new MenuItemProperty({ itemID: MENU.help, itemName: 'How to play' }),
              new MenuItemProperty({ itemID: MENU.hall, itemName: 'Hall of Fame' }),
            ],
          }),
        }
      : {}
    const image = new ImageContainerProperty({ xPosition: ART.x, yPosition: ART.y, width: ART.w, height: ART.h, containerID: ART.id, containerName: ART.name })
    if (f.layout === 'page') {
      return {
        containerTotalNum: 5,
        textObject: [this.text(HEADER, ' ', false), this.text(BODY, ' ', true), this.text(FOOTER, ' ', false), this.text(CAPTION, ' ', false)],
        imageObject: [image],
        ...menu,
      }
    }
    const items = f.items.length ? f.items : [' ']
    return {
      containerTotalNum: 6,
      textObject: [this.text(HEADER, ' ', false), this.text(STORY, ' ', false), this.text(FOOTER, ' ', false), this.text(CAPTION, ' ', false)],
      imageObject: [image],
      listObject: [
        new ListContainerProperty({
          xPosition: LIST.x,
          yPosition: LIST.y,
          width: LIST.w,
          height: LIST.h,
          borderWidth: 0,
          borderColor: 5,
          borderRadius: 8,
          paddingLength: LIST.pad,
          containerID: LIST.id,
          containerName: LIST.name,
          isEventCapture: 1,
          itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items }),
        }),
      ],
      ...menu,
    }
  }

  // --- input -------------------------------------------------------------------------------

  /** Returns true if the event was a gesture or menu pick (audio is routed elsewhere). */
  handleEvent(event: EvenHubEvent): boolean {
    if (event.menuItemClickEvent?.itemID) {
      this.onMenu(event.menuItemClickEvent.itemID)
      return true
    }
    // CLICK_EVENT is 0 and protobuf drops zero values, so a bare tap arrives
    // as an envelope with no eventType -- and the first list item as no index.
    const typeOf = (e?: { eventType?: OsEventTypeList }) => (e ? e.eventType ?? OsEventTypeList.CLICK_EVENT : null)
    const list = typeOf(event.listEvent)
    const sys = typeOf(event.sysEvent)
    const txt = typeOf(event.textEvent)
    const any = (t: OsEventTypeList) => list === t || sys === t || txt === t
    if (any(OsEventTypeList.DOUBLE_CLICK_EVENT)) return this.app.double(), true
    // A long press opens the glasses' own menu; acting on it here too would
    // do something behind that menu.
    if (any(OsEventTypeList.LONG_PRESS_EVENT) || any(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return true
    if (list === OsEventTypeList.CLICK_EVENT) return this.app.tapItem(event.listEvent?.currentSelectItemIndex ?? 0), true
    if (this.layout === 'page') {
      if (txt === OsEventTypeList.SCROLL_TOP_EVENT) return this.app.swipe(-1), true
      if (txt === OsEventTypeList.SCROLL_BOTTOM_EVENT) return this.app.swipe(1), true
      if (txt === OsEventTypeList.CLICK_EVENT || sys === OsEventTypeList.CLICK_EVENT) return this.app.tap(), true
    }
    return false
  }

  private onMenu(id: number) {
    if (id === MENU.main) return this.app.openMenu()
    if (id === MENU.sheet) return this.app.openPage('sheet')
    if (id === MENU.inventory) return this.app.openPage('inventory')
    if (id === MENU.help) return this.app.openPage('help')
    if (id === MENU.hall) return this.app.openPage('hall')
    if (id === MENU.handsFree) return this.app.toggleHandsFree()
  }

  // --- painting ---------------------------------------------------------------------------

  /** Coalesced: any number of calls while a paint is queued become one paint. */
  render() {
    if (this.pending) return
    this.pending = true
    this.queue = this.queue
      .then(() => {
        this.pending = false
        return this.paint()
      })
      // Load-bearing: one failed write must not leave the chain rejected, or
      // every later paint inherits the failure and the lens freezes.
      .catch(err => console.error('lens paint failed:', err))
  }

  private compose(): LensFrame {
    const app = this.app
    const g = app.game
    if (app.page) {
      const p = app.page
      return {
        layout: 'page',
        header: spread(`◆ ${p.title}`, pageDots(p.index, p.pages.length)),
        body: p.pages[p.index] ?? '',
        items: [],
        caption: p.title,
        footer: footerLine(p.pages.length > 1 ? 'swipe: page   tap: close' : 'tap: close'),
        icon: p.icon,
        dim: false,
      }
    }
    const header = spread(app.headerLeft(), app.headerRight())
    const items = app.lensItems().slice(0, MAX_ITEMS).map(o => lensSafe(pillText(o.label, o.detail)))
    if (app.menu.open) {
      const m = app.menuScene()
      return { layout: 'game', header, body: fitStory(m.text, '', 'start'), items, caption: m.caption, footer: footerLine(app.footer()), icon: m.icon, dim: false }
    }
    if (g.mode === 'class') {
      const h = app.heroCard()
      // Three fixed lines; each is cut to one lens line so they never run together.
      const body = h.text.split('\n').slice(0, 3).map(l => clampLines(l, 1, STORY_INNER_W)).join('\n')
      return { layout: 'game', header, body, items, caption: h.caption, footer: footerLine(app.footer()), icon: h.icon, dim: false }
    }
    const scene = g.scene()
    return {
      layout: 'game',
      header,
      body: fitStory(app.story().text, scene.prompt, app.narration ? 'start' : 'end'),
      items,
      caption: captionText(scene.caption, scene.bar),
      footer: footerLine(app.footer()),
      icon: scene.icon,
      dim: scene.dim,
    }
  }

  private async paint() {
    const f = this.compose()
    this.frame = f
    this.onFrame(f)
    if (!this.started) return
    const listKey = f.items.join('\n')
    if (f.layout !== this.layout || (f.layout === 'game' && listKey !== this.listKey)) {
      const ok = await this.host.rebuildPageContainer(new RebuildPageContainer(this.containers(f)))
      if (!ok && this.features.menu) {
        // A host that took the menu at startup may still refuse it here.
        this.features = { ...this.features, menu: false }
        await this.host.rebuildPageContainer(new RebuildPageContainer(this.containers(f)))
      }
      this.layout = f.layout
      this.listKey = listKey
      this.sent = {}
      this.artKey = ''
    }
    await this.put(HEADER, f.header)
    await this.put(f.layout === 'page' ? BODY : STORY, f.body)
    await this.put(CAPTION, f.caption)
    await this.put(FOOTER, f.footer)
    await this.pushArt(f.icon, f.dim)
  }

  private async put(c: { id: number; name: string }, content: string) {
    const text = lensSafe(content) || ' '
    const key = `${c.id}:${c.name}`
    if (this.sent[key] === text) return
    await this.host.textContainerUpgrade(new TextContainerUpgrade({ containerID: c.id, containerName: c.name, content: text }))
    this.sent[key] = text
  }

  private async pushArt(icon: IconName, dim: boolean) {
    const pixel = this.app.settings.pixelArt
    const key = `${icon}|${dim}|${pixel}`
    if (this.artKey === key) return
    this.artKey = key
    const bytes = await portrait(icon, { size: ART.w, dim, pixel })
    if (this.artKey !== key) return // the scene moved on while it rendered
    const result = await this.host.updateImageRawData(new ImageRawDataUpdate({ containerID: ART.id, containerName: ART.name, imageData: bytes }))
    if (result !== 'success') console.warn('portrait push:', result)
  }
}

/** Stands in for the Even bridge in a plain browser. */
export const stubHost: GlassesHost = {
  createStartUpPageContainer: async () => 0,
  rebuildPageContainer: async () => true,
  textContainerUpgrade: async () => true,
  updateImageRawData: async () => 'success',
  shutDownPageContainer: async () => true,
}
