// Pure function layout state machine (Part A - Appendix E)
export type ViewKind = 'markdown' | 'graph' | 'plugin' | 'empty';

export interface ViewState {
  kind: ViewKind;
  path?: string;
  mode?: 'source' | 'preview' | 'reading';
  scroll?: number;
  pluginId?: string;
}

export interface Tab {
  id: string;
  view: ViewState;
  pinned: boolean;
}

export interface TabGroup {
  id: string;
  tabs: Tab[];
  activeIndex: number;
}

export interface SplitNode {
  id: string;
  direction: 'row' | 'column';
  children: LayoutNode[];
  weights: number[];
}

export type LayoutNode = SplitNode | TabGroup;

export interface LayoutState {
  main: LayoutNode;
  sidebar: { collapsed: boolean; width: number; panel: string };
  statusText: string;
}

export type LayoutAction =
  | { type: 'OPEN_FILE'; path: string; content: string; html: string }
  | { type: 'CLOSE_TAB'; groupId: string; tabId: string }
  | { type: 'SELECT_TAB'; groupId: string; tabId: string }
  | { type: 'SPLIT_GROUP'; groupId: string; direction: 'row' | 'column' }
  | { type: 'CLOSE_SPLIT'; splitId: string }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'SET_SIDEBAR_WIDTH'; width: number }
  | { type: 'SET_PANEL'; panel: string }
  | { type: 'SET_STATUS'; text: string }
  | { type: 'RESIZE_SPLIT'; splitId: string; index: number; delta: number }
  | { type: 'SET_LOADING'; key: string; loading: boolean };

let nextId = 1;
function genId(): string { return `n${nextId++}`; }

export function createTabGroup(tabs?: Tab[]): TabGroup {
  return {
    id: genId(),
    tabs: tabs || [{ id: genId(), view: { kind: 'empty' }, pinned: false }],
    activeIndex: 0,
  };
}

export function createSplit(dir: 'row' | 'column', ...children: LayoutNode[]): SplitNode {
  return {
    id: genId(),
    direction: dir,
    children: children.length ? children : [createTabGroup(), createTabGroup()],
    weights: children.length ? children.map(() => 1 / children.length) : [0.5, 0.5],
  };
}

// Initialize default layout
export function createInitialState(): LayoutState {
  return {
    main: createTabGroup(),
    sidebar: { collapsed: false, width: 280, panel: 'files' },
    statusText: '就绪',
  };
}

// Pure reducer
export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case 'OPEN_FILE': {
      // Find first group, add or activate tab — immutable
      const main = cloneNode(state.main);
      const group = findFirstGroup(main);
      if (group) {
        const existing = group.tabs.find(t => t.view.path === action.path);
        if (existing) {
          group.activeIndex = group.tabs.indexOf(existing);
        } else {
          group.tabs = [...group.tabs, {
            id: genId(),
            view: { kind: 'markdown', path: action.path, mode: 'preview' },
            pinned: false,
          }];
          group.activeIndex = group.tabs.length - 1;
        }
      }
      return { ...state, main, statusText: `打开: ${action.path}` };
    }
    case 'CLOSE_TAB': {
      const main = cloneNode(state.main);
      traverse(main, (node) => {
        if (node.id === action.groupId && 'tabs' in node) {
          const group = node as TabGroup;
          group.tabs = group.tabs.filter(t => t.id !== action.tabId);
          if (group.activeIndex >= group.tabs.length) {
            group.activeIndex = Math.max(0, group.tabs.length - 1);
          }
        }
      });
      return { ...state, main };
    }
    case 'SELECT_TAB': {
      const main = cloneNode(state.main);
      traverse(main, (node) => {
        if (node.id === action.groupId && 'tabs' in node) {
          const group = node as TabGroup;
          const idx = group.tabs.findIndex(t => t.id === action.tabId);
          if (idx >= 0) group.activeIndex = idx;
        }
      });
      return { ...state, main };
    }
    case 'SPLIT_GROUP': {
      const newMain = splitGroup(state.main, action.groupId, action.direction);
      return { ...state, main: normalize(newMain) };
    }
    case 'CLOSE_SPLIT': {
      const newMain = closeSplit(state.main, action.splitId);
      return { ...state, main: normalize(newMain) };
    }
    case 'TOGGLE_SIDEBAR':
      return { ...state, sidebar: { ...state.sidebar, collapsed: !state.sidebar.collapsed } };
    case 'SET_SIDEBAR_WIDTH':
      return { ...state, sidebar: { ...state.sidebar, width: Math.max(200, Math.min(600, action.width)) } };
    case 'SET_PANEL':
      return { ...state, sidebar: { ...state.sidebar, panel: action.panel } };
    case 'SET_STATUS':
      return { ...state, statusText: action.text };
    case 'SET_LOADING':
      return { ...state, statusText: action.loading ? '加载中...' : state.statusText };
    default:
      return state;
  }
}

// ── Helpers ──────────────────────────────────────────────────

function traverse(node: LayoutNode, fn: (n: LayoutNode) => void) {
  fn(node);
  if ('children' in node) {
    node.children.forEach(c => traverse(c, fn));
  }
}

function findFirstGroup(node: LayoutNode): TabGroup | null {
  if ('tabs' in node) return node;
  if ('children' in node) return findFirstGroup(node.children[0]);
  return null;
}

function splitGroup(node: LayoutNode, groupId: string, dir: 'row' | 'column'): LayoutNode {
  if ('tabs' in node && node.id === groupId) {
    return createSplit(dir, node, createTabGroup());
  }
  if ('children' in node) {
    return {
      ...node,
      children: (node as SplitNode).children.map(c => splitGroup(c, groupId, dir)),
    };
  }
  return node;
}

function closeSplit(node: LayoutNode, splitId: string): LayoutNode {
  if ('children' in node && node.id === splitId) {
    return node.children[0]; // Collapse to first child
  }
  if ('children' in node) {
    return {
      ...node,
      children: (node as SplitNode).children.map(c => closeSplit(c, splitId)),
    };
  }
  return node;
}

/** Deep clone a layout node tree for immutable updates. */
function cloneNode(node: LayoutNode): LayoutNode {
  return JSON.parse(JSON.stringify(node));
}

function normalize(node: LayoutNode): LayoutNode {
  if ('tabs' in node) {
    const g = node as TabGroup;
    if (g.tabs.length === 0) g.tabs = [{ id: genId(), view: { kind: 'empty' }, pinned: false }];
    if (g.activeIndex < 0 || g.activeIndex >= g.tabs.length) g.activeIndex = 0;
    return g;
  }
  if ('children' in node) {
    let s = node as SplitNode;
    s.children = s.children.map(normalize);
    // Flatten same-direction nested splits
    s.children = s.children.flatMap(c => {
      if ('children' in c && (c as SplitNode).direction === s.direction) {
        return (c as SplitNode).children;
      }
      return [c];
    });
    // Clamp weights
    if (s.children.length !== s.weights.length) {
      s.weights = s.children.map(() => 1 / s.children.length);
    }
    if (s.children.length < 2) return s.children[0] || createTabGroup();
    return s;
  }
  return node;
}
