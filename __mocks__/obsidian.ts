/**
 * Minimal Obsidian API mock for unit tests.
 * Only stubs what the plugin actually uses — extend as needed.
 * The real `obsidian` package is provided by the Obsidian runtime, not Node.js.
 */
import { StateField } from '@codemirror/state';
import { vi } from 'vitest';

export function parseLinktext(linktext: string): { path: string; subpath: string } {
  const subpathIndex = linktext.search(/[#^]/);
  return {
    path: subpathIndex === -1 ? linktext : linktext.slice(0, subpathIndex),
    subpath: subpathIndex === -1 ? '' : linktext.slice(subpathIndex),
  };
}

export class Workspace {
  trigger = vi.fn();
  getLeaf = vi.fn().mockReturnValue({ openFile: vi.fn().mockResolvedValue(undefined) });
  getRightLeaf = vi.fn().mockReturnValue({
    view: {},
    setViewState: vi.fn().mockResolvedValue(undefined),
  });
  getLeavesOfType = vi.fn().mockReturnValue([]);
  revealLeaf = vi.fn();
  on = vi.fn().mockReturnValue({});
  offref = vi.fn();
  activeEditor?: {
    editor: { replaceRange: ReturnType<typeof vi.fn>; getCursor: ReturnType<typeof vi.fn> };
  };

  openLinkText(_path: string, _sourcePath: string, _newLeaf: boolean): Promise<void> {
    return Promise.resolve();
  }
}

export class MetadataCache {
  resolvedLinks: Record<string, Record<string, number>> = {};

  getCache(_path: string): { frontmatter?: Record<string, unknown> } | null {
    return null;
  }

  getFirstLinkpathDest(path: string, _sourcePath: string): TFile | null {
    return new TFile(path.endsWith('.md') ? path : `${path}.md`);
  }
}

type KeymapHandler = (evt: KeyboardEvent, ctx: unknown) => boolean | void;

/** Minimal Scope: first matching handler wins, unmatched keys fall back to the parent. */
export class Scope {
  keys: Array<{ modifiers: string[]; key: string; func: KeymapHandler }> = [];
  constructor(public parent?: Scope | { register?: unknown }) {}
  register(modifiers: string[], key: string, func: KeymapHandler) {
    const entry = { modifiers, key, func };
    this.keys.push(entry);
    return entry;
  }
  unregister(entry: unknown) {
    this.keys = this.keys.filter((k) => k !== entry);
  }
  /** Test helper mirroring Obsidian's dispatch for plain (modifier-less) keys. */
  handleKey(evt: KeyboardEvent): boolean | void {
    const mods: string[] = [];
    if (evt.ctrlKey || evt.metaKey) mods.push('Mod');
    if (evt.altKey) mods.push('Alt');
    if (evt.shiftKey) mods.push('Shift');
    const match = this.keys.find(
      (k) =>
        k.key === evt.key &&
        k.modifiers.length === mods.length &&
        k.modifiers.every((m) => mods.includes(m)),
    );
    if (match) {
      const result = match.func(evt, {});
      if (result === false) evt.preventDefault();
      return result;
    }
    const parent = this.parent as Scope | undefined;
    return typeof parent?.handleKey === 'function' ? parent.handleKey(evt) : undefined;
  }
}

export class Keymap {
  scopes: Scope[] = [];
  pushScope(scope: Scope) {
    this.scopes.push(scope);
  }
  popScope(scope: Scope) {
    this.scopes = this.scopes.filter((s) => s !== scope);
  }
}

export class App {
  keymap: Keymap = new Keymap();
  workspace: Workspace = new Workspace();
  metadataCache: MetadataCache = new MetadataCache();
  vault = {
    adapter: {
      getBasePath: () => '/test-vault',
    },
    getAbstractFileByPath: (path: string) => new TFile(path),
  };
  secretStorage = new SecretStorage();
}

export class Component {
  private children: Component[] = [];
  private cleanup: Array<() => void> = [];
  private loaded = false;

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.onload();
    for (const child of this.children) child.load();
  }

  unload(): void {
    const children = this.children.splice(0);
    const cleanup = this.cleanup.splice(0);
    for (const child of children) child.unload();
    for (const callback of cleanup) callback();
    if (this.loaded) this.onunload();
    this.loaded = false;
  }

  onload(): void {}
  onunload(): void {}

  addChild<T extends Component>(child: T): T {
    this.children.push(child);
    if (this.loaded) child.load();
    return child;
  }

  removeChild<T extends Component>(child: T): T {
    this.children = this.children.filter((entry) => entry !== child);
    child.unload();
    return child;
  }

  register(callback: () => void): void {
    this.cleanup.push(callback);
  }

  registerDomEvent(el: EventTarget, type: string, listener: EventListenerOrEventListenerObject) {
    el.addEventListener(type, listener);
    this.register(() => el.removeEventListener(type, listener));
  }
}

export class HoverPopover extends Component {
  hoverEl = activeDocument.createDiv({ cls: 'popover hover-popover' });
  state = {};

  constructor(
    parent: { hoverPopover: HoverPopover | null },
    _targetEl: HTMLElement | null,
    _waitTime?: number,
    _staticPos?: { x: number; y: number } | null,
  ) {
    super();
    parent.hoverPopover = this;
  }
}

interface PluginManifest {
  id: string;
  name: string;
  version: string;
}

export class Plugin {
  app: App;
  manifest: PluginManifest;
  // Required, mirroring the real signature. A default would hand every caller a plausible id and
  // hide the case where a manifest never reached the plugin at all.
  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }
  addRibbonIcon(_icon: string, _title: string, _cb: (evt: MouseEvent) => void) {}
  addCommand(_cmd: {
    id: string;
    name: string;
    callback?: () => void;
    hotkeys?: Array<{ modifiers: string[]; key: string }>;
  }) {}
  loadData(): Promise<unknown> {
    return Promise.resolve({});
  }
  saveData(_data: unknown): Promise<void> {
    return Promise.resolve();
  }
  addSettingTab(_tab: PluginSettingTab) {}
  registerView(_type: string, _viewCreator: (leaf: WorkspaceLeaf) => unknown) {}
  registerEditorExtension(_extension: unknown) {}
  registerEditorSuggest(_suggest: unknown) {}
  registerEvent(_eventRef: unknown) {}
  registerDomEvent(el: EventTarget, type: string, listener: EventListenerOrEventListenerObject) {
    el.addEventListener(type, listener);
  }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement = activeDocument.createDiv();
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }
  display() {}
  hide() {}
}

export class Modal {
  app: App;
  contentEl: HTMLElement = activeDocument.createDiv();
  modalEl: HTMLElement = activeDocument.createDiv();
  constructor(app: App) {
    this.app = app;
  }
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
}

export class ItemView {
  app: App;
  containerEl: HTMLElement = activeDocument.createDiv();
  leaf: WorkspaceLeaf;
  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app ?? new App();
    this.containerEl.appendChild(activeDocument.createDiv());
    this.containerEl.appendChild(activeDocument.createDiv());
  }
  getViewType(): string {
    return '';
  }
  getDisplayText(): string {
    return '';
  }
  getIcon(): string {
    return '';
  }
  onOpen(): Promise<void> {
    return Promise.resolve();
  }
  onClose(): Promise<void> {
    return Promise.resolve();
  }
  registerDomEvent(el: EventTarget, type: string, listener: EventListenerOrEventListenerObject) {
    el.addEventListener(type, listener);
  }
}

export class MarkdownView {
  file: TFile | null = null;
  containerEl: HTMLElement = activeDocument.createDiv();
  leaf: WorkspaceLeaf;
  constructor(leaf?: WorkspaceLeaf) {
    this.leaf = leaf ?? new WorkspaceLeaf();
  }
}

export class WorkspaceLeaf {
  app?: App;
  view: unknown = {};
  setViewState = vi.fn().mockResolvedValue(undefined);
}

export class SuggestModal<T> extends Modal {
  scope = { register: vi.fn() };
  setPlaceholder(_placeholder: string): void {}
  getSuggestions(_query: string): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_item: T, _el: HTMLElement) {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent) {}
}

export class EditorSuggest<T> {
  app: App;
  context: unknown = null;
  limit = 100;
  scope = { register: vi.fn() };
  constructor(app: App) {
    this.app = app;
  }
  setInstructions(_instructions: unknown[]): void {}
  close(): void {}
  onTrigger(): unknown {
    return null;
  }
  getSuggestions(): T[] | Promise<T[]> {
    return [];
  }
  renderSuggestion(_item: T, _el: HTMLElement) {}
  selectSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent) {}
}

export class TextComponent {
  private cb?: (value: string) => void;
  setValue(_value: string): this {
    return this;
  }
  setPlaceholder(_placeholder: string): this {
    return this;
  }
  onChange(cb: (value: string) => void): this {
    this.cb = cb;
    return this;
  }
  triggerChange(value: string): void {
    this.cb?.(value);
  }
}

export class ToggleComponent {
  private cb?: (value: boolean) => void;
  setValue(_value: boolean): this {
    return this;
  }
  onChange(cb: (value: boolean) => void): this {
    this.cb = cb;
    return this;
  }
  triggerChange(value: boolean): void {
    this.cb?.(value);
  }
}

export class DropdownComponent {
  private cb?: (value: string) => void;
  addOption(_value: string, _display: string): this {
    return this;
  }
  setValue(_value: string): this {
    return this;
  }
  getValue(): string {
    return '';
  }
  onChange(cb: (value: string) => void): this {
    this.cb = cb;
    return this;
  }
  triggerChange(value: string): void {
    this.cb?.(value);
  }
}

export class SliderComponent {
  private cb?: (value: number) => void;
  setLimits(_min: number, _max: number, _step: number): this {
    return this;
  }
  setValue(_value: number): this {
    return this;
  }
  setDynamicTooltip(): this {
    return this;
  }
  onChange(cb: (value: number) => void): this {
    this.cb = cb;
    return this;
  }
  triggerChange(value: number): void {
    this.cb?.(value);
  }
}

export class ButtonComponent {
  private cb?: (evt: MouseEvent) => void;
  setButtonText(_text: string): this {
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(cb: (evt: MouseEvent) => void): this {
    this.cb = cb;
    return this;
  }
  triggerClick(evt?: MouseEvent): void {
    this.cb?.(evt ?? new MouseEvent('click'));
  }
}

export class ExtraButtonComponent {
  private cb?: (evt: MouseEvent) => void;
  setIcon(_icon: string): this {
    return this;
  }
  setTooltip(_tooltip: string): this {
    return this;
  }
  onClick(cb: (evt: MouseEvent) => void): this {
    this.cb = cb;
    return this;
  }
  triggerClick(evt?: MouseEvent): void {
    this.cb?.(evt ?? new MouseEvent('click'));
  }
}

export class Setting {
  static readonly instances: Setting[] = [];
  static clearInstances(): void {
    Setting.instances.length = 0;
  }
  private nameEl: HTMLElement;
  private descEl: HTMLElement;
  textComponents: TextComponent[] = [];
  toggleComponents: ToggleComponent[] = [];
  dropdownComponents: DropdownComponent[] = [];
  buttonComponents: ButtonComponent[] = [];
  extraButtonComponents: ExtraButtonComponent[] = [];
  private settingEl: HTMLElement;
  controlEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    Setting.instances.push(this);
    const item = activeDocument.createDiv();
    item.className = 'setting-item';
    containerEl.appendChild(item);
    this.settingEl = item;
    const controlEl = activeDocument.createDiv();
    controlEl.className = 'setting-item-control';
    item.appendChild(controlEl);
    this.controlEl = controlEl;
    const nameEl = activeDocument.createDiv();
    nameEl.className = 'setting-item-name';
    item.appendChild(nameEl);
    this.nameEl = nameEl;
    const descEl = activeDocument.createDiv();
    descEl.className = 'setting-item-description';
    item.appendChild(descEl);
    this.descEl = descEl;
  }
  setName(name: string): this {
    this.nameEl.textContent = name;
    return this;
  }
  getName(): string {
    return this.nameEl.textContent ?? '';
  }
  setDesc(desc: string): this {
    this.descEl.textContent = desc;
    return this;
  }
  setHeading(): this {
    this.settingEl.className += ' setting-item-heading';
    return this;
  }
  addText(cb: (text: TextComponent) => void): this {
    const t = new TextComponent();
    this.textComponents.push(t);
    cb(t);
    return this;
  }
  addToggle(cb: (toggle: ToggleComponent) => void): this {
    const t = new ToggleComponent();
    this.toggleComponents.push(t);
    cb(t);
    return this;
  }
  addDropdown(cb: (dropdown: DropdownComponent) => void): this {
    const d = new DropdownComponent();
    this.dropdownComponents.push(d);
    cb(d);
    return this;
  }
  addSlider(_cb: (slider: SliderComponent) => void): this {
    return this;
  }
  addButton(cb: (btn: ButtonComponent) => void): this {
    const b = new ButtonComponent();
    this.buttonComponents.push(b);
    cb(b);
    return this;
  }
  addExtraButton(cb: (btn: ExtraButtonComponent) => void): this {
    const b = new ExtraButtonComponent();
    this.extraButtonComponents.push(b);
    cb(b);
    return this;
  }
}

export class SecretComponent {
  static readonly instances: SecretComponent[] = [];
  static clearInstances(): void {
    SecretComponent.instances.length = 0;
  }
  value = '';
  changeCallback: ((value: string) => unknown) | null = null;
  constructor(_app: App, _containerEl: HTMLElement) {
    SecretComponent.instances.push(this);
  }
  setValue(value: string): this {
    this.value = value;
    return this;
  }
  onChange(cb: (value: string) => unknown): this {
    this.changeCallback = cb;
    return this;
  }
  triggerChange(value: string): unknown {
    this.value = value;
    return this.changeCallback?.(value);
  }
}

export class SecretStorage {
  private store = new Map<string, string>();
  setSecret(id: string, secret: string): void {
    this.store.set(id, secret);
  }
  getSecret(id: string): string | null {
    return this.store.get(id) ?? null;
  }
  listSecrets(): string[] {
    return [...this.store.keys()];
  }
}

/** Same contract as Obsidian's getFrontMatterInfo: a `---` line opens the block and
 *  the next `---` line closes it; `contentStart` is the offset after the closing line. */
export function getFrontMatterInfo(content: string): {
  exists: boolean;
  frontmatter: string;
  from: number;
  to: number;
  contentStart: number;
} {
  const none = { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
  const open = /^---[ \t]*\r?\n/.exec(content);
  if (!open) return none;
  const from = open[0].length;
  const close = /^---[ \t]*(\r?\n|$)/gm;
  close.lastIndex = from;
  const match = close.exec(content);
  if (!match) return none;
  const to = match.index;
  return {
    exists: true,
    frontmatter: content.slice(from, to),
    from,
    to,
    contentStart: match.index + match[0].length,
  };
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class TFile {
  path: string;
  extension: string;
  constructor(path = '') {
    this.path = path;
    this.extension = path.includes('.') ? path.replace(/^.*\./, '') : '';
  }
}

export class MarkdownRenderChild {
  containerEl: HTMLElement;
  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }
  load(): void {}
  unload(): void {}
}

export const MarkdownRenderer = {
  render: vi.fn((_app, source: string, el: HTMLElement) => {
    el.textContent = source;
    return Promise.resolve();
  }),
};

export const requestUrl = vi.fn();

export const setIcon = vi.fn((parent: HTMLElement, iconId: string) => {
  parent.dataset.icon = iconId;
});

// Passthrough debounce — returns a plain function that calls cb immediately.
// resetTimer param is accepted and ignored.
export const debounce = <T extends unknown[]>(
  cb: (...args: T) => void,
  _wait?: number,
  _resetTimer?: boolean,
): ((...args: T) => void) & { cancel: () => void } => {
  const fn = (...args: T) => cb(...args);
  fn.cancel = () => {};
  return fn;
};

/** Same role as Obsidian's editorInfoField: which view/file an editor belongs to.
 * Tests provide it with `editorInfoField.init(() => view)`. */
export const editorInfoField = StateField.define<unknown>({
  create: () => null,
  update: (value) => value,
});
